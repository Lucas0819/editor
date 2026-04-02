/**
 * DXF INSERT（天正/通用门窗块）→ 墙上 window/door 子节点；无法落墙时生成同向短墙（统一管线）。
 */

import type { DxfLayerMapping, ParsedDxfLayerMappingFile } from './dxf-layer-mapping.ts'
import { resolveLayerMapping } from './dxf-layer-mapping.ts'
import type { PlanInsert } from './parse-dxf-entities.ts'

export type OpeningKind = 'window' | 'door'

/** 与 example/墙体内有门和窗.json 一致的墙局部竖向（窗中心高度） */
export const DXF_IMPORT_WINDOW_CENTER_Y = 1.5
export const DXF_IMPORT_WINDOW_HEIGHT = 1.5
export const DXF_IMPORT_DOOR_HEIGHT = 2.1
export const DXF_IMPORT_DOOR_CENTER_Y = DXF_IMPORT_DOOR_HEIGHT / 2

export function canonicalBlockName(full: string): string {
  const t = full.trim()
  const i = t.lastIndexOf('$')
  return i >= 0 ? t.slice(i + 1) : t
}

/**
 * 根据块名判断门窗（天正 WIN2D、DorLib2D 等）。
 */
export function classifyOpeningBlock(blockName: string): OpeningKind | null {
  const c = canonicalBlockName(blockName).toUpperCase()
  const full = blockName.toUpperCase()
  if (/\bWIN2D\b|TCHSYS\$WIN|_TCHSYS\$WIN|WIN2D/i.test(full) || /\bWIN2D\b/i.test(c)) {
    return 'window'
  }
  if (/\bDORLIB\b|DOOR2D|DORLIB2D|\bDOR\b/i.test(full) || /DORLIB/i.test(c)) {
    return 'door'
  }
  return null
}

