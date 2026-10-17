import { muzzleTransforms, physicsConfig, stepProjectile, type ProjectileState } from '@robot-arena/shared';
import type { GameHost } from './GameHost';
import type { ServerRobot } from './ServerRobot';

/** Authoritative projectile cannon: spawning, swept-ray travel, ricochets, damage and knockback. */
export class WeaponSystem {
  private readonly host: GameHost;
  private projectiles: ProjectileState[] = [];
  private nextId = 1;

  constructor(host: GameHost) {
    this.host = host;
  }

  fireIntervalFor(robot: ServerRobot): number {
    return physicsConfig.fireInterval / robot.stats.fireRateMul;
  }

  tryFire(robot: ServerRobot, aimYaw: number): boolean {
    if (robot.fireCooldown > 0 || !robot.alive) return false;
    const cfg = physicsConfig;
    robot.fireCooldown = this.fireIntervalFor(robot);
    const body = robot.controller.body;
    const muzzles = muzzleTransforms(body.translation(), body.rotation(), aimYaw, robot.stats.projectileCount, cfg.twinSpread);
    const damage = cfg.projectileDamage * robot.stats.damageMul;
    const knockback = cfg.projectileImpulse * robot.stats.knockbackMul;
    for (const m of muzzles) {
      const p: ProjectileState = {
        id: this.nextId++,
        owner: robot.id,
        pos: m.p,
        vel: { x: m.d.x * cfg.projectileSpeed, y: m.d.y * cfg.projectileSpeed, z: m.d.z * cfg.projectileSpeed },
        bouncesLeft: robot.stats.ricochetBounces,
        age: 0,
        lifetime: cfg.projectileLifetime,
        damage,
        knockback,
      };
      this.projectiles.push(p);
      this.host.emit({ k: 'shot', pid: p.id, owner: robot.id, p: { ...p.pos }, v: { ...p.vel }, bounces: p.bouncesLeft });
    }
    return true;
  }

  update(dt: number): void {
    const host = this.host;
    const physics = host.physics;
    const survivors: ProjectileState[] = [];
    for (const p of this.projectiles) {
      const owner = host.robotById(p.owner);
      const exclude = owner && owner.alive ? owner.controller.collider : undefined;
      const r = stepProjectile(physics.world, p, dt, exclude, physics.isEnvironment);
      if (r.kind === 'fly') {
        if (p.pos.y < -5) continue;
        survivors.push(p);
        continue;
      }
      if (r.kind === 'expire') continue;
      if (r.kind === 'bounce') {
        host.emit({ k: 'bounce', pid: p.id, p: { ...r.point }, v: { ...p.vel } });
        survivors.push(p);
        continue;
      }
      // `r` is a reused object; snapshot it before anything else can step a projectile.
      const point = { ...r.point };
      const normal = { ...r.normal };
      const targetId = physics.robotIdForCollider(r.collider);
      const target = targetId !== undefined ? host.robotById(targetId) : undefined;
      let dealt = 0;
      if (target && target.alive) {
        const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
        const k = p.knockback / speed;
        const impulse = { x: p.vel.x * k, y: p.knockback * 0.18, z: p.vel.z * k };
        if (host.combatEnabled()) target.controller.body.applyImpulseAtPoint(impulse, point, true);
        dealt = host.applyDamage(target, p.damage, owner ?? null, 'projectile', point);
      }
      host.emit({ k: 'impact', pid: p.id, p: point, n: normal, target: target ? target.id : -1, dmg: Math.round(dealt), owner: p.owner });
    }
    this.projectiles = survivors;
  }

  clear(): void {
    this.projectiles = [];
  }
}
