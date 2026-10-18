import * as THREE from 'three';
import { physicsConfig, RobotFlags, WHEEL_ANCHORS, type CharacterId, type MapBiome, type PowerUpStacks, type WeaponId } from '@robot-arena/shared';

export interface WheelTelemetry {
  suspension: number[];
  rotation: number[];
  steering: number[];
  contact: boolean[];
}

const _invQ = new THREE.Quaternion();
const _localV = new THREE.Vector3();
const _accel = new THREE.Vector3();

/**
 * Client-side visual state of one robot. Pure presentation: lean, recoil,
 * barrel heat, wheel animation, landing squash, damage tier. Never feeds back
 * into physics or networking.
 */
export class RobotVisual {
  readonly id: number;
  readonly slot: number;
  color: number;
  characterId: CharacterId = 'striker';
  weaponId: WeaponId | null = null;
  biome: MapBiome = 'volcanic';
  level = 1;
  stacks: PowerUpStacks = {};
  stacksKey = '';

  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  aimYaw = 0;
  /** Target barrel pitch (radians, up positive); `barrelPitch` is the smoothed value that is drawn. */
  aimPitch = 0;
  barrelPitch = 0;
  steerInput = 0;
  /** Authoritative front-wheel angle for remote visuals; local wheels use telemetry. */
  steeringAngle = 0;
  flags = 0;
  hp = 100;
  maxHp = 100;
  visible = true;

  // Wheels
  readonly wheelSuspension = [0, 0, 0, 0];
  readonly wheelSteer = [0, 0, 0, 0];
  readonly wheelSpin = [0, 0, 0, 0];
  readonly wheelContact = [true, true, true, true];
  hasTelemetry = false;

  // Lean (visual-only chassis attitude offset)
  leanPitch = 0;
  leanRoll = 0;
  private leanPitchVel = 0;
  private leanRollVel = 0;
  private readonly prevLocalVel = new THREE.Vector3();
  private readonly prevWorldVel = new THREE.Vector3();
  private longitudinalAccel = 0;
  private lateralAccel = 0;
  private hasPrevVel = false;
  readonly leanQuat = new THREE.Quaternion();

  // Landing squash (extra visual suspension compression for every robot)
  squash = 0;
  private squashVel = 0;
  private prevVy = 0;
  airTime = 0;
  /** Set for one frame when a landing happens; value = impact speed. */
  landingImpact = 0;

  // Weapon
  recoil = 0;
  private recoilVel = 0;
  heat = 0;

  hitFlash = 0;
  /** Seconds since the robot last took damage (drives regen VFX). */
  sinceDamaged = 99;
  boosterGlow = 0;
  dashTimer = 0;
  aura = 0;
  flickerPhase = Math.random() * 10;
  /** 0 = healthy, 1 = below 66%, 2 = below 33%. */
  damageTier = 0;
  damagePointIndex = Math.floor(Math.random() * 5);
  emitTimer = 0;
  readonly wearSeed = Math.random();

  constructor(id: number, slot: number, color: number) {
    this.id = id;
    this.slot = slot;
    this.color = color;
    for (let i = 0; i < 4; i++) this.wheelSuspension[i] = physicsConfig.suspensionRestLength;
  }

  get alive(): boolean {
    return (this.flags & RobotFlags.ALIVE) !== 0;
  }

  onFire(): void {
    this.recoilVel -= 9;
    this.heat = Math.min(1, this.heat + 0.16);
  }

  onDamaged(): void {
    this.hitFlash = 1;
    this.sinceDamaged = 0;
  }

  onDash(): void {
    this.dashTimer = 0.55;
  }

  /** Teleports reset anything that integrates over time. */
  resetMotion(): void {
    this.hasPrevVel = false;
    this.longitudinalAccel = this.lateralAccel = 0;
    this.leanPitch = this.leanRoll = this.leanPitchVel = this.leanRollVel = 0;
    this.squash = this.squashVel = 0;
    this.airTime = 0;
    this.prevVy = 0;
  }

  setTelemetry(t: WheelTelemetry | null): void {
    this.hasTelemetry = t !== null;
    if (!t) return;
    for (let i = 0; i < 4; i++) {
      this.wheelSuspension[i] = t.suspension[i];
      this.wheelSteer[i] = t.steering[i];
      this.wheelSpin[i] = t.rotation[i];
      this.wheelContact[i] = t.contact[i];
    }
  }

