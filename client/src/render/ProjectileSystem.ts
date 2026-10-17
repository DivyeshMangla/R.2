import * as THREE from 'three';
import {
  castHitTargets,
  createEnvCaster,
  makeStepResult,
  physicsConfig,
  StepKind,
  stepProjectile,
  type ArenaBlockKind,
  type HitTarget,
  type ProjectileState,
  type ProjectileWorld,
  type ShotResultMsg,
  type Vec3,
} from '@robot-arena/shared';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { MAX_PROJECTILES, TRAIL_POINTS, type ProjectileDrawData } from './vfx/ProjectileRenderer';
import type { ImpactSurface, VFXSystem } from './vfx/VFXSystem';

interface Shell {
  active: boolean;
  state: ProjectileState;
  color: THREE.Color;
  serverPid: number;
  /** Local player's predicted shell: input seq + barrel (seq -1 = remote shell). */
  seq: number;
  barrel: number;
  /** Seconds since a predicted robot contact (-1 = flying). The shell fades while it waits on the server. */
  waitT: number;
  /** Trail history, newest first. */
  trail: Float32Array;
  trailCount: number;
  path: Vec3[] | null;
}

export interface ProjectileCallbacks {
  onSurfaceHit(point: Vec3, normal: Vec3, surface: ImpactSurface): void;
  /** A predicted shell finished (any outcome): its client-side path, for the debug overlay. */
  onPredictedDone?(seq: number, barrel: number, path: Vec3[], hitRobot: number): void;
}

const FADE_S = 0.12;
const _pos = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();

function surfaceOf(kind: ArenaBlockKind | undefined): ImpactSurface {
  switch (kind) {
    case 'floor':
      return 'ground';
    case 'cover':
      return 'wall';
    default:
      return 'metal';
  }
}

/**
 * Cosmetic shells on the client, flown with the same stepper as the server:
 * the static arena via Rapier, robots as hitboxes at their interpolated poses.
 * A fixed pool (no per-shot allocation); each shell keeps a short history ring
 * the ProjectileRenderer turns into a ribbon trail.
 *
 * Wall hits show immediately (the arena is identical on both sides). Robot
 * contacts never show feedback on their own: the shell fades and the impact is
 * drawn when the server confirms it (confirmShot).
 */
export class ProjectileSystem {
  private readonly pool: Shell[] = [];
  private readonly vfx: VFXSystem;
  private readonly physics: PhysicsWorld;
  private readonly callbacks: ProjectileCallbacks;
  /** Static arena + current hitboxes; also used by the aim solver. */
  readonly world: ProjectileWorld;
  private readonly step = makeStepResult();
  private readonly draw: ProjectileDrawData;
  private targets: readonly HitTarget[] = [];
  private targetCount = 0;
  private nextLocalId = -1;
  recordPaths = false;

