import {
  aimAnglesFrom, angleDiff, getTurretPivot, makeAimSolution, ROBOT_HITBOX_CENTER, rotateVec,
  ARENA_HALF_SIZE, Buttons, clamp, distance, weaponStats, yawFromQuat,
  type InputFrame, type SpawnPoint, type Vec3, type WeaponPickupState,
} from '@robot-arena/shared';
import type { PhysicsWorld } from './PhysicsWorld';
import type { ServerRobot } from './ServerRobot';

export interface BotWorldView {
  physics: PhysicsWorld;
  spawnPoints: readonly SpawnPoint[];
  robots(): Iterable<ServerRobot>;
  pickupSnapshot(): WeaponPickupState[];
}

const DETECTION_RADIUS = 22;
const ACQUIRE_SECONDS = 1.3;
const SHOT_PAUSE_SECONDS = 1.2;

/** Relaxed patrol bots: collect a first weapon, notice nearby threats, then fire spaced single shots. */
export class BotAI {
  private targetId = -1;
  private visibleFor = 0;
  private shotPause = 0;
  private strafeDir = 1;
  private patrolPoint: Vec3 = { x: 0, y: 0, z: 0 };
  private patrolTimer = 0;
  private stuckTimer = 0;
  private reverseTimer = 0;
  private aimNoise = 0;
  private aimNoiseTimer = 0;
  private readonly aim = makeAimSolution();

  constructor(private readonly random: () => number = Math.random) {
    this.strafeDir = random() < 0.5 ? -1 : 1;
  }

