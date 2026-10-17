import { quatFromAxisAngle, quatFromYaw, quatMul, rotateVec, sub, length, scale, add, type Quat, type Vec3 } from './math';

export type ArenaBlockKind = 'floor' | 'barrier' | 'platform' | 'ramp' | 'cover' | 'pillar' | 'jump';

export interface ArenaBlock {
  kind: ArenaBlockKind;
  center: Vec3;
  half: Vec3;
  rotation: Quat;
}

export interface SpawnPoint {
  position: Vec3;
  yaw: number;
}

export const ARENA_HALF_SIZE = 40;
export const PLATFORM_HALF = 7;
export const PLATFORM_HEIGHT = 1.5;
export const BARRIER_HEIGHT = 2.2;

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

function box(kind: ArenaBlockKind, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw = 0): ArenaBlock {
  return { kind, center: { x: cx, y: cy, z: cz }, half: { x: hx, y: hy, z: hz }, rotation: yaw === 0 ? IDENTITY : quatFromYaw(yaw) };
}

/**
 * Builds a ramp whose TOP surface runs from `low` to `high` (both points on the
 * top surface centerline). The box extends `thickness` below that surface.
 */
function ramp(kind: ArenaBlockKind, low: Vec3, high: Vec3, width: number, thickness: number): ArenaBlock {
  const dir = sub(high, low);
  const len = length(dir);
  const yaw = Math.atan2(dir.x, dir.z);
  const pitch = -Math.asin(dir.y / len);
  const rotation = quatMul(quatFromYaw(yaw), quatFromAxisAngle({ x: 1, y: 0, z: 0 }, pitch));
  const normal = rotateVec(rotation, { x: 0, y: 1, z: 0 });
  const mid = scale(add(low, high), 0.5);
  const center = sub(mid, scale(normal, thickness / 2));
  return { kind, center, half: { x: width / 2, y: thickness / 2, z: len / 2 }, rotation };
}

function buildArena(): ArenaBlock[] {
  const H = ARENA_HALF_SIZE;
  const blocks: ArenaBlock[] = [];

  blocks.push(box('floor', 0, -0.5, 0, H + 2, 0.5, H + 2));

  const bh = BARRIER_HEIGHT / 2;
  blocks.push(box('barrier', 0, bh, H + 0.6, H + 1.2, bh, 0.6));
  blocks.push(box('barrier', 0, bh, -H - 0.6, H + 1.2, bh, 0.6));
  blocks.push(box('barrier', H + 0.6, bh, 0, 0.6, bh, H + 1.2));
  blocks.push(box('barrier', -H - 0.6, bh, 0, 0.6, bh, H + 1.2));

  blocks.push(box('platform', 0, PLATFORM_HEIGHT / 2, 0, PLATFORM_HALF, PLATFORM_HEIGHT / 2, PLATFORM_HALF));

  const rampLen = 8;
  const edge = PLATFORM_HALF;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const dx = Math.sin(a);
    const dz = Math.cos(a);
    const high = { x: dx * edge, y: PLATFORM_HEIGHT, z: dz * edge };
    const low = { x: dx * (edge + rampLen), y: 0, z: dz * (edge + rampLen) };
    blocks.push(ramp('ramp', low, high, 6, 1.6));
  }

  // Jump ramps with a sheer drop at the high end.
  blocks.push(ramp('jump', { x: 23, y: 0, z: -6 }, { x: 23, y: 1.25, z: 3 }, 4.5, 2.8));
  blocks.push(ramp('jump', { x: -23, y: 0, z: 6 }, { x: -23, y: 1.25, z: -3 }, 4.5, 2.8));

  // Low cover walls, pinwheel around the platform.
  blocks.push(box('cover', 15, 0.6, 10, 3.5, 0.6, 0.4));
  blocks.push(box('cover', -15, 0.6, -10, 3.5, 0.6, 0.4));
  blocks.push(box('cover', 10, 0.6, -15, 3.5, 0.6, 0.4, Math.PI / 2));
  blocks.push(box('cover', -10, 0.6, 15, 3.5, 0.6, 0.4, Math.PI / 2));

  // Diagonal corner walls.
  blocks.push(box('cover', 27, 0.6, 27, 4, 0.6, 0.4, Math.PI / 4));
  blocks.push(box('cover', -27, 0.6, 27, 4, 0.6, 0.4, -Math.PI / 4));
  blocks.push(box('cover', 27, 0.6, -27, 4, 0.6, 0.4, -Math.PI / 4));
  blocks.push(box('cover', -27, 0.6, -27, 4, 0.6, 0.4, Math.PI / 4));

  // Lane walls near the barriers.
  blocks.push(box('cover', 0, 0.6, 31, 5, 0.6, 0.4));
  blocks.push(box('cover', 0, 0.6, -31, 5, 0.6, 0.4));
  blocks.push(box('cover', 31, 0.6, 0, 5, 0.6, 0.4, Math.PI / 2));
  blocks.push(box('cover', -31, 0.6, 0, 5, 0.6, 0.4, Math.PI / 2));

  // Tall pillars for line-of-sight breaks.
  for (const [x, z] of [
    [18, 19],
    [-18, 19],
    [18, -19],
    [-18, -19],
  ] as const) {
    blocks.push(box('pillar', x, 2.2, z, 1.2, 2.2, 1.2));
  }

  return blocks;
}

export const ARENA_BLOCKS: readonly ArenaBlock[] = buildArena();

function buildSpawns(): SpawnPoint[] {
  const out: SpawnPoint[] = [];
  const r = 33;
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + (i * Math.PI) / 4;
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    out.push({ position: { x, y: 1.4, z }, yaw: Math.atan2(-x, -z) });
  }
  return out;
}

export const SPAWN_POINTS: readonly SpawnPoint[] = buildSpawns();
