/**
 * DXF INSERT（天正等柱块）→ 单根平面墙段：中心线为对边中点连线，厚度为垂直于中心线的边长（米），
 * 与块局部 ±0.5 单位、组码 41/42 比例一致，截面为矩形；sx≈sy 时为方柱。
 *
 * 纯 LINE/LWPOLYLINE 画出的轴对齐矩形柱（四条边）→ 合并为一条中心线 + columnThicknessM。
 */

import { canonicalDxfLayerName } from './dxf-layer-mapping.ts'
import type { MergedWallSegment } from './merge-double-wall-lines.ts'
import type { PlanInsert, PlanSegment } from './parse-dxf-entities.ts'

export type ColumnSquareWallFromInsert = {
  seg: PlanSegment
  /** 米：墙厚方向 = 块局部 y（组码 42 sy）尺度 × unitToMeters */
  thicknessM: number
}

/**
 * 块局部：底边沿 +x，长度为 sx；墙厚对应局部 y 方向尺寸 sy。
 * 中心线取局部 x 轴上 (-sx/2,0) → (sx/2,0)，再经转角、平移到插入点。
 */
export function columnInsertToSquareWallSegment(
  ins: PlanInsert,
  unitToMeters: number,
): ColumnSquareWallFromInsert {
  const { bx, by, sx, sy, rotationDeg, layer } = ins
  const ax = Math.abs(sx)
  const ay = Math.abs(sy)
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || ax < 1e-8 || ay < 1e-8) {
    const halfDu = 0.15 / unitToMeters
    return {
      seg: {
        x0: bx - halfDu,
        y0: by,
        x1: bx + halfDu,
        y1: by,
        layer,
        fromInsert: true,
      },
      thicknessM: 0.3,
    }
  }

  const hw = sx * 0.5
  const rad = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const rot = (lx: number, ly: number): [number, number] => {
    const rx = lx * cos - ly * sin
    const ry = lx * sin + ly * cos
    return [bx + rx, by + ry]
  }
  const [x0, y0] = rot(-hw, 0)
  const [x1, y1] = rot(hw, 0)

  return {
    seg: {
      x0,
      y0,
      x1,
      y1,
      layer,
      fromInsert: true,
    },
    thicknessM: ay * unitToMeters,
  }
}

// --- 四条边 → 单根墙（轴对齐矩形，米制平面） --------------------------------

const RECT_ENDPOINT_TOL_M = 0.03
const AXIS_ALIGN_RATIO = 0.02

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
  const px = (flipX ? -mx : mx) / scale
  const py = (flipY ? -my : my) / scale
  const x = useOffset ? px + ox : px
  const y = useOffset ? py + oy : py
  return [x, y]
}

function approxEq(a: number, b: number, tol = RECT_ENDPOINT_TOL_M): boolean {
  return Math.abs(a - b) <= tol
}

type AxisSegM = {
  idx: number
  w: MergedWallSegment
  sx: number
  sy: number
  ex: number
  ey: number
  len: number
}

function toAxisSegM(
  w: MergedWallSegment,
  idx: number,
  ox: number,
  oy: number,
  scale: number,
  offset: boolean,
  flipX: boolean,
  flipY: boolean,
): AxisSegM | null {
  const s = w.seg
  const [sx, sy] = transformPoint(s.x0, s.y0, ox, oy, scale, offset, flipX, flipY)
  const [ex, ey] = transformPoint(s.x1, s.y1, ox, oy, scale, offset, flipX, flipY)
  const dx = ex - sx
  const dy = ey - sy
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) {
    return null
  }
  if (Math.abs(dy) / len > AXIS_ALIGN_RATIO && Math.abs(dx) / len > AXIS_ALIGN_RATIO) {
    return null
  }
  return { idx, w, sx, sy, ex, ey, len }
}

function loHi(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a]
}

export type ColumnRectMergeOpts = {
  ox: number
  oy: number
  scale: number
  offset: boolean
  flipX: boolean
  flipY: boolean
  defaultThicknessM: number
}

function columnGroupKey(w: MergedWallSegment): string {
  return `${w.levelIndex}\0${canonicalDxfLayerName(w.seg.layer)}`
}

function sameColumnGroup(a: MergedWallSegment, b: MergedWallSegment): boolean {
  return columnGroupKey(a) === columnGroupKey(b)
}

type HorizM = { idx: number; w: MergedWallSegment; lo: number; hi: number; y: number }
type VertM = { idx: number; w: MergedWallSegment; xc: number; yLo: number; yHi: number }