  think(self: ServerRobot, view: BotWorldView, dt: number): InputFrame {
    const pos = self.position();
    const vel = self.velocity();
    const rot = self.controller.body.rotation();
    const yaw = yawFromQuat(rot);
    const speed = Math.hypot(vel.x, vel.z);
    this.shotPause = Math.max(0, this.shotPause - dt);
    this.patrolTimer -= dt;
    this.aimNoiseTimer -= dt;
    if (this.aimNoiseTimer <= 0) {
      // Broad, slowly changing inaccuracy; bots only partially lead movers.
      this.aimNoise = (this.random() - 0.5) * 0.22;
      this.aimNoiseTimer = 0.7;
    }

    const target = this.findTarget(self, view, pos);
    if (!target || target.id !== this.targetId) this.visibleFor = 0;
    this.targetId = target?.id ?? -1;
    if (target) this.visibleFor += dt;

    let desired: Vec3;
    if (self.weaponId === null) {
      const pad = view.pickupSnapshot()
        .filter((p) => p.available && !this.nearHuman(p.position, view, self, 7))
        .sort((a, b) => distance(pos, a.position) - distance(pos, b.position))[0];
      desired = pad?.position ?? this.patrol(pos);
    } else if (target && self.hp / self.stats.maxHp > 0.3) {
      const tp = target.position();
      const dx = pos.x - tp.x, dz = pos.z - tp.z;
      const d = Math.hypot(dx, dz) || 1;
      // Maintain distance and circle locally; never boost across the map to chase.
      desired = { x: tp.x + dx / d * 15 - dz / d * this.strafeDir * 4, y: 0, z: tp.z + dz / d * 15 + dx / d * this.strafeDir * 4 };
    } else {
      desired = this.patrol(pos);
    }

    let nearestHuman = Infinity;
    for (const other of view.robots()) {
      if (other === self || other.isBot || !other.alive) continue;
      const p = other.position();
      const d = distance(pos, p);
      nearestHuman = Math.min(nearestHuman, d);
      if (d < 10) {
        // Give players a wide berth, especially while either robot is unarmed.
        const n = Math.hypot(pos.x - p.x, pos.z - p.z) || 1;
        desired = { x: pos.x + (pos.x - p.x) / n * 12, y: 0, z: pos.z + (pos.z - p.z) / n * 12 };
      }
    }
    const lim = ARENA_HALF_SIZE - 8;
    desired = { x: clamp(desired.x, -lim, lim), y: desired.y, z: clamp(desired.z, -lim, lim) };
    let diff = angleDiff(yaw, Math.atan2(desired.x - pos.x, desired.z - pos.z));
    const probeOrigin = { x: pos.x, y: pos.y + 0.1, z: pos.z };
    const probeLen = 4 + speed * 0.3;
    const probe = (offset: number): number => view.physics.rayEnvironment(probeOrigin, { x: Math.sin(yaw + offset), y: 0, z: Math.cos(yaw + offset) }, probeLen) ?? probeLen;
    const front = probe(0);
    if (front < probeLen * 0.95) diff += (probe(0.6) > probe(-0.6) ? 1 : -1) * (1 - front / probeLen) * 1.6;
    let throttle = Math.abs(diff) > 1.6 ? 0.25 : self.weaponId === null ? 0.55 : 0.4;
    let steer = clamp(-diff * 1.7, -1, 1);
    if (speed > (self.weaponId === null ? 6.5 : 5.5) || nearestHuman < 9) throttle = 0;
    if (nearestHuman < 5 && speed > 1) throttle = -0.3;
    if (throttle > 0.2 && speed < 0.8) this.stuckTimer += dt;
    else this.stuckTimer = 0;
    if (this.stuckTimer > 2) { this.reverseTimer = 0.7; this.stuckTimer = 0; }
    if (this.reverseTimer > 0) { this.reverseTimer -= dt; throttle = nearestHuman < 5 ? 0 : -0.4; steer = -steer; }

    let aimYaw = self.aimYaw;
    let aimPitch = self.aimPitch;
    let fire = false;
    if (target && self.weaponId !== null) {
      const tp = target.position();
      const tv = target.velocity();
      const flightTime = distance(pos, tp) / weaponStats(self.weaponId).speed;
      const c = rotateVec(target.controller.body.rotation(), ROBOT_HITBOX_CENTER);
      const lead = { x: tp.x + c.x + tv.x * flightTime * 0.28, y: tp.y + c.y, z: tp.z + c.z + tv.z * flightTime * 0.28 };
      const solution = aimAnglesFrom(getTurretPivot(pos, rot, { x: 0, y: 0, z: 0 }), lead, this.aim);
      aimYaw = solution.yaw + this.aimNoise;
      aimPitch = solution.pitch + this.aimNoise * 0.55;
      if (this.visibleFor >= ACQUIRE_SECONDS && this.shotPause <= 0 && self.fireCooldown <= 0) {
        fire = true;
        this.shotPause = SHOT_PAUSE_SECONDS;
      }
    }
    return { seq: 0, throttle, steer, aimYaw, aimPitch, buttons: fire ? Buttons.FIRE : 0, viewT: 0 };
  }

  private patrol(pos: Vec3): Vec3 {
    if (this.patrolTimer <= 0 || distance(pos, this.patrolPoint) < 4) {
      const a = this.random() * Math.PI * 2;
      const r = 10 + this.random() * 14;
      this.patrolPoint = { x: pos.x + Math.sin(a) * r, y: 0, z: pos.z + Math.cos(a) * r };
      this.patrolTimer = 8;
    }
    return this.patrolPoint;
  }

  private nearHuman(position: Vec3, view: BotWorldView, self: ServerRobot, radius: number): boolean {
    for (const robot of view.robots()) if (robot !== self && !robot.isBot && robot.alive && distance(position, robot.position()) < radius) return true;
    return false;
  }

  private findTarget(self: ServerRobot, view: BotWorldView, pos: Vec3): ServerRobot | null {
    if (self.weaponId === null || self.protectTimer > 0) return null;
    let nearest: ServerRobot | null = null;
    let nearestDistance = DETECTION_RADIUS;
    for (const robot of view.robots()) {
      if (robot === self || !robot.alive || robot.protectTimer > 0 || (!robot.isBot && robot.weaponId === null)) continue;
      const p = robot.position();
      const d = distance(pos, p);
      if (d >= nearestDistance || !view.physics.lineOfSight({ x: pos.x, y: pos.y + 0.8, z: pos.z }, { x: p.x, y: p.y + 0.5, z: p.z })) continue;
      nearest = robot;
      nearestDistance = d;
    }
    return nearest;
  }
}
