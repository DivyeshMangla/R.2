import {
  castHitTargets,
  clampAimPitch,
  computeWeaponShots,
  createEnvCaster,
  FIXED_DT,
  getTurretPivot,
  getWeapon,
  hitboxCenter,
  makeEnvHit,
  makeHitTarget,
  makeRobotHit,
  makeStepResult,
  MAX_PLAYERS,
  Msg,
  physicsConfig,
  quatFromYaw,
  ROBOT_HITBOX_CENTER,
  rotateVec,
  StepKind,
  stepProjectile,
  weaponStats,
  yawFromQuat,
  type DamageCauseWire,
  type HitTarget,
  type ProjectileState,
  type ProjectileWorld,
  type ShotMissReason,
  type ShotResultMsg,
  type StatusSpec,
  type Vec3,
  type WeaponDef,
  type WeaponId,
  type ZoneSpec,
} from '@robot-arena/shared';
import type { GameHost } from './GameHost';
import type { LagCompensator } from './LagCompensator';
import type { ServerRobot } from './ServerRobot';
import { applyStatus, grantShield, grantSpeedBoost } from './StatusSystem';

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
  weaponId: WeaponId;
  def: Readonly<WeaponDef>;
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
  /** Robots this shell may still pass through. */
  pierceLeft: number;
  /** Robots already hit (pierce never re-hits one). */
  hitIds: number[];
  /** SHOT_RESULT already sent (pierce reports its first hit). */
  reported: boolean;
}

/** Remaining shots of a multi-shot single use (revolver, pistol). */
interface Burst {
  robot: ServerRobot;
  weaponId: WeaponId;
  remaining: number;
  index: number;
  timer: number;
  interval: number;
  seq: number;
  viewT: number;
  elapsed: number;
}

/** A melee swing waiting for its lunge, or a sustained cone / chainsaw. */
interface ActiveUse {
  robot: ServerRobot;
  def: Readonly<WeaponDef>;
  /** Seconds before an instant melee swing lands. */
  delay: number;
  /** Sustained time left (cone / chainsaw). */
  timeLeft: number;
  tick: number;
}

/** A dropped proximity barrel (toxic_barrel): blasts the first time an enemy comes near. */
interface Barrel {
  owner: number;
  def: Readonly<WeaponDef>;
  p: Vec3;
  damage: number;
  /** Seconds before it can trigger. */
  arm: number;
  timeLeft: number;
}

interface Zone {
  zid: number;
  owner: number;
  spec: ZoneSpec;
  p: Vec3;
  timeLeft: number;
  tick: number;
}

const POOL_SIZE = MAX_PLAYERS + 2;
const NEAR_MISS_M = 2.5;
const HOMING_RANGE = 40;
const CHAIN_RANGE = 16;
const CHAIN_DAMAGE = 0.7;
const MELEE_DELAY_S = 0.12;
const SUSTAIN_TICK_S = 0.2;
const ZONE_TICK_S = 0.5;
const ZONE_HEIGHT = 3;
const DASH_HIT_RADIUS = 2.4;
const SELF_BLAST_MUL = 0.5;
const BARREL_ARM_S = 0.3;
/** Burst shots after the first get a distinct barrel key: barrel + index * BURST_BARREL_STRIDE. */
export const BURST_BARREL_STRIDE = 100;

function causeFor(status: StatusSpec | undefined, fallback: DamageCauseWire): DamageCauseWire {
  if (status?.effect === 'burn') return 'burn';
  if (status?.effect === 'poison') return 'poison';
  return fallback;
}

/**
 * Authoritative single-use arsenal. Every trigger pull spends the held weapon
 * (`weapon` null event) and resolves by its kind: lag-compensated shells
 * (projectile / lob), instant beams, sustained cones, melee swings, dashes,
 * pulses, self buffs and deployed hazard zones.
 */
