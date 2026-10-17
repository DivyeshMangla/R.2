import {
  castHitTargets,
  clampAimPitch,
  computeShots,
  createEnvCaster,
  FIXED_DT,
  getTurretPivot,
  hitboxCenter,
  makeEnvHit,
  makeHitTarget,
  makeRobotHit,
  makeStepResult,
  MAX_PLAYERS,
  Msg,
  physicsConfig,
  StepKind,
  stepProjectile,
  type HitTarget,
  type ProjectileState,
  type ProjectileWorld,
  type ShotMissReason,
  type ShotResultMsg,
  type Vec3,
} from '@robot-arena/shared';
import type { GameHost } from './GameHost';
import type { LagCompensator } from './LagCompensator';
import type { ServerRobot } from './ServerRobot';

export interface FireRequest {
  aimYaw: number;
  aimPitch: number;
  /** Input sequence of the trigger pull (0 for bots). */
  seq: number;
  /** Server time the shooter was viewing (0 = no rewind). */
  viewT: number;
}

interface Shell {
  state: ProjectileState;
  human: boolean;
  seq: number;
  barrel: number;
  recvTick: number;
  rewindMs: number;
  /** Server time whose world this shell is tested against at age 0; sampled at t0 + age. */
  t0: number;
  aimYaw: number;
  aimPitch: number;
  muzzle: Vec3;
  dir: Vec3;
  closest: number;
  closestAbove: boolean;
}

const POOL_SIZE = MAX_PLAYERS + 2;
const NEAR_MISS_M = 2.5;

/**
 * Authoritative cannon. Shells are swept against the static arena (Rapier)
 * and against robot hitboxes rewound to what the shooter saw (LagCompensator).
 * Every resolved human shot is reported back to its shooter (SHOT_RESULT).
 */
export class WeaponSystem {
  private readonly host: GameHost;
  private readonly lag: LagCompensator;
  private shells: Shell[] = [];
  private nextId = 1;
  private tick = 0;
  private readonly castEnv: ProjectileWorld['castEnv'];
  private readonly pool: HitTarget[] = Array.from({ length: POOL_SIZE }, makeHitTarget);
  private poolCount = 0;
  private readonly world: ProjectileWorld;
  private readonly step = makeStepResult();
  private readonly env = makeEnvHit();
  private readonly robotHit = makeRobotHit();
  private readonly center: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly prev: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(host: GameHost, lag: LagCompensator) {
    this.host = host;
    this.lag = lag;
    this.castEnv = createEnvCaster(host.physics.world);
    this.world = {
      castEnv: this.castEnv,
      castRobots: (o, d, max, radius, padH, padV, ignore, out) => castHitTargets(this.pool, this.poolCount, o, d, max, radius, padH, padV, ignore, out),
    };
  }

  fireIntervalFor(robot: ServerRobot): number {
    return physicsConfig.fireInterval / robot.stats.fireRateMul;
  }

  /** Called once per simulation tick before inputs are processed. */
  beginTick(tick: number): void {
    this.tick = tick;
  }

