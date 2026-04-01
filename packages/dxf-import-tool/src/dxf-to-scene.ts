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
  type PlanSegment,
  parseDxfPlanSegments,
} from './parse-dxf-entities.ts'

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
  let wallHeight = 2.5
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
  },
): SceneGraph {
  const scale = opts.scaleOverride ?? insUnitsToMetersFactor(header.insUnits)
  const ox = header.extMin.x
  const oy = header.extMin.y

  const layerRegex = opts.layerRegexSource ? compileLayerRegex(opts.layerRegexSource) : null

  type Tagged = { seg: PlanSegment; levelIndex: number }
  const tagged: Tagged[] = []
  let skippedLong = 0
  for (const s of segments) {
    if (tagged.length >= opts.maxWalls) {
      break
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
    tagged.push({ seg: s, levelIndex })
  }

  const byLevel = new Map<number, PlanSegment[]>()
  for (const { seg, levelIndex } of tagged) {
    const list = byLevel.get(levelIndex) ?? []
    list.push(seg)
    byLevel.set(levelIndex, list)
  }

  const usedSegs = tagged.map((t) => t.seg)
  let levelIndices = [...byLevel.keys()].sort((a, b) => a - b)
  if (levelIndices.length === 0) {
    levelIndices = [0]
    byLevel.set(0, [])
  }

  const nodes: Record<string, unknown> = {}
  const siteId = nid('site')
  const buildingId = nid('building')
  const levelNodeIds: string[] = []

  for (const li of levelIndices) {
    const levelId = nid('level')
    levelNodeIds.push(levelId)
    const segs = byLevel.get(li) ?? []
    const wallIds: string[] = []
    for (const s of segs) {
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
      nodes[wid] = {
        object: 'node',
        id: wid,
        type: 'wall',
        name: s.layer ? `Wall (${s.layer})` : undefined,
        parentId: levelId,
        visible: true,
        metadata: { source: 'dxf-import', layer: s.layer, levelIndex: li },
        children: [],
        start: [sx, sy],
        end: [ex, ey],
        thickness: opts.wallThickness,
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
      metadata: {
        dxfLayerFloor: opts.layerFloorOneBased ? li + 1 : li,
      },
      children: wallIds,
      level: li,
    }
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

  const siteMeta: Record<string, unknown> = {
    source: 'dxf-import',
    insUnits: header.insUnits,
    scaleToMeters: scale,
    offset: opts.offset,
    flipX: opts.flipX,
    flipY: opts.flipY,
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

  nodes[siteId] = {
    object: 'node',
    id: siteId,
    type: 'site',
    parentId: null,
    visible: true,
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
    metadata: {},
    children: levelNodeIds,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  }

  if (skippedLong > 0 && opts.maxSegmentLengthM > 0) {
    console.error(
      `Skipped ${skippedLong} segment(s) longer than ${opts.maxSegmentLengthM} m (often site bounds or reference lines).`,
    )
  }

  return { nodes, rootNodeIds: [siteId] }
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.input) {
    console.error(
      'Usage: bun run dxf-to-scene.ts --input path/to/file.dxf [--out scene.json] [--max-walls 8000]',
    )
    process.exit(1)
  }

  const inputPath = resolve(args.input)
  console.error(`Reading ${inputPath} …`)
  const text = await readFile(inputPath, 'utf8')
  console.error('Parsing DXF …')
  const { header, segments: rawSegments } = parseDxfPlanSegments(text)
  const scale = args.scaleOverride ?? insUnitsToMetersFactor(header.insUnits)
  const segments = snapPlanSegmentsToAxis(
    rawSegments,
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
  console.error(`Segments (LINE+LWPOLYLINE edges): ${segments.length}`)
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
