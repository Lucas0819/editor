import {
  getDoorExteriorFlushLocalZ,
  useRegistry,
  useScene,
  type AnyNode,
  type DoorNode,
  type WallNode,
} from '@pascal-app/core'
import { useMemo, useRef } from 'react'
import type { Mesh } from 'three'
import { useNodeEvents } from '../../../hooks/use-node-events'
import { createMaterial, DEFAULT_DOOR_MATERIAL } from '../../../lib/materials'

export const DoorRenderer = ({ node }: { node: DoorNode }) => {
  const ref = useRef<Mesh>(null!)

  useRegistry(node.id, 'door', ref)
  const handlers = useNodeEvents(node, 'door')
  const isTransient = !!(node.metadata as Record<string, unknown> | null)?.isTransient

  const nodes = useScene((s) => s.nodes) as Record<string, AnyNode>
  const wall = node.parentId ? (nodes[node.parentId] as WallNode | undefined) : undefined
  const zFlush = useMemo(() => {
    if (!wall || wall.type !== 'wall') return 0
    return getDoorExteriorFlushLocalZ(
      wall,
      node,
      nodes as Record<string, { type?: string; start?: [number, number]; end?: [number, number] }>,
    )
  }, [wall, node, nodes])

  const material = useMemo(() => {
    const mat = node.material
    if (!mat) return DEFAULT_DOOR_MATERIAL
    return createMaterial(mat)
  }, [node.material, node.material?.preset, node.material?.properties, node.material?.texture])

  return (
    <mesh
      castShadow
      material={material}
      position={[node.position[0], node.position[1], node.position[2] + zFlush]}
      receiveShadow
      ref={ref}
      rotation={node.rotation}
      visible={node.visible}
      {...(isTransient ? {} : handlers)}
    >
      <boxGeometry args={[0, 0, 0]} />
    </mesh>
  )
}
