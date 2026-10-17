import * as THREE from 'three';
import type { Collider } from '@dimforge/rapier3d-compat';
import { physicsConfig, stepProjectile, type ProjectileState, type Vec3 } from '@robot-arena/shared';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { VFXSystem } from './VFXSystem';

interface VisualProjectile {
  state: ProjectileState;
  mesh: THREE.Mesh;
  color: THREE.Color;
  serverPid: number;
  predicted: boolean;
  exclude: Collider | undefined;
  prev: THREE.Vector3;
}

export interface ProjectileCallbacks {
  /** A locally predicted shot touched a robot (instant hit feedback). */
  onPredictedRobotHit(point: Vec3, robotId: number): void;
  onSurfaceHit(point: Vec3, normal: Vec3): void;
}

const tmpDir = new THREE.Vector3();
const tmpVel = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

/**
 * Cosmetic projectile simulation on the client. Uses the same swept-raycast
 * routine as the server, against the client's world, so travel time, ricochets
 * and impacts look right without waiting on the network.
 */
export class ProjectileSystem {
  private readonly list: VisualProjectile[] = [];
  private readonly geo = new THREE.CylinderGeometry(0.07, 0.07, 1.1, 8, 1).rotateX(Math.PI / 2);
  private readonly scene: THREE.Scene;
  private readonly physics: PhysicsWorld;
  private readonly vfx: VFXSystem;
  private readonly callbacks: ProjectileCallbacks;
  private nextLocalId = -1;

  constructor(scene: THREE.Scene, physics: PhysicsWorld, vfx: VFXSystem, callbacks: ProjectileCallbacks) {
    this.scene = scene;
    this.physics = physics;
    this.vfx = vfx;
    this.callbacks = callbacks;
  }

  spawn(owner: number, pos: Vec3, vel: Vec3, bounces: number, color: number, predicted: boolean, serverPid: number, exclude: Collider | undefined): void {
    const c = new THREE.Color(color);
    const mat = new THREE.MeshBasicMaterial({ color: c.clone().lerp(new THREE.Color(1, 1, 1), 0.45).multiplyScalar(7) });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    tmpDir.set(vel.x, vel.y, vel.z).normalize();
    mesh.lookAt(tmpPos.copy(mesh.position).add(tmpDir));
    this.scene.add(mesh);
    this.list.push({
      state: {
        id: serverPid !== 0 ? serverPid : this.nextLocalId--,
        owner,
        pos: { ...pos },
        vel: { ...vel },
        bouncesLeft: bounces,
        age: 0,
        lifetime: physicsConfig.projectileLifetime,
        damage: 0,
        knockback: 0,
      },
      mesh,
      color: c,
      serverPid,
      predicted,
      exclude,
      prev: new THREE.Vector3(pos.x, pos.y, pos.z),
    });
  }

  /** Removes a remote projectile the server says has already impacted. */
  removeByServerPid(pid: number): void {
    const i = this.list.findIndex((p) => p.serverPid === pid);
    if (i >= 0) this.kill(i);
  }

  /** Server bounce correction for remote projectiles. */
  correctBounce(pid: number, p: Vec3, v: Vec3): void {
    const proj = this.list.find((x) => x.serverPid === pid);
    if (!proj) return;
    proj.state.pos = { ...p };
    proj.state.vel = { ...v };
  }

  private kill(i: number): void {
    const p = this.list[i];
    this.scene.remove(p.mesh);
    (p.mesh.material as THREE.Material).dispose();
    this.list.splice(i, 1);
  }

  fixedUpdate(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.prev.set(p.state.pos.x, p.state.pos.y, p.state.pos.z);
      const r = stepProjectile(this.physics.world, p.state, dt, p.exclude, this.physics.isEnvironment);
      if (r.kind === 'expire') {
        this.kill(i);
        continue;
      }
      if (r.kind === 'bounce') {
        const pt = new THREE.Vector3(r.point.x, r.point.y, r.point.z);
        const n = new THREE.Vector3(r.normal.x, r.normal.y, r.normal.z);
        this.vfx.impactSparks(pt, n, p.color, 0.6);
        this.callbacks.onSurfaceHit(r.point, r.normal);
        // Exclusion only matters at launch; after a ricochet the shooter can be hit.
        p.exclude = undefined;
        continue;
      }
      if (r.kind === 'hit') {
        const pt = new THREE.Vector3(r.point.x, r.point.y, r.point.z);
        const n = new THREE.Vector3(r.normal.x, r.normal.y, r.normal.z);
        const robotId = this.physics.robotIdFor(r.collider);
        if (robotId === undefined) {
          this.vfx.impactSparks(pt, n, p.color, 1);
          this.vfx.decal(pt, n, 0.9);
          this.callbacks.onSurfaceHit(r.point, r.normal);
        } else if (p.predicted) {
          this.vfx.impactSparks(pt, n, p.color, 1.2);
          this.callbacks.onPredictedRobotHit(r.point, robotId);
        }
        this.kill(i);
      }
    }
  }

  /** Per-frame visual update: orientation + trail particles. */
  update(): void {
    for (const p of this.list) {
      const s = p.state;
      p.mesh.position.set(s.pos.x, s.pos.y, s.pos.z);
      tmpVel.set(s.vel.x, s.vel.y, s.vel.z);
      tmpDir.copy(tmpVel).normalize();
      if (Math.abs(tmpDir.dot(Y)) < 0.999) p.mesh.lookAt(tmpPos.copy(p.mesh.position).add(tmpDir));
      // Two trail puffs per frame along the travelled segment.
      for (let k = 0; k < 2; k++) {
        tmpPos.lerpVectors(p.prev, p.mesh.position, k / 2);
        this.vfx.trail(tmpPos, tmpVel, p.color);
      }
    }
  }

  clear(): void {
    for (let i = this.list.length - 1; i >= 0; i--) this.kill(i);
  }
}