function mergeOneColumnRectangle(
  input: MergedWallSegment[],
  opts: ColumnRectMergeOpts,
): MergedWallSegment[] | null {
  const candidates: { idx: number; w: MergedWallSegment }[] = []
  for (let i = 0; i < input.length; i++) {
    const w = input[i]!
    if (w.mapping.target.kind !== 'wall' || w.mapping.target.variant !== 'column_outline') {
      continue
    }
    if (w.seg.columnThicknessM !== undefined) {
      continue
    }
    candidates.push({ idx: i, w })
  }
  if (candidates.length < 4) {
    return null
  }

  const groupKeys = new Set<string>()
  for (const { w } of candidates) {
    groupKeys.add(columnGroupKey(w))
  }

  for (const gk of groupKeys) {
    const horiz: HorizM[] = []
    const vert: VertM[] = []

    for (const { idx, w } of candidates) {
      if (columnGroupKey(w) !== gk) {
        continue
      }
      const m = toAxisSegM(w, idx, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
      if (!m) {
        continue
      }
      const dx = m.ex - m.sx
      const dy = m.ey - m.sy
      const len = m.len
      if (Math.abs(dy) / len <= AXIS_ALIGN_RATIO) {
        const [lo, hi] = loHi(m.sx, m.ex)
        const y = (m.sy + m.ey) / 2
        horiz.push({ idx, w, lo, hi, y })
      } else if (Math.abs(dx) / len <= AXIS_ALIGN_RATIO) {
        const xc = (m.sx + m.ex) / 2
        const [yLo, yHi] = loHi(m.sy, m.ey)
        vert.push({ idx, w, xc, yLo, yHi })
      }
    }

    const bySpan = new Map<string, HorizM[]>()
    for (const h of horiz) {
      const key = `${Math.round(h.lo * 1000)},${Math.round(h.hi * 1000)}`
      const list = bySpan.get(key) ?? []
      list.push(h)
      bySpan.set(key, list)
    }

    for (const hs of bySpan.values()) {
      if (hs.length < 2) {
        continue
      }
      for (let a = 0; a < hs.length; a++) {
        for (let b = a + 1; b < hs.length; b++) {
          const ha = hs[a]!
          const hb = hs[b]!
          if (!sameColumnGroup(ha.w, hb.w)) {
            continue
          }
          if (!approxEq(ha.lo, hb.lo) || !approxEq(ha.hi, hb.hi)) {
            continue
          }
          const y1 = Math.min(ha.y, hb.y)
          const y2 = Math.max(ha.y, hb.y)
          if (approxEq(y1, y2)) {
            continue
          }
          const lo = (ha.lo + hb.lo) / 2
          const hi = (ha.hi + hb.hi) / 2

          const vL = vert.find(
            (v) =>
              sameColumnGroup(v.w, ha.w) &&
              approxEq(v.xc, lo) &&
              approxEq(v.yLo, y1) &&
              approxEq(v.yHi, y2),
          )
          const vR = vert.find(
            (v) =>
              sameColumnGroup(v.w, ha.w) &&
              approxEq(v.xc, hi) &&
              approxEq(v.yLo, y1) &&
              approxEq(v.yHi, y2),
          )
          if (!vL || !vR || vL.idx === vR.idx) {
            continue
          }
          const four = [ha.idx, hb.idx, vL.idx, vR.idx]
          if (new Set(four).size !== 4) {
            continue
          }

          const W = hi - lo
          const H = y2 - y1
          let mx0: number
          let my0: number
          let mx1: number
          let my1: number
          let thicknessM: number
          if (W >= H) {
            const midY = (y1 + y2) / 2
            mx0 = lo
            my0 = midY
            mx1 = hi
            my1 = midY
            thicknessM = H
          } else {
            const midX = (lo + hi) / 2
            mx0 = midX
            my0 = y1
            mx1 = midX
            my1 = y2
            thicknessM = W
          }

          const layer = ha.w.seg.layer
          const levelIndex = ha.w.levelIndex
          const mapping = ha.w.mapping
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
          const [x1, yEnd] = inverseTransformPoint(
            mx1,
            my1,
            opts.ox,
            opts.oy,
            opts.scale,
            opts.offset,
            opts.flipX,
            opts.flipY,
          )

          const mergedSeg: PlanSegment = {
            x0,
            y0,
            x1,
            y1: yEnd,
            layer,
            columnThicknessM: thicknessM,
          }

          const out: MergedWallSegment[] = []
          const remove = new Set(four)
          for (let i = 0; i < input.length; i++) {
            if (remove.has(i)) {
              continue
            }
            out.push(input[i]!)
          }
          out.push({
            seg: mergedSeg,
            levelIndex,
            mapping,
            thicknessM: opts.defaultThicknessM,
            fromDoubleLineMerge: false,
          })
          return out
        }
      }
    }
  }

  return null
}

/**
 * 将 `column_outline` 图层上、未带 INSERT 厚度的轴对齐闭合四边形（四条边）合并为一条墙段，
 * 并写入 `columnThicknessM`（米），与 INSERT 单根柱后续厚度逻辑一致。
 */
export function mergeColumnOutlineAxisAlignedRectangles(
  pieces: MergedWallSegment[],
  opts: ColumnRectMergeOpts,
): { merged: MergedWallSegment[]; rectanglesMerged: number } {
  let current = pieces
  let rectanglesMerged = 0
  for (let guard = 0; guard < 4096; guard++) {
    const next = mergeOneColumnRectangle(current, opts)
    if (!next) {
      break
    }
    current = next
    rectanglesMerged += 1
  }
  return { merged: current, rectanglesMerged }
}
