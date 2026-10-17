import {
  distance,
  forEachHook,
  getPowerUp,
  physicsConfig,
  type DamagedEvent,
  type HitEvent,
  type KillEvent,
  type MineWire,
  type PowerUpDef,
  type PowerUpHookContext,
  type PowerUpId,
  type Vec3,
} from '@robot-arena/shared';
import type { GameHost } from './GameHost';
import type { ServerRobot } from './ServerRobot';

interface Mine {
  id: number;
  owner: number;
  pos: Vec3;
  vel: Vec3;
  age: number;
}

/** Applies picked power-ups, runs their event hooks, and simulates ability effects (EMP, mines, regen). */
export class PowerUpSystem {
  private readonly host: GameHost;
  private mines: Mine[] = [];
  private nextMineId = 1;

  constructor(host: GameHost) {
    this.host = host;
  }

  definition(id: string): PowerUpDef | undefined {
    return getPowerUp(id);
  }

  grant(robot: ServerRobot, id: PowerUpId): void {
    const def = getPowerUp(id);
    if (!def) return;
    const current = robot.stacks[id] ?? 0;
    if (current >= def.maxStacks) return;
    robot.stacks[id] = current + 1;
    robot.recomputeStats();
    this.host.emit({ k: 'powerup', id: robot.id, powerup: id });
    this.host.markRosterDirty();
  }

  private context(robot: ServerRobot): PowerUpHookContext {
    return {
      selfId: robot.id,
      stats: robot.stats,
      heal: (amount, sourceId) => this.host.heal(robot, amount, sourceId),
      spawnMines: (position, count) => this.spawnMines(robot, position, count),
    };
  }

  onHit(attacker: ServerRobot, e: HitEvent): void {
    const ctx = this.context(attacker);
    forEachHook(attacker.stacks, 'onHit', (h, n) => h(ctx, e, n));
  }

  onKill(killer: ServerRobot, e: KillEvent): void {
    const ctx = this.context(killer);
    forEachHook(killer.stacks, 'onKill', (h, n) => h(ctx, e, n));
  }

  onDamaged(victim: ServerRobot, e: DamagedEvent): void {
    const ctx = this.context(victim);
    forEachHook(victim.stacks, 'onDamaged', (h, n) => h(ctx, e, n));
  }

  /** Space-bar abilities that the server resolves (dash is resolved inside RobotController). */
  tryAbilities(robot: ServerRobot): void {
    if (robot.stats.abilities.includes('emp') && robot.empCooldown <= 0) this.fireEmp(robot);
  }

  private fireEmp(robot: ServerRobot): void {
    const cfg = physicsConfig;
    robot.empCooldown = cfg.empCooldown;
    const origin = robot.position();
    const hits: number[] = [];
    if (this.host.combatEnabled()) {
      for (const other of this.host.robots()) {
        if (other === robot || !other.alive || other.protectTimer > 0) continue;
        const d = distance(origin, other.position());
        if (d > cfg.empRadius) continue;
        other.stunTimer = Math.max(other.stunTimer, cfg.empStunDuration);
        hits.push(other.id);
        const mass = cfg.chassisMass;
        const dir = { x: (other.position().x - origin.x) / (d || 1), z: (other.position().z - origin.z) / (d || 1) };
        other.controller.body.applyImpulse({ x: dir.x * mass * 3, y: mass * 4, z: dir.z * mass * 3 }, true);
        other.damageLog.set(robot.id, this.host.time);
      }
    }
    this.host.emit({ k: 'emp', id: robot.id, p: origin, r: cfg.empRadius, hits });
  }

  spawnMines(owner: ServerRobot, position: Vec3, count: number): void {
    for (let i = 0; i < count; i++) {
      const a = (i / Math.max(1, count)) * Math.PI * 2 + Math.random() * 0.6;
      const speed = 4 + Math.random() * 2;
      this.mines.push({
        id: this.nextMineId++,
        owner: owner.id,
        pos: { x: position.x, y: position.y + 0.5, z: position.z },
        vel: { x: Math.cos(a) * speed, y: 0, z: Math.sin(a) * speed },
        age: 0,
      });
    }
  }