  constructor(physics: PhysicsWorld, vfx: VFXSystem, callbacks: ProjectileCallbacks) {
    this.physics = physics;
    this.vfx = vfx;
    this.callbacks = callbacks;
    const castEnv = createEnvCaster(physics.world);
    this.world = {
      castEnv,
      castRobots: (o, d, max, radius, padH, padV, ignore, out) => castHitTargets(this.targets, this.targetCount, o, d, max, radius, padH, padV, ignore, out),
    };
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.pool.push({
        active: false,
        state: {
          id: 0, owner: 0, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, bouncesLeft: 0, age: 0, lifetime: 1,
          damage: 0, knockback: 0, radius: 0.15, assist: false, dist: 0,
        },
        color: new THREE.Color(),
        serverPid: 0,
        seq: -1,
        barrel: 0,
        waitT: -1,
        trail: new Float32Array(TRAIL_POINTS * 3),
        trailCount: 0,
        path: null,
      });
    }
    this.draw = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, r: 1, g: 1, b: 1, trail: this.pool[0].trail, trailCount: 0, alpha: 1 };
  }

  /** Robot hitboxes shells are tested against this tick (interpolated remotes + the predicted local robot). */
  setTargets(targets: readonly HitTarget[], count: number): void {
    this.targets = targets;
    this.targetCount = count;
  }

  /** `seq` >= 0 marks the local player's predicted shell (input seq + barrel). */
  spawn(owner: number, pos: Vec3, vel: Vec3, bounces: number, color: number, serverPid: number, seq: number, barrel: number, assist: boolean, lifetime = physicsConfig.projectileLifetime): void {
    let p: Shell | undefined;
    for (const s of this.pool) {
      if (!s.active) {
        p = s;
        break;
      }
    }
    if (!p) return;
    p.active = true;
    const st = p.state;
    st.id = serverPid !== 0 ? serverPid : this.nextLocalId--;
    st.owner = owner;
    st.pos.x = pos.x; st.pos.y = pos.y; st.pos.z = pos.z;
    st.vel.x = vel.x; st.vel.y = vel.y; st.vel.z = vel.z;
    st.bouncesLeft = bounces;
    st.age = 0;
    st.lifetime = lifetime;
    st.radius = physicsConfig.projectileRadius;
    st.assist = assist;
    st.dist = 0;
    p.color.setHex(color).lerp(_c.setRGB(1, 1, 1), 0.35).multiplyScalar(5);
    p.serverPid = serverPid;
    p.seq = seq;
    p.barrel = barrel;
    p.waitT = -1;
    p.trail[0] = pos.x; p.trail[1] = pos.y; p.trail[2] = pos.z;
    p.trailCount = 1;
    p.path = seq >= 0 && this.recordPaths ? [{ ...pos }] : null;
  }

  /** Advances a just-spawned remote shell by the server's hitscan fast-forward. */
  fastForward(pid: number, seconds: number): void {
    const p = this.pool.find((x) => x.active && x.serverPid === pid);
    if (!p) return;
    let left = seconds;
    while (left > 1e-6 && p.active) {
      const h = Math.min(1 / 60, left);
      left -= h;
      this.stepOne(p, h);
    }
  }

  /** Removes a remote projectile the server says has already impacted. */
  removeByServerPid(pid: number): void {
    for (const p of this.pool) if (p.active && p.serverPid === pid) p.active = false;
  }

  /** Server verdict for one of our own shells: draw the impact where the server resolved it. */
  confirmShot(r: ShotResultMsg, color: number): void {
    let mine: Shell | null = null;
    for (const p of this.pool) {
      if (p.active && p.seq === r.seq && p.barrel === r.b) {
        mine = p;
        break;
      }
    }
    if (r.hit) {
      if (mine) mine.active = false;
      _pos.set(r.point.x, r.point.y, r.point.z);
      _n.set(-r.dir.x, -r.dir.y, -r.dir.z);
      this.vfx.impact(_pos, _n, 'robot', _c.setHex(color), 1.2);
    } else if (mine && mine.waitT >= 0) {
      // We predicted a hit the server rejected: the shell already faded; nothing to show.
      mine.active = false;
    }
  }

  /** Server bounce correction for remote projectiles. */
  correctBounce(pid: number, p: Vec3, v: Vec3): void {
    for (const s of this.pool) {
      if (!s.active || s.serverPid !== pid) continue;
      s.state.pos.x = p.x; s.state.pos.y = p.y; s.state.pos.z = p.z;
      s.state.vel.x = v.x; s.state.vel.y = v.y; s.state.vel.z = v.z;
    }
  }

  fixedUpdate(dt: number): void {
    for (const p of this.pool) if (p.active) this.stepOne(p, dt);
  }

  private pushTrail(p: Shell): void {
    const t = p.trail;
    t.copyWithin(3, 0, (TRAIL_POINTS - 1) * 3);
    t[0] = p.state.pos.x; t[1] = p.state.pos.y; t[2] = p.state.pos.z;
    p.trailCount = Math.min(TRAIL_POINTS, p.trailCount + 1);
  }

  private stepOne(p: Shell, dt: number): void {
    if (p.waitT >= 0) {
      p.waitT += dt;
      // Unconfirmed after a generous wait: drop it.
      if (p.waitT > 1) p.active = false;
      return;
    }
    const kind = stepProjectile(this.world, p.state, dt, this.step);
    this.pushTrail(p);
    p.path?.push({ ...p.state.pos });
    const r = this.step;
    if (kind === StepKind.FLY) return;
    if (kind === StepKind.EXPIRE) {
      this.finish(p, -1);
      p.active = false;
      return;
    }
    _pos.set(r.point.x, r.point.y, r.point.z);
    _n.set(r.normal.x, r.normal.y, r.normal.z);
    if (kind === StepKind.BOUNCE || kind === StepKind.HIT_ENV) {
      const surface = surfaceOf(this.physics.blockKind(r.envHandle));
      _c.copy(p.color).multiplyScalar(0.2);
      this.vfx.impact(_pos, _n, surface, _c, kind === StepKind.BOUNCE ? 0.6 : 1);
      this.callbacks.onSurfaceHit(r.point, r.normal, surface);
      if (kind === StepKind.HIT_ENV) {
        this.finish(p, -1);
        p.active = false;
      }
      return;
    }
    // Robot contact.
    this.finish(p, r.targetId);
    if (p.seq >= 0) {
      p.waitT = 0;
    } else {
      // Remote shell: the server's impact event draws the hit.
      p.active = false;
    }
  }

  private finish(p: Shell, robot: number): void {
    if (p.seq >= 0 && p.path) this.callbacks.onPredictedDone?.(p.seq, p.barrel, p.path, robot);
  }

  /** Per-frame: hands every live shell to the renderer (cores + ribbon trails). */
  render(time: number): void {
    const out = this.vfx.projectiles;
    const d = this.draw;
    out.begin();
    for (const p of this.pool) {
      if (!p.active) continue;
      const s = p.state;
      d.x = s.pos.x; d.y = s.pos.y; d.z = s.pos.z;
      d.dx = s.vel.x; d.dy = s.vel.y; d.dz = s.vel.z;
      d.r = p.color.r; d.g = p.color.g; d.b = p.color.b;
      d.trail = p.trail;
      d.trailCount = p.trailCount;
      d.alpha = p.waitT >= 0 ? Math.max(0, 1 - p.waitT / FADE_S) : 1;
      out.push(d);
    }
    out.end(time);
  }

  clear(): void {
    for (const p of this.pool) p.active = false;
  }
}
