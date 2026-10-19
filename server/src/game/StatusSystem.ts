import type { StatusSpec } from '@robot-arena/shared';
import type { GameHost } from './GameHost';
import type { ServerRobot } from './ServerRobot';

/** Damage-over-time is applied in chunks of this many seconds (readable damage numbers). */
const DOT_TICK_S = 0.5;

/**
 * Applies a weapon status to `target`. Durations refresh (max), DoT takes the
 * strongest dps. Emits `status` when the effect is newly applied (stun: always).
 * Returns false when the target is immune (protected, dead, or combat is off).
 */
export function applyStatus(host: GameHost, target: ServerRobot, spec: StatusSpec, attackerId: number): boolean {
  if (!host.combatEnabled() || !target.alive || target.protectTimer > 0) return false;
  let fresh = false;
  switch (spec.effect) {
    case 'burn':
      fresh = target.burnTimer <= 0;
      target.burnTimer = Math.max(target.burnTimer, spec.duration);
      target.burnDps = fresh ? spec.dps ?? 0 : Math.max(target.burnDps, spec.dps ?? 0);
      target.burnSource = attackerId;
      break;
    case 'poison':
      fresh = target.poisonTimer <= 0;
      target.poisonTimer = Math.max(target.poisonTimer, spec.duration);
      target.poisonDps = fresh ? spec.dps ?? 0 : Math.max(target.poisonDps, spec.dps ?? 0);
      target.poisonSource = attackerId;
      break;
    case 'slow':
      fresh = target.slowTimer <= 0;
      target.slowTimer = Math.max(target.slowTimer, spec.duration);
      target.refreshModifiers();
      break;
    case 'stun':
      fresh = true;
      target.stunTimer = Math.max(target.stunTimer, spec.duration);
      break;
  }
  if (attackerId >= 0 && attackerId !== target.id) target.damageLog.set(attackerId, host.time);
  if (fresh) host.emit({ k: 'status', target: target.id, effect: spec.effect, dur: spec.duration });
  return true;
}

export function grantShield(host: GameHost, robot: ServerRobot, amount: number, duration: number): void {
  if (amount <= 0) return;
  robot.shield = Math.max(robot.shield, amount);
  robot.shieldTimer = Math.max(robot.shieldTimer, duration > 0 ? duration : 10);
  host.emit({ k: 'shield', id: robot.id, amount: Math.round(robot.shield) });
}

export function grantSpeedBoost(robot: ServerRobot, mul: number, duration: number): void {
  if (mul <= 0 || duration <= 0) return;
  robot.speedBoostMul = robot.speedBoostTimer > 0 ? Math.max(robot.speedBoostMul, mul) : mul;
  robot.speedBoostTimer = Math.max(robot.speedBoostTimer, duration);
  robot.refreshModifiers();
}

/** Shield soaks damage before HP. Returns the damage left over for HP. */
export function absorbWithShield(host: GameHost, robot: ServerRobot, amount: number): number {
  if (robot.shield <= 0) return amount;
  const soaked = Math.min(robot.shield, amount);
  robot.shield -= soaked;
  if (robot.shield <= 1e-3) {
    robot.shield = 0;
    robot.shieldTimer = 0;
    host.emit({ k: 'shield', id: robot.id, amount: 0 });
  }
  return amount - soaked;
}

/** Ticks DoT, slow, shield and speed-boost timers for every living robot. */
export function updateStatuses(host: GameHost, dt: number): void {
  for (const r of host.robots()) {
    if (!r.alive) continue;
    const wasSlow = r.slowTimer > 0, wasBoosted = r.speedBoostTimer > 0;
    r.slowTimer = Math.max(0, r.slowTimer - dt);
    r.speedBoostTimer = Math.max(0, r.speedBoostTimer - dt);
    if ((wasSlow && r.slowTimer <= 0) || (wasBoosted && r.speedBoostTimer <= 0)) r.refreshModifiers();
    if (r.shieldTimer > 0) {
      r.shieldTimer = Math.max(0, r.shieldTimer - dt);
      if (r.shieldTimer <= 0 && r.shield > 0) {
        r.shield = 0;
        host.emit({ k: 'shield', id: r.id, amount: 0 });
      }
    }
    if (r.burnTimer <= 0 && r.poisonTimer <= 0) {
      r.dotTick = 0;
      continue;
    }
    // Damage covers only the time each effect was actually active this chunk.
    const burnT = Math.min(dt, r.burnTimer);
    const poisonT = Math.min(dt, r.poisonTimer);
    r.burnTimer = Math.max(0, r.burnTimer - dt);
    r.poisonTimer = Math.max(0, r.poisonTimer - dt);
    r.dotTick += dt;
    r.dotBurn += burnT * r.burnDps;
    r.dotPoison += poisonT * r.poisonDps;
    const ending = r.burnTimer <= 0 && r.poisonTimer <= 0;
    if (r.dotTick < DOT_TICK_S && !ending) continue;
    r.dotTick = 0;
    const p = r.position();
    const burn = r.dotBurn, poison = r.dotPoison;
    r.dotBurn = 0;
    r.dotPoison = 0;
    if (burn > 0) host.applyDamage(r, burn, host.robotById(r.burnSource) ?? null, 'burn', p);
    if (poison > 0 && r.alive) host.applyDamage(r, poison, host.robotById(r.poisonSource) ?? null, 'poison', p);
  }
}
