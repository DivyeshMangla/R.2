import RAPIER from '@dimforge/rapier3d-compat';
import type { RigidBody, World } from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import {
  buildArenaColliders,
  CHASSIS_HALF,
  CollisionGroups,
  createPhysicsWorld,
  physicsConfig,
  syncGravity,
  type Quat,
  type Vec3,
} from '@robot-arena/shared';
import type { DebrisPiece } from '../render/RobotModelFactory';
import type { VFXSystem } from '../render/VFXSystem';

interface Chunk {
  body: RigidBody;
  object: THREE.Object3D;
  materials: THREE.Material[];
  age: number;
}

interface RobotProxy {
  body: RigidBody;
  seen: boolean;
}

const MAX_CHUNKS = 120;

/**
 * Death debris: a dedicated Rapier world (arena + kinematic robot proxies) so
 * cosmetic chunks never perturb client prediction replays. Chunks are in the
 * DEBRIS collision group, which projectiles ignore.
 */
export class DebrisSystem {
  private readonly world: World;
  private readonly chunks: Chunk[] = [];
  private readonly proxies = new Map<number, RobotProxy>();
  private readonly scene: THREE.Scene;
  private readonly vfx: VFXSystem;

  constructor(scene: THREE.Scene, vfx: VFXSystem) {
    this.scene = scene;
    this.vfx = vfx;
    this.world = createPhysicsWorld();
    buildArenaColliders(this.world);
  }

  spawn(pieces: DebrisPiece[], p: Vec3, q: Quat, v: Vec3): void {
    const cfg = physicsConfig;
    const rot = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    const center = new THREE.Vector3(p.x, p.y, p.z);
    const blastOrigin = center.clone().add(new THREE.Vector3(0, -0.6, 0));
    for (const piece of pieces) {
      while (this.chunks.length >= MAX_CHUNKS) this.removeChunk(0);
      const wp = piece.offset.clone().applyQuaternion(rot).add(center);
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(wp.x, wp.y, wp.z)
          .setRotation(rot)
          .setLinearDamping(0.15)
          .setAngularDamping(0.4)
          .setCcdEnabled(true),
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(Math.max(0.03, piece.half.x), Math.max(0.03, piece.half.y), Math.max(0.03, piece.half.z))
          .setDensity(180)
          .setFriction(0.7)
          .setRestitution(0.25)
          .setCollisionGroups(CollisionGroups.DEBRIS),
        body,
      );
      const away = wp.clone().sub(blastOrigin).normalize();
      const mass = body.mass();
      const kick = cfg.debrisImpulse * (0.6 + Math.random() * 0.8);
      body.setLinvel({ x: v.x * 0.6, y: v.y * 0.6, z: v.z * 0.6 }, true);
      body.applyImpulse({ x: away.x * kick * mass, y: (Math.abs(away.y) + 0.8) * kick * mass, z: away.z * kick * mass }, true);
      body.setAngvel({ x: (Math.random() - 0.5) * 18, y: (Math.random() - 0.5) * 18, z: (Math.random() - 0.5) * 18 }, true);

      const materials: THREE.Material[] = [];
      piece.object.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const m = (o.material as THREE.Material).clone();
          m.transparent = true;
          o.material = m;
          o.castShadow = true;
          materials.push(m);
        }
      });
      this.scene.add(piece.object);
      this.chunks.push({ body, object: piece.object, materials, age: 0 });
    }
  }

  /** Keeps kinematic proxies of the live robots so debris gets shoved around. */
  syncRobot(id: number, p: Vec3, q: Quat, alive: boolean): void {
    let proxy = this.proxies.get(id);
    if (!proxy) {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(CHASSIS_HALF.x, CHASSIS_HALF.y, CHASSIS_HALF.z).setCollisionGroups(CollisionGroups.ROBOT), body);
      proxy = { body, seen: true };
      this.proxies.set(id, proxy);
    }
    proxy.seen = true;
    if (proxy.body.isEnabled() !== alive) proxy.body.setEnabled(alive);
    if (alive) {
      proxy.body.setNextKinematicTranslation(p);
      proxy.body.setNextKinematicRotation(q);
    }
  }

  pruneRobots(liveIds: Set<number>): void {
    for (const [id, proxy] of this.proxies) {
      if (!liveIds.has(id)) {
        this.world.removeRigidBody(proxy.body);
        this.proxies.delete(id);
      }
    }
  }

  private removeChunk(i: number): void {
    const c = this.chunks[i];
    this.scene.remove(c.object);
    for (const m of c.materials) m.dispose();
    c.object.traverse((o) => {
      // Per-death shard geometries are disposed; factory-shared ones are flagged and kept.
      if (o instanceof THREE.Mesh && !o.geometry.userData.shared) o.geometry.dispose();
    });
    this.world.removeRigidBody(c.body);
    this.chunks.splice(i, 1);
  }

  fixedUpdate(dt: number): void {
    syncGravity(this.world);
    this.world.timestep = dt;
    this.world.step();
    const life = physicsConfig.debrisLifetime;
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      c.age += dt;
      if (c.age >= life) this.removeChunk(i);
    }
  }

  update(): void {
    const life = physicsConfig.debrisLifetime;
    const fadeStart = Math.max(0, life - 1.5);
    for (const c of this.chunks) {
      const t = c.body.translation();
      const r = c.body.rotation();
      c.object.position.set(t.x, t.y, t.z);
      c.object.quaternion.set(r.x, r.y, r.z, r.w);
      const opacity = c.age < fadeStart ? 1 : Math.max(0, 1 - (c.age - fadeStart) / (life - fadeStart));
      for (const m of c.materials) m.opacity = opacity;
      if (c.age < 2.8) this.vfx.debrisSmoke(c.object.position);
    }
  }

  clear(): void {
    while (this.chunks.length > 0) this.removeChunk(0);
  }
}