  tryFire(robot: ServerRobot, req: FireRequest): boolean {
    if (robot.fireCooldown > 0 || !robot.alive) return false;
    const cfg = physicsConfig;
    robot.fireCooldown = this.fireIntervalFor(robot);
    const human = !robot.isBot;
    const latest = this.lag.latestTime();
    const rewindMs = cfg.lagCompEnabled > 0 && req.viewT > 0 ? Math.min(cfg.lagCompMaxMs, Math.max(0, latest - req.viewT)) : 0;
    const t0 = latest - rewindMs;
    const pitch = clampAimPitch(req.aimPitch);
    const body = robot.controller.body;
    const p = body.translation();
    const q = body.rotation();
    const shots = computeShots(p, q, req.aimYaw, pitch, robot.stats.projectileCount, robot.id, req.seq);
    const pivot = getTurretPivot(p, q, { x: 0, y: 0, z: 0 });
    const damage = cfg.projectileDamage * robot.stats.damageMul;
    const knockback = cfg.projectileImpulse * robot.stats.knockbackMul;
    // The hitscan assist spends rewind: a shell fast-forwarded by ff is tested at t0 + age either way.
    const ff = human ? Math.min(cfg.hitscanAssistMs, rewindMs) / 1000 : 0;

    for (const s of shots) {
      const shell: Shell = {
        state: {
          id: this.nextId++,
          owner: robot.id,
          pos: { ...pivot },
          vel: { x: s.dir.x * cfg.projectileSpeed, y: s.dir.y * cfg.projectileSpeed, z: s.dir.z * cfg.projectileSpeed },
          bouncesLeft: robot.stats.ricochetBounces,
          age: 0,
          lifetime: cfg.projectileLifetime,
          damage,
          knockback,
          radius: cfg.projectileRadius,
          assist: human,
          dist: 0,
        },
        human,
        seq: req.seq,
        barrel: s.barrel,
        recvTick: this.tick,
        rewindMs,
        t0,
        aimYaw: req.aimYaw,
        aimPitch: pitch,
        muzzle: s.origin,
        dir: s.dir,
        closest: Infinity,
        closestAbove: false,
      };
      // Hinge -> muzzle: a barrel poking through a wall (or into an enemy) resolves right here.
      if (this.barrelBlocked(shell, pivot, s.origin)) continue;
      shell.state.pos = { ...s.origin };
      this.host.emit({
        k: 'shot', pid: shell.state.id, owner: robot.id, p: { ...s.origin }, v: { ...shell.state.vel },
        bounces: shell.state.bouncesLeft, seq: req.seq, b: s.barrel, ff,
      });
      let alive = true;
      let left = ff;
      while (alive && left > 1e-6) {
        const h = Math.min(FIXED_DT, left);
        left -= h;
        alive = this.advance(shell, h);
      }
      if (alive) this.shells.push(shell);
    }
    return true;
  }

