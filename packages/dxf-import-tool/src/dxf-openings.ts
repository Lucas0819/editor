/**
 * DXF INSERT（天正/通用门窗块）→ 墙上 window/door 子节点；无法落墙时生成同向短墙（统一管线）。
 */

import type { DxfFloorPlan, DxfLayerMapping, ParsedDxfLayerMappingFile } from './dxf-layer-mapping.ts'
import {
  inverseTransformDxfPointForLevel,
  resolveLayerMapping,
  resolveLevelIndexForDxfRawPoint,
  transformDxfPointForLevel,
} from './dxf-layer-mapping.ts'
import type { PlanInsert } from './parse-dxf-entities.ts'

export type OpeningKind = 'window' | 'door'

/** 从 DXF 门 INSERT 推断的开门方向（与 `DoorNode` 的 hingesSide / swingDirection / handleSide 一致） */
export type DoorSwingFromDxf = {
  hingesSide: 'left' | 'right'
  swingDirection: 'inward' | 'outward'
  handleSide: 'left' | 'right'
}

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

/** 与 `dxf-to-scene` 平面变换一致；`floorPlan` 存在时按层减掉 DXF 轴锚点。 */
export type OpeningTransformOpts = {
  ox: number
  oy: number
  scale: number
  offset: boolean
  flipX: boolean
  flipY: boolean
  floorPlan?: DxfFloorPlan | null
  /** 与 `computePerLevelSplitAxisAnchorFromGeometry` 一致，多楼层平面轴对齐 */
  perLevelAnchor?: Map<number, number> | null
}

