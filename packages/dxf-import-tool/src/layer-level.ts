/**
 * Map DXF layer names to Pascal `LevelNode.level` indices (0-based).
 */

export type UnmatchedLayersMode = 'skip' | 'level0'

/**
 * @param layerName — DXF layer string (e.g. `图层 1`)
 * @param regex — must contain one capture group for the floor / level number
 * @param floorOneBased — if true, capture 1 → level index 0 (typical for `图层1`…`图层7`)
 * @returns level index, or `null` if no match / invalid
 */
export function layerNameToLevelIndex(
  layerName: string,
  regex: RegExp,
  floorOneBased: boolean,
): number | null {
  const m = layerName.match(regex)
  if (!m) {
    return null
  }
  const n = Number.parseInt(m[1] ?? '', 10)
  if (!Number.isFinite(n)) {
    return null
  }
  if (floorOneBased) {
    if (n < 1) {
      return null
    }
    return n - 1
  }
  if (n < 0) {
    return null
  }
  return n
}

export function compileLayerRegex(source: string): RegExp {
  return new RegExp(source, 'u')
}
