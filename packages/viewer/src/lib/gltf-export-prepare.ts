import { PASCAL_NODE_ID_KEY, PASCAL_NODE_TYPE_KEY } from '@pascal-app/core'
import * as THREE from 'three'
import {
  GLTF_EXPORT_USERDATA_KEYS,
  type PascalExportNodeType,
} from './gltf-export-rules'

function hasPascalRootTag(obj: THREE.Object3D): obj is THREE.Object3D & {
  userData: { [PASCAL_NODE_ID_KEY]: string; [PASCAL_NODE_TYPE_KEY]: PascalExportNodeType }
} {
  const id = obj.userData[PASCAL_NODE_ID_KEY]
  const t = obj.userData[PASCAL_NODE_TYPE_KEY]
  return typeof id === 'string' && typeof t === 'string'
}

function materialsFullyInvisible(material: THREE.Material | THREE.Material[] | undefined): boolean {
  if (!material) return false
  const arr = Array.isArray(material) ? material : [material]
  if (arr.length === 0) return false
  return arr.every((m) => m.visible === false)
}

/**
 * glTF 不表示 `Material.visible`；不可见材质会被导出成默认不透明，例如窗体根 hitbox。
 * 在导出克隆上移除此类几何；若有子节点（框、玻璃、cutout 等），用 Group 承接变换以保留层级。
 */
export function stripInvisibleDrawablesForGltfExport(root: THREE.Object3D): void {
  const snapshot = [...root.children]
  for (const child of snapshot) {
    stripInvisibleDrawablesForGltfExport(child)
  }

  const skinned = root as THREE.Object3D & { isSkinnedMesh?: boolean }
  if (skinned.isSkinnedMesh) {
    if (materialsFullyInvisible((root as THREE.SkinnedMesh).material)) {
      root.parent?.remove(root)
      ;(root as THREE.SkinnedMesh).geometry?.dispose()
    }
    return
  }

  const mesh = root as THREE.Mesh
  const line = root as THREE.Line
  const pts = root as THREE.Points
  const isDrawable = mesh.isMesh || line.isLine || pts.isPoints
  if (!isDrawable) return
  if (!materialsFullyInvisible(mesh.isMesh ? mesh.material : line.isLine ? line.material : pts.material)) {
    return
  }

  const drawable = mesh.isMesh ? mesh : line.isLine ? line : pts
  const parent = drawable.parent
  if (!parent) return

  if (drawable.children.length > 0) {
    const group = new THREE.Group()
    group.name = drawable.name
    Object.assign(group.userData, drawable.userData)
    group.position.copy(drawable.position)
    group.quaternion.copy(drawable.quaternion)
    group.scale.copy(drawable.scale)
    group.matrix.copy(drawable.matrix)
    group.matrixWorld.copy(drawable.matrixWorld)
    group.matrixAutoUpdate = drawable.matrixAutoUpdate

    while (drawable.children.length > 0) {
      const c = drawable.children[0]!
      drawable.remove(c)
      group.add(c)
    }
    parent.remove(drawable)
    parent.add(group)
    drawable.geometry.dispose()
  } else {
    parent.remove(drawable)
    drawable.geometry.dispose()
  }
}

/**
 * Walk the tree and set `userData.type` / `userData.nodeId` on every Object3D from the
 * nearest registered ancestor (so child meshes inherit wall/window/door, etc.).
 */
export function propagatePascalMetadataForExport(root: THREE.Object3D): void {
  const walk = (
    obj: THREE.Object3D,
    inherited: { id: string; type: PascalExportNodeType } | null,
  ) => {
    let next = inherited
    if (hasPascalRootTag(obj)) {
      next = { id: obj.userData[PASCAL_NODE_ID_KEY], type: obj.userData[PASCAL_NODE_TYPE_KEY] }
    }
    const effective = next ?? inherited
    if (effective) {
      obj.userData[GLTF_EXPORT_USERDATA_KEYS.type] = effective.type
      obj.userData[GLTF_EXPORT_USERDATA_KEYS.nodeId] = effective.id
    }
    for (const c of obj.children) {
      walk(c, next ?? inherited)
    }
  }
  walk(root, null)
}