  update(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.shells.length; i++) {
      const s = this.shells[i];
      if (this.advance(s, dt)) this.shells[w++] = s;
    }
    this.shells.length = w;
  }

  clear(): void {
    this.shells = [];
  }

  /** Steps one shell; returns false once it has resolved. */
  private advance(s: Shell, dt: number): boolean {
    const host = this.host;
    const p = s.state;
    this.poolCount = this.lag.sample(s.t0 + (p.age + dt) * 1000, this.pool);
    this.prev.x = p.pos.x; this.prev.y = p.pos.y; this.prev.z = p.pos.z;
    const kind = stepProjectile(this.world, p, dt, this.step);
    this.trackClosest(s);
    const r = this.step;
    if (kind === StepKind.FLY) {
      if (p.pos.y < -5) {
        this.resolve(s, false, -1, p.pos, s.closest < NEAR_MISS_M ? (s.closestAbove ? 'passed over' : 'passed under') : 'out of range', false, 0);
        return false;
      }
      return true;
    }
    if (kind === StepKind.BOUNCE) {
      host.emit({ k: 'bounce', pid: p.id, p: { ...r.point }, v: { ...p.vel } });
      return true;
    }
    if (kind === StepKind.EXPIRE) {
      const reason: ShotMissReason = s.closest < NEAR_MISS_M ? (s.closestAbove ? 'passed over' : 'passed under') : 'out of range';
      this.resolve(s, false, -1, p.pos, reason, false, 0);
      return false;
    }
    const point = { ...r.point };
    const normal = { ...r.normal };
    if (kind === StepKind.HIT_ENV) {
      host.emit({ k: 'impact', pid: p.id, p: point, n: normal, target: -1, dmg: 0, owner: p.owner });
      this.resolve(s, false, -1, point, this.envMissReason(s, point), false, 0);
      return false;
    }
    this.hitRobot(s, r.targetId, point, normal, r.assisted);
    return false;
  }

  private hitRobot(s: Shell, targetId: number, point: Vec3, normal: Vec3, assisted: boolean): void {
    const host = this.host;
    const p = s.state;
    const owner = host.robotById(p.owner);
    const target = host.robotById(targetId);
    let dealt = 0;
    if (target && target.alive) {
      // The hit was found on the rewound pose; push the body where it is now.
      const sampled = this.pool.find((t) => t.id === targetId);
      const now = target.position();
      const at = sampled ? { x: now.x + point.x - sampled.p.x, y: now.y + point.y - sampled.p.y, z: now.z + point.z - sampled.p.z } : point;
      const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
      const k = p.knockback / speed;
      if (host.combatEnabled()) target.controller.body.applyImpulseAtPoint({ x: p.vel.x * k, y: p.knockback * 0.18, z: p.vel.z * k }, at, true);
      dealt = host.applyDamage(target, p.damage, owner ?? null, 'projectile', point);
    }
    host.emit({ k: 'impact', pid: p.id, p: point, n: normal, target: targetId, dmg: Math.round(dealt), owner: p.owner });
    const self = targetId === p.owner;
    const reason: ShotMissReason = self ? 'self-collision' : dealt > 0 ? 'hit' : 'filtered';
    this.resolve(s, dealt > 0 && !self, targetId, point, reason, assisted, dealt);
  }

  private barrelBlocked(s: Shell, pivot: Vec3, muzzle: Vec3): boolean {
    const dx = muzzle.x - pivot.x, dy = muzzle.y - pivot.y, dz = muzzle.z - pivot.z;
    const len = Math.hypot(dx, dy, dz);
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    this.poolCount = this.lag.sample(s.t0, this.pool);
    const envHit = this.castEnv(pivot, dir, len, this.env);
    const reach = envHit ? this.env.t : len;
    if (castHitTargets(this.pool, this.poolCount, pivot, dir, reach, s.state.radius, 0, 0, s.state.owner, this.robotHit)) {
      this.hitRobot(s, this.robotHit.targetId, { ...this.robotHit.point }, { ...this.robotHit.normal }, false);
      return true;
    }
    if (!envHit) return false;
    const point = { ...this.env.point };
    this.host.emit({ k: 'impact', pid: s.state.id, p: point, n: { ...this.env.normal }, target: -1, dmg: 0, owner: s.state.owner });
    this.resolve(s, false, -1, point, 'blocked', false, 0);
    return true;
  }

  /** Records the shell's closest approach to any enemy hitbox centre over the last segment. */
  private trackClosest(s: Shell): void {
    const a = this.prev, b = s.state.pos;
    const sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z;
    const len2 = sx * sx + sy * sy + sz * sz;
    for (let i = 0; i < this.poolCount; i++) {
      const t = this.pool[i];
      if (t.id === s.state.owner) continue;
      const c = hitboxCenter(t, this.center);
      let u = len2 > 0 ? ((c.x - a.x) * sx + (c.y - a.y) * sy + (c.z - a.z) * sz) / len2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const px = a.x + sx * u, py = a.y + sy * u, pz = a.z + sz * u;
      const d = Math.hypot(px - c.x, py - c.y, pz - c.z);
      if (d < s.closest) {
        s.closest = d;
        s.closestAbove = py > c.y;
      }
    }
  }

  /** A wall hit is "blocked" when an enemy stood further along the line of fire. */
  private envMissReason(s: Shell, point: Vec3): ShotMissReason {
    const hitDist = Math.hypot(point.x - s.muzzle.x, point.y - s.muzzle.y, point.z - s.muzzle.z);
    for (let i = 0; i < this.poolCount; i++) {
      const t = this.pool[i];
      if (t.id === s.state.owner) continue;
      const c = hitboxCenter(t, this.center);
      const rx = c.x - s.muzzle.x, ry = c.y - s.muzzle.y, rz = c.z - s.muzzle.z;
      const along = rx * s.dir.x + ry * s.dir.y + rz * s.dir.z;
      const perp = Math.hypot(rx - s.dir.x * along, ry - s.dir.y * along, rz - s.dir.z * along);
      if (along > hitDist && perp < NEAR_MISS_M) return 'blocked';
    }
    if (s.closest < NEAR_MISS_M) return s.closestAbove ? 'passed over' : 'passed under';
    return 'no contact';
  }

  private resolve(s: Shell, hit: boolean, target: number, point: Vec3, reason: ShotMissReason, assisted: boolean, dmg: number): void {
    if (!s.human) return;
    const shooter = this.host.robotById(s.state.owner);
    if (!shooter) return;
    const msg: ShotResultMsg = {
      seq: s.seq,
      b: s.barrel,
      pid: s.state.id,
      recvTick: s.recvTick,
      rewindMs: Math.round(s.rewindMs),
      aimYaw: s.aimYaw,
      aimPitch: s.aimPitch,
      muzzle: s.muzzle,
      dir: s.dir,
      hit,
      target,
      point: { x: point.x, y: point.y, z: point.z },
      reason,
      assisted,
      dmg: Math.round(dmg),
      closest: Number.isFinite(s.closest) ? Math.round(s.closest * 100) / 100 : -1,
    };
    this.host.sendTo(shooter, Msg.SHOT_RESULT, msg);
  }
}
