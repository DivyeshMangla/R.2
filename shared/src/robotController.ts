import RAPIER from '@dimforge/rapier3d-compat';
import type { Collider, DynamicRayCastVehicleController, RigidBody, World } from '@dimforge/rapier3d-compat';
import { CollisionGroups } from './collisionGroups';
import { cross, dot, length, normalize, quatFromYaw, rotateVec, type Quat, type Vec3 } from './math';
import { physicsConfig } from './physicsConfig';

/** Half extents of the chassis collision box. Forward is local +Z. */
export const CHASSIS_HALF: Readonly<Vec3> = { x: 0.85, y: 0.3, z: 1.15 };

/** Wheel hard points in chassis space. Indices 0,1 are the steered front wheels. */
export const WHEEL_ANCHORS: readonly Readonly<Vec3>[] = [
  { x: 0.98, y: -0.05, z: 0.78 },
  { x: -0.98, y: -0.05, z: 0.78 },
  { x: 0.98, y: -0.05, z: -0.78 },
  { x: -0.98, y: -0.05, z: -0.78 },
];

/** Turret pivot height above the chassis origin, and barrel length. */
export const TURRET_HEIGHT = 0.62;
export const BARREL_LENGTH = 1.55;
export const TWIN_BARREL_OFFSET = 0.2;

export interface DriveInput {
  throttle: number;
  steer: number;
  boost: boolean;
  ability: boolean;
}

/** Per-robot simulation state beyond the rigid body itself (must be reconciled too). */
export interface RobotSimState {
  boostEnergy: number;
  dashCooldown: number;
  flipTimer: number;
  boosting: boolean;
}

export interface RobotPhysState {
  p: Vec3;
  q: Quat;
  v: Vec3;
  w: Vec3;
}

export interface RobotModifiers {
  speedMul: number;
  engineMul: number;
  gripMul: number;
  hasDash: boolean;
}

export interface DriveStepResult {
  dashed: boolean;
  grounded: boolean;
  forwardSpeed: number;
}

function boxInertia(mass: number, h: Vec3): Vec3 {
  const x = h.x * 2, y = h.y * 2, z = h.z * 2;
  return { x: (mass / 12) * (y * y + z * z), y: (mass / 12) * (x * x + z * z), z: (mass / 12) * (x * x + y * y) };
}

/**
 * Wheeled robot built on Rapier's DynamicRayCastVehicleController. Shared by
 * the authoritative server and the client predictor so both run identical code.
 */
export class RobotController {
  readonly body: RigidBody;
  readonly collider: Collider;
  readonly vehicle: DynamicRayCastVehicleController;
  readonly sim: RobotSimState = { boostEnergy: 100, dashCooldown: 0, flipTimer: 0, boosting: false };
  modifiers: RobotModifiers = { speedMul: 1, engineMul: 1, gripMul: 1, hasDash: false };

  private readonly world: World;
  private appliedMass = -1;
  private appliedComY = Number.NaN;

