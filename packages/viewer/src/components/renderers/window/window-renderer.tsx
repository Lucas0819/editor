import {
  getWindowExteriorFlushLocalZ,
  useRegistry,
  useScene,
  type AnyNode,
  type WallNode,
  type WindowNode,
} from '@pascal-app/core'
import { useMemo, useRef } from 'react'
import type { Mesh } from 'three'
import { useNodeEvents } from '../../../hooks/use-node-events'
import { createMaterial, DEFAULT_WINDOW_MATERIAL } from '../../../lib/materials'

export const WindowRenderer = ({ node }: { node: WindowNode }) => {
  const ref = useRef<Mesh>(null!)

  useRegistry(node.id, 'window', ref)
  const handlers = useNodeEvents(node, 'window')
  const isTransient = !!(node.metadata as Record<string, unknown> | null)?.isTransient

  const nodes = useScene((s) => s.nodes) as Record<string, AnyNode>
  const wall = node.parentId ? (nodes[node.parentId] as WallNode | undefined) : undefined
  const zFlush = useMemo(() => {
    if (!wall || wall.type !== 'wall') return 0
    return getWindowExteriorFlushLocalZ(
      wall,
      node,
      nodes as Record<string, { type?: string; start?: [number, number]; end?: [number, number] }>,
    )
  }, [wall, node, nodes])

  const material = useMemo(() => {
    const mat = node.material
    if (!mat) return DEFAULT_WINDOW_MATERIAL
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
