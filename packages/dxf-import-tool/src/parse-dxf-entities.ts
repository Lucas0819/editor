/**
 * Minimal ASCII DXF parser: HEADER ($INSUNITS, $EXTMIN) + ENTITIES (LINE, LWPOLYLINE, INSERT).
 * INSERT 由上层（柱 / 门窗）按图层映射处理；本文件仅解析几何与块参数。
 */

export type DxfHeader = {
  /** AutoCAD INSUNITS code; 4 = mm, 6 = m */
  insUnits: number
  extMin: { x: number; y: number; z: number }
}

export type PlanSegment = {
  x0: number
  y0: number
  x1: number
  y1: number
  layer: string
  /** 由 INSERT 块展开得到的边，不参与双线合并 */
  fromInsert?: boolean
  /**
   * 柱 INSERT 单根墙：墙厚（米），由块 sy/sx 与 INSUNITS 换算，与中心线几何长度解耦。
   * 仅 `dxf-column-inserts` 写入。
   */
  columnThicknessM?: number
}

/** ENTITIES 中 INSERT：插入点 + XYZ 比例 + 转角（块名用于柱/门窗分流） */
export type PlanInsert = {
  layer: string
  /** 块名（可含 xref 前缀） */
  blockName: string
  bx: number
  by: number
  sx: number
  sy: number
  sz: number
  rotationDeg: number
  /** INSERT 后 ATTRIB：组码 2=tag、1=value（天正等可能含开向文字） */
  attribs?: Record<string, string>
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

function parseHeader(lines: string[], start: number): DxfHeader {
  let insUnits = 6
  const extMin = { x: 0, y: 0, z: 0 }
  let i = start
  while (i < lines.length - 1) {
    const code = Number(lines[i])
    const val = lines[i + 1]
    i += 2
    if (code === 0 && trimPair(val) === 'ENDSEC') {
      break
    }
    if (code === 9 && val === '$INSUNITS') {
      if (Number(lines[i]) === 70) {
        insUnits = Number.parseInt(trimPair(lines[i + 1]), 10)
        i += 2
      }
    }
    if (code === 9 && val === '$EXTMIN') {
      let x = 0
      let y = 0
      let z = 0
      while (i < lines.length - 1) {
        const c = Number(lines[i])
        const v = lines[i + 1]
        i += 2
        if (c === 9 || c === 0) {
          i -= 2
          break
        }
        if (c === 10) x = Number.parseFloat(trimPair(v))
        if (c === 20) y = Number.parseFloat(trimPair(v))
        if (c === 30) z = Number.parseFloat(trimPair(v))
      }
      extMin.x = x
      extMin.y = y
      extMin.z = z
    }
  }
  return { insUnits, extMin }
}

function parseLineEntity(
  lines: string[],
  start: number,
): { seg: PlanSegment | null; next: number } {
  let i = start
  let x0 = 0
  let y0 = 0
  let x1 = 0
  let y1 = 0
  let layer = ''
  while (i < lines.length - 1) {
    const code = Number(lines[i])
    const val = lines[i + 1]
    i += 2
    if (code === 0) {
      const dx = x1 - x0
      const dy = y1 - y0
      if (dx * dx + dy * dy < 1e-20) {
        return { seg: null, next: i - 2 }
      }
      return {
        seg: { x0, y0, x1, y1, layer },
        next: i - 2,
      }
    }
    if (code === 8) layer = trimPair(val)
    if (code === 10) x0 = Number.parseFloat(trimPair(val))
    if (code === 20) y0 = Number.parseFloat(trimPair(val))
    if (code === 11) x1 = Number.parseFloat(trimPair(val))
    if (code === 21) y1 = Number.parseFloat(trimPair(val))
  }
  return { seg: null, next: start }
}

function parseLwPolylineEntity(
  lines: string[],
  start: number,
): { segments: PlanSegment[]; next: number } {
  let i = start
  const verts: [number, number][] = []
  let layer = ''
  let closed = false
  while (i < lines.length - 1) {
    const code = Number(lines[i])
    const val = lines[i + 1]
    i += 2
    if (code === 0) {
      const segments: PlanSegment[] = []
      for (let k = 0; k < verts.length - 1; k++) {
        const a = verts[k]
        const b = verts[k + 1]
        if (a && b) {
          segments.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1], layer })
        }
      }
      if (closed && verts.length > 2) {
        const a = verts[verts.length - 1]
        const b = verts[0]
        if (a && b) {
          segments.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1], layer })
        }
      }
      return { segments, next: i - 2 }
    }
    if (code === 8) layer = trimPair(val)
    if (code === 70) {
      const f = Number.parseInt(trimPair(val), 10)
      closed = (f & 1) === 1
    }
    if (code === 10) {
      const x = Number.parseFloat(trimPair(val))
      const c20 = Number(lines[i])
      const vy = lines[i + 1]
      if (c20 === 20) {
        const y = Number.parseFloat(trimPair(vy))
        verts.push([x, y])
        i += 2
      }
    }
  }
  return { segments: [], next: start }
}

