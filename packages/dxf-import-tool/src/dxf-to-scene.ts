#!/usr/bin/env bun
/**
 * DXF (LINE + LWPOLYLINE) → Pascal SceneGraph JSON for @pascal-app/editor.
 *
 * Usage:
 *   bun run src/dxf-to-scene.ts --input ../../沈本大街.dxf --out ../../scene-from-dxf.json --max-walls 4000
 *
 * Load in editor: copy the JSON to apps/editor/public/demos/ (e.g. demos/from-dxf.json), then in devtools:
 *   const g = await fetch('/demos/from-dxf.json').then((r) => r.json())
 *   localStorage.setItem('pascal-editor-scene', JSON.stringify(g))
 *   location.reload()
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { snapPlanSegmentsToAxis } from './axis-snap.ts'
import {
  columnInsertToSquareWallSegment,
  mergeColumnOutlineAxisAlignedRectangles,
} from './dxf-column-inserts.ts'
import {
  insUnitsToMetersFactor,
  type PlanInsert,
  type PlanSegment,
  parseDxfPlanSegments,
} from './parse-dxf-entities.ts'
import {
  computePerLevelSplitAxisAnchorFromGeometry,
  parseDxfLayerMappingFileJson,
  resolveLayerMapping,
  resolveLevelIndexForDxfRawSegment,
  transformDxfPointForLevel,
  type DxfFloorPlan,
  type DxfLayerMapping,
  type ParsedDxfLayerMappingFile,
} from './dxf-layer-mapping.ts'
import {
  canonicalBlockName,
  DXF_IMPORT_DOOR_CENTER_Y,
  DXF_IMPORT_DOOR_HEIGHT,
  DXF_IMPORT_WINDOW_CENTER_Y,
  DXF_IMPORT_WINDOW_HEIGHT,
  groupAttachByWallIndex,
  matchOpeningsToWalls,
  type OpeningAttach,
  type OpeningSynthetic,
} from './dxf-openings.ts'
import {
  baseDxfMetadata,
  displayNameForNode,
  DXF_IMPORT_DOOR_DEFAULTS,
  DXF_IMPORT_WINDOW_DEFAULTS,
} from './dxf-scene-nodes.ts'
import {
  mergeColinearGapWallPiecesIterative,
  mergeDoubleWallLineSegments,
  removeRedundantCornerStubs,
} from './merge-double-wall-lines.ts'

type SceneGraph = {
  nodes: Record<string, unknown>
  rootNodeIds: string[]
}

function nid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

function parseArgs(argv: string[]) {
  let input = ''
  let out = 'scene-from-dxf.json'
  let maxWalls = 8000
  let minLenM = 0.02
  let wallHeight = 3
  let wallThickness = 0.15
  let offset = true
  let scaleOverride: number | null = null
  /** 0 = disabled. Set explicitly to cap segment length (meters), e.g. to filter site bounds. */
  let maxSegmentLengthM = 0
  /**
   * In meter space, if |Δy| (or |Δx|) is below this, snap segment to horizontal (or vertical).
   * Reduces wall/render glitches from tiny DXF float drift on axis-aligned edges. 0 = off.
   */
  let axisSnapToleranceM = 1e-4
  /** Negate plan X after scale (Pascal world X). Default true — matches typical CAD vs viewer orientation. */
  let flipX = true
  /** Negate plan Y after scale (Pascal world Z). Default false. */
  let flipY = false
  /** Optional JSON: per-layer `target` + `confidence` overrides (see `parseDxfLayerMappingFileJson`). */
  let mappingFile = ''
  /** 将同层平行双线合并为中心线，厚度取两线间距（CAD 墙厚表达） */
  let mergeDoubleWallLines = false
  let doubleWallMinSpacingM = 0.02
  /** 略放宽以容纳窗洞四条线、厚墙双线的外沿间距 */
  let doubleWallMaxSpacingM = 0.72
  let doubleWallMinOverlapM = 0.04
  /** 双线合并：两段长度比下限；0=不限制。略放宽使门洞旁短线与长墙仍可能成对合并 */
  let doubleWallMinLengthRatio = 0.5
  /** 横平竖直共线缝合并：轴向间隙上限（米），门洞处无双线时常需跨过 ~1–2m */
  let colinearGapMergeMaxM = 2.0
  /** 法向容差（米）；与同立面条带分桶一致，窗洞多线合并后的中心线漂移 */
  let colinearGapMergePerpTolM = 0.1
  /** 分组桶宽（米），见 merge-double-wall-lines 默认值 */
  let colinearGapMergeBucketM = 0.01
  /** 共线缝合并最大轮数（每轮内链式合并，多轮可继续并） */
  let colinearGapMergeMaxPasses = 20
  /** 横平竖直判定半角（度），略大则更多微斜段参与水平/竖直合并 */
  let colinearGapMergeAxisAlignDeg = 2.5
  /** 斜向段按同一无限长直线做区间合并（与横平竖直逻辑并行） */
  let colinearGapMergeGeneralDirection = false
  /** 墙角短肢删除：短肢最大长度（米） */
  let redundantStubMaxLenM = 0.4
  /** 长墙最短长度（米），短肢相对其判断 */
  let redundantStubLongMinLenM = 2.0

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--input' || a === '-i') {
      input = argv[++i] ?? ''
    } else if (a === '--out' || a === '-o') {
      out = argv[++i] ?? out
    } else if (a === '--max-walls') {
      maxWalls = Number.parseInt(argv[++i] ?? '', 10) || maxWalls
    } else if (a === '--min-length-m') {
      minLenM = Number.parseFloat(argv[++i] ?? '') || minLenM
    } else if (a === '--wall-height') {
      wallHeight = Number.parseFloat(argv[++i] ?? '') || wallHeight
    } else if (a === '--wall-thickness') {
      wallThickness = Number.parseFloat(argv[++i] ?? '') || wallThickness
    } else if (a === '--no-offset') {
      offset = false
    } else if (a === '--scale-to-meters') {
      scaleOverride = Number.parseFloat(argv[++i] ?? '') || null
    } else if (a === '--max-segment-length-m') {
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        maxSegmentLengthM = Number.parseFloat(argv[++i] ?? '0')
      }
      if (!Number.isFinite(maxSegmentLengthM) || maxSegmentLengthM < 0) {
        maxSegmentLengthM = 0
      }
    } else if (a === '--axis-snap-tolerance-m') {
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        axisSnapToleranceM = Number.parseFloat(argv[++i] ?? '0')
      }
      if (!Number.isFinite(axisSnapToleranceM) || axisSnapToleranceM < 0) {
        axisSnapToleranceM = 0
      }
    } else if (a === '--flip-x') {
      flipX = true
    } else if (a === '--no-flip-x') {
      flipX = false
    } else if (a === '--flip-y') {
      flipY = true
    } else if (a === '--no-flip-y') {
      flipY = false
    } else if (a === '--mapping-file' || a === '-m') {
      mappingFile = argv[++i] ?? ''
    } else if (a === '--merge-double-wall-lines') {
      mergeDoubleWallLines = true
    } else if (a === '--double-wall-min-spacing-m') {
      doubleWallMinSpacingM = Number.parseFloat(argv[++i] ?? '') || doubleWallMinSpacingM
    } else if (a === '--double-wall-max-spacing-m') {
      doubleWallMaxSpacingM = Number.parseFloat(argv[++i] ?? '') || doubleWallMaxSpacingM
    } else if (a === '--double-wall-min-overlap-m') {
      doubleWallMinOverlapM = Number.parseFloat(argv[++i] ?? '') || doubleWallMinOverlapM
    } else if (a === '--double-wall-min-length-ratio') {
      const v = Number.parseFloat(argv[++i] ?? '0')
      doubleWallMinLengthRatio = Number.isFinite(v) && v >= 0 && v <= 1 ? v : doubleWallMinLengthRatio
    } else if (a === '--colinear-gap-merge-max-m') {
      const v = Number.parseFloat(argv[++i] ?? '')
      if (Number.isFinite(v) && v > 0) {
        colinearGapMergeMaxM = v
      }
    } else if (a === '--colinear-gap-merge-perp-tol-m') {
      const v = Number.parseFloat(argv[++i] ?? '')
      if (Number.isFinite(v) && v > 0) {
        colinearGapMergePerpTolM = v
      }
    } else if (a === '--colinear-gap-merge-bucket-m') {
      const v = Number.parseFloat(argv[++i] ?? '')
      if (Number.isFinite(v) && v > 0) {
        colinearGapMergeBucketM = v
      }
    } else if (a === '--colinear-gap-merge-max-passes') {
      const v = Number.parseInt(argv[++i] ?? '', 10)
      if (Number.isFinite(v) && v >= 1 && v <= 50) {
        colinearGapMergeMaxPasses = v
      }
    } else if (a === '--colinear-gap-merge-axis-align-deg') {
      const v = Number.parseFloat(argv[++i] ?? '')
      if (Number.isFinite(v) && v > 0 && v <= 45) {
        colinearGapMergeAxisAlignDeg = v
      }
    } else if (a === '--colinear-gap-merge-general-direction') {
      colinearGapMergeGeneralDirection = true
    } else if (a === '--redundant-stub-max-len-m') {
      const v = Number.parseFloat(argv[++i] ?? '')
      if (Number.isFinite(v) && v > 0 && v <= 5) {
        redundantStubMaxLenM = v
      }
    } else if (a === '--redundant-stub-long-min-len-m') {
      const v = Number.parseFloat(argv[++i] ?? '')
      if (Number.isFinite(v) && v >= 0.5 && v <= 20) {
        redundantStubLongMinLenM = v
      }
    }
  }

  return {
    input,
    out,
    maxWalls,
    minLenM,
    wallHeight,
    wallThickness,
    offset,
    scaleOverride,
    maxSegmentLengthM,
    axisSnapToleranceM,
    flipX,
    flipY,
    mappingFile,
    mergeDoubleWallLines,
    doubleWallMinSpacingM,
    doubleWallMaxSpacingM,
    doubleWallMinOverlapM,
    doubleWallMinLengthRatio,
    colinearGapMergeMaxM,
    colinearGapMergePerpTolM,
    colinearGapMergeBucketM,
    colinearGapMergeMaxPasses,
    colinearGapMergeAxisAlignDeg,
    colinearGapMergeGeneralDirection,
    redundantStubMaxLenM,
    redundantStubLongMinLenM,
  }
}

