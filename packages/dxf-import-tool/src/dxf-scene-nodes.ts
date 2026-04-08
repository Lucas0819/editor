/**
 * Helpers: plan segment (level XZ) → Pascal node payloads for dxf-to-scene.
 * Coordinates match WallNode: start/end are [x, z] in level space; Y is world up.
 */

import type { DxfLayerMapping } from './dxf-layer-mapping.ts'
import { canonicalDxfLayerName, dxfTargetToJson, dxfWallNodeDisplayName } from './dxf-layer-mapping.ts'

export type SegmentPlanM = {
  sx: number
  sy: number
  ex: number
  ey: number
  lenM: number
  cx: number
  cz: number
  angleY: number
}

export function planSegmentMetrics(sx: number, sy: number, ex: number, ey: number): SegmentPlanM {
  const cx = (sx + ex) / 2
  const cz = (sy + ey) / 2
  const dx = ex - sx
  const dz = ey - sy
  const lenM = Math.hypot(dx, dz)
  const angleY = Math.atan2(dx, dz)
  return { sx, sy, ex, ey, lenM, cx, cz, angleY }
}

/** Narrow ribbon polygon [x,z][] for a polyline segment (zone / slab outline from 2D lines). */
export function segmentRibbonPolygonXZ(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  halfWidthM: number,
): [number, number][] {
  const dx = ex - sx
  const dz = ey - sy
  const len = Math.hypot(dx, dz) || 1
  const nx = (-dz / len) * halfWidthM
  const nz = (dx / len) * halfWidthM
  return [
    [sx + nx, sy + nz],
    [ex + nx, ey + nz],
    [ex - nx, ey - nz],
    [sx - nx, sy - nz],
  ]
}

/** Placeholder GLB for DXF-imported items (editor resolves /items/... from public). */
export function placeholderItemAssetForCategory(
  catalog: 'furniture' | 'appliance' | 'bathroom' | 'kitchen' | 'outdoor' | 'window' | 'door' | 'unspecified',
): {
  id: string
  category: string
  name: string
  thumbnail: string
  src: string
  dimensions: [number, number, number]
} {
  const base = {
    id: 'dxf-import-placeholder',
    thumbnail: '/items/pillar/thumbnail.webp',
    src: '/items/pillar/model.glb',
    dimensions: [0.5, 0.5, 0.5] as [number, number, number],
  }
  switch (catalog) {
    case 'bathroom':
      return {
        ...base,
        id: 'dxf-import-bathroom',
        category: 'bathroom',
        name: '卫浴（DXF）',
        dimensions: [0.6, 0.9, 0.5],
      }
    case 'kitchen':
      return { ...base, id: 'dxf-import-kitchen', category: 'kitchen', name: '厨房（DXF）' }
    case 'furniture':
      return { ...base, id: 'dxf-import-furniture', category: 'furniture', name: '家具（DXF）' }
    case 'outdoor':
      return { ...base, id: 'dxf-import-outdoor', category: 'outdoor', name: '室外（DXF）' }
    case 'appliance':
    default:
      return { ...base, id: 'dxf-import-appliance', category: 'appliance', name: '设备（DXF）' }
  }
}

export function baseDxfMetadata(
  layer: string,
  li: number,
  mapping: DxfLayerMapping,
  opts?: { dxfFloorLabels?: string[] },
): Record<string, unknown> {
  const canon = canonicalDxfLayerName(layer)
  const tgt = dxfTargetToJson(mapping.target)
  return {
    source: 'dxf-import',
    layer,
    dxfLayerCanonical: canon,
    dxfPascalTarget: tgt,
    dxfMappingConfidence: mapping.confidence,
    levelIndex: li,
    dxfCorrespondenceKey: `${canon}|${JSON.stringify(tgt)}`,
    ...(opts?.dxfFloorLabels?.length ? { dxfFloorLabels: opts.dxfFloorLabels } : {}),
  }
}

export function displayNameForNode(layer: string, mapping: DxfLayerMapping): string {
  return dxfWallNodeDisplayName(layer, mapping)
}

/** 与 `WindowNode` schema 默认一致 — 原始 JSON 未走 Zod 时必须带齐，否则 WindowSystem 会读 undefined.length */
export const DXF_IMPORT_WINDOW_DEFAULTS = {
  frameThickness: 0.05,
  frameDepth: 0.07,
  columnRatios: [1],
  rowRatios: [1],
  columnDividerThickness: 0.03,
  rowDividerThickness: 0.03,
  sill: true,
  sillDepth: 0.08,
  sillThickness: 0.03,
} as const

/** 与编辑器 `WallNode` / `SlabNode` / layout 示例一致：DXF 导入墙与自动生成楼板共用 */
export const DXF_IMPORT_WALL_MATERIAL = {
  preset: 'concrete' as const,
}

/** 与 `DoorNode` schema 默认一致 */
export const DXF_IMPORT_DOOR_DEFAULTS = {
  frameThickness: 0.05,
  frameDepth: 0.07,
  threshold: true,
  thresholdHeight: 0.02,
  hingesSide: 'left' as const,
  swingDirection: 'inward' as const,
  segments: [
    {
      type: 'panel' as const,
      heightRatio: 0.4,
      columnRatios: [1],
      dividerThickness: 0.03,
      panelDepth: 0.01,
      panelInset: 0.04,
    },
    {
      type: 'panel' as const,
      heightRatio: 0.6,
      columnRatios: [1],
      dividerThickness: 0.03,
      panelDepth: 0.01,
      panelInset: 0.04,
    },
  ],
  handle: true,
  handleHeight: 1.05,
  handleSide: 'right' as const,
  contentPadding: [0.04, 0.04] as [number, number],
  doorCloser: false,
  panicBar: false,
  panicBarHeight: 1.0,
}
