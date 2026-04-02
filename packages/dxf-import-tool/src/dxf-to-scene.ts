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
import {
  compileLayerRegex,
  layerNameToLevelIndex,
  type UnmatchedLayersMode,
} from './layer-level.ts'
import { snapPlanSegmentsToAxis } from './axis-snap.ts'
import {
  insUnitsToMetersFactor,
  insertBlockToColumnOutlineSegments,
  type PlanSegment,
  parseDxfPlanSegments,
} from './parse-dxf-entities.ts'
import {
  parseDxfLayerMappingFileJson,
  resolveLayerMapping,
  type DxfLayerMapping,
  type ParsedDxfLayerMappingFile,
} from './dxf-layer-mapping.ts'
import { baseDxfMetadata, displayNameForNode } from './dxf-scene-nodes.ts'
import { mergeDoubleWallLineSegments } from './merge-double-wall-lines.ts'

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
  /** If set, split walls across multiple Level nodes by layer name (first regex capture = floor). */
  let layerRegexSource: string | null = null
  /** If true (default), capture 1 → Pascal level 0; if false, capture is already 0-based level index. */
  let layerFloorOneBased = true
  let unmatchedLayers: UnmatchedLayersMode = 'skip'
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
  let doubleWallMaxSpacingM = 0.65
  let doubleWallMinOverlapM = 0.04
  /** 双线合并：两段长度比下限；0=不限制（旧行为）。默认 0.75 避免长墙与短隔墙并成一组 */
  let doubleWallMinLengthRatio = 0.75

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
    } else if (a === '--layer-regex') {
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        layerRegexSource = argv[++i] ?? ''
      } else {
        layerRegexSource = String.raw`图层\s*(\d+)`
      }
    } else if (a === '--layer-floor-zero-based') {
      layerFloorOneBased = false
    } else if (a === '--unmatched-layers') {
      const v = argv[++i]
      if (v === 'skip' || v === 'level0') {
        unmatchedLayers = v
      }
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
    layerRegexSource: layerRegexSource?.trim() || null,
    layerFloorOneBased,
    unmatchedLayers,
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
  }
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

function segmentLengthM(
  s: PlanSegment,
  ox: number,
  oy: number,
  scale: number,
  useOffset: boolean,
  flipX: boolean,
  flipY: boolean,
): number {
  const [x0, y0] = transformPoint(s.x0, s.y0, ox, oy, scale, useOffset, flipX, flipY)
  const [x1, y1] = transformPoint(s.x1, s.y1, ox, oy, scale, useOffset, flipX, flipY)
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
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const s of segments) {
    for (const [x, y] of [
      transformPoint(s.x0, s.y0, ox, oy, scale, useOffset, flipX, flipY),
      transformPoint(s.x1, s.y1, ox, oy, scale, useOffset, flipX, flipY),
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
    layerRegexSource: string | null
    layerFloorOneBased: boolean
    unmatchedLayers: UnmatchedLayersMode
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
  },
): SceneGraph {
  const scale = opts.scaleOverride ?? insUnitsToMetersFactor(header.insUnits)
  const ox = header.extMin.x
  const oy = header.extMin.y

  const layerRegex = opts.layerRegexSource ? compileLayerRegex(opts.layerRegexSource) : null

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
    const lenM = segmentLengthM(s, ox, oy, scale, opts.offset, opts.flipX, opts.flipY)
    if (lenM < opts.minLenM) {
      continue
    }
    if (opts.maxSegmentLengthM > 0 && lenM > opts.maxSegmentLengthM) {
      skippedLong++
      continue
    }

    let levelIndex = 0
    if (layerRegex) {
      let idx = layerNameToLevelIndex(s.layer, layerRegex, opts.layerFloorOneBased)
      if (idx === null) {
        if (opts.unmatchedLayers === 'skip') {
          continue
        }
        idx = 0
      }
      levelIndex = idx
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

  /** 承重柱（column_outline）：平面边长即柱宽方向尺寸，墙厚与边长一致时更接近正方形柱体 */
  const columnOutlineThicknessCapM = 3
  wallPieces = wallPieces.map((w) => {
    if (w.mapping.target.kind !== 'wall' || w.mapping.target.variant !== 'column_outline') {
      return w
    }
    const lenM = segmentLengthM(w.seg, ox, oy, scale, opts.offset, opts.flipX, opts.flipY)
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

  const bb = bboxFromSegments(usedSegs, ox, oy, scale, opts.offset, opts.flipX, opts.flipY)
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
  if (opts.layerRegexSource) {
    siteMeta.layerRegex = opts.layerRegexSource
    siteMeta.layerFloorOneBased = opts.layerFloorOneBased
    siteMeta.unmatchedLayers = opts.unmatchedLayers
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

  for (const li of levelIndices) {
    const levelId = nid('level')
    levelNodeIds.push(levelId)
    const levelName = `楼层 ${nameSeq.next()}`
    const segs = byLevel.get(li) ?? []
    const wallIds: string[] = []
    for (const { seg: s, mapping, thicknessM, fromDoubleLineMerge } of segs) {
      const [sx, sy] = transformPoint(
        s.x0,
        s.y0,
        ox,
        oy,
        scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )
      const [ex, ey] = transformPoint(
        s.x1,
        s.y1,
        ox,
        oy,
        scale,
        opts.offset,
        opts.flipX,
        opts.flipY,
      )
      const wid = nid('wall')
      wallIds.push(wid)
      const baseLabel = displayNameForNode(s.layer, mapping)
      nodes[wid] = {
        object: 'node',
        id: wid,
        type: 'wall',
        name: `${baseLabel} ${nameSeq.next()}`,
        parentId: levelId,
        visible: true,
        metadata: {
          ...baseDxfMetadata(s.layer, li, mapping),
          ...(fromDoubleLineMerge ? { dxfMergedDoubleWall: true } : {}),
        },
        children: [],
        start: [sx, sy],
        end: [ex, ey],
        thickness: thicknessM,
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
        dxfLayerFloor: opts.layerFloorOneBased ? li + 1 : li,
      },
      children: wallIds,
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
  let columnInsertEdgeCount = 0
  for (const ins of inserts) {
    const map = resolveLayerMapping(ins.layer, layerMapping?.map ?? null)
    if (map.target.kind === 'wall' && map.target.variant === 'column_outline') {
      const segs = insertBlockToColumnOutlineSegments(ins)
      expanded.push(...segs)
      columnInsertEdgeCount += segs.length
    }
  }
  if (inserts.length > 0) {
    console.error(`INSERT entities: ${inserts.length}`)
  }
  if (columnInsertEdgeCount > 0) {
    console.error(
      `Column INSERT → ${columnInsertEdgeCount} segment(s) (${columnInsertEdgeCount / 4} block(s), ±0.5 unit block → square outline)`,
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
    layerRegexSource: args.layerRegexSource,
    layerFloorOneBased: args.layerFloorOneBased,
    unmatchedLayers: args.unmatchedLayers,
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
  })

  const wallCount = Object.keys(scene.nodes).filter(
    (id) => (scene.nodes[id] as { type?: string }).type === 'wall',
  ).length
  const levelCount = Object.keys(scene.nodes).filter(
    (id) => (scene.nodes[id] as { type?: string }).type === 'level',
  ).length
  console.error(`Levels: ${levelCount}, walls: ${wallCount}`)

  const outPath = resolve(args.out)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(scene, null, 2)}\n`, 'utf8')
  console.error(`Wrote ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