function segmentLengthM(
  s: PlanSegment,
  ox: number,
  oy: number,
  scale: number,
  useOffset: boolean,
  flipX: boolean,
  flipY: boolean,
  floorPlan: DxfFloorPlan | null,
  levelIndex: number,
  perLevelAnchor: Map<number, number> | null,
): number {
  const [x0, y0] = transformDxfPointForLevel(
    s.x0,
    s.y0,
    levelIndex,
    floorPlan,
    ox,
    oy,
    scale,
    useOffset,
    flipX,
    flipY,
    perLevelAnchor,
  )
  const [x1, y1] = transformDxfPointForLevel(
    s.x1,
    s.y1,
    levelIndex,
    floorPlan,
    ox,
    oy,
    scale,
    useOffset,
    flipX,
    flipY,
    perLevelAnchor,
  )
  const dx = x1 - x0
  const dy = y1 - y0
  return Math.hypot(dx, dy)
}

/** 导出节点 `name` 后缀：全局自增，便于在编辑器中按序号定位（1 起） */
function createExportNameCounter(): { next: () => number } {
  let n = 0
  return {
    next: () => {
      n += 1
      return n
    },
  }
}

function bboxFromSegments(
  segments: PlanSegment[],
  ox: number,
  oy: number,
  scale: number,
  useOffset: boolean,
  flipX: boolean,
  flipY: boolean,
  floorPlan: DxfFloorPlan | null,
  perLevelAnchor: Map<number, number> | null,
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const s of segments) {
    const li = resolveLevelIndexForDxfRawSegment(s.x0, s.y0, s.x1, s.y1, floorPlan)
    for (const [x, y] of [
      transformDxfPointForLevel(s.x0, s.y0, li, floorPlan, ox, oy, scale, useOffset, flipX, flipY, perLevelAnchor),
      transformDxfPointForLevel(s.x1, s.y1, li, floorPlan, ox, oy, scale, useOffset, flipX, flipY, perLevelAnchor),
    ]) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
  }
  if (!Number.isFinite(minX)) {
    return null
  }
  return { minX, maxX, minY, maxY }
}

