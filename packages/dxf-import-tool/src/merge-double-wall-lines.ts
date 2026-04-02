/**
 * CAD 平面常「双线」表示墙厚；线段导入时每条线会变成一堵墙。本模块在米制坐标下
 * 将同层、平行、间距在合理范围内的线段合并为一条中心线，并把厚度设为两线间距。
 */

import { canonicalDxfLayerName } from './dxf-layer-mapping.ts'
import type { DxfLayerMapping } from './dxf-layer-mapping.ts'
import type { PlanSegment } from './parse-dxf-entities.ts'

export type TaggedWallSegment = {
  seg: PlanSegment
  levelIndex: number
  mapping: DxfLayerMapping
}

export type MergedWallSegment = TaggedWallSegment & {
  /** 米制；合并双线时用测得间距，否则为调用方传入的默认墙厚 */
  thicknessM: number
  /** 是否由同组内 ≥2 条平行线段合并而成 */
  fromDoubleLineMerge: boolean
}

function transformPoint(
  x: number,
  y: number,
  ox: number,
  oy: number,
  scale: number,
  useOffset: boolean,
  flipX: boolean,
  flipY: boolean,
): [number, number] {
  const px = useOffset ? x - ox : x
  const py = useOffset ? y - oy : y
  let mx = px * scale
  let my = py * scale
  if (flipX) mx = -mx
  if (flipY) my = -my
  return [mx, my]
}

function inverseTransformPoint(
  mx: number,
  my: number,
  ox: number,
  oy: number,
  scale: number,
  useOffset: boolean,
  flipX: boolean,
  flipY: boolean,
): [number, number] {
  let px = (flipX ? -mx : mx) / scale
  let py = (flipY ? -my : my) / scale
  const x = useOffset ? px + ox : px
  const y = useOffset ? py + oy : py
  return [x, y]
}

function segmentEndpointsM(
  s: PlanSegment,
  ox: number,
  oy: number,
  scale: number,
  offset: boolean,
  flipX: boolean,
  flipY: boolean,
): [[number, number], [number, number]] {
  const a = transformPoint(s.x0, s.y0, ox, oy, scale, offset, flipX, flipY)
  const b = transformPoint(s.x1, s.y1, ox, oy, scale, offset, flipX, flipY)
  return [a, b]
}

function unitDir(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { vx: number; vy: number; len: number } | null {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) {
    return null
  }
  return { vx: dx / len, vy: dy / len, len }
}

function perp(vx: number, vy: number): [number, number] {
  return [-vy, vx]
}

function dot(ax: number, ay: number, bx: number, by: number): number {
  return ax * bx + ay * by
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx
}

function intervalOnAxis(
  px0: number,
  py0: number,
  px1: number,
  py1: number,
  vx: number,
  vy: number,
): [number, number] {
  const t0 = dot(px0, py0, vx, vy)
  const t1 = dot(px1, py1, vx, vy)
  return t0 <= t1 ? [t0, t1] : [t1, t0]
}

function overlapLen(a: [number, number], b: [number, number]): number {
  const lo = Math.max(a[0], b[0])
  const hi = Math.min(a[1], b[1])
  return Math.max(0, hi - lo)
}

type MetersSeg = {
  p0: [number, number]
  p1: [number, number]
  v: { vx: number; vy: number }
  n: [number, number]
  /** n·p = c 的 c */
  c: number
  t: [number, number]
}

function toMetersSeg(
  s: PlanSegment,
  ox: number,
  oy: number,
  scale: number,
  offset: boolean,
  flipX: boolean,
  flipY: boolean,
): MetersSeg | null {
  const [p0, p1] = segmentEndpointsM(s, ox, oy, scale, offset, flipX, flipY)
  const u = unitDir(p0[0], p0[1], p1[0], p1[1])
  if (!u) {
    return null
  }
  const [nx, ny] = perp(u.vx, u.vy)
  const c = dot(p0[0], p0[1], nx, ny)
  const t = intervalOnAxis(p0[0], p0[1], p1[0], p1[1], u.vx, u.vy)
  return {
    p0: [p0[0], p0[1]],
    p1: [p1[0], p1[1]],
    v: { vx: u.vx, vy: u.vy },
    n: [nx, ny],
    c,
    t,
  }
}