  update(dt: number, leanStrength: number): void {
    if (dt <= 0) return;
    const cfg = physicsConfig;

    // Barrel pitch follows the aim with a 25 ms time constant (~95% within 75 ms).
    this.barrelPitch += (this.aimPitch - this.barrelPitch) * (1 - Math.exp(-dt / 0.025));

    // Differentiate in world space FIRST. Differentiating local velocity erases
    // centripetal acceleration during a steady corner, making the chassis rigid.
    _invQ.copy(this.quaternion).invert();
    _localV.copy(this.velocity).applyQuaternion(_invQ);
    let targetPitch = 0;
    let targetRoll = 0;
    if (this.hasPrevVel) {
      _accel.copy(this.velocity).sub(this.prevWorldVel).divideScalar(dt).applyQuaternion(_invQ);
      const response = 1 - Math.exp(-dt * 9);
      this.longitudinalAccel += (THREE.MathUtils.clamp(_accel.z, -16, 16) - this.longitudinalAccel) * response;
      this.lateralAccel += (THREE.MathUtils.clamp(_accel.x, -14, 14) - this.lateralAccel) * response;
      const supported = this.hasTelemetry ? this.wheelContact.some(Boolean) : Math.abs(this.velocity.y) < 1.5;
      if (supported) {
        // +X pitch lowers the +Z nose. Accelerating lifts it; braking dips it.
        targetPitch = THREE.MathUtils.clamp(-this.longitudinalAccel * 0.0075, -0.075, 0.075) * leanStrength;
        targetRoll = THREE.MathUtils.clamp(this.lateralAccel * 0.009, -0.09, 0.09) * leanStrength;
      }
    }
    this.prevLocalVel.copy(_localV);
    this.prevWorldVel.copy(this.velocity);
    this.hasPrevVel = true;
    // Settle like a sprung body, with stable integration during a slow frame.
    const steps = Math.max(1, Math.ceil(dt * 120)), step = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.leanPitchVel += ((targetPitch - this.leanPitch) * 95 - this.leanPitchVel * 17) * step;
      this.leanRollVel += ((targetRoll - this.leanRoll) * 85 - this.leanRollVel * 15) * step;
      this.leanPitch += this.leanPitchVel * step;
      this.leanRoll += this.leanRollVel * step;
    }
    this.leanQuat.setFromEuler(_euler.set(this.leanPitch, 0, this.leanRoll));

    // Landing detection.
    this.landingImpact = 0;
    const vy = this.velocity.y;
    let grounded = !this.hasTelemetry && Math.abs(vy) < 1.5;
    if (this.hasTelemetry) for (let i = 0; i < 4; i++) grounded = grounded || this.wheelContact[i];
    if (!grounded) this.airTime += dt;
    else {
      if (this.airTime > 0.18 && this.prevVy < -3) {
        this.landingImpact = -this.prevVy;
        this.squashVel -= Math.min(4, this.landingImpact * 0.35);
      }
      this.airTime = 0;
    }
    this.prevVy = vy;
    this.squashVel += (-this.squash * 220 - this.squashVel * 16) * dt;
    this.squash += this.squashVel * dt;

    // Recoil spring + barrel heat.
    this.recoilVel += (-this.recoil * 380 - this.recoilVel * 24) * dt;
    this.recoil += this.recoilVel * dt;
    this.recoil = Math.max(this.recoil, -0.28);
    this.heat = Math.max(0, this.heat - dt * 0.22);

    // Remote wheels use the same speed-limited angle as the authoritative chassis.
    if (!this.hasTelemetry) {
      const fwdSpeed = _localV.z;
      for (let i = 0; i < 4; i++) {
        this.wheelSpin[i] += (fwdSpeed / cfg.wheelRadius) * dt;
        this.wheelSteer[i] = i < 2 ? this.steeringAngle : 0;
        this.wheelSuspension[i] = cfg.suspensionRestLength - 0.06;
      }
    }

    this.hitFlash = Math.max(0, this.hitFlash - dt * 6);
    this.sinceDamaged += dt;
    this.dashTimer = Math.max(0, this.dashTimer - dt);
    const boosting = (this.flags & RobotFlags.BOOSTING) !== 0;
    const glowTarget = this.dashTimer > 0 ? 3 : boosting ? 1.4 : 0.2;
    this.boosterGlow += (glowTarget - this.boosterGlow) * Math.min(1, dt * 10);
    const frac = this.maxHp > 0 ? this.hp / this.maxHp : 1;
    this.damageTier = frac < 0.33 ? 2 : frac < 0.66 ? 1 : 0;
    const auraTarget = this.level >= 10 ? 1 : this.level >= 5 ? 0.45 : 0;
    this.aura += (auraTarget - this.aura) * Math.min(1, dt * 2);
  }

  /** Forward speed in the chassis frame (m/s) from the last update. */
  get forwardSpeed(): number {
    return this.prevLocalVel.z;
  }

  get lateralSpeed(): number {
    return this.prevLocalVel.x;
  }
}

const _euler = new THREE.Euler();

export const WHEEL_COUNT = WHEEL_ANCHORS.length;
