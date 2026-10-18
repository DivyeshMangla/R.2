import * as THREE from 'three';
import {
  Buttons,
  RobotController,
  type InputFrame,
  type RobotModifiers,
  type RobotNetState,
  type Vec3,
} from '@robot-arena/shared';
import type { PhysicsWorld } from './PhysicsWorld';

export interface PredictionStats {
  corrections: number;
  lastErrorM: number;
  pendingInputs: number;
  replayed: number;
}

const SNAP_DISTANCE = 4;
const MAX_PENDING = 120;

function toDrive(f: InputFrame): { throttle: number; steer: number; boost: boolean; ability: boolean } {
  return {
    throttle: f.throttle,
    steer: f.steer,
    boost: (f.buttons & Buttons.BOOST) !== 0,
    ability: (f.buttons & Buttons.ABILITY) !== 0,
  };
}

/**
 * Client-side prediction + reconciliation for the local robot.
 * Inputs are applied immediately; on every authoritative snapshot the robot is
 * rewound to the server state and all unacknowledged inputs are replayed.
 * The resulting visual discontinuity is folded into an offset that decays over
 * ~100 ms so corrections never snap.
 */
export class LocalPredictor {
  controller: RobotController | null = null;
  readonly stats: PredictionStats = { corrections: 0, lastErrorM: 0, pendingInputs: 0, replayed: 0 };
  /** Seconds over which corrections are smoothed. */
  smoothTime = 0.1;
  stunned = false;
  lastDashed = false;

  private readonly physics: PhysicsWorld;
  private pending: InputFrame[] = [];
  private spawnCount = -1;
  private robotId = -1;

  private readonly prevPos = new THREE.Vector3();
  private readonly currPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly currQuat = new THREE.Quaternion();
  private readonly posOffset = new THREE.Vector3();
  private readonly rotOffset = new THREE.Quaternion();

  constructor(physics: PhysicsWorld) {
    this.physics = physics;
  }

  get active(): boolean {
    return this.controller !== null;
  }

  ensure(robotId: number, state: RobotNetState): void {
    if (this.controller && this.robotId === robotId) return;
    this.destroy();
    this.robotId = robotId;
    this.controller = new RobotController(this.physics.world, state.p, 0);
    this.controller.setState(state);
    this.controller.sim.steeringAngle = state.steeringAngle;
    this.controller.sim.driveDemand = state.driveDemand;
    this.physics.registerLocal(this.controller.collider, robotId);
    this.spawnCount = state.spawnCount;
    this.capture(true);
  }

  destroy(): void {
    if (!this.controller) return;
    this.physics.unregisterCollider(this.controller.collider);
    this.controller.dispose();
    this.controller = null;
    this.pending = [];
  }

  setModifiers(m: RobotModifiers): void {
    if (this.controller) this.controller.modifiers = m;
  }

  setEnabled(enabled: boolean): void {
    this.controller?.setEnabled(enabled);
  }

  /** Applies one input before the shared world step. */
  applyInput(input: InputFrame, dt: number): void {
    const c = this.controller;
    if (!c) return;
    this.pending.push(input);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    const res = c.drive(toDrive(input), dt, this.stunned);
    this.lastDashed = res.dashed;
  }

  /** Call after the world has stepped to record the new pose for render interpolation. */
  afterStep(): void {
    this.capture(false);
  }

  private capture(reset: boolean): void {
    const c = this.controller;
    if (!c) return;
    const t = c.body.translation();
    const r = c.body.rotation();
    if (reset) {
      this.currPos.set(t.x, t.y, t.z);
      this.currQuat.set(r.x, r.y, r.z, r.w);
      this.prevPos.copy(this.currPos);
      this.prevQuat.copy(this.currQuat);
      this.posOffset.set(0, 0, 0);
      this.rotOffset.identity();
      return;
    }
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
  }

  /** Rewind to the authoritative state and replay every unacknowledged input. */
  reconcile(server: RobotNetState, dt: number): void {
    const c = this.controller;
    if (!c) return;
    this.pending = this.pending.filter((f) => f.seq > server.lastSeq);
    this.stats.pendingInputs = this.pending.length;

    const hardReset = server.spawnCount !== this.spawnCount;
    this.spawnCount = server.spawnCount;

    const before = c.getState();
    c.setState(server);
    c.sim.boostEnergy = server.boostEnergy;
    c.sim.dashCooldown = server.dashCooldown;
    c.sim.flipTimer = server.flipTimer;
    c.sim.steeringAngle = server.steeringAngle;
    c.sim.driveDemand = server.driveDemand;

    // The world also contains kinematic proxies; stepping it re-simulates contacts against them.
    for (const f of this.pending) {
      c.drive(toDrive(f), dt, this.stunned);
      this.physics.step();
    }
    this.stats.replayed = this.pending.length;

    const after = c.getState();
    const err = Math.hypot(before.p.x - after.p.x, before.p.y - after.p.y, before.p.z - after.p.z);
    this.stats.lastErrorM = err;
    if (err > 0.02) this.stats.corrections += 1;

    if (hardReset || err > SNAP_DISTANCE) {
      this.capture(true);
      return;
    }
    // Fold the discontinuity into the decaying visual offset.
    this.posOffset.x += before.p.x - after.p.x;
    this.posOffset.y += before.p.y - after.p.y;
    this.posOffset.z += before.p.z - after.p.z;
    qBefore.set(before.q.x, before.q.y, before.q.z, before.q.w);
    qAfter.set(after.q.x, after.q.y, after.q.z, after.q.w);
    // rotOffset' = before * after^-1 * rotOffset  (applied as rotOffset * renderQuat)
    qDelta.copy(qAfter).invert().premultiply(qBefore);
    this.rotOffset.premultiply(qDelta);

    // The interpolation endpoints move with the corrected state.
    this.currPos.set(after.p.x, after.p.y, after.p.z);
    this.currQuat.copy(qAfter);
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
  }

  /** Smoothed render pose for the current frame. */
  renderPose(alpha: number, frameDt: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    const k = Math.exp(-frameDt / Math.max(0.001, this.smoothTime / 3));
    this.posOffset.multiplyScalar(k);
    this.rotOffset.slerp(identity, 1 - k);
    outPos.lerpVectors(this.prevPos, this.currPos, alpha).add(this.posOffset);
    outQuat.slerpQuaternions(this.prevQuat, this.currQuat, alpha).premultiply(this.rotOffset);
  }

  velocity(): Vec3 {
    const v = this.controller?.body.linvel();
    return v ? { x: v.x, y: v.y, z: v.z } : { x: 0, y: 0, z: 0 };
  }
}

const qBefore = new THREE.Quaternion();
const qAfter = new THREE.Quaternion();
const qDelta = new THREE.Quaternion();
const identity = new THREE.Quaternion();