/** 解析单个 ATTRIB 实体（从 code 0 ATTRIB 之后到下一 code 0 之前） */
function parseAttribEntity(lines: string[], start: number): { tag: string; value: string; next: number } {
  let i = start
  let tag = ''
  let value = ''
  while (i < lines.length - 1) {
    const code = Number(lines[i])
    const val = lines[i + 1]
    i += 2
    if (code === 0) {
      return { tag, value, next: i - 2 }
    }
    if (code === 2) tag = trimPair(val)
    if (code === 1) value = trimPair(val)
  }
  return { tag, value, next: start }
}

function parseInsertEntity(
  lines: string[],
  start: number,
): { insert: PlanInsert | null; next: number } {
  let i = start
  let layer = ''
  let blockName = ''
  let bx = 0
  let by = 0
  let sx = 1
  let sy = 1
  let sz = 1
  let rot = 0
  const attribPairs: [string, string][] = []
  while (i < lines.length - 1) {
    const code = Number(lines[i])
    const val = lines[i + 1]
    if (code === 0) {
      const v = trimPair(val)
      /** 下一实体以 code 0 开头：LINE / INSERT / … 均结束当前 INSERT（勿把「0 INSERT」当嵌套而 skip，否则会吞掉相邻块参照）。 */
      if (v === 'ATTRIB') {
        i += 2
        const { tag, value, next } = parseAttribEntity(lines, i)
        i = next
        if (tag.length > 0 || value.length > 0) {
          attribPairs.push([tag, value])
        }
        continue
      }
      if (v === 'SEQEND') {
        i += 2
        if (!Number.isFinite(sx) || sx === 0) {
          sx = 1
        }
        if (!Number.isFinite(sy) || sy === 0) {
          sy = 1
        }
        if (!Number.isFinite(sz) || sz === 0) {
          sz = 1
        }
        if (!Number.isFinite(rot)) {
          rot = 0
        }
        const attribs =
          attribPairs.length > 0 ? Object.fromEntries(attribPairs.filter(([t]) => t.length > 0)) : undefined
        return {
          insert: { layer, blockName, bx, by, sx, sy, sz, rotationDeg: rot, attribs },
          next: i,
        }
      }
      /** 无 ATTRIB 的 INSERT：下一实体（LINE/LWPOLYLINE/…）的 0 开头即结束 */
      if (!Number.isFinite(sx) || sx === 0) {
        sx = 1
      }
      if (!Number.isFinite(sy) || sy === 0) {
        sy = 1
      }
      if (!Number.isFinite(sz) || sz === 0) {
        sz = 1
      }
      if (!Number.isFinite(rot)) {
        rot = 0
      }
      const attribs =
        attribPairs.length > 0 ? Object.fromEntries(attribPairs.filter(([t]) => t.length > 0)) : undefined
      return {
        insert: { layer, blockName, bx, by, sx, sy, sz, rotationDeg: rot, attribs },
        next: i,
      }
    }
    i += 2
    if (code === 8) layer = trimPair(val)
    if (code === 2) blockName = trimPair(val)
    if (code === 10) bx = Number.parseFloat(trimPair(val))
    if (code === 20) by = Number.parseFloat(trimPair(val))
    if (code === 41) sx = Number.parseFloat(trimPair(val))
    if (code === 42) sy = Number.parseFloat(trimPair(val))
    if (code === 43) sz = Number.parseFloat(trimPair(val))
    if (code === 50) rot = Number.parseFloat(trimPair(val))
  }
  return { insert: null, next: start }
}

