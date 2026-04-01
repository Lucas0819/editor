/**
 * Minimal ASCII DXF parser: HEADER ($INSUNITS, $EXTMIN) + ENTITIES (LINE, LWPOLYLINE only).
 * Sufficient for plan exports; ignores blocks/xrefs.
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
} {
  const lines = text.split(/\r?\n/)
  const headerIdx = findSection(lines, 'HEADER')
  const header =
    headerIdx >= 0 ? parseHeader(lines, headerIdx) : { insUnits: 6, extMin: { x: 0, y: 0, z: 0 } }

  const entIdx = findSection(lines, 'ENTITIES')
  if (entIdx < 0) {
    return { header, segments: [] }
  }

  let i = entIdx
  const segments: PlanSegment[] = []

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
    if (code === 0) {
      i = skipUnknownEntity(lines, i)
    }
  }

  return { header, segments }
}