function convertSingleMaterial(material: THREE.Material): THREE.Material {
  const mAny = material as THREE.Material & {
    isShaderMaterial?: boolean
    isMeshStandardMaterial?: boolean
    isMeshPhysicalMaterial?: boolean
    isMeshBasicMaterial?: boolean
  }
  if (mAny.isShaderMaterial) {
    return new THREE.MeshStandardMaterial({
      color: 0x888888,
      roughness: 1,
      metalness: 0,
      name: material.name || 'shader-fallback',
    })
  }

  if (
    (material as unknown as { isLineBasicNodeMaterial?: boolean }).isLineBasicNodeMaterial === true ||
    material.type === 'LineBasicNodeMaterial'
  ) {
    const lineMat = material as THREE.LineBasicMaterial
    return new THREE.LineBasicMaterial({
      name: material.name,
      color: lineMat.color?.clone?.() ?? new THREE.Color(0xffffff),
      transparent: lineMat.transparent,
      opacity: lineMat.opacity,
    })
  }

  // MeshBasicNodeMaterial (WebGPU)
  if (
    (material as unknown as { isMeshBasicNodeMaterial?: boolean }).isMeshBasicNodeMaterial ===
      true ||
    material.type === 'MeshBasicNodeMaterial'
  ) {
    const mb = material as THREE.MeshBasicMaterial
    return new THREE.MeshBasicMaterial({
      name: material.name,
      color: mb.color?.clone?.() ?? new THREE.Color(0xffffff),
      map: mb.map ?? null,
      transparent: mb.transparent,
      opacity: mb.opacity,
      side: mb.side,
      depthWrite: mb.depthWrite,
      depthTest: mb.depthTest,
    })
  }

  // MeshPhysicalNodeMaterial — approximate as physical
  if (
    (material as unknown as { isMeshPhysicalNodeMaterial?: boolean }).isMeshPhysicalNodeMaterial ===
      true ||
    material.type === 'MeshPhysicalNodeMaterial'
  ) {
    const p = material as THREE.MeshPhysicalMaterial
    return new THREE.MeshPhysicalMaterial({
      name: material.name,
      color: p.color?.clone?.() ?? new THREE.Color(0xffffff),
      roughness: p.roughness ?? 1,
      metalness: p.metalness ?? 0,
      opacity: p.opacity ?? 1,
      transparent: p.transparent ?? false,
      side: p.side,
      emissive: p.emissive?.clone?.() ?? new THREE.Color(0x000000),
      emissiveIntensity: p.emissiveIntensity ?? 1,
      transmission: p.transmission ?? 0,
      thickness: p.thickness ?? 0,
      ior: p.ior ?? 1.5,
      depthWrite: p.depthWrite,
    })
  }

  // MeshStandardNodeMaterial (WebGPU)
  if (
    (material as unknown as { isMeshStandardNodeMaterial?: boolean }).isMeshStandardNodeMaterial ===
      true ||
    material.type === 'MeshStandardNodeMaterial'
  ) {
    const m = material as THREE.MeshStandardMaterial & {
      opacityNode?: unknown
    }
    const out = new THREE.MeshStandardMaterial({
      name: material.name,
      color: m.color?.clone?.() ?? new THREE.Color(0xffffff),
      roughness: m.roughness ?? 1,
      metalness: m.metalness ?? 0,
      opacity: m.opacity ?? 1,
      transparent: m.transparent ?? false,
      side: m.side ?? THREE.FrontSide,
      emissive: m.emissive?.clone?.() ?? new THREE.Color(0x000000),
      emissiveIntensity: m.emissiveIntensity ?? 1,
      depthWrite: m.depthWrite ?? true,
    })
    if (m.map) out.map = m.map
    if (m.normalMap) out.normalMap = m.normalMap
    if (m.roughnessMap) out.roughnessMap = m.roughnessMap
    if (m.metalnessMap) out.metalnessMap = m.metalnessMap
    if (m.aoMap) out.aoMap = m.aoMap
    if (m.emissiveMap) out.emissiveMap = m.emissiveMap
    // Wall cutaway / dotted opacity uses a node graph — approximate for glTF
    if (m.opacityNode) {
      out.transparent = true
      out.opacity = 0.24
      out.depthWrite = false
    }
    return out
  }

  // Native materials: clone so export tree does not share mutable state with the live scene
  if (mAny.isMeshStandardMaterial) {
    return (material as THREE.MeshStandardMaterial).clone()
  }
  if (mAny.isMeshPhysicalMaterial) {
    return (material as THREE.MeshPhysicalMaterial).clone()
  }
  if (mAny.isMeshBasicMaterial) {
    return (material as THREE.MeshBasicMaterial).clone()
  }

  return new THREE.MeshStandardMaterial({
    color: 0xcccccc,
    roughness: 1,
    metalness: 0,
    name: material.name || 'unknown-material',
  })
}

export function convertMaterialsForGltfExport(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return

    const m = mesh.material
    if (Array.isArray(m)) {
      mesh.material = m.map((mat) => convertSingleMaterial(mat))
    } else {
      mesh.material = convertSingleMaterial(m)
    }
  })
}

/**
 * Run before `GLTFExporter.parse`: metadata for extras + glTF–safe materials.
 * Call on a **clone** of the scene subtree you intend to export (not the live scene).
 */
export function prepareObject3DForGltfExport(root: THREE.Object3D): void {
  stripInvisibleDrawablesForGltfExport(root)
  propagatePascalMetadataForExport(root)
  convertMaterialsForGltfExport(root)
}