  constructor(world: World, position: Vec3, yaw: number) {
    this.world = world;
    const cfg = physicsConfig;
    const q = quatFromYaw(yaw);
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation(q)
      .setLinearDamping(cfg.linearDamping)
      .setAngularDamping(cfg.angularDamping)
      .setCanSleep(false)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(bodyDesc);

    const colDesc = RAPIER.ColliderDesc.cuboid(CHASSIS_HALF.x, CHASSIS_HALF.y, CHASSIS_HALF.z)
      .setCollisionGroups(CollisionGroups.ROBOT)
      .setFriction(cfg.chassisFriction)
      .setRestitution(cfg.chassisRestitution)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.collider = world.createCollider(colDesc, this.body);

    this.vehicle = world.createVehicleController(this.body);
    this.vehicle.indexUpAxis = 1;
    this.vehicle.setIndexForwardAxis = 2;
    for (const a of WHEEL_ANCHORS) {
      this.vehicle.addWheel({ x: a.x, y: a.y, z: a.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, cfg.suspensionRestLength, cfg.wheelRadius);
    }
    this.applyConfig();
  }

  /** Pushes the current physicsConfig + modifiers into Rapier. Cheap; called every step. */
  applyConfig(): void {
    const cfg = physicsConfig;
    const v = this.vehicle;
    const grip = this.modifiers.gripMul;
    for (let i = 0; i < WHEEL_ANCHORS.length; i++) {
      v.setWheelSuspensionRestLength(i, cfg.suspensionRestLength);
      v.setWheelRadius(i, cfg.wheelRadius);
      v.setWheelSuspensionStiffness(i, cfg.suspensionStiffness);
      v.setWheelSuspensionCompression(i, cfg.suspensionCompression);
      v.setWheelSuspensionRelaxation(i, cfg.suspensionRelaxation);
      v.setWheelMaxSuspensionTravel(i, cfg.maxSuspensionTravel);
      v.setWheelMaxSuspensionForce(i, cfg.maxSuspensionForce);
      v.setWheelFrictionSlip(i, cfg.frictionSlip * grip);
      v.setWheelSideFrictionStiffness(i, cfg.sideFrictionStiffness * grip);
    }
    if (this.appliedMass !== cfg.chassisMass || this.appliedComY !== cfg.centerOfMassY) {
      this.appliedMass = cfg.chassisMass;
      this.appliedComY = cfg.centerOfMassY;
      this.collider.setMassProperties(
        cfg.chassisMass,
        { x: 0, y: cfg.centerOfMassY, z: 0 },
        boxInertia(cfg.chassisMass, CHASSIS_HALF),
        { x: 0, y: 0, z: 0, w: 1 },
      );
    }
    this.body.setLinearDamping(cfg.linearDamping);
    this.body.setAngularDamping(cfg.angularDamping);
    this.collider.setFriction(cfg.chassisFriction);
    this.collider.setRestitution(cfg.chassisRestitution);
  }

  /**
   * Applies one fixed step of driving input. Must be called right before
   * `world.step()` with the same dt as the world timestep.
   */
  drive(input: DriveInput, dt: number, stunned: boolean): DriveStepResult {
    const cfg = physicsConfig;
    const mods = this.modifiers;
    this.applyConfig();

    const throttle = stunned ? 0 : input.throttle;
    const steer = stunned ? 0 : input.steer;
    const rot = this.body.rotation();
    const fwd = rotateVec(rot, { x: 0, y: 0, z: 1 });
    const up = rotateVec(rot, { x: 0, y: 1, z: 0 });
    const lin = this.body.linvel();
    const forwardSpeed = dot(lin, fwd);
    const mass = cfg.chassisMass;

    // Boost meter.
    const sim = this.sim;
    const wantBoost = !stunned && input.boost && throttle > 0.1 && sim.boostEnergy > 0.5;
    if (wantBoost) {
      sim.boostEnergy = Math.max(0, sim.boostEnergy - cfg.boostDrainPerSec * dt);
      sim.boosting = true;
    } else {
      sim.boostEnergy = Math.min(100, sim.boostEnergy + cfg.boostRegenPerSec * dt);
      sim.boosting = false;
    }

    const maxSpeed = cfg.maxSpeed * mods.speedMul * (sim.boosting ? cfg.boostMaxSpeedMul : 1);
    let engine = (throttle * cfg.engineForce * mods.engineMul * (sim.boosting ? cfg.boostForceMul : 1)) / 4;
    if (throttle < 0) engine *= cfg.reverseFactor;
    if (throttle > 0 && forwardSpeed > maxSpeed) engine = 0;
    if (throttle < 0 && forwardSpeed < -maxSpeed * 0.5) engine = 0;

    let brake = 0;
    if (throttle * forwardSpeed < 0 && Math.abs(forwardSpeed) > 1.0) {
      brake = cfg.brakeForce;
      engine = 0;
    } else if (Math.abs(throttle) < 0.05) {
      brake = cfg.rollingBrake;
    }
    if (stunned) brake = cfg.brakeForce * 0.4;

    // Positive steer input turns right; with +Z forward, right is -X, i.e. negative yaw.
    const steerAngle = (-steer * cfg.maxSteerAngle) / (1 + Math.abs(forwardSpeed) * cfg.steerSpeedFalloff);
    const v = this.vehicle;
    for (let i = 0; i < WHEEL_ANCHORS.length; i++) {
      v.setWheelEngineForce(i, engine);
      v.setWheelBrake(i, brake);
      v.setWheelSteering(i, i < 2 ? steerAngle : 0);
    }

    // Rocket Dash ability (predicted on the client as well).
    let dashed = false;
    sim.dashCooldown = Math.max(0, sim.dashCooldown - dt);
    if (!stunned && input.ability && mods.hasDash && sim.dashCooldown <= 0) {
      const flatFwd = normalize({ x: fwd.x, y: 0, z: fwd.z });
      this.body.applyImpulse({ x: flatFwd.x * cfg.dashImpulse * mass, y: 1.6 * mass, z: flatFwd.z * cfg.dashImpulse * mass }, true);
      sim.dashCooldown = cfg.dashCooldown;
      dashed = true;
    }

    v.updateVehicle(dt, undefined, CollisionGroups.WHEEL_QUERY);

    let grounded = false;
    for (let i = 0; i < WHEEL_ANCHORS.length; i++) if (v.wheelIsInContact(i)) grounded = true;

    if (grounded) {
      const df = cfg.downforce * Math.abs(forwardSpeed) * mass * dt;
      this.body.applyImpulse({ x: -up.x * df, y: -up.y * df, z: -up.z * df }, true);
    }

    // Anti-flip: if upside down long enough, apply a righting torque.
    if (up.y < 0.3) sim.flipTimer += dt;
    else if (up.y > 0.75) sim.flipTimer = 0;
    if (sim.flipTimer > cfg.antiFlipDelay) {
      const axis = cross(up, { x: 0, y: 1, z: 0 });
      const axisLen = length(axis);
      // When perfectly inverted the cross product vanishes; roll around the forward axis instead.
      const a = axisLen > 0.05 ? { x: axis.x / axisLen, y: axis.y / axisLen, z: axis.z / axisLen } : fwd;
      const inertia = boxInertia(mass, CHASSIS_HALF).x;
      const t = cfg.antiFlipTorque * inertia * dt;
      this.body.applyTorqueImpulse({ x: a.x * t, y: a.y * t, z: a.z * t }, true);
      if (up.y < 0.5) this.body.applyImpulse({ x: 0, y: cfg.antiFlipLift * mass * dt, z: 0 }, true);
    }

    return { dashed, grounded, forwardSpeed };
  }

  getState(): RobotPhysState {
    const p = this.body.translation();
    const q = this.body.rotation();
    const v = this.body.linvel();
    const w = this.body.angvel();
    return { p: { x: p.x, y: p.y, z: p.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w }, v: { x: v.x, y: v.y, z: v.z }, w: { x: w.x, y: w.y, z: w.z } };
  }

  setState(s: RobotPhysState): void {
    this.body.setTranslation(s.p, true);
    this.body.setRotation(s.q, true);
    this.body.setLinvel(s.v, true);
    this.body.setAngvel(s.w, true);
  }

  teleport(position: Vec3, yaw: number): void {
    this.setState({ p: position, q: quatFromYaw(yaw), v: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 } });
    this.sim.boostEnergy = 100;
    this.sim.dashCooldown = 0;
    this.sim.flipTimer = 0;
    this.sim.boosting = false;
  }