function skipUnknownEntity(lines: string[], start: number): number {
  let i = start
  while (i < lines.length - 1) {
    const code = Number(lines[i])
    const val = lines[i + 1]
    i += 2
    if (code === 0) {
      return i - 2
    }
  }
  return start
}

/** INSUNITS code → multiply raw numbers to get meters */
export function insUnitsToMetersFactor(insUnits: number): number {
  switch (insUnits) {
    case 0:
      return 1
    case 1:
      return 0.0254
    case 2:
      return 0.3048
    case 3:
      return 1609.344
    case 4:
      return 0.001
    case 5:
      return 0.01
    case 6:
      return 1
    case 7:
      return 1000
    case 8:
      return 1e-6
    case 9:
      return 0.0254
    case 10:
      return 1e-10
    default:
      return 1
  }
}

export function parseDxfPlanSegments(text: string): {
  header: DxfHeader
  segments: PlanSegment[]
  /** 未展开的 INSERT；由 dxf-to-scene 按图层是否为柱再展开为 segments */
  inserts: PlanInsert[]
} {
  const lines = text.split(/\r?\n/)
  const headerIdx = findSection(lines, 'HEADER')
  const header =
    headerIdx >= 0 ? parseHeader(lines, headerIdx) : { insUnits: 6, extMin: { x: 0, y: 0, z: 0 } }

  const entIdx = findSection(lines, 'ENTITIES')
  if (entIdx < 0) {
    return { header, segments: [], inserts: [] }
  }

  let i = entIdx
  const segments: PlanSegment[] = []
  const inserts: PlanInsert[] = []

  while (i < lines.length - 1) {
    const code = Number(lines[i])
    const val = lines[i + 1]
    i += 2
    if (code === 0 && trimPair(val) === 'ENDSEC') {
      break
    }
    if (code === 0 && trimPair(val) === 'LINE') {
      const { seg, next } = parseLineEntity(lines, i)
      i = next
      if (seg) {
        segments.push(seg)
      }
      continue
    }
    if (code === 0 && trimPair(val) === 'LWPOLYLINE') {
      const { segments: segs, next } = parseLwPolylineEntity(lines, i)
      i = next
      segments.push(...segs)
      continue
    }
    if (code === 0 && trimPair(val) === 'INSERT') {
      const { insert, next } = parseInsertEntity(lines, i)
      i = next
      if (insert) {
        inserts.push(insert)
      }
      continue
    }
    if (code === 0) {
      i = skipUnknownEntity(lines, i)
    }
  }

  return { header, segments, inserts }
}

/**
 * 从 `TABLES` → `LAYER` 表提取全部图层名（去重，顺序不保证）。
 */
export function parseDxfLayerTableNames(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const secStart = findSection(lines, 'TABLES')
  if (secStart < 0) {
    return []
  }
  let i = secStart
  let inLayerTable = false
  const names: string[] = []
  while (i < lines.length - 1) {
    const code = Number(lines[i])
    const val = trimPair(lines[i + 1])
    if (code === 0 && val === 'ENDSEC') {
      break
    }
    if (code === 0 && val === 'ENDTAB') {
      inLayerTable = false
      i += 2
      continue
    }
    if (code === 0 && val === 'TABLE') {
      i += 2
      if (i < lines.length - 1 && Number(lines[i]) === 2) {
        inLayerTable = trimPair(lines[i + 1]) === 'LAYER'
      } else {
        inLayerTable = false
      }
      i += 2
      continue
    }
    if (inLayerTable && code === 100 && val === 'AcDbLayerTableRecord') {
      i += 2
      if (i < lines.length - 1 && Number(lines[i]) === 2) {
        names.push(trimPair(lines[i + 1]))
        i += 2
        continue
      }
    }
    i += 2
  }
  return [...new Set(names)]
}
