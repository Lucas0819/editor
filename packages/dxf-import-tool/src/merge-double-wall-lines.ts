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