export class WeaponSystem {
  private readonly host: GameHost;
  private readonly lag: LagCompensator;
  private shells: Shell[] = [];
  private bursts: Burst[] = [];
  private actives: ActiveUse[] = [];
  private zones: Zone[] = [];
  private barrels: Barrel[] = [];
  private nextId = 1;
  private nextZoneId = 1;
  private tick = 0;
  private readonly castEnv: ProjectileWorld['castEnv'];
  private readonly pool: HitTarget[] = Array.from({ length: POOL_SIZE }, makeHitTarget);
  private poolCount = 0;
  /** Pool view handed to stepProjectile (pierce shells skip robots they already hit). */
  private castPool: HitTarget[] = this.pool;
  private castCount = 0;
  private readonly filtered: HitTarget[] = [];
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
      castRobots: (o, d, max, radius, padH, padV, ignore, out) => castHitTargets(this.castPool, this.castCount, o, d, max, radius, padH, padV, ignore, out),
    };
  }

  fireIntervalFor(robot: ServerRobot): number {
    if (robot.weaponId === null) return 0;
    return weaponStats(robot.weaponId).interval / robot.stats.fireRateMul;
  }

  /** Called once per simulation tick before inputs are processed. */
  beginTick(tick: number): void {
    this.tick = tick;
  }

  /** True while a burst / sustained use of this robot is still running. */
  busy(robot: ServerRobot): boolean {
    return this.bursts.some((b) => b.robot === robot) || this.actives.some((a) => a.robot === robot);
  }

  /** One trigger pull: resolves the held weapon's single use and spends it. */
  tryFire(robot: ServerRobot, req: FireRequest): boolean {
    if (robot.weaponId === null || robot.fireCooldown > 0 || !robot.alive || this.busy(robot)) return false;
    const id = robot.weaponId;
    const def = getWeapon(id);
    robot.fireCooldown = this.fireIntervalFor(robot);
    const pitch = clampAimPitch(req.aimPitch);
    const host = this.host;
    host.emit({ k: 'use', id: robot.id, weaponId: id, p: robot.position(), yaw: req.aimYaw, pitch });
    robot.weaponId = null;
    host.emit({ k: 'weapon', id: robot.id, weaponId: null });
    host.markRosterDirty();

    // A use-time rush (e.g. the syringe leech dart); sustained melee grants its own for its duration.
    if (def.kind !== 'self' && !(def.kind === 'melee' && def.duration > 0) && def.speedBoost > 0 && def.buffDuration > 0) {
      grantSpeedBoost(robot, def.speedBoost, def.buffDuration);
    }

    switch (def.kind) {
      case 'projectile':
      case 'lob':
        this.fireShells(robot, id, req, 0);
        if (def.burst > 1) {
          const interval = physicsConfig.fireInterval * def.fireIntervalMul / robot.stats.fireRateMul;
          this.bursts.push({ robot, weaponId: id, remaining: def.burst - 1, index: 1, timer: interval, interval, seq: req.seq, viewT: req.viewT, elapsed: 0 });
        }
        break;
      case 'beam':
        this.fireBeam(robot, id, def, req);
        break;
      case 'cone':
        this.actives.push({ robot, def, delay: 0, timeLeft: Math.max(def.duration, FIXED_DT), tick: 0 });
        break;
      case 'melee':
        this.lunge(robot, def, req.aimYaw);
        if (def.duration > 0) {
          grantSpeedBoost(robot, def.speedBoost, def.duration);
          this.actives.push({ robot, def, delay: 0, timeLeft: def.duration, tick: 0 });
        } else {
          this.actives.push({ robot, def, delay: def.lunge > 0 ? MELEE_DELAY_S : 0, timeLeft: 0, tick: 0 });
        }
        break;
      case 'dash':
        this.dash(robot, def, req.aimYaw);
        break;
      case 'pulse':
        this.pulse(robot, def);
        break;
      case 'self':
        if (def.heal > 0) host.heal(robot, def.heal, robot.id);
        if (def.shield > 0) grantShield(host, robot, def.shield, def.buffDuration);
        if (def.speedBoost > 0) grantSpeedBoost(robot, def.speedBoost, def.buffDuration);
        // Shield canister: the activation releases a lethal shockwave around the user.
        if (def.damage > 0 && def.range > 0) {
          host.emit({ k: 'explode', owner: robot.id, weaponId: id, p: robot.position(), r: def.range });
          this.pulse(robot, def);
        }
        break;
      case 'deploy':
        this.deploy(robot, def);
        break;
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
    this.updateBursts(dt);
    this.updateActives(dt);
    this.updateZones(dt);
    this.updateBarrels(dt);
  }

  clear(): void {
    this.shells = [];
    this.bursts = [];
    this.actives = [];
    this.zones = [];
    this.barrels = [];
  }

  // ------------------------------------------------------------ shells

  private fireShells(robot: ServerRobot, weaponId: WeaponId, req: FireRequest, burstIndex: number): void {
    const cfg = physicsConfig;
    const def = getWeapon(weaponId);
    const weapon = weaponStats(weaponId);
    const human = !robot.isBot;
    const latest = this.lag.latestTime();
    const rewindMs = cfg.lagCompEnabled > 0 && req.viewT > 0 ? Math.min(cfg.lagCompMaxMs, Math.max(0, latest - req.viewT)) : 0;
    const t0 = latest - rewindMs;
    const pitch = clampAimPitch(req.aimPitch);
    const body = robot.controller.body;
    const p = body.translation();
    const q = body.rotation();
    const shots = computeWeaponShots(p, q, req.aimYaw, pitch, robot.stats.projectileCount, robot.id, req.seq, weaponId);
    const pivot = getTurretPivot(p, q, { x: 0, y: 0, z: 0 });
    const damage = weapon.damage * robot.stats.damageMul;
    const knockback = weapon.knockback * robot.stats.knockbackMul;
    // The hitscan assist spends rewind: a shell fast-forwarded by ff is tested at t0 + age either way.
    const ff = human && def.kind === 'projectile' ? Math.min(cfg.hitscanAssistMs, rewindMs) / 1000 : 0;

    for (const s of shots) {
      const barrel = s.barrel + burstIndex * BURST_BARREL_STRIDE;
      const shell: Shell = {
        state: {
          id: this.nextId++,
          owner: robot.id,
          pos: { ...pivot },
          vel: { x: s.dir.x * weapon.speed, y: s.dir.y * weapon.speed, z: s.dir.z * weapon.speed },
          bouncesLeft: robot.stats.ricochetBounces + def.bounces,
          age: 0,
          lifetime: weapon.lifetime,
          damage,
          knockback,
          radius: weapon.radius,
          assist: human,
          dist: 0,
          ...(def.gravity > 0 ? { gravity: def.gravity } : {}),
        },
        weaponId,
        def,
        human,
        seq: req.seq,
        barrel,
        recvTick: this.tick,
        rewindMs,
        t0,
        aimYaw: req.aimYaw,
        aimPitch: pitch,
        muzzle: s.origin,
        dir: s.dir,
        closest: Infinity,
        closestAbove: false,
        pierceLeft: def.pierce,
        hitIds: [],
        reported: false,
      };
      // Hinge -> muzzle: a barrel poking through a wall (or into an enemy) resolves right here.
      if (this.barrelBlocked(shell, pivot, s.origin)) continue;
      shell.state.pos = { ...s.origin };
      this.host.emit({
        k: 'shot', pid: shell.state.id, owner: robot.id, p: { ...s.origin }, v: { ...shell.state.vel },
        bounces: shell.state.bouncesLeft, seq: req.seq, b: barrel, ff, weaponId, lifetime: weapon.lifetime,
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
  }

  private updateBursts(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.bursts.length; i++) {
      const b = this.bursts[i];
      if (!b.robot.alive || !this.host.combatEnabled()) continue;
      b.timer -= dt;
      b.elapsed += dt;
      while (b.timer <= 0 && b.remaining > 0) {
        const r = b.robot;
        const viewT = b.viewT > 0 ? b.viewT + b.elapsed * 1000 : 0;
        this.fireShells(r, b.weaponId, { aimYaw: r.aimYaw, aimPitch: r.aimPitch, seq: b.seq, viewT }, b.index);
        b.index += 1;
        b.remaining -= 1;
        b.timer += b.interval;
      }
      if (b.remaining > 0) this.bursts[w++] = b;
    }
    this.bursts.length = w;
  }

  /** Steps one shell; returns false once it has resolved. */
  private advance(s: Shell, dt: number): boolean {
    const host = this.host;
    const p = s.state;
    this.poolCount = this.lag.sample(s.t0 + (p.age + dt) * 1000, this.pool);
    this.selectCastPool(s);
    if (s.def.homing > 0) this.steer(s, dt);
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
      this.detonate(s, { ...p.pos }, null, -1);
      return false;
    }
    const point = { ...r.point };
    const normal = { ...r.normal };
    if (kind === StepKind.HIT_ENV) {
      host.emit({ k: 'impact', pid: p.id, p: point, n: normal, target: -1, dmg: 0, owner: p.owner });
      this.resolve(s, false, -1, point, this.envMissReason(s, point), false, 0);
      this.detonate(s, point, normal, -1);
      return false;
    }
    const targetId = r.targetId;
    if (this.hitRobot(s, targetId, point, normal, r.assisted)) {
      // Pierce: carry on just past the victim.
      const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
      p.pos.x += p.vel.x / speed * 0.05; p.pos.y += p.vel.y / speed * 0.05; p.pos.z += p.vel.z / speed * 0.05;
      return true;
    }
    this.detonate(s, point, null, targetId);
    return false;
  }

  private selectCastPool(s: Shell): void {
    if (s.hitIds.length === 0) {
      this.castPool = this.pool;
      this.castCount = this.poolCount;
      return;
    }
    this.filtered.length = 0;
    for (let i = 0; i < this.poolCount; i++) if (!s.hitIds.includes(this.pool[i].id)) this.filtered.push(this.pool[i]);
    this.castPool = this.filtered;
    this.castCount = this.filtered.length;
  }

  /** Homing: turn the velocity toward the nearest enemy at up to `homing` rad/s. */
  private steer(s: Shell, dt: number): void {
    const p = s.state;
    if (p.age < 0.12) return;
    let best: Vec3 | null = null;
    let bestD = HOMING_RANGE;
    for (const r of this.host.robots()) {
      if (!r.alive || r.id === p.owner || r.protectTimer > 0 || s.hitIds.includes(r.id)) continue;
      const c = this.liveCenter(r);
      const d = Math.hypot(c.x - p.pos.x, c.y - p.pos.y, c.z - p.pos.z);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best) return;
    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    if (speed < 1e-3) return;
    const dx = p.vel.x / speed, dy = p.vel.y / speed, dz = p.vel.z / speed;
    let tx = best.x - p.pos.x, ty = best.y - p.pos.y, tz = best.z - p.pos.z;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const cos = Math.max(-1, Math.min(1, dx * tx + dy * ty + dz * tz));
    const angle = Math.acos(cos);
    const turn = s.def.homing * dt;
    let nx = tx, ny = ty, nz = tz;
    if (angle > turn) {
      let ux = tx - dx * cos, uy = ty - dy * cos, uz = tz - dz * cos;
      const ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-6) return;
      ux /= ul; uy /= ul; uz /= ul;
      const c = Math.cos(turn), sn = Math.sin(turn);
      nx = dx * c + ux * sn; ny = dy * c + uy * sn; nz = dz * c + uz * sn;
    }
    p.vel.x = nx * speed; p.vel.y = ny * speed; p.vel.z = nz * speed;
  }

  /** Applies a shell hit; returns true when the shell pierces on. */
  private hitRobot(s: Shell, targetId: number, point: Vec3, normal: Vec3, assisted: boolean): boolean {
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
      const before = target.hp + target.shield;
      dealt = host.applyDamage(target, p.damage, owner ?? null, 'projectile', point);
      // Leech: heal the shooter by what the hit actually drained.
      if (dealt > 0 && s.def.lifesteal > 0 && owner && owner.alive && targetId !== p.owner) {
        host.heal(owner, Math.min(dealt, before) * s.def.lifesteal, owner.id);
      }
      if (s.def.status && targetId !== p.owner) applyStatus(host, target, s.def.status, p.owner);
    }
    host.emit({ k: 'impact', pid: p.id, p: point, n: normal, target: targetId, dmg: Math.round(dealt), owner: p.owner });
    const self = targetId === p.owner;
    const reason: ShotMissReason = self ? 'self-collision' : dealt > 0 ? 'hit' : 'filtered';
    this.resolve(s, dealt > 0 && !self, targetId, point, reason, assisted, dealt);
    if (!self && s.def.chain > 0) this.chain(s, targetId, point);
    if (!self && s.pierceLeft > 0) {
      s.pierceLeft -= 1;
      s.hitIds.push(targetId);
      return true;
    }
    return false;
  }

  /** Chain lightning: jump from the impact to the nearest unhit enemies. */
  private chain(s: Shell, firstId: number, point: Vec3): void {
    const host = this.host;
    const owner = host.robotById(s.state.owner) ?? null;
    const hit = new Set<number>([s.state.owner, firstId]);
    const pts: Vec3[] = [{ ...point }];
    let from = point;
    for (let jump = 0; jump < s.def.chain; jump++) {
      let best: ServerRobot | null = null;
      let bestC: Vec3 | null = null;
      let bestD = CHAIN_RANGE;
      for (const r of host.robots()) {
        if (!r.alive || hit.has(r.id) || r.protectTimer > 0) continue;
        const c = this.liveCenter(r);
        const d = Math.hypot(c.x - from.x, c.y - from.y, c.z - from.z);
        if (d >= bestD || !this.clearLine(from, c)) continue;
        best = r; bestC = c; bestD = d;
      }
      if (!best || !bestC) break;
      hit.add(best.id);
      host.applyDamage(best, s.state.damage * CHAIN_DAMAGE, owner, 'beam', bestC);
      if (s.def.status) applyStatus(host, best, s.def.status, s.state.owner);
      pts.push(bestC);
      from = bestC;
    }
    if (pts.length > 1) host.emit({ k: 'chain', owner: s.state.owner, pts });
  }

  /** End of a shell's life: explosion, hazard zone and/or owner teleport. */
  private detonate(s: Shell, point: Vec3, normal: Vec3 | null, directTarget: number): void {
    const def = s.def;
    if (def.explodeRadius > 0) this.explode(s.state.owner, s.weaponId, point, def.explodeRadius, s.state.damage, s.state.knockback, directTarget, def.status);
    if (def.zone) this.spawnZone(s.state.owner, def.zone, point);
    if (def.teleport) {
      const owner = this.host.robotById(s.state.owner);
      if (owner && owner.alive) {
        const v = s.state.vel;
        const sp = Math.hypot(v.x, v.y, v.z) || 1;
        const back = directTarget >= 0 ? 2 : normal ? 0 : 0.5;
        const dest = {
          x: point.x - v.x / sp * back + (normal ? normal.x * 1.2 : 0),
          y: point.y + (normal ? normal.y * 1.2 : 0),
          z: point.z - v.z / sp * back + (normal ? normal.z * 1.2 : 0),
        };
        this.teleportRobot(owner, dest, null);
      }
    }
  }

  private explode(ownerId: number, weaponId: WeaponId, point: Vec3, radius: number, damage: number, knockback: number, exclude: number, status?: StatusSpec): void {
    const host = this.host;
    host.emit({ k: 'explode', owner: ownerId, weaponId, p: { ...point }, r: radius });
    if (!host.combatEnabled()) return;
    const owner = host.robotById(ownerId) ?? null;
    const origin = { x: point.x, y: point.y + 0.3, z: point.z };
    for (const r of host.robots()) {
      if (!r.alive || r.id === exclude) continue;
      const c = this.liveCenter(r);
      const d = Math.hypot(c.x - point.x, c.y - point.y, c.z - point.z);
      if (d > radius || !this.clearLine(origin, c)) continue;
      const falloff = 1 - (d / radius) * 0.6;
      const hx = c.x - point.x, hz = c.z - point.z;
      const hl = Math.hypot(hx, hz) || 1;
      const k = Math.max(knockback, physicsConfig.chassisMass * 4) * falloff;
      if (r.protectTimer <= 0) r.controller.body.applyImpulse({ x: hx / hl * k, y: k * 0.5, z: hz / hl * k }, true);
      host.applyDamage(r, damage * falloff * (r.id === ownerId ? SELF_BLAST_MUL : 1), owner, 'blast', c);
      if (status && r.id !== ownerId) applyStatus(host, r, status, ownerId);
    }
  }

  // ------------------------------------------------------------ zones

  private spawnZone(ownerId: number, spec: ZoneSpec, at: Vec3): void {
    // Land the hazard on the floor below the burst point (lobs can expire mid-air).
    const p = { x: at.x, y: this.host.physics.groundHeight(at.x, at.z, at.y + 1), z: at.z };
    const zone: Zone = { zid: this.nextZoneId++, owner: ownerId, spec, p, timeLeft: spec.duration, tick: 0 };
    this.zones.push(zone);
    this.host.emit({ k: 'zone', zid: zone.zid, owner: ownerId, kind: spec.kind, p: { ...p }, r: spec.radius, dur: spec.duration });
  }

  private updateZones(dt: number): void {
    const host = this.host;
    let w = 0;
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      z.timeLeft -= dt;
      z.tick += dt;
      if (z.tick >= ZONE_TICK_S) {
        const chunk = z.tick;
        z.tick = 0;
        const owner = host.robotById(z.owner) ?? null;
        for (const r of host.robots()) {
          if (!r.alive || r.id === z.owner) continue;
          const p = r.position();
          if (Math.hypot(p.x - z.p.x, p.z - z.p.z) > z.spec.radius || Math.abs(p.y - z.p.y) > ZONE_HEIGHT) continue;
          if (z.spec.status) applyStatus(host, r, z.spec.status, z.owner);
          host.applyDamage(r, z.spec.dps * chunk, owner, 'zone', p);
        }
      }
      if (z.timeLeft > 0) this.zones[w++] = z;
    }
    this.zones.length = w;
  }

  private deploy(robot: ServerRobot, def: Readonly<WeaponDef>): void {
    const p = robot.position();
    const f = robot.controller.forward();
    const fl = Math.hypot(f.x, f.z) || 1;
    const at = { x: p.x - f.x / fl * 3, y: p.y + 0.5, z: p.z - f.z / fl * 3 };
    if (def.zone) this.spawnZone(robot.id, def.zone, at);
    if (def.triggerRadius > 0 && def.damage > 0) {
      const ground = { x: at.x, y: this.host.physics.groundHeight(at.x, at.z, at.y + 1), z: at.z };
      this.barrels.push({
        owner: robot.id, def, p: ground, damage: def.damage * robot.stats.damageMul,
        arm: BARREL_ARM_S, timeLeft: def.zone ? def.zone.duration : 10,
      });
    }
  }

  /** Proximity barrels: the first enemy inside `triggerRadius` sets off the blast (owner immune). */
  private updateBarrels(dt: number): void {
    const host = this.host;
    let w = 0;
    for (let i = 0; i < this.barrels.length; i++) {
      const b = this.barrels[i];
      b.timeLeft -= dt;
      b.arm -= dt;
      let triggered = false;
      if (b.arm <= 0 && host.combatEnabled()) {
        for (const r of host.robots()) {
          if (!r.alive || r.id === b.owner || r.protectTimer > 0) continue;
          const p = r.position();
          if (Math.hypot(p.x - b.p.x, p.z - b.p.z) <= b.def.triggerRadius && Math.abs(p.y - b.p.y) <= ZONE_HEIGHT) { triggered = true; break; }
        }
      }
      if (triggered) {
        const center = { x: b.p.x, y: b.p.y + 0.6, z: b.p.z };
        this.explode(b.owner, b.def.id, center, b.def.explodeRadius, b.damage, b.def.push * physicsConfig.chassisMass, b.owner, b.def.status);
        continue;
      }
      if (b.timeLeft > 0) this.barrels[w++] = b;
    }
    this.barrels.length = w;
  }

  // ------------------------------------------------------------ instant / close-range kinds

  private fireBeam(robot: ServerRobot, weaponId: WeaponId, def: Readonly<WeaponDef>, req: FireRequest): void {
    const cfg = physicsConfig;
    const host = this.host;
    const human = !robot.isBot;
    const latest = this.lag.latestTime();
    const rewindMs = cfg.lagCompEnabled > 0 && req.viewT > 0 ? Math.min(cfg.lagCompMaxMs, Math.max(0, latest - req.viewT)) : 0;
    this.poolCount = this.lag.sample(latest - rewindMs, this.pool);
    const body = robot.controller.body;
    const bp = body.translation();
    const bq = body.rotation();
    const shot = computeWeaponShots(bp, bq, req.aimYaw, clampAimPitch(req.aimPitch), 1, robot.id, req.seq, weaponId)[0];
    const pivot = getTurretPivot(bp, bq, { x: 0, y: 0, z: 0 });
    const origin = shot.origin;
    const dir = shot.dir;
    let to: Vec3;
    let target = -1;
    // Barrel through a wall: the beam stops at the wall.
    const bx = origin.x - pivot.x, by = origin.y - pivot.y, bz = origin.z - pivot.z;
    const bl = Math.hypot(bx, by, bz) || 1;
    if (this.castEnv(pivot, { x: bx / bl, y: by / bl, z: bz / bl }, bl, this.env)) {
      to = { ...this.env.point };
    } else {
      const envHit = this.castEnv(origin, dir, def.range, this.env);
      const reach = envHit ? this.env.t : def.range;
      const assist = human && cfg.aimAssistEnabled > 0;
      const padH = assist ? cfg.aimAssistRadiusH : 0;
      const padV = assist ? cfg.aimAssistRadiusV : 0;
      if (castHitTargets(this.pool, this.poolCount, origin, dir, reach, 0.2, padH, padV, robot.id, this.robotHit)) {
        to = { ...this.robotHit.point };
        target = this.robotHit.targetId;
        const victim = host.robotById(target);
        if (victim && victim.alive) {
          const k = def.push * cfg.chassisMass;
          if (host.combatEnabled() && victim.protectTimer <= 0) victim.controller.body.applyImpulse({ x: dir.x * k, y: k * 0.2, z: dir.z * k }, true);
          host.applyDamage(victim, def.damage * robot.stats.damageMul, robot, 'beam', to);
          if (def.status) applyStatus(host, victim, def.status, robot.id);
        }
      } else {
        to = envHit ? { ...this.env.point } : { x: origin.x + dir.x * def.range, y: origin.y + dir.y * def.range, z: origin.z + dir.z * def.range };
      }
    }
    host.emit({ k: 'beam', owner: robot.id, weaponId, from: { ...origin }, to, target });
  }

  private lunge(robot: ServerRobot, def: Readonly<WeaponDef>, yaw: number): void {
    if (def.lunge <= 0) return;
    const k = def.lunge * physicsConfig.chassisMass;
    robot.controller.body.applyImpulse({ x: Math.sin(yaw) * k, y: k * 0.08, z: Math.cos(yaw) * k }, true);
  }

  private updateActives(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.actives.length; i++) {
      const a = this.actives[i];
      if (!a.robot.alive) continue;
      if (a.timeLeft <= 0) {
        // Instant melee swing: lands once its lunge has had a moment to close in.
        a.delay -= dt;
        if (a.delay > 0) { this.actives[w++] = a; continue; }
        this.swing(a.robot, a.def, 1);
        continue;
      }
      const step = Math.min(dt, a.timeLeft);
      a.timeLeft -= dt;
      a.tick += step;
      const ending = a.timeLeft <= 0;
      if (a.tick >= SUSTAIN_TICK_S || ending) {
        const chunk = a.tick;
        a.tick = 0;
        this.swing(a.robot, a.def, chunk);
      }
      if (!ending) this.actives[w++] = a;
    }
    this.actives.length = w;
  }

  /**
   * Hits every robot in front of `robot` within the weapon's range / arc.
   * `scale` is 1 for an instant swing, or the elapsed seconds for sustained
   * per-second damage (cone, chainsaw).
   */
  private swing(robot: ServerRobot, def: Readonly<WeaponDef>, scale: number): void {
    const host = this.host;
    if (!host.combatEnabled()) return;
    const cfg = physicsConfig;
    const sustained = def.duration > 0;
    const origin = robot.position();
    const eye = { x: origin.x, y: origin.y + 0.6, z: origin.z };
    const yaw = robot.aimYaw;
    const cause: DamageCauseWire = def.kind === 'cone' ? causeFor(def.status, 'melee') : 'melee';
    for (const r of host.robots()) {
      if (r === robot || !r.alive) continue;
      const p = r.position();
      const dx = p.x - origin.x, dz = p.z - origin.z;
      const flat = Math.hypot(dx, dz);
      if (flat > def.range || Math.abs(p.y - origin.y) > 3) continue;
      const off = Math.atan2(dx, dz) - yaw;
      const diff = Math.abs(Math.atan2(Math.sin(off), Math.cos(off)));
      // Point-blank targets count even slightly outside the arc.
      if (diff > def.arc / 2 && flat > 1.8) continue;
      const c = this.liveCenter(r);
      if (!this.clearLine(eye, c)) continue;
      const nx = flat > 1e-3 ? dx / flat : Math.sin(yaw), nz = flat > 1e-3 ? dz / flat : Math.cos(yaw);
      if (r.protectTimer <= 0) {
        const push = def.push * cfg.chassisMass * (sustained ? scale : 1);
        const up = def.launch * cfg.chassisMass + push * 0.2;
        if (push > 0 || up > 0) r.controller.body.applyImpulse({ x: nx * push, y: up, z: nz * push }, true);
      }
      const dealt = host.applyDamage(r, def.damage * scale * robot.stats.damageMul, robot, cause, c);
      if (def.status) applyStatus(host, r, def.status, robot.id);
      if (dealt > 0) host.emit({ k: 'melee', owner: robot.id, target: r.id, weaponId: def.id, p: c, dmg: Math.round(dealt) });
      if (def.disarm && r.alive && r.weaponId !== null && r.protectTimer <= 0) {
        r.weaponId = null;
        host.emit({ k: 'weapon', id: r.id, weaponId: null });
        host.emit({ k: 'disarm', owner: robot.id, victim: r.id });
        host.markRosterDirty();
      }
    }
  }

  private pulse(robot: ServerRobot, def: Readonly<WeaponDef>): void {
    const host = this.host;
    if (!host.combatEnabled()) return;
    const cfg = physicsConfig;
    const origin = robot.position();
    const eye = { x: origin.x, y: origin.y + 0.6, z: origin.z };
    for (const r of host.robots()) {
      if (r === robot || !r.alive) continue;
      const c = this.liveCenter(r);
      const d = Math.hypot(c.x - origin.x, c.y - origin.y, c.z - origin.z);
      if (d > def.range || !this.clearLine(eye, c)) continue;
      const hx = c.x - origin.x, hz = c.z - origin.z;
      const hl = Math.hypot(hx, hz) || 1;
      if (r.protectTimer <= 0) {
        const k = def.push * cfg.chassisMass;
        r.controller.body.applyImpulse({ x: hx / hl * k, y: cfg.chassisMass * 2 + def.launch * cfg.chassisMass, z: hz / hl * k }, true);
      }
      const dealt = host.applyDamage(r, def.damage * robot.stats.damageMul, robot, causeFor(def.status, 'melee'), c);
      if (def.status) applyStatus(host, r, def.status, robot.id);
      if (dealt > 0) host.emit({ k: 'melee', owner: robot.id, target: r.id, weaponId: def.id, p: c, dmg: Math.round(dealt) });
    }
  }

  /** Katana: blink up to `range` along the aim, slicing everything near the path once. */
  private dash(robot: ServerRobot, def: Readonly<WeaponDef>, yaw: number): void {
    const host = this.host;
    const cfg = physicsConfig;
    const from = robot.position();
    const dir = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
    const eye = { x: from.x, y: from.y + 0.5, z: from.z };
    const dist = this.castEnv(eye, dir, def.range, this.env) ? Math.max(0, this.env.t - 1.6) : def.range;
    const to = { x: from.x + dir.x * dist, y: from.y, z: from.z + dir.z * dist };
    if (host.combatEnabled()) {
      for (const r of host.robots()) {
        if (r === robot || !r.alive) continue;
        const p = r.position();
        if (Math.abs(p.y - from.y) > 2.5) continue;
        const rx = p.x - from.x, rz = p.z - from.z;
        const along = Math.max(0, Math.min(dist, rx * dir.x + rz * dir.z));
        const px = from.x + dir.x * along - p.x, pz = from.z + dir.z * along - p.z;
        if (Math.hypot(px, pz) > DASH_HIT_RADIUS) continue;
        const c = this.liveCenter(r);
        if (r.protectTimer <= 0) {
          const side = Math.hypot(px, pz) > 1e-3 ? { x: -px / Math.hypot(px, pz), z: -pz / Math.hypot(px, pz) } : { x: dir.z, z: -dir.x };
          const k = def.push * cfg.chassisMass;
          r.controller.body.applyImpulse({ x: (side.x + dir.x * 0.5) * k, y: k * 0.3 + def.launch * cfg.chassisMass, z: (side.z + dir.z * 0.5) * k }, true);
        }
        const dealt = host.applyDamage(r, def.damage * robot.stats.damageMul, robot, 'melee', c);
        if (def.status) applyStatus(host, r, def.status, robot.id);
        if (dealt > 0) host.emit({ k: 'melee', owner: robot.id, target: r.id, weaponId: def.id, p: c, dmg: Math.round(dealt) });
      }
    }
    this.teleportRobot(robot, to, { x: dir.x * 8, y: 0, z: dir.z * 8 });
  }

  /** Moves a robot instantly (upright, keeping its heading) and emits `teleport`. */
  private teleportRobot(robot: ServerRobot, dest: Vec3, vel: Vec3 | null): void {
    const body = robot.controller.body;
    const from = robot.position();
    const ground = this.host.physics.groundHeight(dest.x, dest.z, dest.y + 1.5);
    const to = { x: dest.x, y: Math.max(dest.y, ground + 0.9), z: dest.z };
    body.setTranslation(to, true);
    body.setRotation(quatFromYaw(yawFromQuat(body.rotation())), true);
    body.setLinvel(vel ?? { x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.host.emit({ k: 'teleport', id: robot.id, from, to: { ...to } });
  }

  // ------------------------------------------------------------ helpers

  private liveCenter(r: ServerRobot): Vec3 {
    const p = r.controller.body.translation();
    const c = rotateVec(r.controller.body.rotation(), ROBOT_HITBOX_CENTER);
    return { x: p.x + c.x, y: p.y + c.y, z: p.z + c.z };
  }

  private clearLine(a: Vec3, b: Vec3): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return true;
    return !this.castEnv(a, { x: dx / len, y: dy / len, z: dz / len }, len, this.env);
  }

  private barrelBlocked(s: Shell, pivot: Vec3, muzzle: Vec3): boolean {
    const dx = muzzle.x - pivot.x, dy = muzzle.y - pivot.y, dz = muzzle.z - pivot.z;
    const len = Math.hypot(dx, dy, dz);
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    this.poolCount = this.lag.sample(s.t0, this.pool);
    const envHit = this.castEnv(pivot, dir, len, this.env);
    const reach = envHit ? this.env.t : len;
    if (castHitTargets(this.pool, this.poolCount, pivot, dir, reach, s.state.radius, 0, 0, s.state.owner, this.robotHit)) {
      const point = { ...this.robotHit.point };
      const targetId = this.robotHit.targetId;
      s.pierceLeft = 0;
      this.hitRobot(s, targetId, point, { ...this.robotHit.normal }, false);
      this.detonate(s, point, null, targetId);
      return true;
    }
    if (!envHit) return false;
    const point = { ...this.env.point };
    const normal = { ...this.env.normal };
    this.host.emit({ k: 'impact', pid: s.state.id, p: point, n: normal, target: -1, dmg: 0, owner: s.state.owner });
    this.resolve(s, false, -1, point, 'blocked', false, 0);
    this.detonate(s, point, normal, -1);
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
    if (!s.human || s.reported) return;
    s.reported = true;
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
