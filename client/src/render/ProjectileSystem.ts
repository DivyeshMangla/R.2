import * as THREE from 'three';
import {
  castHitTargets,
  createEnvCaster,
  makeStepResult,
  physicsConfig,
  StepKind,
  stepProjectile,
  type HitTarget,
  type ProjectileState,
  type ProjectileWorld,
  type ShotResultMsg,
  type Vec3,
} from '@robot-arena/shared';
import type { PhysicsWorld } from '../physics/PhysicsWorld';

/** The few effects shells need; satisfied by the VFX system. */
export interface ProjectileVfx {
  impactSparks(p: THREE.Vector3, n: THREE.Vector3, color: THREE.Color, scale: number): void;
  decal(p: THREE.Vector3, n: THREE.Vector3, size: number): void;
  trail(p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color): void;
}

interface VisualProjectile {
  state: ProjectileState;
  mesh: THREE.Mesh;
  color: THREE.Color;
  serverPid: number;
  /** "seq:barrel" for the local player's predicted shells, else ''. */
  shotKey: string;
  prev: THREE.Vector3;
  /** Seconds since a predicted robot contact (-1 = flying). The shell fades while it waits on the server. */
  waitT: number;
  /** Positions of every tick, for the debug overlay (predicted shells only). */
  path: Vec3[] | null;
}

export interface ProjectileCallbacks {
  onSurfaceHit(point: Vec3, normal: Vec3): void;
  /** A predicted shell finished (any outcome) — its client-side path for the debug overlay. */
  onPredictedDone?(shotKey: string, path: Vec3[], hitRobot: number): void;
}

const tmpDir = new THREE.Vector3();
const tmpVel = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);
const FADE_S = 0.12;

/**
 * Cosmetic shells on the client, flown with the same stepper as the server:
 * the static arena via Rapier, robots as hitboxes at their interpolated poses.
 * Wall hits are shown immediately (the arena is identical on both sides).
 * Robot contacts never show feedback on their own: the shell fades and the
 * impact is drawn when the server confirms it (confirmShot).
 */
export class ProjectileSystem {
  private readonly list: VisualProjectile[] = [];
  private readonly geo = new THREE.CylinderGeometry(0.07, 0.07, 1.1, 8, 1).rotateX(Math.PI / 2);
  private readonly scene: THREE.Scene;
  private readonly vfx: ProjectileVfx;
  private readonly callbacks: ProjectileCallbacks;
  /** Static arena + current hitboxes; also used by the aim solver. */
  readonly world: ProjectileWorld;
  private readonly step = makeStepResult();
  private targets: readonly HitTarget[] = [];
  private targetCount = 0;
  private nextLocalId = -1;
  recordPaths = false;

  constructor(scene: THREE.Scene, physics: PhysicsWorld, vfx: ProjectileVfx, callbacks: ProjectileCallbacks) {
    this.scene = scene;
    this.vfx = vfx;
    this.callbacks = callbacks;
    const castEnv = createEnvCaster(physics.world);
    this.world = {
      castEnv,
      castRobots: (o, d, max, radius, padH, padV, ignore, out) => castHitTargets(this.targets, this.targetCount, o, d, max, radius, padH, padV, ignore, out),
    };
  }

  /** Robot hitboxes shells are tested against this tick (interpolated remotes + the predicted local robot). */
  setTargets(targets: readonly HitTarget[], count: number): void {
    this.targets = targets;
    this.targetCount = count;
  }

  spawn(owner: number, pos: Vec3, vel: Vec3, bounces: number, color: number, serverPid: number, shotKey: string, assist: boolean): void {
    const c = new THREE.Color(color);
    const mat = new THREE.MeshBasicMaterial({ color: c.clone().lerp(new THREE.Color(1, 1, 1), 0.45).multiplyScalar(7), transparent: true });
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
        radius: physicsConfig.projectileRadius,
        assist,
        dist: 0,
      },
      mesh,
      color: c,
      serverPid,
      shotKey,
      prev: new THREE.Vector3(pos.x, pos.y, pos.z),
      waitT: -1,
      path: shotKey && this.recordPaths ? [{ ...pos }] : null,
    });
  }

  /** Advances a just-spawned remote shell by the server's hitscan fast-forward. */
  fastForward(pid: number, seconds: number): void {
    const p = this.list.find((x) => x.serverPid === pid);
    if (!p) return;
    let left = seconds;
    while (left > 1e-6 && this.list.includes(p)) {
      const h = Math.min(1 / 60, left);
      left -= h;
      this.stepOne(this.list.indexOf(p), h);
    }
  }

  /** Removes a remote projectile the server says has already impacted. */
  removeByServerPid(pid: number): void {
    const i = this.list.findIndex((p) => p.serverPid === pid);
    if (i >= 0) this.kill(i);
  }

  /** Server verdict for one of our own shells: draw the impact where the server resolved it. */
  confirmShot(r: ShotResultMsg, color: number): void {
    const key = `${r.seq}:${r.b}`;
    const i = this.list.findIndex((p) => p.shotKey === key);
    if (r.hit) {
      if (i >= 0) this.kill(i);
      tmpPos.set(r.point.x, r.point.y, r.point.z);
      tmpN.set(-r.dir.x, -r.dir.y, -r.dir.z);
      this.vfx.impactSparks(tmpPos, tmpN, new THREE.Color(color), 1.2);
    } else if (i >= 0 && this.list[i].waitT >= 0) {
      // We predicted a hit the server rejected: the shell already faded; nothing to show.
      this.kill(i);
    }
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
    for (let i = this.list.length - 1; i >= 0; i--) this.stepOne(i, dt);
  }

  private stepOne(i: number, dt: number): void {
    const p = this.list[i];
    if (p.waitT >= 0) {
      p.waitT += dt;
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - p.waitT / FADE_S);
      // Unconfirmed after a generous wait: drop it.
      if (p.waitT > 1) this.kill(i);
      return;
    }
    p.prev.set(p.state.pos.x, p.state.pos.y, p.state.pos.z);
    const kind = stepProjectile(this.world, p.state, dt, this.step);
    p.path?.push({ ...p.state.pos });
    const r = this.step;
    if (kind === StepKind.FLY) return;
    if (kind === StepKind.EXPIRE) {
      this.finish(p, -1);
      this.kill(i);
      return;
    }
    tmpPos.set(r.point.x, r.point.y, r.point.z);
    tmpN.set(r.normal.x, r.normal.y, r.normal.z);
    if (kind === StepKind.BOUNCE) {
      this.vfx.impactSparks(tmpPos, tmpN, p.color, 0.6);
      this.callbacks.onSurfaceHit(r.point, r.normal);
      return;
    }
    if (kind === StepKind.HIT_ENV) {
      this.vfx.impactSparks(tmpPos, tmpN, p.color, 1);
      this.vfx.decal(tmpPos, tmpN, 0.9);
      this.callbacks.onSurfaceHit(r.point, r.normal);
      this.finish(p, -1);
      this.kill(i);
      return;
    }
    // Robot contact.
    this.finish(p, r.targetId);
    if (p.shotKey) {
      p.mesh.position.set(r.point.x, r.point.y, r.point.z);
      p.waitT = 0;
    } else {
      // Remote shell: the server's impact event draws the hit.
      this.kill(i);
    }
  }

  private finish(p: VisualProjectile, robot: number): void {
    if (p.shotKey && p.path) this.callbacks.onPredictedDone?.(p.shotKey, p.path, robot);
  }

  /** Per-frame visual update: orientation + trail particles. */
  update(): void {
    for (const p of this.list) {
      if (p.waitT >= 0) continue;
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