function buildSceneGraph(
  segments: PlanSegment[],
  header: { insUnits: number; extMin: { x: number; y: number; z: number } },
  opts: {
    maxWalls: number
    minLenM: number
    wallHeight: number
    wallThickness: number
    offset: boolean
    scaleOverride: number | null
    maxSegmentLengthM: number
    axisSnapToleranceM: number
    flipX: boolean
    flipY: boolean
    /** 来自 `--mapping-file`；仅 `map` 参与解析，`layerCount` 写入 site metadata */
    layerMapping: ParsedDxfLayerMappingFile | null
    mergeDoubleWallLines: boolean
    doubleWallMinSpacingM: number
    doubleWallMaxSpacingM: number
    doubleWallMinOverlapM: number
    doubleWallMinLengthRatio: number
    colinearGapMergeMaxM: number
    colinearGapMergePerpTolM: number
    colinearGapMergeBucketM: number
    colinearGapMergeMaxPasses: number
    colinearGapMergeAxisAlignDeg: number
    colinearGapMergeGeneralDirection: boolean
    redundantStubMaxLenM: number
    redundantStubLongMinLenM: number
    /** 门窗 INSERT（WIN2D / DorLib 等）；与墙段关联后写入墙 children，否则生成短墙 */
    inserts: PlanInsert[]
    /** 各层分割轴锚点（与 `computePerLevelSplitAxisAnchorFromGeometry`） */
    perLevelAnchor: Map<number, number> | null
  },
): SceneGraph {
  const scale = opts.scaleOverride ?? insUnitsToMetersFactor(header.insUnits)
  const ox = header.extMin.x
  const oy = header.extMin.y
  const fp = opts.layerMapping?.floorPlan ?? null
  const pl = opts.perLevelAnchor

  type Tagged = { seg: PlanSegment; levelIndex: number; mapping: DxfLayerMapping }
  const tagged: Tagged[] = []
  let skippedLong = 0
  /** 非墙体类图层（含 skip/annotation/window/door/…）的线段条数，不计入墙 */
  let skippedSemanticLayerSegments = 0
  for (const s of segments) {
    if (tagged.length >= opts.maxWalls) {
      break
    }
    const mapping = resolveLayerMapping(s.layer, opts.layerMapping?.map ?? null)
    if (mapping.target.kind !== 'wall') {
      skippedSemanticLayerSegments++
      continue
    }
    const levelIndex = resolveLevelIndexForDxfRawSegment(s.x0, s.y0, s.x1, s.y1, fp)
    const lenM = segmentLengthM(s, ox, oy, scale, opts.offset, opts.flipX, opts.flipY, fp, levelIndex, pl)
    if (lenM < opts.minLenM) {
      continue
    }
    if (opts.maxSegmentLengthM > 0 && lenM > opts.maxSegmentLengthM) {
      skippedLong++
      continue
    }

    tagged.push({ seg: s, levelIndex, mapping })
  }

  type WallPiece = {
    seg: PlanSegment
    levelIndex: number
    mapping: DxfLayerMapping
    thicknessM: number
    fromDoubleLineMerge: boolean
  }

  const taggedWallSegmentCount = tagged.length

  let wallPieces: WallPiece[]
  let mergeStats: { sourceSegmentsMerged: number; wallsReduced: number } | null = null
  if (opts.mergeDoubleWallLines) {
    const mr = mergeDoubleWallLineSegments(tagged, {
      ox,
      oy,
      scale,
      offset: opts.offset,
      flipX: opts.flipX,
      flipY: opts.flipY,
      defaultThicknessM: opts.wallThickness,
      minDoubleSpacingM: opts.doubleWallMinSpacingM,
      maxDoubleSpacingM: opts.doubleWallMaxSpacingM,
      minOverlapM: opts.doubleWallMinOverlapM,
      minLengthRatio: opts.doubleWallMinLengthRatio,
    })
    wallPieces = mr.merged
    mergeStats = { sourceSegmentsMerged: mr.sourceSegmentsMerged, wallsReduced: mr.wallsReduced }
  } else {
    wallPieces = tagged.map((t) => ({
      ...t,
      thicknessM: opts.wallThickness,
      fromDoubleLineMerge: false,
    }))
  }
  const wallPiecesAfterDoubleMerge = wallPieces.length

  let colinearGapPiecesReduced = 0
  let colinearGapMergePasses = 0
  let redundantCornerStubsRemoved = 0
  {
    const col = mergeColinearGapWallPiecesIterative(wallPieces, {
      ox,
      oy,
      scale,
      offset: opts.offset,
      flipX: opts.flipX,
      flipY: opts.flipY,
      maxGapM: opts.colinearGapMergeMaxM,
      perpTolM: opts.colinearGapMergePerpTolM,
      bucketM: opts.colinearGapMergeBucketM,
      maxPasses: opts.colinearGapMergeMaxPasses,
      axisAlignRad: (opts.colinearGapMergeAxisAlignDeg * Math.PI) / 180,
      mergeGeneralDirection: opts.colinearGapMergeGeneralDirection,
    })
    colinearGapPiecesReduced = col.piecesReduced
    colinearGapMergePasses = col.passes
    wallPieces = col.merged
  }
  const wallPiecesAfterColinearGap = wallPieces.length
  {
    const stub = removeRedundantCornerStubs(wallPieces, {
      ox,
      oy,
      scale,
      offset: opts.offset,
      flipX: opts.flipX,
      flipY: opts.flipY,
      stubMaxLenM: opts.redundantStubMaxLenM,
      stubLongMinLenM: opts.redundantStubLongMinLenM,
    })
    redundantCornerStubsRemoved = stub.stubsRemoved
    wallPieces = stub.merged
  }
  const wallPiecesAfterStubRemoval = wallPieces.length

  let columnOutlineRectanglesMerged = 0
  {
    const mr = mergeColumnOutlineAxisAlignedRectangles(wallPieces, {
      ox,
      oy,
      scale,
      offset: opts.offset,
      flipX: opts.flipX,
      flipY: opts.flipY,
      defaultThicknessM: opts.wallThickness,
    })
    wallPieces = mr.merged
    columnOutlineRectanglesMerged = mr.rectanglesMerged
  }
  const geometricWallPiecesBeforeOpenings = wallPieces.length

  /** 承重柱（column_outline）：柱 INSERT 用 `columnThicknessM`（sx/sy×比例）；纯线段仍按边长估厚 */
  const columnOutlineThicknessCapM = 3
  wallPieces = wallPieces.map((w) => {
    if (w.mapping.target.kind !== 'wall' || w.mapping.target.variant !== 'column_outline') {
      return w
    }
    if (w.seg.columnThicknessM !== undefined) {
      const t = Math.min(Math.max(w.seg.columnThicknessM, opts.wallThickness), columnOutlineThicknessCapM)
      return { ...w, thicknessM: t }
    }
    const lenM = segmentLengthM(w.seg, ox, oy, scale, opts.offset, opts.flipX, opts.flipY, fp, w.levelIndex, pl)
    const t = Math.min(Math.max(lenM, opts.wallThickness), columnOutlineThicknessCapM)
    return { ...w, thicknessM: t }
  })

  const byLevel = new Map<number, WallPiece[]>()
  for (const w of wallPieces) {
    const list = byLevel.get(w.levelIndex) ?? []
    list.push(w)
    byLevel.set(w.levelIndex, list)
  }

  const usedSegs = wallPieces.map((w) => w.seg)
  let levelIndices = [...byLevel.keys()].sort((a, b) => a - b)
  if (levelIndices.length === 0) {
    levelIndices = [0]
    byLevel.set(0, [])
  }

  const bb = bboxFromSegments(usedSegs, ox, oy, scale, opts.offset, opts.flipX, opts.flipY, fp, pl)
  const margin = 2
  const polygon =
    bb === null
      ? {
          type: 'polygon' as const,
          points: [
            [-15, -15],
            [15, -15],
            [15, 15],
            [-15, 15],
          ],
        }
      : {
          type: 'polygon' as const,
          points: [
            [bb.minX - margin, bb.minY - margin],
            [bb.maxX + margin, bb.minY - margin],
            [bb.maxX + margin, bb.maxY + margin],
            [bb.minX - margin, bb.maxY + margin],
          ],
        }

  const nameSeq = createExportNameCounter()

  const nodes: Record<string, unknown> = {}
  const siteId = nid('site')
  const buildingId = nid('building')
  const levelNodeIds: string[] = []

  const siteMeta: Record<string, unknown> = {
    source: 'dxf-import',
    insUnits: header.insUnits,
    scaleToMeters: scale,
    offset: opts.offset,
    flipX: opts.flipX,
    flipY: opts.flipY,
  }
  if (opts.layerMapping && opts.layerMapping.layerCount > 0) {
    siteMeta.layerMappingLayers = opts.layerMapping.layerCount
  }
  if (fp && fp.levels.length > 0) {
    siteMeta.dxfFloorPlan = {
      levelCount: fp.levelCount,
      splitAxis: fp.splitAxis,
      levels: fp.levels.map((L) => ({
        levelIndex: L.levelIndex,
        labels: L.labels,
        range: L.range,
      })),
    }
  }
  if (opts.maxSegmentLengthM > 0) {
    siteMeta.maxSegmentLengthM = opts.maxSegmentLengthM
  }
  if (opts.axisSnapToleranceM > 0) {
    siteMeta.axisSnapToleranceM = opts.axisSnapToleranceM
  }
  if (skippedLong > 0) {
    siteMeta.skippedSegmentsLongerThanM = skippedLong
  }
  if (skippedSemanticLayerSegments > 0) {
    siteMeta.skippedSemanticLayerSegments = skippedSemanticLayerSegments
  }
  if (mergeStats && mergeStats.wallsReduced > 0) {
    siteMeta.mergeDoubleWallLines = true
    siteMeta.mergeDoubleWallSourceSegments = mergeStats.sourceSegmentsMerged
    siteMeta.mergeDoubleWallReduced = mergeStats.wallsReduced
  }
  if (colinearGapPiecesReduced > 0) {
    siteMeta.mergeColinearGapReduced = colinearGapPiecesReduced
    siteMeta.mergeColinearGapPasses = colinearGapMergePasses
  }
  if (redundantCornerStubsRemoved > 0) {
    siteMeta.redundantCornerStubsRemoved = redundantCornerStubsRemoved
  }
  if (columnOutlineRectanglesMerged > 0) {
    siteMeta.columnOutlineRectanglesMerged = columnOutlineRectanglesMerged
  }

  const flatWallPieces: WallPiece[] = []
  for (const li of levelIndices) {
    flatWallPieces.push(...(byLevel.get(li) ?? []))
  }

  const openingResolved =
    opts.inserts.length > 0
      ? matchOpeningsToWalls(opts.inserts, flatWallPieces, {
          ox,
          oy,
          scale,
          offset: opts.offset,
          flipX: opts.flipX,
          flipY: opts.flipY,
          layerMapping: opts.layerMapping,
          unitToMeters: scale,
          defaultWallThicknessM: opts.wallThickness,
          floorPlan: fp,
          perLevelAnchor: pl,
        })
      : []

  if (openingResolved.length > 0) {
    siteMeta.dxfOpeningResolved = openingResolved.length
    siteMeta.dxfOpeningAttach = openingResolved.filter((r) => r.mode === 'attach').length
    siteMeta.dxfOpeningSyntheticWalls = openingResolved.filter((r) => r.mode === 'synthetic').length
  }

  const syntheticOpeningWallCount = openingResolved.filter((r) => r.mode === 'synthetic').length
  siteMeta.wallPipelineTaggedSegments = taggedWallSegmentCount
  siteMeta.wallPipelinePiecesAfterDoubleMerge = wallPiecesAfterDoubleMerge
  siteMeta.wallPipelinePiecesAfterColinearGap = wallPiecesAfterColinearGap
  siteMeta.wallPipelinePiecesAfterStubRemoval = wallPiecesAfterStubRemoval
  siteMeta.wallPipelineGeometricPiecesBeforeOpenings = geometricWallPiecesBeforeOpenings
  siteMeta.wallPipelineSyntheticOpeningWalls = syntheticOpeningWallCount
  if (taggedWallSegmentCount > 0) {
    const geom = geometricWallPiecesBeforeOpenings
    siteMeta.wallPipelineGeometricReductionOfTagged = (taggedWallSegmentCount - geom) / taggedWallSegmentCount
    siteMeta.wallPipelineGeometricRetentionOfTagged = geom / taggedWallSegmentCount
  }

  const attachList = openingResolved.filter((r): r is OpeningAttach => r.mode === 'attach')
  const attachByWall = groupAttachByWallIndex(attachList)
  const syntheticByLevel = new Map<number, OpeningSynthetic[]>()
  for (const r of openingResolved) {
    if (r.mode === 'synthetic') {
      const list = syntheticByLevel.get(r.levelIndex) ?? []
      list.push(r)
      syntheticByLevel.set(r.levelIndex, list)
    }
  }

  /** 单层：墙段与合成短墙端点在平面上的包围盒，用于生成该层整块楼板（轴对齐矩形）。 */
  function bboxForLevelWallEndpoints(
    li: number,
    pieces: WallPiece[],
    synthetics: OpeningSynthetic[],
  ): { minX: number; maxX: number; minY: number; maxY: number } | null {
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    const expand = (x: number, y: number) => {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    for (const w of pieces) {
      const s = w.seg
      for (const [x, y] of [
        transformDxfPointForLevel(
          s.x0,
          s.y0,
          li,
          fp,
          ox,
          oy,
          scale,
          opts.offset,
          opts.flipX,
          opts.flipY,
          pl,
        ),
        transformDxfPointForLevel(
          s.x1,
          s.y1,
          li,
          fp,
          ox,
          oy,
          scale,
          opts.offset,
          opts.flipX,
          opts.flipY,
          pl,
        ),
      ]) {
        expand(x, y)
      }
    }
    for (const syn of synthetics) {
      expand(syn.start[0], syn.start[1])
      expand(syn.end[0], syn.end[1])
    }
    if (!Number.isFinite(minX)) {
      return null
    }
    return { minX, maxX, minY, maxY }
  }

  /** polygon 为 [x,z]；与墙 start/end 同一平面。略扩边以覆盖墙厚。 */
  function slabRectangleFromWallBounds(
    bb: { minX: number; maxX: number; minY: number; maxY: number },
    padM: number,
  ): Array<[number, number]> {
    let minX = bb.minX - padM
    let maxX = bb.maxX + padM
    let minY = bb.minY - padM
    let maxY = bb.maxY + padM
    const minSpan = 0.05
    if (maxX - minX < minSpan) {
      const c = (minX + maxX) / 2
      minX = c - minSpan / 2
      maxX = c + minSpan / 2
    }
    if (maxY - minY < minSpan) {
      const c = (minY + maxY) / 2
      minY = c - minSpan / 2
      maxY = c + minSpan / 2
    }
    return [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ]
  }

  nodes[siteId] = {
    object: 'node',
    id: siteId,
    type: 'site',
    parentId: null,
    visible: true,
    name: `场地 ${nameSeq.next()}`,
    metadata: siteMeta,
    polygon,
    children: [buildingId],
  }

  nodes[buildingId] = {
    object: 'node',
    id: buildingId,
    type: 'building',
    parentId: siteId,
    visible: true,
    name: `建筑 ${nameSeq.next()}`,
    metadata: {},
    children: levelNodeIds,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  }

  let flatWallIndex = 0
  for (const li of levelIndices) {
    const levelId = nid('level')
    levelNodeIds.push(levelId)
    const floorEntry = fp?.levels.find((L) => L.levelIndex === li)
    const floorLabels = floorEntry?.labels
    const levelName = floorLabels?.[0] ?? `楼层 ${nameSeq.next()}`
    const segs = byLevel.get(li) ?? []
    const slabSyn = syntheticByLevel.get(li) ?? []
    const wallBBox = bboxForLevelWallEndpoints(li, segs, slabSyn)
    const slabPadM = Math.max(0.05, opts.wallThickness * 0.5)
    let slabId: string | null = null
    if (wallBBox !== null) {
      slabId = nid('slab')
      const slabPolygon = slabRectangleFromWallBounds(wallBBox, slabPadM)
      nodes[slabId] = {
        object: 'node',
        id: slabId,
        type: 'slab',
        name: `楼板 ${nameSeq.next()}`,
        parentId: levelId,
        visible: true,
        metadata: {
          ...(floorLabels?.length ? { dxfFloorLabels: floorLabels } : {}),
          dxfSlabFromWallBounds: true,
        },
        polygon: slabPolygon,
        elevation: 0.05,
      }
    }
    const wallIds: string[] = []
    for (const { seg: s, mapping, thicknessM, fromDoubleLineMerge } of segs) {
      const [sx, sy] = transformDxfPointForLevel(
        s.x0,
        s.y0,
        li,
        fp,
        ox,
        oy,
        scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
        pl,
      )
      const [ex, ey] = transformDxfPointForLevel(
        s.x1,
        s.y1,
        li,
        fp,
        ox,
        oy,
        scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
        pl,
      )
      const wid = nid('wall')
      wallIds.push(wid)
      const baseLabel = displayNameForNode(s.layer, mapping)
      const childIds: string[] = []
      for (const op of attachByWall.get(flatWallIndex) ?? []) {
        const ins = op.insert
        const mapIns = resolveLayerMapping(ins.layer, opts.layerMapping?.map ?? null)
        const label = op.kind === 'window' ? '窗' : '门'
        if (op.kind === 'window') {
          const cid = nid('window')
          childIds.push(cid)
          nodes[cid] = {
            object: 'node',
            id: cid,
            type: 'window',
            name: `${label} ${nameSeq.next()}`,
            parentId: wid,
            visible: true,
            metadata: {
              ...baseDxfMetadata(ins.layer, li, mapIns, { dxfFloorLabels: floorLabels }),
              dxfOpeningBlock: canonicalBlockName(ins.blockName),
            },
            position: [op.localX, DXF_IMPORT_WINDOW_CENTER_Y, 0],
            rotation: [0, 0, 0],
            side: 'front',
            wallId: wid,
            width: op.widthM,
            height: DXF_IMPORT_WINDOW_HEIGHT,
            ...DXF_IMPORT_WINDOW_DEFAULTS,
          }
        } else {
          const cid = nid('door')
          childIds.push(cid)
          nodes[cid] = {
            object: 'node',
            id: cid,
            type: 'door',
            name: `${label} ${nameSeq.next()}`,
            parentId: wid,
            visible: true,
            metadata: {
              ...baseDxfMetadata(ins.layer, li, mapIns, { dxfFloorLabels: floorLabels }),
              dxfOpeningBlock: canonicalBlockName(ins.blockName),
            },
            position: [op.localX, DXF_IMPORT_DOOR_CENTER_Y, 0],
            rotation: [0, 0, 0],
            side: 'front',
            wallId: wid,
            width: op.widthM,
            height: DXF_IMPORT_DOOR_HEIGHT,
            ...DXF_IMPORT_DOOR_DEFAULTS,
          }
        }
      }
      flatWallIndex += 1
      nodes[wid] = {
        object: 'node',
        id: wid,
        type: 'wall',
        name: `${baseLabel} ${nameSeq.next()}`,
        parentId: levelId,
        visible: true,
        metadata: {
          ...baseDxfMetadata(s.layer, li, mapping, { dxfFloorLabels: floorLabels }),
          ...(fromDoubleLineMerge ? { dxfMergedDoubleWall: true } : {}),
        },
        children: childIds,
        start: [sx, sy],
        end: [ex, ey],
        thickness: thicknessM,
        height: opts.wallHeight,
        frontSide: 'unknown',
        backSide: 'unknown',
      }
    }
    for (const syn of syntheticByLevel.get(li) ?? []) {
      const [sx, sy] = syn.start
      const [ex, ey] = syn.end
      const wid = nid('wall')
      wallIds.push(wid)
      const baseLabel = displayNameForNode(syn.layer, syn.mapping)
      const ins = syn.insert
      const mapIns = resolveLayerMapping(ins.layer, opts.layerMapping?.map ?? null)
      const label = syn.kind === 'window' ? '窗' : '门'
      let cid: string
      if (syn.kind === 'window') {
        cid = nid('window')
        nodes[cid] = {
          object: 'node',
          id: cid,
          type: 'window',
          name: `${label} ${nameSeq.next()}`,
          parentId: wid,
          visible: true,
          metadata: {
            ...baseDxfMetadata(ins.layer, li, mapIns, { dxfFloorLabels: floorLabels }),
            dxfOpeningBlock: canonicalBlockName(ins.blockName),
            dxfOpeningSyntheticWall: true,
          },
          position: [syn.widthM / 2, DXF_IMPORT_WINDOW_CENTER_Y, 0],
          rotation: [0, 0, 0],
          side: 'front',
          wallId: wid,
          width: syn.widthM,
          height: DXF_IMPORT_WINDOW_HEIGHT,
          ...DXF_IMPORT_WINDOW_DEFAULTS,
        }
      } else {
        cid = nid('door')
        nodes[cid] = {
          object: 'node',
          id: cid,
          type: 'door',
          name: `${label} ${nameSeq.next()}`,
          parentId: wid,
          visible: true,
          metadata: {
            ...baseDxfMetadata(ins.layer, li, mapIns, { dxfFloorLabels: floorLabels }),
            dxfOpeningBlock: canonicalBlockName(ins.blockName),
            dxfOpeningSyntheticWall: true,
          },
          position: [syn.widthM / 2, DXF_IMPORT_DOOR_CENTER_Y, 0],
          rotation: [0, 0, 0],
          side: 'front',
          wallId: wid,
          width: syn.widthM,
          height: DXF_IMPORT_DOOR_HEIGHT,
          ...DXF_IMPORT_DOOR_DEFAULTS,
        }
      }
      nodes[wid] = {
        object: 'node',
        id: wid,
        type: 'wall',
        name: `${baseLabel} ${nameSeq.next()}`,
        parentId: levelId,
        visible: true,
        metadata: {
          ...baseDxfMetadata(syn.layer, li, syn.mapping, { dxfFloorLabels: floorLabels }),
          dxfOpeningSyntheticWall: true,
          ...(syn.fromDoubleLineMerge ? { dxfMergedDoubleWall: true } : {}),
        },
        children: [cid],
        start: [sx, sy],
        end: [ex, ey],
        thickness: syn.thicknessM,
        height: opts.wallHeight,
        frontSide: 'unknown',
        backSide: 'unknown',
      }
    }
    nodes[levelId] = {
      object: 'node',
      id: levelId,
      type: 'level',
      parentId: buildingId,
      visible: true,
      name: levelName,
      metadata: {
        dxfLayerFloor: li + 1,
        dxfFloorPlanLevelIndex: li,
        ...(floorLabels?.length ? { dxfFloorLabels: floorLabels } : {}),
      },
      children: slabId !== null ? [slabId, ...wallIds] : wallIds,
      level: li,
    }
  }

  if (skippedLong > 0 && opts.maxSegmentLengthM > 0) {
    console.error(
      `Skipped ${skippedLong} segment(s) longer than ${opts.maxSegmentLengthM} m (often site bounds or reference lines).`,
    )
  }
  if (skippedSemanticLayerSegments > 0) {
    console.error(
      `Skipped ${skippedSemanticLayerSegments} segment(s) on non-wall layers (walls-only output; see LAYERS.md / mapDxfLayerToPascal).`,
    )
  }
  if (mergeStats && mergeStats.wallsReduced > 0) {
    console.error(
      `Merged double wall lines: ${mergeStats.sourceSegmentsMerged} segment(s) → ${mergeStats.sourceSegmentsMerged - mergeStats.wallsReduced} wall(s) (−${mergeStats.wallsReduced})`,
    )
  }
  if (openingResolved.length > 0) {
    const a = openingResolved.filter((r) => r.mode === 'attach').length
    const s = openingResolved.filter((r) => r.mode === 'synthetic').length
    console.error(`Openings resolved: ${openingResolved.length} (on-wall ${a}, synthetic short walls ${s})`)
  }

  return { nodes, rootNodeIds: [siteId] }
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.input) {
    console.error(
      'Usage: bun run dxf-to-scene.ts --input path/to/file.dxf [--out scene.json] [--max-walls 8000] [--mapping-file layers.json]',
    )
    process.exit(1)
  }

  let layerMapping: ParsedDxfLayerMappingFile | null = null
  if (args.mappingFile.trim()) {
    const mp = resolve(args.mappingFile.trim())
    console.error(`Reading layer mapping ${mp} …`)
    const raw = await readFile(mp, 'utf8')
    layerMapping = parseDxfLayerMappingFileJson(raw)
    console.error(
      `Layer mapping: ${layerMapping.layerCount} layer(s), ${layerMapping.map.size} lookup key(s)`,
    )
  }

  const inputPath = resolve(args.input)
  console.error(`Reading ${inputPath} …`)
  const text = await readFile(inputPath, 'utf8')
  console.error('Parsing DXF …')
  const { header, segments: rawSegments, inserts } = parseDxfPlanSegments(text)
  const scale = args.scaleOverride ?? insUnitsToMetersFactor(header.insUnits)
  const expanded: PlanSegment[] = [...rawSegments]
  let columnInsertWallCount = 0
  for (const ins of inserts) {
    const map = resolveLayerMapping(ins.layer, layerMapping?.map ?? null)
    if (map.target.kind === 'wall' && map.target.variant === 'column_outline') {
      const { seg, thicknessM } = columnInsertToSquareWallSegment(ins, scale)
      expanded.push({ ...seg, columnThicknessM: thicknessM })
      columnInsertWallCount++
    }
  }
  if (inserts.length > 0) {
    console.error(`INSERT entities: ${inserts.length}`)
  }
  if (columnInsertWallCount > 0) {
    console.error(
      `Column INSERT → ${columnInsertWallCount} wall(s) (single centerline; thickness = |sy|×scale m, length = |sx|×scale m)`,
    )
  }
  const segments = snapPlanSegmentsToAxis(
    expanded,
    header.extMin.x,
    header.extMin.y,
    scale,
    args.offset,
    args.axisSnapToleranceM,
  )

  const fp = layerMapping?.floorPlan ?? null

  const perLevelAnchor = computePerLevelSplitAxisAnchorFromGeometry(
    fp,
    segments,
    inserts,
    layerMapping?.map ?? null,
  )
  console.error(
    `INSUNITS=${header.insUnits} → scale ${scale} m/unit, EXTMIN (${header.extMin.x}, ${header.extMin.y})`,
  )
  console.error(
    `Plan flip: flipX=${args.flipX}, flipY=${args.flipY} (default matches --flip-x; use --no-flip-x to disable)`,
  )
  console.error(`Segments (LINE+LWPOLYLINE + column INSERT edges): ${segments.length}`)
  if (args.axisSnapToleranceM > 0) {
    console.error(`Axis snap (m): ${args.axisSnapToleranceM} — nearly horizontal/vertical edges aligned to axes`)
  }

  const scene = buildSceneGraph(segments, header, {
    maxWalls: args.maxWalls,
    minLenM: args.minLenM,
    wallHeight: args.wallHeight,
    wallThickness: args.wallThickness,
    offset: args.offset,
    scaleOverride: args.scaleOverride,
    maxSegmentLengthM: args.maxSegmentLengthM,
    axisSnapToleranceM: args.axisSnapToleranceM,
    flipX: args.flipX,
    flipY: args.flipY,
    layerMapping,
    mergeDoubleWallLines: args.mergeDoubleWallLines,
    doubleWallMinSpacingM: args.doubleWallMinSpacingM,
    doubleWallMaxSpacingM: args.doubleWallMaxSpacingM,
    doubleWallMinOverlapM: args.doubleWallMinOverlapM,
    doubleWallMinLengthRatio: args.doubleWallMinLengthRatio,
    colinearGapMergeMaxM: args.colinearGapMergeMaxM,
    colinearGapMergePerpTolM: args.colinearGapMergePerpTolM,
    colinearGapMergeBucketM: args.colinearGapMergeBucketM,
    colinearGapMergeMaxPasses: args.colinearGapMergeMaxPasses,
    colinearGapMergeAxisAlignDeg: args.colinearGapMergeAxisAlignDeg,
    colinearGapMergeGeneralDirection: args.colinearGapMergeGeneralDirection,
    redundantStubMaxLenM: args.redundantStubMaxLenM,
    redundantStubLongMinLenM: args.redundantStubLongMinLenM,
    inserts,
    perLevelAnchor,
  })

  const wallCount = Object.keys(scene.nodes).filter(
    (id) => (scene.nodes[id] as { type?: string }).type === 'wall',
  ).length
  const windowCount = Object.keys(scene.nodes).filter(
    (id) => (scene.nodes[id] as { type?: string }).type === 'window',
  ).length
  const doorCount = Object.keys(scene.nodes).filter(
    (id) => (scene.nodes[id] as { type?: string }).type === 'door',
  ).length
  const levelCount = Object.keys(scene.nodes).filter(
    (id) => (scene.nodes[id] as { type?: string }).type === 'level',
  ).length
  const slabCount = Object.keys(scene.nodes).filter(
    (id) => (scene.nodes[id] as { type?: string }).type === 'slab',
  ).length
  console.error(
    `Levels: ${levelCount}, slabs: ${slabCount}, walls: ${wallCount}, windows: ${windowCount}, doors: ${doorCount}`,
  )

  const siteNode = Object.values(scene.nodes).find((n) => (n as { type?: string }).type === 'site') as
    | { metadata?: Record<string, unknown> }
    | undefined
  const pm = siteNode?.metadata
  if (pm && typeof pm.wallPipelineTaggedSegments === 'number') {
    const t = pm.wallPipelineTaggedSegments
    const g = pm.wallPipelineGeometricPiecesBeforeOpenings
    const syn = typeof pm.wallPipelineSyntheticOpeningWalls === 'number' ? pm.wallPipelineSyntheticOpeningWalls : 0
    const geomNum = typeof g === 'number' ? g : 0
    const red = t > 0 ? ((t - geomNum) / t) * 100 : 0
    const ret = t > 0 ? (geomNum / t) * 100 : 0
    console.error(
      `Wall pipeline (geometry vs tagged LINE segments): tagged ${t} → double-merge ${pm.wallPipelinePiecesAfterDoubleMerge} → colinear ${pm.wallPipelinePiecesAfterColinearGap} → stub ${pm.wallPipelinePiecesAfterStubRemoval} → before openings ${geomNum} | reduction ${red.toFixed(1)}% of tagged, retention ${ret.toFixed(1)}% (expecting ~2/3 reduction ⇒ retention ~33% only if most segments are redundant pairs/gaps on the same wall)`,
    )
    if (syn > 0) {
      console.error(
        `Synthetic opening walls (INSERT could not attach; add ${syn} wall node(s), hurts net reduction): ${syn}`,
      )
    }
  }

  const outPath = resolve(args.out)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(scene, null, 2)}\n`, 'utf8')
  console.error(`Wrote ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