function parallelEnough(
  v1: { vx: number; vy: number },
  v2: { vx: number; vy: number },
  sinEps: number,
): boolean {
  const s = Math.abs(cross(v1.vx, v1.vy, v2.vx, v2.vy))
  return s <= sinEps
}

function mergeablePair(
  a: MetersSeg,
  b: MetersSeg,
  minSpacingM: number,
  maxSpacingM: number,
  minOverlapM: number,
  sinEps: number,
  /** 0 = 不限制；否则两段在米制下的长度须满足 min/max ≥ 该值，避免长墙与短隔墙被并成一组 */
  minLengthRatio: number,
): boolean {
  if (!parallelEnough(a.v, b.v, sinEps)) {
    return false
  }
  const nx = a.n[0]
  const ny = a.n[1]
  const ca = dot(a.p0[0], a.p0[1], nx, ny)
  const cb = dot(b.p0[0], b.p0[1], nx, ny)
  const dist = Math.abs(ca - cb)
  if (dist < minSpacingM || dist > maxSpacingM) {
    return false
  }
  const vx = a.v.vx
  const vy = a.v.vy
  const ta = a.t
  const tb = intervalOnAxis(b.p0[0], b.p0[1], b.p1[0], b.p1[1], vx, vy)
  const ov = overlapLen(ta, tb)
  if (ov < minOverlapM) {
    return false
  }
  if (minLengthRatio > 0) {
    const lenA = ta[1] - ta[0]
    const lenB = tb[1] - tb[0]
    const maxL = Math.max(lenA, lenB)
    if (maxL < 1e-9) {
      return false
    }
    if (Math.min(lenA, lenB) / maxL < minLengthRatio) {
      return false
    }
  }
  return true
}

class UnionFind {
  private p: number[]
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i)
  }
  find(i: number): number {
    let r = i
    while (this.p[r] !== r) {
      r = this.p[r]
    }
    let x = i
    while (this.p[x] !== r) {
      const nxt = this.p[x]
      this.p[x] = r
      x = nxt
    }
    return r
  }
  union(i: number, j: number): void {
    const ri = this.find(i)
    const rj = this.find(j)
    if (ri !== rj) {
      this.p[ri] = rj
    }
  }
}

function groupKey(levelIndex: number, layer: string): string {
  return `${levelIndex}\0${canonicalDxfLayerName(layer)}`
}

export type MergeDoubleWallResult = {
  merged: MergedWallSegment[]
  /** 参与合并的原始线段条数（每条只计一次，且仅计并入 size>1 组的） */
  sourceSegmentsMerged: number
  /** 合并后减少的墙段数量（原条数 − 输出条数，在同一批内） */
  wallsReduced: number
}

/**
 * 按楼层 + 规范图层名分组，在组内将「双线」合并为单段中心线。
 * `fromInsert` 的线段不参与合并（柱块展开后的四边）。
 */
