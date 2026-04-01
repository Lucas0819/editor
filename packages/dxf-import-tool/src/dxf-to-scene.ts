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
  }
}

function transformPoint(
  x: number,
  y: number,
  ox: number,
  oy: number,
  scale: number,
  useOffset: boolean,
): [number, number] {
  const px = useOffset ? x - ox : x
  const py = useOffset ? y - oy : y
  return [px * scale, py * scale]
}

function segmentLengthM(
  s: PlanSegment,
  ox: number,
  oy: number,
  scale: number,
  useOffset: boolean,
): number {
  const [x0, y0] = transformPoint(s.x0, s.y0, ox, oy, scale, useOffset)
  const [x1, y1] = transformPoint(s.x1, s.y1, ox, oy, scale, useOffset)
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
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const s of segments) {
    for (const [x, y] of [
      transformPoint(s.x0, s.y0, ox, oy, scale, useOffset),
      transformPoint(s.x1, s.y1, ox, oy, scale, useOffset),
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
  },
): SceneGraph {
  const scale = opts.scaleOverride ?? insUnitsToMetersFactor(header.insUnits)
  const ox = header.extMin.x
  const oy = header.extMin.y

  const used: PlanSegment[] = []
  for (const s of segments) {
    if (used.length >= opts.maxWalls) {
      break
    }
    if (segmentLengthM(s, ox, oy, scale, opts.offset) >= opts.minLenM) {
      used.push(s)
    }
  }

  const wallIds: string[] = []
  const nodes: Record<string, unknown> = {}

  const siteId = nid('site')
  const buildingId = nid('building')
  const levelId = nid('level')

  for (const s of used) {
    const [sx, sy] = transformPoint(s.x0, s.y0, ox, oy, scale, opts.offset)
    const [ex, ey] = transformPoint(s.x1, s.y1, ox, oy, scale, opts.offset)
    const wid = nid('wall')
    wallIds.push(wid)
    nodes[wid] = {
      object: 'node',
      id: wid,
      type: 'wall',
      name: s.layer ? `Wall (${s.layer})` : undefined,
      parentId: levelId,
      visible: true,
      metadata: { source: 'dxf-import', layer: s.layer },
      children: [],
      start: [sx, sy],
      end: [ex, ey],
      thickness: opts.wallThickness,
      height: opts.wallHeight,
      frontSide: 'unknown',
      backSide: 'unknown',
    }
  }

  const bb = bboxFromSegments(used, ox, oy, scale, opts.offset)
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

  nodes[siteId] = {
    object: 'node',
    id: siteId,
    type: 'site',
    parentId: null,
    visible: true,
    metadata: {
      source: 'dxf-import',
      insUnits: header.insUnits,
      scaleToMeters: scale,
      offset: opts.offset,
    },
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
    children: [levelId],
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  }

  nodes[levelId] = {
    object: 'node',
    id: levelId,
    type: 'level',
    parentId: buildingId,
    visible: true,
    metadata: {},
    children: wallIds,
    level: 0,
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
  const { header, segments } = parseDxfPlanSegments(text)
  console.error(
    `INSUNITS=${header.insUnits} → scale ${args.scaleOverride ?? insUnitsToMetersFactor(header.insUnits)} m/unit, EXTMIN (${header.extMin.x}, ${header.extMin.y})`,
  )
  console.error(`Segments (LINE+LWPOLYLINE edges): ${segments.length}`)

  const scene = buildSceneGraph(segments, header, {
    maxWalls: args.maxWalls,
    minLenM: args.minLenM,
    wallHeight: args.wallHeight,
    wallThickness: args.wallThickness,
    offset: args.offset,
    scaleOverride: args.scaleOverride,
  })

  const wallCount = Object.keys(scene.nodes).filter(
    (id) => (scene.nodes[id] as { type?: string }).type === 'wall',
  ).length
  console.error(`Walls written: ${wallCount}`)

  const outPath = resolve(args.out)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(scene, null, 2)}\n`, 'utf8')
  console.error(`Wrote ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
