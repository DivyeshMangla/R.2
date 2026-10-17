import RAPIER from '@dimforge/rapier3d-compat';
import type { Collider, World } from '@dimforge/rapier3d-compat';
import { ARENA_BLOCKS } from './arena';
import { CollisionGroups } from './collisionGroups';
import { physicsConfig } from './physicsConfig';

/** Creates the static arena colliders in `world` and returns their handles. */
export function buildArenaColliders(world: World): Set<number> {
  const handles = new Set<number>();
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const b of ARENA_BLOCKS) {
    const desc = RAPIER.ColliderDesc.cuboid(b.half.x, b.half.y, b.half.z)
      .setTranslation(b.center.x, b.center.y, b.center.z)
      .setRotation(b.rotation)
      .setCollisionGroups(CollisionGroups.ENV)
      .setFriction(b.kind === 'barrier' || b.kind === 'cover' || b.kind === 'pillar' ? 0.15 : 0.9)
      .setRestitution(b.kind === 'barrier' ? 0.3 : 0.05);
    const c: Collider = world.createCollider(desc, body);
    handles.add(c.handle);
  }
  return handles;
}

export function createPhysicsWorld(): World {
  const world = new RAPIER.World({ x: 0, y: -physicsConfig.gravity, z: 0 });
  world.timestep = 1 / 60;
  return world;
}

export function syncGravity(world: World): void {
  world.gravity = { x: 0, y: -physicsConfig.gravity, z: 0 };
}

let initPromise: Promise<void> | null = null;

/** Initializes the Rapier WASM module exactly once. */
export function initPhysics(): Promise<void> {
  if (!initPromise) initPromise = RAPIER.init();
  return initPromise;
}
