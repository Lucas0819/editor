#!/usr/bin/env bun
/**
 * 在 DXF ENTITIES 的 TEXT/MTEXT 中按「关键词子串」筛选，可选按图层名白名单过滤。
 * 关键词由调用方（Agent / 用户）提供；先跑 dxf-preview 得图层表，再选定层名与检索词。
 *
 *   bun run src/dxf-text-search.ts --input a.dxf --keyword 一层 --keyword 二层 --layer "楼层名称"
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseDxfTextEntities, type DxfTextEntity } from './parse-dxf-text.ts'

function parseArgs(argv: string[]) {
  const keywords: string[] = []
  const layers: string[] = []
  let input = ''
  let maxMatches = 10_000
  let caseInsensitive = true

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--input' || a === '-i') {
      input = resolve(argv[++i] ?? '')
    } else if (a === '--keyword' || a === '-k') {
      const k = argv[++i]
      if (k) keywords.push(k)
    } else if (a === '--layer' || a === '-l') {
      const L = argv[++i]
      if (L) layers.push(L.trim())
    } else if (a === '--max-matches' || a === '-n') {
      maxMatches = Number.parseInt(argv[++i] ?? '', 10) || maxMatches
    } else if (a === '--case-sensitive') {
      caseInsensitive = false
    }
  }

  return { input, keywords, layers, maxMatches, caseInsensitive }
}

function normalize(s: string, ci: boolean): string {
  return ci ? s.toLowerCase() : s
}

function matchesKeywords(
  text: string,
  keywords: string[],
  caseInsensitive: boolean,
): boolean {
  if (keywords.length === 0) {
    return false
  }
  const t = normalize(text, caseInsensitive)
  return keywords.some((k) => t.includes(normalize(k, caseInsensitive)))
}

function layerAllowed(layer: string, layersFilter: Set<string>): boolean {
  if (layersFilter.size === 0) {
    return true
  }
  return layersFilter.has(layer.trim())
}

function mainSync(entities: DxfTextEntity[], args: ReturnType<typeof parseArgs>) {
  const { keywords, layers, maxMatches, caseInsensitive } = args
  const layerSet = new Set(layers.map((s) => s.trim()))

  if (keywords.length === 0) {
    console.error(
      'Usage: bun run dxf-text-search.ts --input <file.dxf> --keyword <substr> [--keyword <k2> ...] [--layer <name> ...] [--max-matches N] [--case-sensitive]',
    )
    console.error('At least one --keyword is required.')
    process.exit(1)
  }

  const matches: Array<
    Pick<DxfTextEntity, 'kind' | 'layer' | 'text' | 'x' | 'y' | 'z'> & {
      matchedKeyword: string
    }
  > = []

  outer: for (const e of entities) {
    if (!layerAllowed(e.layer, layerSet)) {
      continue
    }
    if (!matchesKeywords(e.text, keywords, caseInsensitive)) {
      continue
    }
    let matchedKeyword = ''
    const t = normalize(e.text, caseInsensitive)
    for (const k of keywords) {
      if (t.includes(normalize(k, caseInsensitive))) {
        matchedKeyword = k
        break
      }
    }
    matches.push({
      kind: e.kind,
      layer: e.layer,
      text: e.text,
      x: e.x,
      y: e.y,
      z: e.z,
      matchedKeyword,
    })
    if (matches.length >= maxMatches) {
      break outer
    }
  }

  const out = {
    input: args.input,
    keywords,
    layersFilter: layers.length > 0 ? layers : null,
    caseInsensitive,
    textEntityCount: entities.length,
    matchCount: matches.length,
    truncated: matches.length >= maxMatches,
    matches,
  }

  console.log(JSON.stringify(out, null, 2))
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.input) {
    console.error(
      'Usage: bun run dxf-text-search.ts --input <file.dxf> --keyword <substr> [--keyword ...] [--layer ...] [--max-matches N]',
    )
    process.exit(1)
  }

  const raw = await readFile(args.input, 'utf8')
  const entities = parseDxfTextEntities(raw)
  mainSync(entities, args)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
