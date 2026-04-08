#!/usr/bin/env bun
/**
 * DXF 预读：图层表、墙段长度分布、门窗 INSERT 抽样 → stdout JSON。
 * 供 Agent / skill 在 `dxf-to-scene` 前与用户确认 mapping 与 CLI 参数。
 *
 *   bun run src/dxf-preview.ts --input /path/to/a.dxf [--mapping-file m.json] [--sample 10]
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  parseDxfLayerMappingFileJson,
  resolveLayerMapping,
  type DxfLayerMapping,
} from './dxf-layer-mapping.ts'
import { classifyOpeningBlock, canonicalBlockName, openingWidthMetersFromInsert } from './dxf-openings.ts'
import {
  insUnitsToMetersFactor,
  parseDxfLayerTableNames,
  parseDxfPlanSegments,
  type PlanInsert,
  type PlanSegment,
} from './parse-dxf-entities.ts'

function parseArgs(argv: string[]) {
  let input = ''
  let mappingFile = ''
  let sample = 10
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--input' || a === '-i') {
      input = argv[++i] ?? ''
    } else if (a === '--mapping-file' || a === '-m') {
      mappingFile = argv[++i] ?? ''
    } else if (a === '--sample' || a === '-n') {
      sample = Number.parseInt(argv[++i] ?? '', 10) || sample
    }
  }
  return {
    input: input ? resolve(input) : '',
    mappingFile: mappingFile ? resolve(mappingFile) : '',
    sample,
  }
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function sampleIndices<T>(arr: T[], n: number, seed: number): number[] {
  if (arr.length <= n) {
    return arr.map((_, i) => i)
  }
  const rand = mulberry32(seed)
  const idx = arr.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = idx[i]!
    idx[i] = idx[j]!
    idx[j] = t
  }
  return idx.slice(0, n)
}

function segmentLengthDxf(s: PlanSegment): number {
  const dx = s.x1 - s.x0
  const dy = s.y1 - s.y0
  return Math.hypot(dx, dy)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))))
  return sorted[idx]!
}

async function main() {
  const { input, mappingFile, sample } = parseArgs(process.argv)
  if (!input) {
    console.error('Usage: bun run dxf-preview.ts --input <file.dxf> [--mapping-file <m.json>] [--sample 10]')
    process.exit(1)
  }

  const raw = await readFile(input, 'utf8')
  const layerTableNames = parseDxfLayerTableNames(raw)
  const { header, segments, inserts } = parseDxfPlanSegments(raw)
  const unitToM = insUnitsToMetersFactor(header.insUnits)

  let overrides: Map<string, DxfLayerMapping> | null = null
  if (mappingFile) {
    const mt = await readFile(mappingFile, 'utf8')
    const parsed = parseDxfLayerMappingFileJson(mt)
    overrides = parsed.map
  }

  const seed = hashStr(input)

  const wallSegments: PlanSegment[] = []
  for (const s of segments) {
    const m = resolveLayerMapping(s.layer, overrides)
    if (m.target.kind === 'wall') {
      wallSegments.push(s)
    }
  }

  const wallLensM = wallSegments.map((s) => segmentLengthDxf(s) * unitToM).sort((a, b) => a - b)
  const lenDist =
    wallLensM.length > 0
      ? {
          count: wallLensM.length,
          minM: wallLensM[0]!,
          maxM: wallLensM[wallLensM.length - 1]!,
          p50M: percentile(wallLensM, 50),
          p90M: percentile(wallLensM, 90),
          p99M: percentile(wallLensM, 99),
        }
      : { count: 0, minM: 0, maxM: 0, p50M: 0, p90M: 0, p99M: 0 }

  const doors: PlanInsert[] = []
  const wins: PlanInsert[] = []
  const otherBlocks = new Map<string, number>()
  for (const ins of inserts) {
    const k = classifyOpeningBlock(ins.blockName)
    if (k === 'door') {
      doors.push(ins)
    } else if (k === 'window') {
      wins.push(ins)
    } else {
      const key = canonicalBlockName(ins.blockName)
      otherBlocks.set(key, (otherBlocks.get(key) ?? 0) + 1)
    }
  }

  const si = sampleIndices(doors, sample, seed ^ 0x9e3779b9)
  const sj = sampleIndices(wins, sample, seed ^ 0x85ebca6b)
  const sk = sampleIndices(wallSegments, sample, seed ^ 0xc2b2ae35)

  const doorSamples = si.map((idx) => {
    const ins = doors[idx]!
    return {
      layer: ins.layer,
      blockName: ins.blockName,
      canonicalBlock: canonicalBlockName(ins.blockName),
      insertX: ins.bx,
      insertY: ins.by,
      widthM: openingWidthMetersFromInsert(ins.sx, ins.sy, unitToM),
      rotationDeg: ins.rotationDeg,
    }
  })
  const windowSamples = sj.map((idx) => {
    const ins = wins[idx]!
    return {
      layer: ins.layer,
      blockName: ins.blockName,
      canonicalBlock: canonicalBlockName(ins.blockName),
      insertX: ins.bx,
      insertY: ins.by,
      widthM: openingWidthMetersFromInsert(ins.sx, ins.sy, unitToM),
      rotationDeg: ins.rotationDeg,
    }
  })
  const wallSamples = sk.map((idx) => {
    const s = wallSegments[idx]!
    const m = resolveLayerMapping(s.layer, overrides)
    const lenDxf = segmentLengthDxf(s)
    return {
      layer: s.layer,
      mappingKind: m.target.kind,
      lengthM: lenDxf * unitToM,
      lengthDxf: lenDxf,
    }
  })

  const topOtherBlocks = [...otherBlocks.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, count]) => ({ name, count }))

  const geomLayers = new Set<string>()
  for (const s of segments) {
    geomLayers.add(s.layer.trim())
  }
  for (const ins of inserts) {
    geomLayers.add(ins.layer.trim())
  }

  const suggestedMaxWalls = Math.min(8000, Math.max(100, wallSegments.length + doors.length + wins.length + 500))

  const out = {
    input,
    mappingFile: mappingFile || null,
    header: {
      insUnits: header.insUnits,
      unitToMeters: unitToM,
      extMin: header.extMin,
    },
    counts: {
      layerTable: layerTableNames.length,
      segments: segments.length,
      inserts: inserts.length,
      wallMappedSegments: wallSegments.length,
      doorInserts: doors.length,
      windowInserts: wins.length,
    },
    layerTableNames,
    layersInGeometry: [...geomLayers].sort(),
    lengthDistributionWallSegmentsM: lenDist,
    openingBlockHistogramOther: topOtherBlocks,
    samples: {
      doors: doorSamples,
      windows: windowSamples,
      wallSegments: wallSamples,
      sampleSize: sample,
    },
    cliHints: {
      suggestedMaxWalls,
      defaultMinLengthM: 0.02,
      noteMaxSegmentLengthM:
        lenDist.p99M > 40
          ? '若含场地/轴网超长边，可考虑 --max-segment-length-m 设为约 p99 米值以过滤'
          : null,
      noteMergeDoubleWall:
        wallSegments.length > 2000
          ? '墙段很多；若 CAD 为双线墙厚，可尝试 --merge-double-wall-lines 与 OPERATIONS 中双线间距参数'
          : null,
    },
  }

  console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
