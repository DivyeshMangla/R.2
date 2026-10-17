import RAPIER from '@dimforge/rapier3d-compat';
import type { Collider, World } from '@dimforge/rapier3d-compat';
import { CollisionGroups } from './collisionGroups';
import type { Vec3 } from './math';

export interface ProjectileState {
  id: number;
  owner: number;
  pos: Vec3;
  vel: Vec3;
  bouncesLeft: number;
  age: number;
  lifetime: number;
  damage: number;
  knockback: number;
}

export type ProjectileStep =
  | { kind: 'fly' }
  | { kind: 'expire' }
  | { kind: 'bounce'; point: Vec3; normal: Vec3 }
  | { kind: 'hit'; collider: Collider; point: Vec3; normal: Vec3 };

// Results are reused between calls to keep the hot loop allocation-free.
// Callers must consume a result before the next stepProjectile call.
const FLY: ProjectileStep = { kind: 'fly' };
const EXPIRE: ProjectileStep = { kind: 'expire' };
const BOUNCE: { kind: 'bounce'; point: Vec3; normal: Vec3 } = { kind: 'bounce', point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 } };
const HIT: { kind: 'hit'; collider: Collider; point: Vec3; normal: Vec3 } = {
  kind: 'hit',
  collider: null as unknown as Collider,
  point: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 0 },
};
let sharedRay: RAPIER.Ray | null = null;
const rayOrigin: Vec3 = { x: 0, y: 0, z: 0 };
const rayDir: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Swept-raycast projectile integration. Moves the projectile by vel*dt,
 * bouncing off environment colliders while it has bounces left.
 * Mutates `p` in place. Robots are hit when `isEnvironment(collider)` is false.
 */
export function stepProjectile(
  world: World,
  p: ProjectileState,
  dt: number,
  excludeCollider: Collider | undefined,
  isEnvironment: (c: Collider) => boolean,
): ProjectileStep {
  p.age += dt;
  if (p.age > p.lifetime) return EXPIRE;
  const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
  if (speed < 1e-4) return EXPIRE;
  rayDir.x = p.vel.x / speed;
  rayDir.y = p.vel.y / speed;
  rayDir.z = p.vel.z / speed;
  rayOrigin.x = p.pos.x;
  rayOrigin.y = p.pos.y;
  rayOrigin.z = p.pos.z;
  const travel = speed * dt;
  if (!sharedRay) sharedRay = new RAPIER.Ray(rayOrigin, rayDir);
  sharedRay.origin = rayOrigin;
  sharedRay.dir = rayDir;
  const hit = world.castRayAndGetNormal(sharedRay, travel, true, undefined, CollisionGroups.PROJECTILE_QUERY, excludeCollider);
  if (!hit) {
    p.pos.x += rayDir.x * travel;
    p.pos.y += rayDir.y * travel;
    p.pos.z += rayDir.z * travel;
    return FLY;
  }
  const t = hit.timeOfImpact;
  const px = p.pos.x + rayDir.x * t;
  const py = p.pos.y + rayDir.y * t;
  const pz = p.pos.z + rayDir.z * t;
  let nx = hit.normal.x, ny = hit.normal.y, nz = hit.normal.z;
  if (nx * rayDir.x + ny * rayDir.y + nz * rayDir.z > 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  if (isEnvironment(hit.collider) && p.bouncesLeft > 0) {
    p.bouncesLeft -= 1;
    const d = 2 * (p.vel.x * nx + p.vel.y * ny + p.vel.z * nz);
    p.vel.x -= d * nx;
    p.vel.y -= d * ny;
    p.vel.z -= d * nz;
    p.pos.x = px + nx * 0.05;
    p.pos.y = py + ny * 0.05;
    p.pos.z = pz + nz * 0.05;
    BOUNCE.point.x = px; BOUNCE.point.y = py; BOUNCE.point.z = pz;
    BOUNCE.normal.x = nx; BOUNCE.normal.y = ny; BOUNCE.normal.z = nz;
    return BOUNCE;
  }
  p.pos.x = px;
  p.pos.y = py;
  p.pos.z = pz;
  HIT.collider = hit.collider;
  HIT.point.x = px; HIT.point.y = py; HIT.point.z = pz;
  HIT.normal.x = nx; HIT.normal.y = ny; HIT.normal.z = nz;
  return HIT;
}
