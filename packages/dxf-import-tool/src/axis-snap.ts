/**
 * Snap nearly axis-aligned plan segments to exact horizontal/vertical in meter space,
 * so tiny floating-point drift in DXF (e.g. LWPOLYLINE vertices) does not skew walls.
 */

import type { PlanSegment } from './parse-dxf-entities.ts'

function toMeters(
  x: number,
  y: number,
  ox: number,
  oy: number,
  scale: number,
  useOffset: boolean,
): [number, number] {
  const px = useOffset ? x - ox : x
  const py = useOffset ? y - oy : y
  return [px * scale, py * scale]
}

function fromMeters(
  mx: number,
  my: number,
  ox: number,
  oy: number,
  scale: number,
  useOffset: boolean,
): [number, number] {
  if (useOffset) {
    return [mx / scale + ox, my / scale + oy]
  }
  return [mx / scale, my / scale]
}

/**
 * @param toleranceM - Max deviation (meters) from axis to snap; 0 disables.
 */
export function snapPlanSegmentsToAxis(
  segments: PlanSegment[],
  ox: number,
  oy: number,
  scale: number,
  useOffset: boolean,
  toleranceM: number,
): PlanSegment[] {
  if (toleranceM <= 0 || !Number.isFinite(toleranceM)) {
    return segments
  }

  return segments.map((s) => snapOne(s, ox, oy, scale, useOffset, toleranceM))
}

function snapOne(
  s: PlanSegment,
  ox: number,
  oy: number,
  scale: number,
  useOffset: boolean,
  toleranceM: number,
): PlanSegment {
  const [sx0, sy0] = toMeters(s.x0, s.y0, ox, oy, scale, useOffset)
  const [sx1, sy1] = toMeters(s.x1, s.y1, ox, oy, scale, useOffset)
  const dx = sx1 - sx0
  const dy = sy1 - sy0

  let x1 = sx1
  let y1 = sy1

  // Nearly horizontal: force end Y to match start Y (length ≈ |dx|).
  if (Math.abs(dy) <= toleranceM && Math.abs(dx) > toleranceM) {
    y1 = sy0
  } else if (Math.abs(dx) <= toleranceM && Math.abs(dy) > toleranceM) {
    // Nearly vertical: force end X to match start X.
    x1 = sx0
  }

  const [rx0, ry0] = fromMeters(sx0, sy0, ox, oy, scale, useOffset)
  const [rx1, ry1] = fromMeters(x1, y1, ox, oy, scale, useOffset)

  return {
    ...s,
    x0: rx0,
    y0: ry0,
    x1: rx1,
    y1: ry1,
  }
}
