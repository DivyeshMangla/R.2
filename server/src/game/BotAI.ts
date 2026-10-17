import {
  angleDiff,
  ARENA_HALF_SIZE,
  Buttons,
  clamp,
  distance,
  physicsConfig,
  SPAWN_POINTS,
  yawFromQuat,
  type InputFrame,
  type Vec3,
} from '@robot-arena/shared';
import type { PhysicsWorld } from './PhysicsWorld';
import type { ServerRobot } from './ServerRobot';

export interface BotWorldView {
  physics: PhysicsWorld;
  robots(): Iterable<ServerRobot>;
}

type BotMode = 'hunt' | 'retreat' | 'wander';

/**
 * Server-side bot: seeks the nearest enemy, circle-strafes inside weapon range,
 * fires with lead when it has line of sight, and retreats when low on HP.
 */
export class BotAI {
  private mode: BotMode = 'wander';
  private targetId = -1;
  private retargetTimer = 0;
  private strafeDir = Math.random() < 0.5 ? -1 : 1;
  private strafeTimer = 2 + Math.random() * 3;
  private stuckTimer = 0;
  private reverseTimer = 0;
  private aimNoise = 0;
  private aimNoiseTarget = 0;
  private aimNoiseTimer = 0;
  private wanderPoint: Vec3 = { x: 0, y: 0, z: 0 };
  private wanderTimer = 0;
  private reactionTimer = 0.4;
  private readonly skill = 0.65 + Math.random() * 0.3;

  think(self: ServerRobot, view: BotWorldView, dt: number): InputFrame {
    const pos = self.position();
    const vel = self.velocity();
    const rot = self.controller.body.rotation();
    const yaw = yawFromQuat(rot);
    const speed = Math.hypot(vel.x, vel.z);

    this.retargetTimer -= dt;
    this.strafeTimer -= dt;
    this.aimNoiseTimer -= dt;
    this.wanderTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeDir *= -1;
      this.strafeTimer = 2 + Math.random() * 3.5;
    }
    if (this.aimNoiseTimer <= 0) {
      this.aimNoiseTarget = (Math.random() - 0.5) * 0.16 * (1.4 - this.skill);
      this.aimNoiseTimer = 0.3 + Math.random() * 0.5;
    }
    this.aimNoise += (this.aimNoiseTarget - this.aimNoise) * Math.min(1, dt * 4);

    let target = this.findTarget(self, view, pos);
    const hpFrac = self.hp / self.stats.maxHp;
    if (hpFrac < 0.3 && target) this.mode = 'retreat';
    else if (target) this.mode = 'hunt';
    else this.mode = 'wander';
    if (this.mode === 'retreat' && hpFrac > 0.55) this.mode = 'hunt';

    let desired: Vec3;
    let boost = false;
    let wantAbility = false;
    let distToTarget = Infinity;
    if (target) distToTarget = distance(pos, target.position());

    if (this.mode === 'hunt' && target) {
      const tp = target.position();
      if (distToTarget > 17) {
        desired = tp;
        boost = distToTarget > 26;
      } else {
        const dx = pos.x - tp.x;
        const dz = pos.z - tp.z;
        const d = Math.hypot(dx, dz) || 1;
        const ox = dx / d, oz = dz / d;
        const tx = -oz * this.strafeDir, tz = ox * this.strafeDir;
        const ring = 11;
        desired = { x: tp.x + ox * ring + tx * 9, y: 0, z: tp.z + oz * ring + tz * 9 };
      }
      if (self.stats.abilities.includes('emp') && self.empCooldown <= 0 && distToTarget < physicsConfig.empRadius * 0.75) wantAbility = true;
      if (self.stats.abilities.includes('dash') && self.controller.sim.dashCooldown <= 0 && distToTarget > 22) wantAbility = true;
    } else if (this.mode === 'retreat' && target) {
      const tp = target.position();
      let best = SPAWN_POINTS[0].position;
      let bestD = -1;
      for (const s of SPAWN_POINTS) {
        const d = distance(s.position, tp);
        if (d > bestD) {
          bestD = d;
          best = s.position;
        }
      }
      desired = best;
      boost = true;
      if (self.stats.abilities.includes('dash') && self.controller.sim.dashCooldown <= 0) wantAbility = true;
      if (self.stats.abilities.includes('emp') && self.empCooldown <= 0 && distToTarget < physicsConfig.empRadius * 0.6) wantAbility = true;
    } else {
      if (this.wanderTimer <= 0 || distance(pos, this.wanderPoint) < 5) {
        const a = Math.random() * Math.PI * 2;
        const r = 8 + Math.random() * 24;
        this.wanderPoint = { x: Math.sin(a) * r, y: 0, z: Math.cos(a) * r };
        this.wanderTimer = 6;
      }
      desired = this.wanderPoint;
    }