export function mergeDoubleWallLineSegments(
  tagged: TaggedWallSegment[],
  opts: {
    ox: number
    oy: number
    scale: number
    offset: boolean
    flipX: boolean
    flipY: boolean
    defaultThicknessM: number
    minDoubleSpacingM: number
    maxDoubleSpacingM: number
    minOverlapM: number
    /** 0 = 不检查长度；否则两段长度比须 ≥ 此值才允许 union（默认由 dxf-to-scene 传入） */
    minLengthRatio: number
  },
): MergeDoubleWallResult {
  const sinEps = Math.sin(0.004) // ~0.23°

  const mergeable: TaggedWallSegment[] = []
  const insertPassthrough: TaggedWallSegment[] = []
  for (const t of tagged) {
    if (t.seg.fromInsert) {
      insertPassthrough.push(t)
    } else {
      mergeable.push(t)
    }
  }

  const groups = new Map<string, TaggedWallSegment[]>()
  for (const t of mergeable) {
    const k = groupKey(t.levelIndex, t.seg.layer)
    const list = groups.get(k) ?? []
    list.push(t)
    groups.set(k, list)
  }

  const out: MergedWallSegment[] = []
  let sourceSegmentsMerged = 0
  let wallsReduced = 0

  for (const [, list] of groups) {
    if (list.length < 2) {
      for (const t of list) {
        out.push({ ...t, thicknessM: opts.defaultThicknessM, fromDoubleLineMerge: false })
      }
      continue
    }

    const n = list.length
    const ms: (MetersSeg | null)[] = list.map((t) =>
      toMetersSeg(t.seg, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY),
    )
    const uf = new UnionFind(n)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ai = ms[i]
        const bj = ms[j]
        if (!ai || !bj) {
          continue
        }
        if (
          mergeablePair(
            ai,
            bj,
            opts.minDoubleSpacingM,
            opts.maxDoubleSpacingM,
            opts.minOverlapM,
            sinEps,
            opts.minLengthRatio,
          )
        ) {
          uf.union(i, j)
        }
      }
    }

    const comp = new Map<number, number[]>()
    for (let i = 0; i < n; i++) {
      const r = uf.find(i)
      const arr = comp.get(r) ?? []
      arr.push(i)
      comp.set(r, arr)
    }

    for (const [, idxs] of comp) {
      if (idxs.length === 1) {
        const i = idxs[0]!
        out.push({ ...list[i]!, thicknessM: opts.defaultThicknessM, fromDoubleLineMerge: false })
        continue
      }

      const ref = ms[idxs[0]!]
      if (!ref) {
        for (const i of idxs) {
          out.push({ ...list[i]!, thicknessM: opts.defaultThicknessM, fromDoubleLineMerge: false })
        }
        continue
      }

      const nx = ref.n[0]
      const ny = ref.n[1]
      const vx = ref.v.vx
      const vy = ref.v.vy

      let cMin = Number.POSITIVE_INFINITY
      let cMax = Number.NEGATIVE_INFINITY
      let tMin = Number.POSITIVE_INFINITY
      let tMax = Number.NEGATIVE_INFINITY

      for (const i of idxs) {
        const m = ms[i]
        if (!m) {
          continue
        }
        const ci = dot(m.p0[0], m.p0[1], nx, ny)
        cMin = Math.min(cMin, ci)
        cMax = Math.max(cMax, ci)
        const ti = intervalOnAxis(m.p0[0], m.p0[1], m.p1[0], m.p1[1], vx, vy)
        tMin = Math.min(tMin, ti[0])
        tMax = Math.max(tMax, ti[1])
      }

      const cMid = (cMin + cMax) / 2
      const rawT = cMax - cMin
      const thicknessM = rawT > 1e-6 ? rawT : opts.defaultThicknessM

      const mx0 = nx * cMid + vx * tMin
      const my0 = ny * cMid + vy * tMin
      const mx1 = nx * cMid + vx * tMax
      const my1 = ny * cMid + vy * tMax

      const [x0, y0] = inverseTransformPoint(
        mx0,
        my0,
        opts.ox,
        opts.oy,
        opts.scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )
      const [x1, y1] = inverseTransformPoint(
        mx1,
        my1,
        opts.ox,
        opts.oy,
        opts.scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )

      const first = list[idxs[0]!]!
      const mergedSeg: PlanSegment = {
        x0,
        y0,
        x1,
        y1,
        layer: first.seg.layer,
      }

      sourceSegmentsMerged += idxs.length
      wallsReduced += idxs.length - 1

      out.push({
        seg: mergedSeg,
        levelIndex: first.levelIndex,
        mapping: first.mapping,
        thicknessM,
        fromDoubleLineMerge: true,
      })
    }
  }

  for (const t of insertPassthrough) {
    out.push({ ...t, thicknessM: opts.defaultThicknessM, fromDoubleLineMerge: false })
  }

  return { merged: out, sourceSegmentsMerged, wallsReduced }
}

