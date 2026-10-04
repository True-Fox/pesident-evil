import { ORR, ORR_NORMAL } from './layout';

/** Shared numeric policy for the open-world streaming layer. */
export const WORLD_WRAP_SIZE = 4096;
export const WORLD_WRAP_HALF = WORLD_WRAP_SIZE / 2;
/** Length of the authored-looking Ring Road loop, measured along its centre line. */
export const ROAD_LOOP_LENGTH = 1536;
export const ROAD_LOOP_HALF = ROAD_LOOP_LENGTH / 2;

export function wrapWorldPosition(pos: { x: number; z: number }): boolean {
  let changed = false;
  while (pos.x < -WORLD_WRAP_HALF) { pos.x += WORLD_WRAP_SIZE; changed = true; }
  while (pos.x >= WORLD_WRAP_HALF) { pos.x -= WORLD_WRAP_SIZE; changed = true; }
  while (pos.z < -WORLD_WRAP_HALF) { pos.z += WORLD_WRAP_SIZE; changed = true; }
  while (pos.z >= WORLD_WRAP_HALF) { pos.z -= WORLD_WRAP_SIZE; changed = true; }
  return changed;
}

/**
 * The authored road is a finite visual loop. Rebase only actors travelling in its corridor;
 * buildings/campus coordinates stay untouched. This makes both ends use exactly the same road
 * heading and lane offsets, so a straight drive can continue without a dead-end reveal.
 */
export function wrapRoadPosition(pos: { x: number; z: number }): boolean {
  const dx = pos.x - ORR.origin[0], dz = pos.z - ORR.origin[1];
  const across = dx * ORR_NORMAL[0] + dz * ORR_NORMAL[1];
  if (Math.abs(across) > ORR.width * 1.8) return false;
  let t = dx * ORR.dir[0] + dz * ORR.dir[1];
  let changed = false;
  while (t > ROAD_LOOP_HALF) { t -= ROAD_LOOP_LENGTH; changed = true; }
  while (t <= -ROAD_LOOP_HALF) { t += ROAD_LOOP_LENGTH; changed = true; }
  if (changed) {
    pos.x = ORR.origin[0] + ORR.dir[0] * t + ORR_NORMAL[0] * across;
    pos.z = ORR.origin[1] + ORR.dir[1] * t + ORR_NORMAL[1] * across;
  }
  return changed;
}