    // Keep away from the outer barriers.
    const lim = ARENA_HALF_SIZE - 5;
    desired = { x: clamp(desired.x, -lim, lim), y: desired.y, z: clamp(desired.z, -lim, lim) };

    const desiredYaw = Math.atan2(desired.x - pos.x, desired.z - pos.z);
    let diff = angleDiff(yaw, desiredYaw);

    // Whisker probes for obstacle avoidance.
    const probeOrigin = { x: pos.x, y: pos.y + 0.1, z: pos.z };
    const probeLen = 5 + speed * 0.35;
    const probe = (offset: number): number => {
      const a = yaw + offset;
      const d = view.physics.rayEnvironment(probeOrigin, { x: Math.sin(a), y: 0, z: Math.cos(a) }, probeLen);
      return d === null ? probeLen : d;
    };
    const front = probe(0);
    if (front < probeLen * 0.95) {
      const left = probe(0.6);
      const right = probe(-0.6);
      diff += (left > right ? 1 : -1) * (1 - front / probeLen) * 1.6;
    }

    let throttle = Math.abs(diff) > 2.0 ? 0.45 : 1;
    let steer = clamp(-diff * 2.2, -1, 1);

    if (Math.abs(throttle) > 0.4 && speed < 1.2) this.stuckTimer += dt;
    else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
    if (this.stuckTimer > 1.1) {
      this.reverseTimer = 0.9 + Math.random() * 0.5;
      this.stuckTimer = 0;
    }
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      throttle = -1;
      steer = -steer;
      boost = false;
    }

    // Aim with lead.
    let aimYaw = self.aimYaw;
    let fire = false;
    if (target) {
      const tp = target.position();
      const tv = target.velocity();
      const t = distToTarget / physicsConfig.projectileSpeed;
      const lead = { x: tp.x + tv.x * t * this.skill, y: tp.y, z: tp.z + tv.z * t * this.skill };
      aimYaw = Math.atan2(lead.x - pos.x, lead.z - pos.z) + this.aimNoise;
      const eye = { x: pos.x, y: pos.y + 0.8, z: pos.z };
      const los = view.physics.lineOfSight(eye, { x: tp.x, y: tp.y + 0.5, z: tp.z });
      if (los && distToTarget < 36) {
        this.reactionTimer -= dt;
        fire = this.reactionTimer <= 0;
      } else {
        this.reactionTimer = 0.25 + (1 - this.skill) * 0.6;
      }
    }

    let buttons = 0;
    if (fire) buttons |= Buttons.FIRE;
    if (boost && throttle > 0) buttons |= Buttons.BOOST;
    if (wantAbility) buttons |= Buttons.ABILITY;
    return { seq: 0, throttle, steer, aimYaw, buttons };
  }

  private findTarget(self: ServerRobot, view: BotWorldView, pos: Vec3): ServerRobot | null {
    let current: ServerRobot | null = null;
    let nearest: ServerRobot | null = null;
    let nearestD = Infinity;
    for (const r of view.robots()) {
      if (r === self || !r.alive) continue;
      if (r.id === this.targetId) current = r;
      const d = distance(pos, r.position());
      if (d < nearestD) {
        nearestD = d;
        nearest = r;
      }
    }
    if (this.retargetTimer <= 0 || !current) {
      this.retargetTimer = 0.6;
      this.targetId = nearest ? nearest.id : -1;
      return nearest;
    }
    return current;
  }
}