export function openingWidthMetersFromInsert(
  sx: number,
  sy: number,
  unitToMeters: number,
): number {
  const raw = Math.max(Math.abs(sx), Math.abs(sy))
  if (!Number.isFinite(raw) || raw < 1e-6) {
    return 0.9 * unitToMeters
  }
  return raw * unitToMeters
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

/** 到有限线段的欧氏距离 + 最近点参数 t∈[0,1]（用于「最近墙段」唯一归属） */
function pointToFiniteSegment(
  px: number,
  pz: number,
  sx: number,
  sz: number,
  ex: number,
  ez: number,
): { dist: number; tClamped: number; tParam: number; len: number } {
  const dx = ex - sx
  const dz = ez - sz
  const len2 = dx * dx + dz * dz
  if (len2 < 1e-18) {
    const d = Math.hypot(px - sx, pz - sz)
    return { dist: d, tClamped: 0, tParam: 0, len: 0 }
  }
  const len = Math.sqrt(len2)
  const tParam = ((px - sx) * dx + (pz - sz) * dz) / len2
  const tClamped = Math.max(0, Math.min(1, tParam))
  const qx = sx + tClamped * dx
  const qz = sz + tClamped * dz
  const dist = Math.hypot(px - qx, pz - qz)
  return { dist, tClamped, tParam, len }
}

/** 点到无限长直线的垂直距离（CAD 插入点常略偏墙线） */
function pointToLineDistance(
  px: number,
  pz: number,
  sx: number,
  sz: number,
  ex: number,
  ez: number,
): number {
  const dx = ex - sx
  const dz = ez - sz
  const len = Math.hypot(dx, dz)
  if (len < 1e-18) {
    return Math.hypot(px - sx, pz - sz)
  }
  const cross = Math.abs((px - sx) * dz - (pz - sz) * dx)
  return cross / len
}

/** INSERT 场景朝向与墙段切向（场景坐标）不一致时接近 1，一致或反向共线时接近 0 */
function openingAngleAlignPenalty(rScene: number, thetaSeg: number): number {
  return 1 - Math.abs(Math.cos(rScene - thetaSeg))
}

export type WallPieceForOpenings = {
  seg: { x0: number; y0: number; x1: number; y1: number; layer: string }
  levelIndex: number
  mapping: DxfLayerMapping
  thicknessM: number
  fromDoubleLineMerge: boolean
}

/** 落在已有墙段中心线上 → 子节点 */
export type OpeningAttach = {
  mode: 'attach'
  kind: OpeningKind
  widthM: number
  wallIndex: number
  localX: number
  insert: PlanInsert
}

/** 新建短墙 + 子节点（段外或近邻方向） */
export type OpeningSynthetic = {
  mode: 'synthetic'
  kind: OpeningKind
  widthM: number
  levelIndex: number
  thicknessM: number
  layer: string
  mapping: DxfLayerMapping
  fromDoubleLineMerge: boolean
  start: [number, number]
  end: [number, number]
  insert: PlanInsert
}

export type OpeningResolved = OpeningAttach | OpeningSynthetic

/** 与 `transformPoint` 一致：用于 INSERT 场景朝向（合成短墙中心线沿块宽方向）。 */
export type OpeningTransformOpts = {
  ox: number
  oy: number
  scale: number
  offset: boolean
  flipX: boolean
  flipY: boolean
}

/** INSERT 块 +X 在场景平面上的朝向（弧度），与墙 mesh 的 atan2(end-start) 同系。 */
export function dxfInsertSceneRotationRad(insert: PlanInsert, opts: OpeningTransformOpts): number {
  const rRad = (insert.rotationDeg * Math.PI) / 180
  const cosR = Math.cos(rRad)
  const sinR = Math.sin(rRad)
  const vx = (opts.flipX ? -1 : 1) * cosR
  const vy = (opts.flipY ? -1 : 1) * sinR
  return Math.atan2(vy, vx)
}

/** 投影落在段内时，到无限长墙线的垂直距离上限 */
const TOL_ON_LINE = 0.28
/** 第二相：到有限墙段的最近距离上限（略宽于 TOL_ON_LINE，避免符号与双线中心偏差漏挂） */
const TOL_FINITE_ATTACH = 0.55
/**
 * 挂接：score = 距离 + 权重×(1-|cos(Δθ)|)，在距离相近时优先与 INSERT 块朝向一致的墙段，
 * 避免双线合并墙角处竖段/横段各挂一扇窗、子节点相互垂直。
 */
const ATTACH_ANGLE_ALIGN_WEIGHT_M = 0.55
/**
 * 优先：插入点投影在段内 (tParam) 且到无限长墙线距离小 → 同轴多段里唯一一段「拥有」该投影。
 * 否则：用有限线段最近距离选段（避免所有共线段 distLine 相同而总命中 wi=0）。
 */
const T_SEGMENT_LO = -0.02
const T_SEGMENT_HI = 1.02
/** 合成短墙：到最近墙段（有限线段）的距离上限 */
const TOL_NEAREST_SEGMENT = 0.55
/** 两个挂接门窗场景距离小于此值且落在互相垂直的墙段上时，合并到同一墙段（避免墙角双面各挂一扇、子节点相互垂直；同立面相邻窗常相距 ~0.6–1.2m） */
const CLUSTER_CORNER_ATTACH_M = 1.35
/** 两条平行短墙段上、平面距离小于此值的门窗合并到同一段（随后可拉长中心线包住洞口） */
const CLUSTER_PARALLEL_FACADE_ATTACH_M = 2.5

/**
 * 将 INSERT 投影到指定墙段上，逻辑与 matchOpeningsToWalls 主循环一致：先段内投影 + 无限长墙线距离，否则有限线段距离。
 */
function attachProjectToWallInsert(
  ins: PlanInsert,
  wi: number,
  flatWallPieces: WallPieceForOpenings[],
  opts: {
    ox: number
    oy: number
    scale: number
    offset: boolean
    flipX: boolean
    flipY: boolean
  },
): { tClamped: number; len: number } | null {
  const [px, pz] = transformPoint(
    ins.bx,
    ins.by,
    opts.ox,
    opts.oy,
    opts.scale,
    opts.offset,
    opts.flipX,
    opts.flipY,
  )
  const s = flatWallPieces[wi]!.seg
  const [sx, sy] = transformPoint(
    s.x0,
    s.y0,
    opts.ox,
    opts.oy,
    opts.scale,
    opts.offset,
    opts.flipX,
    opts.flipY,
  )
  const [ex, ey] = transformPoint(
    s.x1,
    s.y1,
    opts.ox,
    opts.oy,
    opts.scale,
    opts.offset,
    opts.flipX,
    opts.flipY,
  )
  const { tParam, len } = pointToFiniteSegment(px, pz, sx, sy, ex, ey)
  if (len < 1e-6) {
    return null
  }
  if (tParam >= T_SEGMENT_LO && tParam <= T_SEGMENT_HI) {
    const distLine = pointToLineDistance(px, pz, sx, sy, ex, ey)
    if (distLine <= TOL_ON_LINE) {
      const tClamped = Math.max(0, Math.min(1, tParam))
      return { tClamped, len }
    }
  }
  const { dist, tClamped, len: len2 } = pointToFiniteSegment(px, pz, sx, sy, ex, ey)
  if (len2 < 1e-6) {
    return null
  }
  if (dist > TOL_FINITE_ATTACH) {
    return null
  }
  return { tClamped, len: len2 }
}

function clampedLocalXOpening(len: number, widthM: number, tClamped: number): number {
  const localX = tClamped * len
  return len < widthM + 1e-9 ? len / 2 : Math.max(widthM / 2, Math.min(len - widthM / 2, localX))
}

/**
 * 双线合并墙角：两扇门窗很近却挂在互相垂直的短墙段上时，合并到同一墙段。
 * 优先较厚墙段（主墙面中心线）；厚度相同时优先较长中心线（主立面），再尝试较短；
 * 若仍相等则用「到墙线距离和」决胜负。仅当两插入点都能按挂接规则投影到同一墙段上时才合并。
 */
function fixCornerAttachClusters(
  out: OpeningResolved[],
  flatWallPieces: WallPieceForOpenings[],
  opts: {
    ox: number
    oy: number
    scale: number
    offset: boolean
    flipX: boolean
    flipY: boolean
    unitToMeters: number
  },
): void {
  const attachIdx = out
    .map((o, i) => (o.mode === 'attach' ? i : -1))
    .filter((i): i is number => i >= 0)

  const segmentTheta = (wi: number): number => {
    const s = flatWallPieces[wi]!.seg
    const [sx, sy] = transformPoint(
      s.x0,
      s.y0,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    const [ex, ey] = transformPoint(
      s.x1,
      s.y1,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    return Math.atan2(ey - sy, ex - sx)
  }

  const perpendicularWalls = (wi: number, wj: number): boolean =>
    Math.abs(Math.cos(segmentTheta(wi) - segmentTheta(wj))) < 0.5

  const sumDistToWallLine = (px: number, pz: number, wi: number): number => {
    const s = flatWallPieces[wi]!.seg
    const [sx, sy] = transformPoint(
      s.x0,
      s.y0,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    const [ex, ey] = transformPoint(
      s.x1,
      s.y1,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    return pointToLineDistance(px, pz, sx, sy, ex, ey)
  }

  const segmentLenScene = (wi: number): number => {
    const s = flatWallPieces[wi]!.seg
    const [sx, sy] = transformPoint(
      s.x0,
      s.y0,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    const [ex, ey] = transformPoint(
      s.x1,
      s.y1,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    return Math.hypot(ex - sx, ey - sy)
  }

  for (let a = 0; a < attachIdx.length; a++) {
    for (let b = a + 1; b < attachIdx.length; b++) {
      const ia = attachIdx[a]!
      const ib = attachIdx[b]!
      const oa = out[ia] as OpeningAttach
      const ob = out[ib] as OpeningAttach
      if (oa.wallIndex === ob.wallIndex) {
        continue
      }
      const wa = oa.wallIndex
      const wb = ob.wallIndex
      if (!perpendicularWalls(wa, wb)) {
        continue
      }

      const [pxa, pza] = transformPoint(
        oa.insert.bx,
        oa.insert.by,
        opts.ox,
        opts.oy,
        opts.scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )
      const [pxb, pzb] = transformPoint(
        ob.insert.bx,
        ob.insert.by,
        opts.ox,
        opts.oy,
        opts.scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )
      if (Math.hypot(pxa - pxb, pza - pzb) > CLUSTER_CORNER_ATTACH_M) {
        continue
      }

      const ta = flatWallPieces[wa]!.thicknessM
      const tb = flatWallPieces[wb]!.thicknessM
      const lenA = segmentLenScene(wa)
      const lenB = segmentLenScene(wb)
      const sumAOnWa =
        sumDistToWallLine(pxa, pza, wa) + sumDistToWallLine(pxb, pzb, wa)
      const sumBOnWb =
        sumDistToWallLine(pxa, pza, wb) + sumDistToWallLine(pxb, pzb, wb)

      const candidates: number[] = []
      const pushUnique = (wi: number) => {
        if (!candidates.includes(wi)) {
          candidates.push(wi)
        }
      }

      if (Math.abs(ta - tb) > 1e-4) {
        pushUnique(ta >= tb ? wa : wb)
        pushUnique(ta >= tb ? wb : wa)
      } else if (Math.abs(lenA - lenB) > 1e-4) {
        /** 较长段常为主立面；较短段为墙角短肢。先试较长，使两窗都能投影到同一段上（短肢上常无法同时容纳两插入点） */
        pushUnique(lenA >= lenB ? wa : wb)
        pushUnique(lenA >= lenB ? wb : wa)
      } else {
        pushUnique(sumAOnWa <= sumBOnWb + 1e-9 ? wa : wb)
        pushUnique(sumAOnWa <= sumBOnWb + 1e-9 ? wb : wa)
      }

      let chosen: number | null = null
      let projOa: { tClamped: number; len: number } | null = null
      let projOb: { tClamped: number; len: number } | null = null
      for (const wi of candidates) {
        const pa = attachProjectToWallInsert(oa.insert, wi, flatWallPieces, opts)
        const pb = attachProjectToWallInsert(ob.insert, wi, flatWallPieces, opts)
        if (pa && pb) {
          chosen = wi
          projOa = pa
          projOb = pb
          break
        }
      }
      if (chosen === null || !projOa || !projOb) {
        continue
      }

      const widthA = openingWidthMetersFromInsert(oa.insert.sx, oa.insert.sy, opts.unitToMeters)
      const widthB = openingWidthMetersFromInsert(ob.insert.sx, ob.insert.sy, opts.unitToMeters)

      oa.wallIndex = chosen
      ob.wallIndex = chosen
      oa.localX = clampedLocalXOpening(projOa.len, widthA, projOa.tClamped)
      ob.localX = clampedLocalXOpening(projOb.len, widthB, projOb.tClamped)
    }
  }
}

/**
 * 同一水平立面上、挂在两条平行短墙段上的相邻门窗合并到同一段（优先较短主立面段，再试较长段）。
 * 若双线投影仍失败，则按 INSERT 在墙无限长线上的标量位置算 localX（后续 extendWallPiecesForAttachmentOpenings 会拉长段）。
 */
function fixParallelFacadeAttachClusters(
  out: OpeningResolved[],
  flatWallPieces: WallPieceForOpenings[],
  opts: {
    ox: number
    oy: number
    scale: number
    offset: boolean
    flipX: boolean
    flipY: boolean
    unitToMeters: number
  },
): void {
  const attachIdx = out
    .map((o, i) => (o.mode === 'attach' ? i : -1))
    .filter((i): i is number => i >= 0)

  const segmentTheta = (wi: number): number => {
    const s = flatWallPieces[wi]!.seg
    const [sx, sy] = transformPoint(
      s.x0,
      s.y0,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    const [ex, ey] = transformPoint(
      s.x1,
      s.y1,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    return Math.atan2(ey - sy, ex - sx)
  }

  const parallelWalls = (wi: number, wj: number): boolean =>
    Math.abs(Math.cos(segmentTheta(wi) - segmentTheta(wj))) > 0.85

  const segmentLenScene = (wi: number): number => {
    const s = flatWallPieces[wi]!.seg
    const [sx, sy] = transformPoint(
      s.x0,
      s.y0,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    const [ex, ey] = transformPoint(
      s.x1,
      s.y1,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    return Math.hypot(ex - sx, ey - sy)
  }

  const localXFromInsertAlongWall = (
    ins: PlanInsert,
    wi: number,
    widthM: number,
  ): number => {
    const s = flatWallPieces[wi]!.seg
    const [sx, sy] = transformPoint(
      s.x0,
      s.y0,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    const [ex, ey] = transformPoint(
      s.x1,
      s.y1,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    const [px, pz] = transformPoint(
      ins.bx,
      ins.by,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    const dx = ex - sx
    const dy = ey - sy
    const L = Math.hypot(dx, dy)
    if (L < 1e-9) {
      return widthM / 2
    }
    const t = ((px - sx) * dx + (pz - sy) * dy) / (L * L)
    const tClamped = Math.max(0, Math.min(1, t))
    return clampedLocalXOpening(L, widthM, tClamped)
  }

  for (let a = 0; a < attachIdx.length; a++) {
    for (let b = a + 1; b < attachIdx.length; b++) {
      const ia = attachIdx[a]!
      const ib = attachIdx[b]!
      const oa = out[ia] as OpeningAttach
      const ob = out[ib] as OpeningAttach
      if (oa.wallIndex === ob.wallIndex) {
        continue
      }
      const wa = oa.wallIndex
      const wb = ob.wallIndex
      if (!parallelWalls(wa, wb)) {
        continue
      }

      const [pxa, pza] = transformPoint(
        oa.insert.bx,
        oa.insert.by,
        opts.ox,
        opts.oy,
        opts.scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )
      const [pxb, pzb] = transformPoint(
        ob.insert.bx,
        ob.insert.by,
        opts.ox,
        opts.oy,
        opts.scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )
      if (Math.hypot(pxa - pxb, pza - pzb) > CLUSTER_PARALLEL_FACADE_ATTACH_M) {
        continue
      }
      if (Math.abs(pza - pzb) > 0.08) {
        continue
      }

      const lenA = segmentLenScene(wa)
      const lenB = segmentLenScene(wb)
      const shorter = lenA <= lenB ? wa : wb
      const longer = lenA <= lenB ? wb : wa

      const widthA = openingWidthMetersFromInsert(oa.insert.sx, oa.insert.sy, opts.unitToMeters)
      const widthB = openingWidthMetersFromInsert(ob.insert.sx, ob.insert.sy, opts.unitToMeters)

      let chosen: number | null = null
      let projOa: { tClamped: number; len: number } | null = null
      let projOb: { tClamped: number; len: number } | null = null
      for (const wi of [shorter, longer]) {
        const pa = attachProjectToWallInsert(oa.insert, wi, flatWallPieces, opts)
        const pb = attachProjectToWallInsert(ob.insert, wi, flatWallPieces, opts)
        if (pa && pb) {
          chosen = wi
          projOa = pa
          projOb = pb
          break
        }
      }

      if (chosen !== null && projOa && projOb) {
        oa.wallIndex = chosen
        ob.wallIndex = chosen
        oa.localX = clampedLocalXOpening(projOa.len, widthA, projOa.tClamped)
        ob.localX = clampedLocalXOpening(projOb.len, widthB, projOb.tClamped)
        continue
      }

      chosen = shorter
      oa.wallIndex = chosen
      ob.wallIndex = chosen
      oa.localX = localXFromInsertAlongWall(oa.insert, chosen, widthA)
      ob.localX = localXFromInsertAlongWall(ob.insert, chosen, widthB)
    }
  }
}

function filterOpeningInserts(
  inserts: PlanInsert[],
  layerMapping: ParsedDxfLayerMappingFile | null,
): PlanInsert[] {
  const out: PlanInsert[] = []
  for (const ins of inserts) {
    const map = resolveLayerMapping(ins.layer, layerMapping?.map ?? null)
    if (map.target.kind === 'wall' && map.target.variant === 'column_outline') {
      continue
    }
    if (!ins.blockName.trim()) {
      continue
    }
    if (classifyOpeningBlock(ins.blockName) === null) {
      continue
    }
    out.push(ins)
  }
  return out
}

export function matchOpeningsToWalls(
  inserts: PlanInsert[],
  flatWallPieces: WallPieceForOpenings[],
  opts: {
    ox: number
    oy: number
    scale: number
    offset: boolean
    flipX: boolean
    flipY: boolean
    layerMapping: ParsedDxfLayerMappingFile | null
    unitToMeters: number
    defaultWallThicknessM: number
  },
): OpeningResolved[] {
  const candidates = filterOpeningInserts(inserts, opts.layerMapping)
  const out: OpeningResolved[] = []

  for (const ins of candidates) {
    const kind = classifyOpeningBlock(ins.blockName)
    if (!kind) {
      continue
    }
    const widthM = openingWidthMetersFromInsert(ins.sx, ins.sy, opts.unitToMeters)
    const [px, pz] = transformPoint(
      ins.bx,
      ins.by,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )

    const rotOpts: OpeningTransformOpts = {
      ox: opts.ox,
      oy: opts.oy,
      scale: opts.scale,
      offset: opts.offset,
      flipX: opts.flipX,
      flipY: opts.flipY,
    }
    const rScene = dxfInsertSceneRotationRad(ins, rotOpts)

    let bestInterior: { wi: number; distLine: number; tParam: number; len: number; score: number } | null = null
    for (let wi = 0; wi < flatWallPieces.length; wi++) {
      const s = flatWallPieces[wi]!.seg
      const [sx, sy] = transformPoint(
        s.x0,
        s.y0,
        opts.ox,
        opts.oy,
        opts.scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )
      const [ex, ey] = transformPoint(
        s.x1,
        s.y1,
        opts.ox,
        opts.oy,
        opts.scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )
      const { tParam, len } = pointToFiniteSegment(px, pz, sx, sy, ex, ey)
      if (len < 1e-6) {
        continue
      }
      if (tParam < T_SEGMENT_LO || tParam > T_SEGMENT_HI) {
        continue
      }
      const distLine = pointToLineDistance(px, pz, sx, sy, ex, ey)
      if (distLine > TOL_ON_LINE) {
        continue
      }
      const thetaSeg = Math.atan2(ey - sy, ex - sx)
      const score = distLine + ATTACH_ANGLE_ALIGN_WEIGHT_M * openingAngleAlignPenalty(rScene, thetaSeg)
      const better =
        !bestInterior ||
        score < bestInterior.score - 1e-9 ||
        (Math.abs(score - bestInterior.score) < 1e-9 && wi < bestInterior.wi)
      if (better) {
        bestInterior = { wi, distLine, tParam, len, score }
      }
    }

    let bestOn: { wi: number; tClamped: number; len: number } | null = null
    if (bestInterior && bestInterior.len > 1e-6) {
      bestOn = {
        wi: bestInterior.wi,
        tClamped: Math.max(0, Math.min(1, bestInterior.tParam)),
        len: bestInterior.len,
      }
    } else {
      let bestNear: { wi: number; dist: number; tClamped: number; len: number; score: number } | null = null
      for (let wi = 0; wi < flatWallPieces.length; wi++) {
        const s = flatWallPieces[wi]!.seg
        const [sx, sy] = transformPoint(
          s.x0,
          s.y0,
          opts.ox,
          opts.oy,
          opts.scale,
          opts.offset,
          opts.flipX,
          opts.flipY,
        )
        const [ex, ey] = transformPoint(
          s.x1,
          s.y1,
          opts.ox,
          opts.oy,
          opts.scale,
          opts.offset,
          opts.flipX,
          opts.flipY,
        )
        const { dist, tClamped, len } = pointToFiniteSegment(px, pz, sx, sy, ex, ey)
        if (len < 1e-6) {
          continue
        }
        if (dist > TOL_FINITE_ATTACH) {
          continue
        }
        const thetaSeg = Math.atan2(ey - sy, ex - sx)
        const score = dist + ATTACH_ANGLE_ALIGN_WEIGHT_M * openingAngleAlignPenalty(rScene, thetaSeg)
        const better =
          !bestNear ||
          score < bestNear.score - 1e-9 ||
          (Math.abs(score - bestNear.score) < 1e-9 && wi < bestNear.wi)
        if (better) {
          bestNear = { wi, dist, tClamped, len, score }
        }
      }
      if (bestNear && bestNear.len > 1e-6) {
        bestOn = { wi: bestNear.wi, tClamped: bestNear.tClamped, len: bestNear.len }
      }
    }

    if (bestOn && bestOn.len > 1e-6) {
      const len = bestOn.len
      const localX = bestOn.tClamped * len
      /** 段短于洞口宽度时，中心落在段中点，避免 clamp 无解 */
      const clampedX =
        len < widthM + 1e-9 ? len / 2 : Math.max(widthM / 2, Math.min(len - widthM / 2, localX))
      out.push({
        mode: 'attach',
        kind,
        widthM,
        wallIndex: bestOn.wi,
        localX: clampedX,
        insert: ins,
      })
      continue
    }

    let bestLine: {
      wi: number
      dist: number
      sx: number
      sy: number
      ex: number
      ey: number
      len: number
    } | null = null

    /** 合成短墙中心线与天正块宽（INSERT 组码 50 + flip）一致；门窗为子节点，不再单独写 rotation */
    const ux = Math.cos(rScene)
    const uz = Math.sin(rScene)

    for (let wi = 0; wi < flatWallPieces.length; wi++) {
      const s = flatWallPieces[wi]!.seg
      const [sx, sy] = transformPoint(
        s.x0,
        s.y0,
        opts.ox,
        opts.oy,
        opts.scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )
      const [ex, ey] = transformPoint(
        s.x1,
        s.y1,
        opts.ox,
        opts.oy,
        opts.scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )
      const { dist, len } = pointToFiniteSegment(px, pz, sx, sy, ex, ey)
      if (len < 1e-6) {
        continue
      }
      if (!Number.isFinite(dist)) {
        continue
      }
      if (!bestLine || dist < bestLine.dist - 1e-9 || (Math.abs(dist - bestLine.dist) < 1e-9 && wi < bestLine.wi)) {
        bestLine = { wi, dist, sx, sy, ex, ey, len }
      }
    }

    const half = widthM / 2
    const start: [number, number] = [px - ux * half, pz - uz * half]
    const end: [number, number] = [px + ux * half, pz + uz * half]

    if (bestLine && bestLine.len > 1e-6 && bestLine.dist < TOL_NEAREST_SEGMENT) {
      const wp = flatWallPieces[bestLine.wi]!
      out.push({
        mode: 'synthetic',
        kind,
        widthM,
        levelIndex: wp.levelIndex,
        thicknessM: wp.thicknessM,
        layer: wp.seg.layer,
        mapping: wp.mapping,
        fromDoubleLineMerge: wp.fromDoubleLineMerge,
        start,
        end,
        insert: ins,
      })
      continue
    }

    const ref = flatWallPieces[0]
    out.push({
      mode: 'synthetic',
      kind,
      widthM,
      levelIndex: 0,
      thicknessM: opts.defaultWallThicknessM,
      layer: ref?.seg.layer ?? '0',
      mapping: ref?.mapping ?? resolveLayerMapping('A-WALL', opts.layerMapping?.map ?? null),
      fromDoubleLineMerge: false,
      start,
      end,
      insert: ins,
    })
  }

  fixCornerAttachClusters(out, flatWallPieces, {
    ox: opts.ox,
    oy: opts.oy,
    scale: opts.scale,
    offset: opts.offset,
    flipX: opts.flipX,
    flipY: opts.flipY,
    unitToMeters: opts.unitToMeters,
  })

  fixParallelFacadeAttachClusters(out, flatWallPieces, {
    ox: opts.ox,
    oy: opts.oy,
    scale: opts.scale,
    offset: opts.offset,
    flipX: opts.flipX,
    flipY: opts.flipY,
    unitToMeters: opts.unitToMeters,
  })

  const attachOnly = out.filter((r): r is OpeningAttach => r.mode === 'attach')
  extendWallPiecesForAttachmentOpenings(flatWallPieces, attachOnly, {
    ox: opts.ox,
    oy: opts.oy,
    scale: opts.scale,
    offset: opts.offset,
    flipX: opts.flipX,
    flipY: opts.flipY,
  })

  return out
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

/**
 * 将墙段中心线沿切向拉长，使所有挂接门窗的 INSERT 中心投影落在段内（CAD 双线合并后中心线常比洞口略短）。
 */
export function extendWallPiecesForAttachmentOpenings(
  flatWallPieces: WallPieceForOpenings[],
  attach: OpeningAttach[],
  opts: OpeningTransformOpts,
): void {
  const byWall = new Map<number, OpeningAttach[]>()
  for (const o of attach) {
    const list = byWall.get(o.wallIndex) ?? []
    list.push(o)
    byWall.set(o.wallIndex, list)
  }

  for (const [wi, ops] of byWall) {
    const wp = flatWallPieces[wi]
    if (!wp || ops.length === 0) {
      continue
    }
    const [sx, sy] = transformPoint(
      wp.seg.x0,
      wp.seg.y0,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    const [ex, ey] = transformPoint(
      wp.seg.x1,
      wp.seg.y1,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
    )
    const dx = ex - sx
    const dy = ey - sy
    const L = Math.hypot(dx, dy)
    if (L < 1e-9) {
      continue
    }
    const ux = dx / L
    const uy = dy / L

    let minOpen = Number.POSITIVE_INFINITY
    let maxOpen = Number.NEGATIVE_INFINITY
    for (const op of ops) {
      const ins = op.insert
      const [px, pz] = transformPoint(
        ins.bx,
        ins.by,
        opts.ox,
        opts.oy,
        opts.scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )
      const t = (px - sx) * ux + (pz - sy) * uy
      const half = op.widthM / 2
      minOpen = Math.min(minOpen, t - half)
      maxOpen = Math.max(maxOpen, t + half)
    }

    const t0 = Math.min(0, minOpen)
    const t1 = Math.max(L, maxOpen)
    if (Math.abs(t0) < 1e-7 && Math.abs(t1 - L) < 1e-7) {
      continue
    }

    const sxp = sx + t0 * ux
    const syp = sy + t0 * uy
    const exp = sx + t1 * ux
    const eyp = sy + t1 * uy
    const [x0, y0] = inverseTransformPoint(sxp, syp, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    const [x1, y1] = inverseTransformPoint(exp, eyp, opts.ox, opts.oy, opts.scale, opts.offset, opts.flipX, opts.flipY)
    wp.seg.x0 = x0
    wp.seg.y0 = y0
    wp.seg.x1 = x1
    wp.seg.y1 = y1

    const newL = t1 - t0
    for (const op of ops) {
      const ins = op.insert
      const [px, pz] = transformPoint(
        ins.bx,
        ins.by,
        opts.ox,
        opts.oy,
        opts.scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )
      const tAlong = (px - sxp) * ux + (pz - syp) * uy
      const tNorm = newL > 1e-12 ? tAlong / newL : 0.5
      op.localX = clampedLocalXOpening(newL, op.widthM, Math.max(0, Math.min(1, tNorm)))
    }
  }
}

export function groupAttachByWallIndex(attach: OpeningAttach[]): Map<number, OpeningAttach[]> {
  const m = new Map<number, OpeningAttach[]>()
  for (const o of attach) {
    const list = m.get(o.wallIndex) ?? []
    list.push(o)
    m.set(o.wallIndex, list)
  }
  for (const [, list] of m) {
    list.sort((a, b) => a.localX - b.localX)
  }
  return m
}
