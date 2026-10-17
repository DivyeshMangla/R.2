import RAPIER from '@dimforge/rapier3d-compat';
import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';
import {
  buildArenaColliders,
  CHASSIS_HALF,
  CollisionGroups,
  createPhysicsWorld,
  syncGravity,
  type ArenaBlockKind,
  type MapId,
  type Quat,
  type Vec3,
} from '@robot-arena/shared';

interface Proxy {
  body: RigidBody;
  collider: Collider;
  enabled: boolean;
}

/**
 * Client-side Rapier world used for prediction of the local robot and for
 * cosmetic projectile sweeps. Remote robots exist as kinematic proxies placed at
 * their interpolated poses so the local robot can bump into them.
 */
export class PhysicsWorld {
  readonly world: World;
  private readonly envHandles: ReadonlyMap<number, ArenaBlockKind>;
  private readonly proxies = new Map<number, Proxy>();
  private readonly ownerByCollider = new Map<number, number>();

  constructor(mapId: MapId = 'foundry') {
    this.world = createPhysicsWorld();
    this.envHandles = buildArenaColliders(this.world, mapId);
  }

  readonly isEnvironment = (c: Collider): boolean => this.envHandles.has(c.handle);

  /** Arena block kind of an environment collider handle (for surface-specific impact effects). */
  blockKind(handle: number): ArenaBlockKind | undefined {
    return this.envHandles.get(handle);
  }

  robotIdFor(c: Collider): number | undefined {
    return this.ownerByCollider.get(c.handle);
  }

  registerLocal(collider: Collider, robotId: number): void {
    this.ownerByCollider.set(collider.handle, robotId);
  }

  unregisterCollider(collider: Collider): void {
    this.ownerByCollider.delete(collider.handle);
  }

  setProxy(id: number, p: Vec3, q: Quat, enabled: boolean): void {
    let proxy = this.proxies.get(id);
    if (!proxy) {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z).setRotation(q));
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(CHASSIS_HALF.x, CHASSIS_HALF.y, CHASSIS_HALF.z).setCollisionGroups(CollisionGroups.ROBOT),
        body,
      );
      proxy = { body, collider, enabled: true };
      this.proxies.set(id, proxy);
      this.ownerByCollider.set(collider.handle, id);
    }
    if (proxy.enabled !== enabled) {
      proxy.enabled = enabled;
      proxy.body.setEnabled(enabled);
      if (enabled) {
        proxy.body.setTranslation(p, true);
        proxy.body.setRotation(q, true);
      }
    }
    if (enabled) {
      proxy.body.setNextKinematicTranslation(p);
      proxy.body.setNextKinematicRotation(q);
    }
  }

  proxyCollider(id: number): Collider | undefined {
    return this.proxies.get(id)?.collider;
  }

  removeProxy(id: number): void {
    const proxy = this.proxies.get(id);
    if (!proxy) return;
    this.ownerByCollider.delete(proxy.collider.handle);
    this.world.removeRigidBody(proxy.body);
    this.proxies.delete(id);
  }

  proxyIds(): number[] {
    return [...this.proxies.keys()];
  }

  step(): void {
    syncGravity(this.world);
    this.world.step();
  }
}
