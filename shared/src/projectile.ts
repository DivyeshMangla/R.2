import RAPIER from '@dimforge/rapier3d-compat';
import type { Collider, World } from '@dimforge/rapier3d-compat';
import { CollisionGroups } from './collisionGroups';
import { dot, length, reflect, type Vec3 } from './math';

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

/**
 * Swept-raycast projectile integration. Moves the projectile by vel*dt,
 * bouncing off environment colliders while it has bounces left.
 * Mutates `p`. Robots are hit when `isEnvironment(collider)` is false.
 */
export function stepProjectile(
  world: World,
  p: ProjectileState,
  dt: number,
  excludeCollider: Collider | undefined,
  isEnvironment: (c: Collider) => boolean,
): ProjectileStep {
  p.age += dt;
  if (p.age > p.lifetime) return { kind: 'expire' };
  const speed = length(p.vel);
  if (speed < 1e-4) return { kind: 'expire' };
  const dir = { x: p.vel.x / speed, y: p.vel.y / speed, z: p.vel.z / speed };
  const travel = speed * dt;
  const ray = new RAPIER.Ray(p.pos, dir);
  const hit = world.castRayAndGetNormal(ray, travel, true, undefined, CollisionGroups.PROJECTILE_QUERY, excludeCollider);
  if (!hit) {
    p.pos = { x: p.pos.x + dir.x * travel, y: p.pos.y + dir.y * travel, z: p.pos.z + dir.z * travel };
    return { kind: 'fly' };
  }
  const point = { x: p.pos.x + dir.x * hit.timeOfImpact, y: p.pos.y + dir.y * hit.timeOfImpact, z: p.pos.z + dir.z * hit.timeOfImpact };
  let normal = { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z };
  if (dot(normal, dir) > 0) normal = { x: -normal.x, y: -normal.y, z: -normal.z };
  if (isEnvironment(hit.collider)) {
    if (p.bouncesLeft > 0) {
      p.bouncesLeft -= 1;
      p.vel = reflect(p.vel, normal);
      p.pos = { x: point.x + normal.x * 0.05, y: point.y + normal.y * 0.05, z: point.z + normal.z * 0.05 };
      return { kind: 'bounce', point, normal };
    }
  }
  p.pos = point;
  return { kind: 'hit', collider: hit.collider, point, normal };
}