function tpScene(x: number, y: number, levelIndex: number, opts: OpeningTransformOpts): [number, number] {
  return transformDxfPointForLevel(
    x,
    y,
    levelIndex,
    opts.floorPlan ?? null,
    opts.ox,
    opts.oy,
    opts.scale,
    opts.offset,
    opts.flipX,
    opts.flipY,
    opts.perLevelAnchor ?? null,
  )
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

/**
 * 块局部轴在场景平面上的单位方向（与 DXF 一致：先块比例再转角，再平面 flip）。
 * +X = 门洞宽度常见方向；+Y = 天正等平面门块开扇弧所在侧（向「室内」摆动的一侧）。
 */
export function dxfInsertLocalAxesInScene(
  insert: PlanInsert,
  opts: Pick<OpeningTransformOpts, 'flipX' | 'flipY'>,
): { ux: number; uy: number; vx: number; vy: number } {
  const fx = opts.flipX ? -1 : 1
  const fy = opts.flipY ? -1 : 1
  const r = (insert.rotationDeg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return {
    ux: fx * c,
    uy: fy * s,
    vx: -fx * s,
    vy: fy * c,
  }
}

/**
 * 洞口宽度在平面上的方向（弧度），仅由块 sx/sy 与旋转决定（|sx|≥|sy| 则宽度沿块局部 +X）。
 * 与 `inferDoorSwingFromDxfInsert` 中相对墙切向选轴不同，此处**不**依赖墙几何，供窗挂接/合成墙朝向使用。
 */
export function openingWidthAxisAngleFromScaleOnly(
  ins: PlanInsert,
  opts: Pick<OpeningTransformOpts, 'flipX' | 'flipY'>,
): number {
  const { ux, uy, vx, vy } = dxfInsertLocalAxesInScene(ins, opts)
  const widthOnBlockX = Math.abs(ins.sx) >= Math.abs(ins.sy)
  let wx = widthOnBlockX ? ux : vx
  let wy = widthOnBlockX ? uy : vy
  const widthMirror = widthOnBlockX ? ins.sx < 0 : ins.sy < 0
  if (widthMirror) {
    wx = -wx
    wy = -wy
  }
  return Math.atan2(wy, wx)
}

/**
 * 从 ATTRIB 关键词补充或覆盖（若图纸写了「左开/右开」「内/外开」等）。
 */
function doorSwingHintsFromAttribs(ins: PlanInsert): Partial<DoorSwingFromDxf> {
  const chunks: string[] = []
  if (ins.attribs) {
    for (const [k, v] of Object.entries(ins.attribs)) {
      chunks.push(k, v)
    }
  }
  const s = chunks.join(' ')
  const out: Partial<DoorSwingFromDxf> = {}
  if (/右开|右扇|向\s*右|RIGHT\s*HINGE|HINGE\s*RIGHT/i.test(s)) {
    out.hingesSide = 'right'
  } else if (/左开|左扇|向\s*左|LEFT\s*HINGE|HINGE\s*LEFT/i.test(s)) {
    out.hingesSide = 'left'
  }
  if (/外开|向外|OUT\s*SWING|SWING\s*OUT/i.test(s)) {
    out.swingDirection = 'outward'
  } else if (/内开|向内|IN\s*SWING|SWING\s*IN/i.test(s)) {
    out.swingDirection = 'inward'
  }
  return out
}

/**
 * 根据门 INSERT 与墙段中心线（楼层平面 X–Z，与 `WallNode.start/end` 同坐标系）推断开门方向。
 * - 宽度轴：与墙切向更对齐的块局部轴（X 或 Y）；`sx`/`sy` 负镜像参与铰链侧。
 * - 摆动方向：块开扇深度向量与**墙切向的左法向**点积符号 → inward/outward。
 *   左法向 **(-ty, tx)** 与编辑器 `getOpeningFootprint` 的 `perp = (-dirZ, dirX)` 一致。
 *   若误用 **(sin θ, cos θ)=(ty, tx)**，在**竖直墙**（t≈(0,±1)）上与左法向相反，会出现内外开与平面图门弧相反。
 */
export function inferDoorSwingFromDxfInsert(
  ins: PlanInsert,
  wallSx: number,
  wallSy: number,
  wallEx: number,
  wallEy: number,
  opts: Pick<OpeningTransformOpts, 'flipX' | 'flipY'>,
): DoorSwingFromDxf {
  const hints = doorSwingHintsFromAttribs(ins)
  const tw = wallEx - wallSx
  const th = wallEy - wallSy
  const len = Math.hypot(tw, th)
  if (len < 1e-9) {
    const hingesSide = hints.hingesSide ?? 'left'
    const swingDirection = hints.swingDirection ?? 'inward'
    return {
      hingesSide,
      swingDirection,
      handleSide: hingesSide === 'left' ? 'right' : 'left',
    }
  }
  const tx = tw / len
  const ty = th / len
  const { ux, uy, vx, vy } = dxfInsertLocalAxesInScene(ins, opts)
  const dotW = ux * tx + uy * ty
  const dotV = vx * tx + vy * ty
  const widthOnBlockX = Math.abs(dotW) >= Math.abs(dotV)

  let wx = widthOnBlockX ? ux : vx
  let wy = widthOnBlockX ? uy : vy
  const widthMirror = widthOnBlockX ? ins.sx < 0 : ins.sy < 0
  if (widthMirror) {
    wx = -wx
    wy = -wy
  }
  const dotWidth = wx * tx + wy * ty
  let hingesSide: 'left' | 'right'
  if (hints.hingesSide !== undefined) {
    hingesSide = hints.hingesSide
  } else {
    hingesSide = dotWidth > 0 ? 'left' : 'right'
  }

  let ddx: number
  let ddy: number
  if (widthOnBlockX) {
    ddx = vx
    ddy = vy
    if (ins.sy < 0) {
      ddx = -ddx
      ddy = -ddy
    }
  } else {
    ddx = ux
    ddy = uy
    if (ins.sx < 0) {
      ddx = -ddx
      ddy = -ddy
    }
  }
  const nwx = -ty
  const nwy = tx
  const inwardDot = ddx * nwx + ddy * nwy
  let swingDirection: 'inward' | 'outward'
  if (hints.swingDirection !== undefined) {
    swingDirection = hints.swingDirection
  } else {
    swingDirection = inwardDot >= 0 ? 'inward' : 'outward'
  }

  const handleSide: 'left' | 'right' = hingesSide === 'left' ? 'right' : 'left'
  return { hingesSide, swingDirection, handleSide }
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
/**
 * 窗（WIN2D）：洞口宽度方向与墙段切向的余弦绝对值低于此值则不挂接到该墙（避免水平窗符号贴到竖向结构墙中心线）。
 * 约 0.5 表示夹角大于 ~60° 即不挂接；正交时≈0 → 走合成短墙（沿 {@link openingWidthAxisAngleFromScaleOnly}）。
 */
const WINDOW_ATTACH_MIN_ALIGN_COS = 0.5
/** 两个挂接门窗场景距离小于此值且落在互相垂直的墙段上时，合并到同一墙段（避免墙角双面各挂一扇、子节点相互垂直；同立面相邻窗常相距 ~0.6–1.2m） */
const CLUSTER_CORNER_ATTACH_M = 1.35
/** 两条平行短墙段上、平面距离小于此值的门窗合并到同一段（随后可拉长中心线包住洞口） */
const CLUSTER_PARALLEL_FACADE_ATTACH_M = 2.5

function windowWidthAlignedWithWallSegment(
  ins: PlanInsert,
  thetaSeg: number,
  opts: Pick<OpeningTransformOpts, 'flipX' | 'flipY'>,
): boolean {
  const widthRad = openingWidthAxisAngleFromScaleOnly(ins, opts)
  return Math.abs(Math.cos(widthRad - thetaSeg)) >= WINDOW_ATTACH_MIN_ALIGN_COS
}

/**
 * 将 INSERT 投影到指定墙段上，逻辑与 matchOpeningsToWalls 主循环一致：先段内投影 + 无限长墙线距离，否则有限线段距离。
 */
function attachProjectToWallInsert(
  ins: PlanInsert,
  wi: number,
  flatWallPieces: WallPieceForOpenings[],
  opts: OpeningTransformOpts,
): { tClamped: number; len: number } | null {
  const li = flatWallPieces[wi]!.levelIndex
  const [px, pz] = tpScene(ins.bx, ins.by, li, opts)
  const s = flatWallPieces[wi]!.seg
  const [sx, sy] = tpScene(s.x0, s.y0, li, opts)
  const [ex, ey] = tpScene(s.x1, s.y1, li, opts)
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
  opts: OpeningTransformOpts & { unitToMeters: number },
): void {
  const attachIdx = out
    .map((o, i) => (o.mode === 'attach' ? i : -1))
    .filter((i): i is number => i >= 0)

  const segmentTheta = (wi: number): number => {
    const s = flatWallPieces[wi]!.seg
    const li = flatWallPieces[wi]!.levelIndex
    const [sx, sy] = tpScene(s.x0, s.y0, li, opts)
    const [ex, ey] = tpScene(s.x1, s.y1, li, opts)
    return Math.atan2(ey - sy, ex - sx)
  }

  const perpendicularWalls = (wi: number, wj: number): boolean =>
    Math.abs(Math.cos(segmentTheta(wi) - segmentTheta(wj))) < 0.5

  const sumDistToWallLine = (px: number, pz: number, wi: number): number => {
    const s = flatWallPieces[wi]!.seg
    const li = flatWallPieces[wi]!.levelIndex
    const [sx, sy] = tpScene(s.x0, s.y0, li, opts)
    const [ex, ey] = tpScene(s.x1, s.y1, li, opts)
    return pointToLineDistance(px, pz, sx, sy, ex, ey)
  }

  const segmentLenScene = (wi: number): number => {
    const s = flatWallPieces[wi]!.seg
    const li = flatWallPieces[wi]!.levelIndex
    const [sx, sy] = tpScene(s.x0, s.y0, li, opts)
    const [ex, ey] = tpScene(s.x1, s.y1, li, opts)
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
      if (flatWallPieces[wa]!.levelIndex !== flatWallPieces[wb]!.levelIndex) {
        continue
      }
      if (!perpendicularWalls(wa, wb)) {
        continue
      }

      const lvl = flatWallPieces[wa]!.levelIndex
      const [pxa, pza] = tpScene(oa.insert.bx, oa.insert.by, lvl, opts)
      const [pxb, pzb] = tpScene(ob.insert.bx, ob.insert.by, lvl, opts)
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

      if (
        (oa.kind === 'window' && !windowWidthAlignedWithWallSegment(oa.insert, segmentTheta(chosen), opts)) ||
        (ob.kind === 'window' && !windowWidthAlignedWithWallSegment(ob.insert, segmentTheta(chosen), opts))
      ) {
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
  opts: OpeningTransformOpts & { unitToMeters: number },
): void {
  const attachIdx = out
    .map((o, i) => (o.mode === 'attach' ? i : -1))
    .filter((i): i is number => i >= 0)

  const segmentTheta = (wi: number): number => {
    const s = flatWallPieces[wi]!.seg
    const li = flatWallPieces[wi]!.levelIndex
    const [sx, sy] = tpScene(s.x0, s.y0, li, opts)
    const [ex, ey] = tpScene(s.x1, s.y1, li, opts)
    return Math.atan2(ey - sy, ex - sx)
  }

  const parallelWalls = (wi: number, wj: number): boolean =>
    Math.abs(Math.cos(segmentTheta(wi) - segmentTheta(wj))) > 0.85

  const segmentLenScene = (wi: number): number => {
    const s = flatWallPieces[wi]!.seg
    const li = flatWallPieces[wi]!.levelIndex
    const [sx, sy] = tpScene(s.x0, s.y0, li, opts)
    const [ex, ey] = tpScene(s.x1, s.y1, li, opts)
    return Math.hypot(ex - sx, ey - sy)
  }

  const localXFromInsertAlongWall = (
    ins: PlanInsert,
    wi: number,
    widthM: number,
  ): number => {
    const s = flatWallPieces[wi]!.seg
    const li = flatWallPieces[wi]!.levelIndex
    const [sx, sy] = tpScene(s.x0, s.y0, li, opts)
    const [ex, ey] = tpScene(s.x1, s.y1, li, opts)
    const [px, pz] = tpScene(ins.bx, ins.by, li, opts)
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
      if (flatWallPieces[wa]!.levelIndex !== flatWallPieces[wb]!.levelIndex) {
        continue
      }
      if (!parallelWalls(wa, wb)) {
        continue
      }

      const lvl = flatWallPieces[wa]!.levelIndex
      const [pxa, pza] = tpScene(oa.insert.bx, oa.insert.by, lvl, opts)
      const [pxb, pzb] = tpScene(ob.insert.bx, ob.insert.by, lvl, opts)
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
        const alignOk =
          (oa.kind !== 'window' || windowWidthAlignedWithWallSegment(oa.insert, segmentTheta(chosen), opts)) &&
          (ob.kind !== 'window' || windowWidthAlignedWithWallSegment(ob.insert, segmentTheta(chosen), opts))
        if (alignOk) {
          oa.wallIndex = chosen
          ob.wallIndex = chosen
          oa.localX = clampedLocalXOpening(projOa.len, widthA, projOa.tClamped)
          ob.localX = clampedLocalXOpening(projOb.len, widthB, projOb.tClamped)
        }
        continue
      }

      const alignShorter =
        (oa.kind !== 'window' || windowWidthAlignedWithWallSegment(oa.insert, segmentTheta(shorter), opts)) &&
        (ob.kind !== 'window' || windowWidthAlignedWithWallSegment(ob.insert, segmentTheta(shorter), opts))
      if (!alignShorter) {
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
    /** 若未传，使用 `layerMapping.floorPlan` */
    floorPlan?: DxfFloorPlan | null
    perLevelAnchor?: Map<number, number> | null
  },
): OpeningResolved[] {
  const candidates = filterOpeningInserts(inserts, opts.layerMapping)
  const out: OpeningResolved[] = []
  const fp = opts.floorPlan ?? opts.layerMapping?.floorPlan ?? null

  const baseOpts: OpeningTransformOpts = {
    ox: opts.ox,
    oy: opts.oy,
    scale: opts.scale,
    offset: opts.offset,
    flipX: opts.flipX,
    flipY: opts.flipY,
    floorPlan: fp,
    perLevelAnchor: opts.perLevelAnchor ?? null,
  }

  for (const ins of candidates) {
    const kind = classifyOpeningBlock(ins.blockName)
    if (!kind) {
      continue
    }
    const insLevel = resolveLevelIndexForDxfRawPoint(ins.bx, ins.by, fp)
    const widthM = openingWidthMetersFromInsert(ins.sx, ins.sy, opts.unitToMeters)
    const [px, pz] = tpScene(ins.bx, ins.by, insLevel, baseOpts)

    const rScene = dxfInsertSceneRotationRad(ins, baseOpts)
    /** 窗：挂接评分用洞口宽度轴与墙切向对齐；门：仍用块 +X 朝向 */
    const alignRadForScore = kind === 'window' ? openingWidthAxisAngleFromScaleOnly(ins, baseOpts) : rScene

    let bestInterior: { wi: number; distLine: number; tParam: number; len: number; score: number } | null = null
    for (let wi = 0; wi < flatWallPieces.length; wi++) {
      const wp = flatWallPieces[wi]!
      if (wp.levelIndex !== insLevel) {
        continue
      }
      const s = wp.seg
      const li = wp.levelIndex
      const [sx, sy] = tpScene(s.x0, s.y0, li, baseOpts)
      const [ex, ey] = tpScene(s.x1, s.y1, li, baseOpts)
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
      if (kind === 'window' && !windowWidthAlignedWithWallSegment(ins, thetaSeg, baseOpts)) {
        continue
      }
      const score = distLine + ATTACH_ANGLE_ALIGN_WEIGHT_M * openingAngleAlignPenalty(alignRadForScore, thetaSeg)
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
        const wp = flatWallPieces[wi]!
        if (wp.levelIndex !== insLevel) {
          continue
        }
        const s = wp.seg
        const li = wp.levelIndex
        const [sx, sy] = tpScene(s.x0, s.y0, li, baseOpts)
        const [ex, ey] = tpScene(s.x1, s.y1, li, baseOpts)
        const { dist, tClamped, len } = pointToFiniteSegment(px, pz, sx, sy, ex, ey)
        if (len < 1e-6) {
          continue
        }
        if (dist > TOL_FINITE_ATTACH) {
          continue
        }
        const thetaSeg = Math.atan2(ey - sy, ex - sx)
        if (kind === 'window' && !windowWidthAlignedWithWallSegment(ins, thetaSeg, baseOpts)) {
          continue
        }
        const score = dist + ATTACH_ANGLE_ALIGN_WEIGHT_M * openingAngleAlignPenalty(alignRadForScore, thetaSeg)
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

    /** 合成短墙：窗沿洞口宽度方向；门沿块 +X 朝向（与挂接评分一致） */
    const syntheticDirRad = kind === 'window' ? openingWidthAxisAngleFromScaleOnly(ins, baseOpts) : rScene
    const ux = Math.cos(syntheticDirRad)
    const uz = Math.sin(syntheticDirRad)

    for (let wi = 0; wi < flatWallPieces.length; wi++) {
      const wp = flatWallPieces[wi]!
      if (wp.levelIndex !== insLevel) {
        continue
      }
      const s = wp.seg
      const li = wp.levelIndex
      const [sx, sy] = tpScene(s.x0, s.y0, li, baseOpts)
      const [ex, ey] = tpScene(s.x1, s.y1, li, baseOpts)
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

    const ref = flatWallPieces.find((w) => w.levelIndex === insLevel) ?? flatWallPieces[0]
    out.push({
      mode: 'synthetic',
      kind,
      widthM,
      levelIndex: insLevel,
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
    ...baseOpts,
    unitToMeters: opts.unitToMeters,
  })

  fixParallelFacadeAttachClusters(out, flatWallPieces, {
    ...baseOpts,
    unitToMeters: opts.unitToMeters,
  })

  const attachOnly = out.filter((r): r is OpeningAttach => r.mode === 'attach')
  extendWallPiecesForAttachmentOpenings(flatWallPieces, attachOnly, baseOpts)

  return out
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
    const li = wp.levelIndex
    const [sx, sy] = tpScene(wp.seg.x0, wp.seg.y0, li, opts)
    const [ex, ey] = tpScene(wp.seg.x1, wp.seg.y1, li, opts)
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
      const [px, pz] = tpScene(ins.bx, ins.by, li, opts)
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
    const [x0, y0] = inverseTransformDxfPointForLevel(
      sxp,
      syp,
      li,
      opts.floorPlan ?? null,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
      opts.perLevelAnchor ?? null,
    )
    const [x1, y1] = inverseTransformDxfPointForLevel(
      exp,
      eyp,
      li,
      opts.floorPlan ?? null,
      opts.ox,
      opts.oy,
      opts.scale,
      opts.offset,
      opts.flipX,
      opts.flipY,
      opts.perLevelAnchor ?? null,
    )
    wp.seg.x0 = x0
    wp.seg.y0 = y0
    wp.seg.x1 = x1
    wp.seg.y1 = y1

    const newL = t1 - t0
    for (const op of ops) {
      const ins = op.insert
      const [px, pz] = tpScene(ins.bx, ins.by, li, opts)
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
