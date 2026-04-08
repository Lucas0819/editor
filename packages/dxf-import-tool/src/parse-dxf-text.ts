/**
 * ASCII DXF：解析 ENTITIES 段中的 TEXT / MTEXT（插入点 + 字符串），供 dxf-text-search 使用。
 * 与 parse-dxf-entities.ts 一致，仅扫描 ENTITIES，不展开 BLOCK 内文字。
 */

export type DxfTextEntity = {
  kind: 'TEXT' | 'MTEXT'
  layer: string
  /** 合并后的可见字符串（MTEXT 仍可能含格式控制符） */
  text: string
  x: number
  y: number
  z: number
}

function trimPair(line: string | undefined): string {
  return line?.trim() ?? ''
}

function findSection(lines: string[], name: string): number {
  for (let i = 0; i < lines.length - 1; i++) {
    if (trimPair(lines[i]) === '2' && trimPair(lines[i + 1]) === name) {
      return i + 2
    }
  }
  return -1
}

function skipUnknownEntity(lines: string[], start: number): number {
  let i = start
  while (i < lines.length - 1) {
    const code = Number(lines[i])
    i += 2
    if (code === 0) {
      return i - 2
    }
  }
  return start
}

function parseTextEntity(
  lines: string[],
  start: number,
): { entity: DxfTextEntity | null; next: number } {
  let i = start
  let layer = ''
  let x = 0
  let y = 0
  let z = 0
  const parts: string[] = []
  while (i < lines.length - 1) {
    const code = Number(lines[i])
    const val = lines[i + 1]
    i += 2
    if (code === 0) {
      const text = parts.join('')
      if (text.length === 0 && layer.length === 0) {
        return { entity: null, next: i - 2 }
      }
      return {
        entity: {
          kind: 'TEXT',
          layer: layer.trim(),
          text,
          x,
          y,
          z,
        },
        next: i - 2,
      }
    }
    if (code === 8) layer = trimPair(val)
    if (code === 10) x = Number.parseFloat(trimPair(val))
    if (code === 20) y = Number.parseFloat(trimPair(val))
    if (code === 30) z = Number.parseFloat(trimPair(val))
    if (code === 1) parts.push(trimPair(val))
  }
  return { entity: null, next: start }
}

function parseMtextEntity(
  lines: string[],
  start: number,
): { entity: DxfTextEntity | null; next: number } {
  let i = start
  let layer = ''
  let x = 0
  let y = 0
  let z = 0
  const parts: string[] = []
  while (i < lines.length - 1) {
    const code = Number(lines[i])
    const val = lines[i + 1]
    i += 2
    if (code === 0) {
      const text = parts.join('')
      if (text.length === 0 && layer.length === 0) {
        return { entity: null, next: i - 2 }
      }
      return {
        entity: {
          kind: 'MTEXT',
          layer: layer.trim(),
          text,
          x,
          y,
          z,
        },
        next: i - 2,
      }
    }
    if (code === 8) layer = trimPair(val)
    if (code === 10) x = Number.parseFloat(trimPair(val))
    if (code === 20) y = Number.parseFloat(trimPair(val))
    if (code === 30) z = Number.parseFloat(trimPair(val))
    if (code === 1 || code === 3) parts.push(trimPair(val))
  }
  return { entity: null, next: start }
}

/** 解析 ENTITIES 中全部 TEXT / MTEXT（大块文件会占内存，与 dxf-preview 同级） */
export function parseDxfTextEntities(raw: string): DxfTextEntity[] {
  const lines = raw.split(/\r?\n/)
  const entIdx = findSection(lines, 'ENTITIES')
  if (entIdx < 0) {
    return []
  }

  let i = entIdx
  const out: DxfTextEntity[] = []
  while (i < lines.length - 1) {
    const code = Number(lines[i])
    const val = lines[i + 1]
    i += 2
    if (code === 0 && trimPair(val) === 'ENDSEC') {
      break
    }
    if (code === 0 && trimPair(val) === 'TEXT') {
      const { entity, next } = parseTextEntity(lines, i)
      i = next
      if (entity) {
        out.push(entity)
      }
      continue
    }
    if (code === 0 && trimPair(val) === 'MTEXT') {
      const { entity, next } = parseMtextEntity(lines, i)
      i = next
      if (entity) {
        out.push(entity)
      }
      continue
    }
    if (code === 0) {
      i = skipUnknownEntity(lines, i)
    }
  }
  return out
}