  update(dt: number): void {
    this.updateRegen(dt);
    this.updateMines(dt);
  }

  private updateRegen(dt: number): void {
    const now = this.host.time;
    for (const r of this.host.robots()) {
      if (!r.alive || r.stats.regenPerSec <= 0 || r.hp >= r.stats.maxHp) continue;
      if (now - r.lastCombatTime < r.stats.regenDelay) continue;
      r.hp = Math.min(r.stats.maxHp, r.hp + r.stats.regenPerSec * dt);
    }
  }

  private updateMines(dt: number): void {
    const cfg = physicsConfig;
    const physics = this.host.physics;
    const survivors: Mine[] = [];
    for (const m of this.mines) {
      m.age += dt;
      if (m.age > cfg.mineLifetime) {
        this.explode(m, false);
        continue;
      }
      let target: ServerRobot | null = null;
      let best = cfg.mineSeekRadius;
      if (m.age > cfg.mineArmDelay) {
        for (const r of this.host.robots()) {
          if (!r.alive || r.id === m.owner) continue;
          const d = distance(m.pos, r.position());
          if (d < best) {
            best = d;
            target = r;
          }
        }
      }
      if (target) {
        const tp = target.position();
        const dx = tp.x - m.pos.x;
        const dz = tp.z - m.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        const k = Math.min(1, dt * 3);
        m.vel.x += ((dx / d) * cfg.mineSpeed - m.vel.x) * k;
        m.vel.z += ((dz / d) * cfg.mineSpeed - m.vel.z) * k;
        if (best < cfg.mineTriggerRadius) {
          this.explode(m, true);
          continue;
        }
      } else {
        const drag = Math.max(0, 1 - dt * 2.5);
        m.vel.x *= drag;
        m.vel.z *= drag;
      }
      const nx = m.pos.x + m.vel.x * dt;
      const nz = m.pos.z + m.vel.z * dt;
      const ground = physics.groundHeight(nx, nz, m.pos.y + 1.5);
      // Mines cannot climb walls: stop horizontal motion when the ground jumps up sharply.
      if (ground - (m.pos.y - 0.35) > 0.6) {
        m.vel.x *= -0.4;
        m.vel.z *= -0.4;
      } else {
        m.pos.x = nx;
        m.pos.z = nz;
        m.pos.y += (ground + 0.35 - m.pos.y) * Math.min(1, dt * 10);
      }
      survivors.push(m);
    }
    this.mines = survivors;
  }

  private explode(m: Mine, armed: boolean): void {
    const cfg = physicsConfig;
    this.host.emit({ k: 'mineBoom', mid: m.id, p: { ...m.pos }, owner: m.owner });
    if (!armed || !this.host.combatEnabled()) return;
    const owner = this.host.robotById(m.owner) ?? null;
    for (const r of this.host.robots()) {
      if (!r.alive || r.id === m.owner) continue;
      const rp = r.position();
      const d = distance(m.pos, rp);
      if (d > cfg.mineBlastRadius) continue;
      const falloff = 1 - (d / cfg.mineBlastRadius) * 0.6;
      const dir = { x: (rp.x - m.pos.x) / (d || 1), y: 0.6, z: (rp.z - m.pos.z) / (d || 1) };
      r.controller.body.applyImpulseAtPoint(
        { x: dir.x * cfg.mineImpulse * falloff, y: dir.y * cfg.mineImpulse * falloff, z: dir.z * cfg.mineImpulse * falloff },
        { x: m.pos.x, y: m.pos.y, z: m.pos.z },
        true,
      );
      this.host.applyDamage(r, cfg.mineDamage * falloff, owner, 'mine', rp);
    }
  }

  mineWire(): MineWire[] {
    return this.mines.map((m) => [m.id, Math.round(m.pos.x * 100), Math.round(m.pos.y * 100), Math.round(m.pos.z * 100), m.owner]);
  }

  clear(): void {
    this.mines = [];
  }
}
