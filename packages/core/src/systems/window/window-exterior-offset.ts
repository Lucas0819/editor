import type { WallNode, WindowNode } from '../../schema'
import { getWallThickness } from '../wall/wall-footprint'

type NodesForCenter = Record<string, { type?: string; start?: [number, number]; end?: [number, number] }>

/**
 * Rough footprint center (world XZ plane; wall `start[1]` is Z) from wall segment mids.
 */
export function estimateBuildingCenterXZ(nodes: NodesForCenter): [number, number] {
  let sx = 0
  let sz = 0
  let n = 0
  for (const node of Object.values(nodes)) {
    if (node.type !== 'wall' || !node.start || !node.end) continue
    sx += (node.start[0] + node.end[0]) / 2
    sz += (node.start[1] + node.end[1]) / 2
    n++
  }
  if (n === 0) return [0, 0]
  return [sx / n, sz / n]
}

/**
 * Extra offset along **parent wall local +Z** (thickness direction) to add to `node.position[2]`.
 * Windows are authored with `position.z === 0` on the wall mid-plane; centering the frame in the
 * wall thickness recesses glass from the exterior façade. Shifting toward the building exterior
 * aligns the outer frame face with the outer wall surface so openings read clearly in opaque
 * viewers and in GLB — and stays consistent with wall CSG cutouts (cutout is a child of the
 * window mesh and moves with it).
 */
export function getWindowExteriorFlushLocalZ(
  wall: WallNode,
  windowNode: WindowNode,
  nodes: NodesForCenter,
): number {
  const t = getWallThickness(wall)
  const fd = windowNode.frameDepth
  const gap = Math.max(0, t / 2 - fd / 2)
  const epsilon = 0.002
  const delta = Math.min(0.08, gap + epsilon)

  const bc = estimateBuildingCenterXZ(nodes)
  const wmx = (wall.start[0] + wall.end[0]) / 2
  const wmz = (wall.start[1] + wall.end[1]) / 2
  let hx = wmx - bc[0]
  let hz = wmz - bc[1]
  const len = Math.hypot(hx, hz)
  if (len < 1e-8) {
    hx = 1
    hz = 0
  } else {
    hx /= len
    hz /= len
  }

  const dx = wall.end[0] - wall.start[0]
  const dz = wall.end[1] - wall.start[1]
  const L = Math.hypot(dx, dz) || 1
  const lx = -dz / L
  const lz = dx / L

  const align = lx * hx + lz * hz
  const sign = align >= 0 ? 1 : -1
  return sign * delta
}