  setEnabled(enabled: boolean): void {
    this.body.setEnabled(enabled);
  }

  forward(): Vec3 {
    return rotateVec(this.body.rotation(), { x: 0, y: 0, z: 1 });
  }

  dispose(): void {
    this.world.removeVehicleController(this.vehicle);
    this.world.removeRigidBody(this.body);
  }
}

/**
 * World-space muzzle positions + directions for the current turret aim.
 * Shots fire horizontally along the aim yaw from the turret's barrel tips.
 */
export function muzzleTransforms(bodyPos: Vec3, bodyRot: Quat, aimYaw: number, count: number, spread: number): { p: Vec3; d: Vec3 }[] {
  const pivotOffset = rotateVec(bodyRot, { x: 0, y: TURRET_HEIGHT, z: 0 });
  const pivot = { x: bodyPos.x + pivotOffset.x, y: bodyPos.y + pivotOffset.y + 0.08, z: bodyPos.z + pivotOffset.z };
  const fwd = { x: Math.sin(aimYaw), y: 0, z: Math.cos(aimYaw) };
  const right = { x: -fwd.z, y: 0, z: fwd.x };
  const out: { p: Vec3; d: Vec3 }[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1) - 0.5;
    const lateral = count === 1 ? 0 : t * 2 * TWIN_BARREL_OFFSET;
    const yaw = aimYaw - t * spread * 2;
    const d = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
    out.push({
      p: { x: pivot.x + fwd.x * BARREL_LENGTH + right.x * lateral, y: pivot.y, z: pivot.z + fwd.z * BARREL_LENGTH + right.z * lateral },
      d,
    });
  }
  return out;
}
