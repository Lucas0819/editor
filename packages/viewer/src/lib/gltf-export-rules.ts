import { sceneRegistry } from '@pascal-app/core'

/**
 * All Pascal scene node kinds that register a root Object3D (`useRegistry`).
 * Keep in sync with `sceneRegistry.byType` in `@pascal-app/core`.
 */
export type PascalExportNodeType = keyof typeof sceneRegistry.byType

export const PASCAL_EXPORT_NODE_TYPES = Object.keys(sceneRegistry.byType) as PascalExportNodeType[]

/**
 * Material conversion runs on every mesh in the export subtree; it is not gated by node type.
 * `PASCAL_EXPORT_NODE_TYPES` lists every kind that registers a root Object3D.
 */

/**
 * Types that export geometry but look wrong or incomplete in a generic glTF viewer
 * (app-specific rendering, editor-only, or container-only).
 */
export const GLTF_EXPORT_LIMITED_TYPES: {
  type: PascalExportNodeType
  reason: string
}[] = [
  {
    type: 'zone',
    reason:
      'Uses ZONE_LAYER and MeshBasicNodeMaterial; intended for the editor post-process pass — flat viewers lose overlay composition.',
  },
  {
    type: 'guide',
    reason: 'Temporary editor guides — not meant as final scene geometry.',
  },
  {
    type: 'scan',
    reason: 'Depends on scan asset format and opacity; may be heavy or need KTX2/environment.',
  },
  {
    type: 'level',
    reason: 'Usually an empty transform; children carry the visible content.',
  },
  {
    type: 'site',
    reason: 'Often a container or ground helper; minimal mesh on its own.',
  },
  {
    type: 'building',
    reason: 'Structural container; visible content lives under levels.',
  },
]

/** Keys on each exported node’s `extras` (from Three.js `userData`). */
export const GLTF_EXPORT_USERDATA_KEYS = {
  /** Pascal node id, e.g. `wall_abc123` */
  nodeId: 'nodeId',
  /** Pascal node kind, e.g. `wall` */
  type: 'type',
} as const
