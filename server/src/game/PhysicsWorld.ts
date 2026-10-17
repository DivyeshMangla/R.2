import RAPIER from '@dimforge/rapier3d-compat';
import type { Collider, World } from '@dimforge/rapier3d-compat';
import { buildArenaColliders, CollisionGroups, createPhysicsWorld, syncGravity, type MapId, type Vec3 } from '@robot-arena/shared';

/** Authoritative Rapier world: the static arena plus every robot chassis. */
export class PhysicsWorld {
  readonly world: World;
  private readonly envHandles: ReadonlyMap<number, unknown>;
  private readonly robotByCollider = new Map<number, number>();

  constructor(mapId: MapId = 'foundry') {
    this.world = createPhysicsWorld();
    this.envHandles = buildArenaColliders(this.world, mapId);
  }

  registerRobot(collider: Collider, robotId: number): void {
    this.robotByCollider.set(collider.handle, robotId);
  }

  unregisterRobot(collider: Collider): void {
    this.robotByCollider.delete(collider.handle);
  }

  robotIdForCollider(c: Collider): number | undefined {
    return this.robotByCollider.get(c.handle);
  }

  readonly isEnvironment = (c: Collider): boolean => this.envHandles.has(c.handle);

  step(): void {
    syncGravity(this.world);
    this.world.step();
  }

  /** Distance to the first environment hit along `dir`, or null if clear within `maxDist`. */
  rayEnvironment(origin: Vec3, dir: Vec3, maxDist: number): number | null {
    const hit = this.world.castRay(new RAPIER.Ray(origin, dir), maxDist, true, undefined, CollisionGroups.ENV_QUERY);
    return hit ? hit.timeOfImpact : null;
  }

  lineOfSight(a: Vec3, b: Vec3): boolean {
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const len = Math.hypot(d.x, d.y, d.z);
    if (len < 1e-3) return true;
    const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
    return this.rayEnvironment(a, dir, len) === null;
  }

  groundHeight(x: number, z: number, fromY: number): number {
    const t = this.rayEnvironment({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }, fromY + 20);
    return t === null ? 0 : fromY - t;
  }
}