/** 水平/竖直墙段与轴线夹角小于此值时视为与轴平行（弧度） */
const COLINEAR_AXIS_ALIGN_RAD = (2.5 * Math.PI) / 180
/** 两段共线墙在轴向上的端点间隙 ≤ 此值（米）时合并（双线合并后门洞两侧常留 ~0.4–0.7m 缝；过大则会把整层同标高墙串成一条） */
const COLINEAR_GAP_MERGE_MAX_M = 0.75
/** 两段墙平行于同一轴线时，法向偏移 ≤ 此值（米）才视为同一立面 */
const COLINEAR_GAP_MERGE_PERP_TOL_M = 0.06

/**
 * 双线合并后，同一楼层上「共线且端点之间有小间隙」的墙段再合并为一条中心线，
 * 使门窗 INSERT 能沿整段立面得到正确的 localX，避免都挤在短碎片上被挤出墙外或重叠。
 */
export function mergeColinearGapWallPieces(
  pieces: MergedWallSegment[],
  opts: {
    ox: number
    oy: number
    scale: number
    offset: boolean
    flipX: boolean
    flipY: boolean
  },
): { merged: MergedWallSegment[]; piecesReduced: number } {
  const isHorizontal = (s: PlanSegment): boolean | null => {
    const [sx, sy] = transformPoint(s.x0, s.y0, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    const [ex, ey] = transformPoint(s.x1, s.y1, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    const dx = ex - sx
    const dy = ey - sy
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) {
      return null
    }
    return Math.abs(dy) / len <= Math.sin(COLINEAR_AXIS_ALIGN_RAD)
  }

  const isVertical = (s: PlanSegment): boolean | null => {
    const [sx, sy] = transformPoint(s.x0, s.y0, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    const [ex, ey] = transformPoint(s.x1, s.y1, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    const dx = ex - sx
    const dy = ey - sy
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) {
      return null
    }
    return Math.abs(dx) / len <= Math.sin(COLINEAR_AXIS_ALIGN_RAD)
  }

  type Horiz = { w: MergedWallSegment; lo: number; hi: number; yMid: number }
  type Vert = { w: MergedWallSegment; lo: number; hi: number; xMid: number }

  const horiz: Horiz[] = []
  const vert: Vert[] = []
  const rest: MergedWallSegment[] = []

  for (const w of pieces) {
    if (w.mapping.target.kind === 'wall' && w.mapping.target.variant === 'column_outline') {
      rest.push(w)
      continue
    }
    const [sx, sy] = transformPoint(w.seg.x0, w.seg.y0, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    const [ex, ey] = transformPoint(w.seg.x1, w.seg.y1, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    const dx = ex - sx
    const dy = ey - sy
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) {
      rest.push(w)
      continue
    }
    const h = isHorizontal(w.seg)
    const v = isVertical(w.seg)
    if (h === true) {
      horiz.push({
        w,
        lo: Math.min(sx, ex),
        hi: Math.max(sx, ex),
        yMid: (sy + ey) / 2,
      })
    } else if (v === true) {
      vert.push({
        w,
        lo: Math.min(sy, ey),
        hi: Math.max(sy, ey),
        xMid: (sx + ex) / 2,
      })
    } else {
      rest.push(w)
    }
  }

  const sameLayer = (a: MergedWallSegment, b: MergedWallSegment): boolean =>
    canonicalDxfLayerName(a.seg.layer) === canonicalDxfLayerName(b.seg.layer)

  const mergeHorizPair = (a: Horiz, b: Horiz): Horiz => {
    const lo = Math.min(a.lo, b.lo)
    const hi = Math.max(a.hi, b.hi)
    const yMid = (a.yMid + b.yMid) / 2
    const [x0, y0] = inverseTransformPoint(lo, yMid, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    const [x1, y1] = inverseTransformPoint(hi, yMid, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    const seg: PlanSegment = { x0, y0, x1, y1, layer: a.w.seg.layer }
    const merged: MergedWallSegment = {
      seg,
      levelIndex: a.w.levelIndex,
      mapping: a.w.mapping,
      thicknessM: Math.max(a.w.thicknessM, b.w.thicknessM),
      fromDoubleLineMerge: a.w.fromDoubleLineMerge || b.w.fromDoubleLineMerge,
    }
    return { w: merged, lo, hi, yMid }
  }

  const mergeVertPair = (a: Vert, b: Vert): Vert => {
    const lo = Math.min(a.lo, b.lo)
    const hi = Math.max(a.hi, b.hi)
    const xMid = (a.xMid + b.xMid) / 2
    const [x0, y0] = inverseTransformPoint(xMid, lo, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    const [x1, y1] = inverseTransformPoint(xMid, hi, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    const seg: PlanSegment = { x0, y0, x1, y1, layer: a.w.seg.layer }
    const merged: MergedWallSegment = {
      seg,
      levelIndex: a.w.levelIndex,
      mapping: a.w.mapping,
      thicknessM: Math.max(a.w.thicknessM, b.w.thicknessM),
      fromDoubleLineMerge: a.w.fromDoubleLineMerge || b.w.fromDoubleLineMerge,
    }
    return { w: merged, lo, hi, xMid }
  }

  const canMergeHoriz = (a: Horiz, b: Horiz): boolean => {
    if (a.w.levelIndex !== b.w.levelIndex || !sameLayer(a.w, b.w)) {
      return false
    }
    if (Math.abs(a.yMid - b.yMid) > COLINEAR_GAP_MERGE_PERP_TOL_M) {
      return false
    }
    const gap = Math.max(0, Math.max(a.lo, b.lo) - Math.min(a.hi, b.hi))
    const overlap = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo)
    if (overlap > 1e-9) {
      return true
    }
    return gap <= COLINEAR_GAP_MERGE_MAX_M + 1e-9
  }

  const canMergeVert = (a: Vert, b: Vert): boolean => {
    if (a.w.levelIndex !== b.w.levelIndex || !sameLayer(a.w, b.w)) {
      return false
    }
    if (Math.abs(a.xMid - b.xMid) > COLINEAR_GAP_MERGE_PERP_TOL_M) {
      return false
    }
    const gap = Math.max(0, Math.max(a.lo, b.lo) - Math.min(a.hi, b.hi))
    const overlap = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo)
    if (overlap > 1e-9) {
      return true
    }
    return gap <= COLINEAR_GAP_MERGE_MAX_M + 1e-9
  }

  let piecesReduced = 0

  /** 仅同标高、同图层的水平段才能链式合并；全局按 x 排序会被其它楼层的水平段打断 */
  const yBucket = (y: number) => Math.round(y / 0.01) * 0.01
  const horizGroups = new Map<string, Horiz[]>()
  for (const h of horiz) {
    const key = `${h.w.levelIndex}::${canonicalDxfLayerName(h.w.seg.layer)}::${yBucket(h.yMid)}`
    const list = horizGroups.get(key) ?? []
    list.push(h)
    horizGroups.set(key, list)
  }
  const mergedHoriz: Horiz[] = []
  for (const group of horizGroups.values()) {
    group.sort((a, b) => a.lo - b.lo)
    let i = 0
    while (i < group.length) {
      let cur = group[i]!
      let j = i + 1
      while (j < group.length) {
        const next = group[j]!
        if (canMergeHoriz(cur, next)) {
          piecesReduced += 1
          cur = mergeHorizPair(cur, next)
          j++
        } else {
          break
        }
      }
      mergedHoriz.push(cur)
      i = j
    }
  }

  const xBucket = (x: number) => Math.round(x / 0.01) * 0.01
  const vertGroups = new Map<string, Vert[]>()
  for (const v of vert) {
    const key = `${v.w.levelIndex}::${canonicalDxfLayerName(v.w.seg.layer)}::${xBucket(v.xMid)}`
    const list = vertGroups.get(key) ?? []
    list.push(v)
    vertGroups.set(key, list)
  }
  const mergedVert: Vert[] = []
  for (const group of vertGroups.values()) {
    group.sort((a, b) => a.lo - b.lo)
    let i = 0
    while (i < group.length) {
      let cur = group[i]!
      let j = i + 1
      while (j < group.length) {
        const next = group[j]!
        if (canMergeVert(cur, next)) {
          piecesReduced += 1
          cur = mergeVertPair(cur, next)
          j++
        } else {
          break
        }
      }
      mergedVert.push(cur)
      i = j
    }
  }

  const merged: MergedWallSegment[] = [
    ...rest,
    ...mergedHoriz.map((h) => h.w),
    ...mergedVert.map((v) => v.w),
  ]
  return { merged, piecesReduced }
}

/** 双线合并 + 共线缝合并后，墙角处常剩极短肢（≈0.2–0.35m）与长立面近乎垂直，3D 上为重复体块 */
const REDUNDANT_STUB_MAX_LEN_M = 0.4
const REDUNDANT_STUB_LONG_MIN_LEN_M = 2.0
/** 短肢与长墙方向点积 |cos| 小于此视为近乎垂直 */
const REDUNDANT_STUB_PERP_DOT_MAX = 0.38
/** 短肢端点到长墙有限段的最近距离上限（米） */
const REDUNDANT_STUB_TO_LONG_MAX_M = 0.18

function distPointToFiniteSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-18) {
    return Math.hypot(px - ax, py - ay)
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  const qx = ax + t * dx
  const qy = ay + t * dy
  return Math.hypot(px - qx, py - qy)
}

/**
 * 删除贴靠在一条同图层长墙中心线上的极短墙角肢（合并立面后多为重复网格）。
 */
export function removeRedundantCornerStubs(
  pieces: MergedWallSegment[],
  opts: {
    ox: number
    oy: number
    scale: number
    offset: boolean
    flipX: boolean
    flipY: boolean
  },
): { merged: MergedWallSegment[]; stubsRemoved: number } {
  type Sc = {
    sx: number
    sy: number
    ex: number
    ey: number
    len: number
    ux: number
    uy: number
  }

  const items: { w: MergedWallSegment; sc: Sc }[] = pieces.map((w) => {
    const [sx, sy] = transformPoint(w.seg.x0, w.seg.y0, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    const [ex, ey] = transformPoint(w.seg.x1, w.seg.y1, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    const dx = ex - sx
    const dy = ey - sy
    const len = Math.hypot(dx, dy)
    const ux = len > 1e-12 ? dx / len : 1
    const uy = len > 1e-12 ? dy / len : 0
    return { w, sc: { sx, sy, ex, ey, len, ux, uy } }
  })

  const longIdx: number[] = []
  for (let i = 0; i < items.length; i++) {
    const { w, sc } = items[i]!
    if (w.mapping.target.kind === 'wall' && w.mapping.target.variant === 'column_outline') {
      continue
    }
    if (sc.len >= REDUNDANT_STUB_LONG_MIN_LEN_M) {
      longIdx.push(i)
    }
  }

  const remove = new Set<number>()
  for (let i = 0; i < items.length; i++) {
    if (remove.has(i)) {
      continue
    }
    const { w, sc } = items[i]!
    if (w.mapping.target.kind === 'wall' && w.mapping.target.variant === 'column_outline') {
      continue
    }
    if (sc.len > REDUNDANT_STUB_MAX_LEN_M) {
      continue
    }

    for (const j of longIdx) {
      if (i === j || remove.has(j)) {
        continue
      }
      const long = items[j]!
      if (long.w.levelIndex !== w.levelIndex) {
        continue
      }
      if (canonicalDxfLayerName(long.w.seg.layer) !== canonicalDxfLayerName(w.seg.layer)) {
        continue
      }

      /** sc.ux/uy 已为切向单位向量；与长墙近乎垂直时 |cos| 小 */
      const cosAlign = Math.abs(sc.ux * long.sc.ux + sc.uy * long.sc.uy)
      if (cosAlign > REDUNDANT_STUB_PERP_DOT_MAX) {
        continue
      }

      const d0 = distPointToFiniteSegment(sc.sx, sc.sy, long.sc.sx, long.sc.sy, long.sc.ex, long.sc.ey)
      const d1 = distPointToFiniteSegment(sc.ex, sc.ey, long.sc.sx, long.sc.sy, long.sc.ex, long.sc.ey)
      if (Math.min(d0, d1) <= REDUNDANT_STUB_TO_LONG_MAX_M) {
        remove.add(i)
        break
      }
    }
  }

  const merged = items.filter((_, i) => !remove.has(i)).map((x) => x.w)
  return { merged, stubsRemoved: remove.size }
}
