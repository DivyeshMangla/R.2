import * as THREE from 'three';
import { physicsConfig, RobotFlags, type PowerUpStacks } from '@robot-arena/shared';
import { RobotModelFactory, type RobotModel } from './RobotModelFactory';

export interface WheelTelemetry {
  suspension: number[];
  rotation: number[];
  steering: number[];
}

export interface RobotPoseInput {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  aimYaw: number;
  steer: number;
  forwardSpeed: number;
  flags: number;
  wheels: WheelTelemetry | null;
}

const _invRoot = new THREE.Quaternion();
const _yawQ = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _white = new THREE.Color(1, 1, 1);
const _stunColor = new THREE.Color(0.35, 0.7, 1.6);

/** Visual state of one robot: pose, wheel animation, turret aim, level glow and add-ons. */
export class RobotView {
  readonly model: RobotModel;
  readonly id: number;
  level = 1;
  private readonly wheelAngles = [0, 0, 0, 0];
  private hitFlash = 0;
  private stacksKey = '';
  private readonly levelColor = new THREE.Color();
  private readonly factory: RobotModelFactory;

  constructor(id: number, color: number, factory: RobotModelFactory, scene: THREE.Scene) {
    this.id = id;
    this.factory = factory;
    this.model = factory.create(color);
    scene.add(this.model.root);
    this.setLevel(1);
  }

  get root(): THREE.Group {
    return this.model.root;
  }

  setVisible(v: boolean): void {
    this.model.root.visible = v;
  }

  /** Re-tints paint + accents (e.g. when the roster arrives after the first snapshot). */
  setColor(color: number): void {
    if (this.model.accentBase.getHex() === color) return;
    const team = new THREE.Color(color);
    this.model.accentBase.copy(team);
    this.model.paint.color.copy(team).lerp(new THREE.Color(0x30343c), 0.45);
    this.setLevel(this.level);
  }

  setLevel(level: number): void {
    this.level = level;
    // Hue drifts and the glow gets hotter/whiter as the robot levels up.
    this.levelColor.copy(this.model.accentBase).offsetHSL((level - 1) * 0.012, 0.05, 0).lerp(_white, (level - 1) * 0.035);
  }

  setPowerUps(stacks: PowerUpStacks): void {
    const key = JSON.stringify(stacks);
    if (key === this.stacksKey) return;
    this.stacksKey = key;
    this.factory.applyPowerUps(this.model, stacks);
  }

  flashHit(): void {
    this.hitFlash = 1;
  }

  update(p: RobotPoseInput, dt: number, time: number): void {
    const root = this.model.root;
    const slots = this.model.slots;
    root.position.copy(p.position);
    root.quaternion.copy(p.quaternion);

    // Turret holds world yaw regardless of chassis attitude.
    _invRoot.copy(p.quaternion).invert();
    _yawQ.setFromAxisAngle(_up, p.aimYaw);
    slots.turret.quaternion.copy(_invRoot).multiply(_yawQ);

    const r = physicsConfig.wheelRadius;
    const rest = physicsConfig.suspensionRestLength;
    const maxSteer = physicsConfig.maxSteerAngle / (1 + Math.abs(p.forwardSpeed) * physicsConfig.steerSpeedFalloff);
    slots.wheels.forEach((w, i) => {
      let susp = rest;
      let steer = i < 2 ? -p.steer * maxSteer : 0;
      if (p.wheels) {
        susp = p.wheels.suspension[i];
        steer = p.wheels.steering[i];
        this.wheelAngles[i] = p.wheels.rotation[i];
      } else {
        this.wheelAngles[i] += (p.forwardSpeed / r) * dt;
      }
      w.pivot.position.y = w.anchor.y - susp;
      w.pivot.rotation.y = steer;
      w.spin.rotation.x = this.wheelAngles[i];
    });

    // Emissive accents: level glow, boost surge, hit flash, stun flicker.
    this.hitFlash = Math.max(0, this.hitFlash - dt * 6);
    const boosting = (p.flags & RobotFlags.BOOSTING) !== 0;
    const stunned = (p.flags & RobotFlags.STUNNED) !== 0;
    const accent = this.model.accent;
    let intensity = 2.2 + this.level * 0.45 + (boosting ? 2.5 : 0) + Math.sin(time * 3 + this.id) * 0.25;
    if (stunned) {
      accent.emissive.copy(_stunColor);
      intensity *= Math.random() < 0.5 ? 0.2 : 1.6;
    } else {
      accent.emissive.copy(this.levelColor);
    }
    accent.emissiveIntensity = intensity;
    this.model.paint.emissive.setRGB(this.hitFlash * 0.9, this.hitFlash * 0.85, this.hitFlash * 0.8);

    const shield = slots.shield;
    shield.visible = (p.flags & RobotFlags.PROTECTED) !== 0;
    if (shield.visible) shield.rotation.y += dt * 1.5;
    slots.leechCore.rotation.y += dt * 2;
    slots.empCoil.rotation.y += dt * (stunned ? 0 : 3);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.model.root);
    this.model.dispose();
  }
}
