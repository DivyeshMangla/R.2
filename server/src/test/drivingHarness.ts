/**
 * Headless driving checks: npx tsx server/src/test/drivingHarness.ts
 * Uses the real controller and arena ramp, without arena walls or other robots.
 * Prints measurements only; it never writes a report or modifies configuration.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_BLOCKS,
  CollisionGroups,
  createPhysicsWorld,
  decodeRobot,
  encodeRobot,
  FIXED_DT,
  initPhysics,
  physicsConfig,
  RobotController,
  rotateVec,
  type DriveInput,
  type RobotPhysState,
  type Vec3,
} from '@robot-arena/shared';
import { LocalPredictor } from '../../../client/src/physics/LocalPredictor';
import { PhysicsWorld as ClientPhysicsWorld } from '../../../client/src/physics/PhysicsWorld';
import { ServerRobot } from '../game/ServerRobot';

const IDLE: DriveInput = { throttle: 0, steer: 0, boost: false, ability: false };
const FORWARD: DriveInput = { ...IDLE, throttle: 1 };
const REVERSE: DriveInput = { ...IDLE, throttle: -1 };
const failures: string[] = [];

interface Sample {
  state: RobotPhysState;
  grounded: boolean;
  speed: number;
  forwardSpeed: number;
  upY: number;
  angularSpeed: number;
}

interface Trace {
  duration: number;
  start: Sample;
  end: Sample;
  samples: Sample[];
}

interface Result {
  scenario: string;
  metrics: Record<string, number | boolean>;
  failures: string[];
}

function check(ok: boolean, message: string): void {
  if (!ok) failures.push(message);
}

function measure(robot: RobotController, grounded: boolean): Sample {
  const state = robot.getState();
  const forward = rotateVec(state.q, { x: 0, y: 0, z: 1 });
  return {
    state,
    grounded,
    speed: Math.hypot(state.v.x, state.v.z),
    forwardSpeed: state.v.x * forward.x + state.v.y * forward.y + state.v.z * forward.z,
    upY: rotateVec(state.q, { x: 0, y: 1, z: 0 }).y,
    angularSpeed: Math.hypot(state.w.x, state.w.y, state.w.z),
  };
}

function fixture(position: Vec3 = { x: 0, y: 1.4, z: 0 }, ramp = false) {
  const world = createPhysicsWorld();
  const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(1000, 0.5, 1000)
      .setTranslation(0, -0.5, 0)
      .setCollisionGroups(CollisionGroups.ENV)
      .setFriction(0.9)
      .setRestitution(0.05),
    floor,
  );
  if (ramp) {
    const jump = ARENA_BLOCKS.find((block) => block.kind === 'jump' && block.center.x > 0);
    if (!jump) throw new Error('Arena jump ramp is missing');
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(jump.half.x, jump.half.y, jump.half.z)
        .setTranslation(jump.center.x, jump.center.y, jump.center.z)
        .setRotation(jump.rotation)
        .setCollisionGroups(CollisionGroups.ENV)
        .setFriction(0.9)
        .setRestitution(0.05),
      floor,
    );
  }
  const robot = new RobotController(world, position, 0);
  let current = measure(robot, false);
  let invalidReported = false;
  const step = (input: DriveInput): Sample => {
    const result = robot.drive(input, FIXED_DT, false);
    world.step();
    current = measure(robot, result.grounded);
    const { p, q, v, w } = current.state;
    const values = [...Object.values(p), ...Object.values(q), ...Object.values(v), ...Object.values(w), robot.sim.boostEnergy];
    const valid = values.every(Number.isFinite)
      && Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 0.01
      && Math.max(Math.abs(p.x), Math.abs(p.z)) < 950 && p.y > -2 && p.y < 30
      && Math.hypot(v.x, v.y, v.z) < Math.max(50, physicsConfig.maxSpeed * physicsConfig.boostMaxSpeedMul * 3)
      && current.angularSpeed < 40
      && robot.sim.boostEnergy >= 0 && robot.sim.boostEnergy <= 100;
    if (!valid && !invalidReported) {
      failures.push('Simulation produced a nonfinite, out-of-bounds, or unstable state');
      invalidReported = true;
    }
    return current;
  };
  const run = (seconds: number, input: DriveInput | ((sample: Sample) => DriveInput)): Trace => {
    const start = current;
    const samples: Sample[] = [];
    const ticks = Math.round(seconds / FIXED_DT);
    for (let i = 0; i < ticks; i++) samples.push(step(typeof input === 'function' ? input(current) : input));
    return { duration: ticks * FIXED_DT, start, end: current, samples };
  };
  return { world, robot, run, sample: () => current, dispose: () => { robot.dispose(); world.free(); } };
}

function extrema(trace: Trace, value: (sample: Sample) => number, kind: 'min' | 'max' = 'max'): number {
  return Math[kind](...trace.samples.map(value));
}

function scenario(name: string, run: () => Record<string, number | boolean>): Result {
  const start = failures.length;
  let metrics: Record<string, number | boolean> = {};
  try {
    metrics = run();
    check(Object.values(metrics).every((v) => typeof v === 'boolean' || Number.isFinite(v)), `${name}: invalid metric`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { scenario: name, metrics, failures: failures.slice(start) };
}

function settledFixture(position?: Vec3, ramp?: boolean) {
  const f = fixture(position, ramp);
  f.run(3, IDLE);
  return f;
}

async function main(): Promise<void> {
  await initPhysics();
  check(Object.values(physicsConfig).every(Number.isFinite), 'Physics configuration contains a nonfinite value');
  check(physicsConfig.gravity > 0 && physicsConfig.chassisMass > 0 && physicsConfig.maxSpeed > 0 && physicsConfig.engineForce > 0, 'Gravity, mass, speed, and engine force must be positive');
  if (failures.length > 0) throw new Error(failures.join('; '));
  const cap = physicsConfig.maxSpeed;
  // Preserve braking time when cruising speed changes. Steering gets its own
  // arena-sized corner-radius target rather than preserving the old wide arc.
  const speedRatio = cap / 12;
  // Allow a small one-tick overshoot without allowing a broken speed limiter.
  const tolerance = Math.max(0.6, cap * 0.06);
  const results: Result[] = [];

  results.push(scenario('settled flat ground', () => {
    const f = settledFixture();
    try {
      const t = f.run(2, IDLE);
      const maxSpeed = extrema(t, (s) => s.speed);
      const heightRange = extrema(t, (s) => s.state.p.y) - extrema(t, (s) => s.state.p.y, 'min');
      const minUp = extrema(t, (s) => s.upY, 'min');
      check(maxSpeed < 0.15 && heightRange < 0.08 && minUp > 0.98, 'Settled robot should remain still and upright');
      check(t.end.grounded && t.end.state.p.y > 0.3 && t.end.state.p.y < 1.5, 'Settled robot should rest on its wheels');
      return { maxSpeed, height: t.end.state.p.y, heightRange, minUp };
    } finally { f.dispose(); }
  }));

  results.push(scenario('forward and coast', () => {
    const f = settledFixture();
    try {
      const t = f.run(8, FORWARD);
      const maxSpeed = extrema(t, (s) => s.speed);
      const forwardDistance = t.end.state.p.z - t.start.state.p.z;
      const coast = f.run(3, IDLE);
      const first99 = t.samples.findIndex((s) => s.forwardSpeed >= cap * 0.99);
      const accelerationTime = first99 < 0 ? t.duration : (first99 + 1) * FIXED_DT;
      const coastRetained = coast.end.speed / coast.start.speed;
      check(forwardDistance > cap * 2 && t.end.forwardSpeed > cap * 0.7, 'Forward input should move forward and reach normal driving speed');
      check(maxSpeed <= cap + tolerance, 'Forward driving exceeded the configured normal speed cap');
      check(coast.end.speed < coast.start.speed * 0.8, 'Releasing throttle should noticeably slow the robot');
      check(extrema(coast, (s) => s.speed) <= coast.start.speed + 0.3, 'Coasting should not accelerate the robot');
      check(accelerationTime >= 1.30 && accelerationTime <= 1.55, '0–99% acceleration should reach usable top speed in approximately 1.5 seconds');
      check(t.samples[Math.round(1.5 / FIXED_DT) - 1].forwardSpeed >= cap * 0.99, 'Full throttle must reach 99% of top speed by 1.5 seconds');
      check(coastRetained >= 0.45 && coastRetained <= 0.65, 'Coasting should retain 45–65% of speed after three seconds');
      check(f.robot.sim.driveDemand === 0, 'Releasing the throttle should remove stored propulsion');
      return { forwardDistance, endSpeed: t.end.forwardSpeed, maxSpeed, accelerationTime, coastRetained, coastEndSpeed: coast.end.speed, coastDistance: coast.end.state.p.z - coast.start.state.p.z };
    } finally { f.dispose(); }
  }));

  results.push(scenario('brake and reverse', () => {
    const f = settledFixture();
    try {
      f.run(6, FORWARD);
      const t = f.run(6, REVERSE);
      const firstStopped = t.samples.findIndex((s) => s.forwardSpeed <= 0.2);
      const stopTime = firstStopped < 0 ? t.duration : (firstStopped + 1) * FIXED_DT;
      const stopDistance = firstStopped < 0 ? cap * t.duration : t.samples[firstStopped].state.p.z - t.start.state.p.z;
      const reverseSpeed = -t.end.forwardSpeed;
      check(t.start.forwardSpeed > cap * 0.6, 'Braking test must begin with forward motion');
      check(stopTime < 3.5 && stopDistance < cap * 2, 'Opposite input should brake to a stop promptly');
      check(stopTime >= 1.2 && stopTime <= 1.7 && stopDistance >= 7 * speedRatio && stopDistance <= 11 * speedRatio, 'Braking should retain its stopping time and speed-scaled distance');
      check(reverseSpeed > cap * 0.2 && reverseSpeed < cap * 0.7 + tolerance, 'Holding reverse after braking should produce controlled reverse motion');
      return { initialSpeed: t.start.forwardSpeed, stopTime, stopDistance, reverseSpeed };
    } finally { f.dispose(); }
  }));

  results.push(scenario('boost and energy recovery', () => {
    const f = settledFixture();
    try {
      f.run(6, FORWARD);
      const energyStart = f.robot.sim.boostEnergy;
      const t = f.run(Math.min(1.5, 50 / physicsConfig.boostDrainPerSec), { ...FORWARD, boost: true });
      const maxSpeed = extrema(t, (s) => s.speed);
      const energyUsed = energyStart - f.robot.sim.boostEnergy;
      const energyAfterBoost = f.robot.sim.boostEnergy;
      f.run(1, IDLE);
      const energyRecovered = f.robot.sim.boostEnergy - energyAfterBoost;
      check(maxSpeed > t.start.speed + 0.3, 'Boost should increase forward speed');
      check(maxSpeed <= cap * physicsConfig.boostMaxSpeedMul + tolerance, 'Boost exceeded the configured boosted speed cap');
      check(energyUsed > 0 && energyRecovered > 0, 'Boost should consume energy and recover after release');
      return { initialSpeed: t.start.speed, maxSpeed, boostCap: cap * physicsConfig.boostMaxSpeedMul, energyUsed, energyRecovered };
    } finally { f.dispose(); }
  }));

  results.push(scenario('full steering stability', () => {
    const f = settledFixture();
    try {
      f.run(6, FORWARD);
      const t = f.run(8, { ...FORWARD, steer: 1 });
      let previousYaw = Math.atan2(rotateVec(t.start.state.q, { x: 0, y: 0, z: 1 }).x, rotateVec(t.start.state.q, { x: 0, y: 0, z: 1 }).z);
      let yawChange = 0;
      for (const s of t.samples) {
        const forward = rotateVec(s.state.q, { x: 0, y: 0, z: 1 });
        const yaw = Math.atan2(forward.x, forward.z);
        yawChange += Math.atan2(Math.sin(yaw - previousYaw), Math.cos(yaw - previousYaw));
        previousYaw = yaw;
      }
      const minUp = extrema(t, (s) => s.upY, 'min');
      const maxHeight = extrema(t, (s) => s.state.p.y);
      const maxAngularSpeed = extrema(t, (s) => s.angularSpeed);
      const steady = t.samples.slice(Math.round(2 / FIXED_DT));
      const turnRadius = steady.reduce((sum, s) => sum + s.speed / Math.max(0.01, Math.abs(s.state.w.y)), 0) / steady.length;
      check(yawChange < -0.5, 'Right steering while driving forward should turn right');
      check(minUp > 0.4 && maxHeight < 2.5 && maxAngularSpeed < 10, 'Full steering on flat ground should remain upright and stable');
      check(extrema(t, (s) => s.speed) <= cap + tolerance, 'Turning should respect the normal speed cap');
      check(turnRadius >= 20 && turnRadius <= 30, 'Full-speed corner radius should remain responsive at 20–30 metres rather than a highway-sized arc');
      check(t.end.speed > cap * 0.90, 'Normal cornering should retain at least 90% of cruising speed');
      return { yawChange, minUp, maxHeight, maxAngularSpeed, turnRadius, endSpeed: t.end.speed };
    } finally { f.dispose(); }
  }));

  results.push(scenario('parking lock and low-speed U-turn', () => {
    const f = settledFixture();
    try {
      f.run(0.6, { ...IDLE, steer: 1 });
      const parkingLockDeg = Math.abs(f.robot.sim.steeringAngle) * 180 / Math.PI;
      check(parkingLockDeg >= 32 && parkingLockDeg <= 36, 'Parking lock should be 32–36 degrees');
      const t = f.run(6, (s) => ({ ...FORWARD, steer: 1, throttle: Math.max(0.05, Math.min(1, (3 - s.speed) * 0.8)) }));
      const steady = t.samples.slice(Math.round(3 / FIXED_DT));
      const speed = steady.reduce((sum, s) => sum + s.speed, 0) / steady.length;
      const radius = steady.reduce((sum, s) => sum + s.speed / Math.max(0.01, Math.abs(s.state.w.y)), 0) / steady.length;
      check(speed > 1.5 && speed < 3.5 && radius > 1.5 && radius < 5, 'Low-speed manoeuvring should make a tight physical U-turn');
      check(extrema(t, (s) => s.upY, 'min') > 0.9, 'Low-speed U-turn should remain stable');
      return { parkingLockDeg, speed, radius };
    } finally { f.dispose(); }
  }));

  results.push(scenario('brake priority and propulsion spool', () => {
    const f = settledFixture();
    try {
      f.run(FIXED_DT, FORWARD);
      const firstDemand = f.robot.sim.driveDemand;
      f.run(6, FORWARD);
      f.run(FIXED_DT, REVERSE);
      const brakeDemand = f.robot.sim.driveDemand;
      check(firstDemand > 0 && firstDemand < 0.2, 'First throttle tick should ramp propulsion instead of applying full torque');
      check(brakeDemand === 0, 'Opposite input must clear propulsion immediately while braking');
      f.run(2, REVERSE);
      const reverseDemand = f.robot.sim.driveDemand;
      check(reverseDemand < -0.75 && f.sample().forwardSpeed < -0.6, 'Brake should transition cleanly into reverse after stopping');
      f.robot.teleport({ x: 0, y: 1.4, z: 0 }, 0);
      check(f.robot.sim.driveDemand === 0 && f.robot.sim.steeringAngle === 0, 'Teleport should clear both drivetrain filter states');
      return { firstDemand, brakeDemand, reverseDemand };
    } finally { f.dispose(); }
  }));

  results.push(scenario('airborne momentum preserved', () => {
    const f = fixture({ x: 0, y: 10, z: 0 });
    try {
      f.robot.body.setLinvel({ x: 4, y: 3, z: 7 }, true);
      f.robot.body.setAngvel({ x: 0.3, y: 0.8, z: -0.2 }, true);
      const before = f.robot.getState();
      const result = f.robot.drive({ ...IDLE, steer: 1 }, FIXED_DT, false);
      const after = f.robot.getState();
      const linearChange = Math.hypot(after.v.x - before.v.x, after.v.y - before.v.y, after.v.z - before.v.z);
      const angularChange = Math.hypot(after.w.x - before.w.x, after.w.y - before.w.y, after.w.z - before.w.z);
      check(!result.grounded && linearChange < 0.00001 && angularChange < 0.00001, 'Grounded assists must not change airborne momentum or heading');
      return { grounded: result.grounded, linearChange, angularChange };
    } finally { f.dispose(); }
  }));

  results.push(scenario('gradual steering response', () => {
    const f = settledFixture();
    try {
      f.run(6, FORWARD);
      f.run(FIXED_DT, { ...FORWARD, steer: 1 });
      const firstAngle = f.robot.sim.steeringAngle;
      f.run(0.5, { ...FORWARD, steer: 1 });
      const heldAngle = f.robot.sim.steeringAngle;
      f.run(FIXED_DT, { ...FORWARD, steer: -1 });
      const reversalFirstAngle = f.robot.sim.steeringAngle;
      f.run(0.5, { ...FORWARD, steer: -1 });
      const reversedAngle = f.robot.sim.steeringAngle;
      check(firstAngle < 0 && Math.abs(firstAngle) < Math.abs(heldAngle) * 0.5, 'Steering should build gradually after a new input');
      check(reversalFirstAngle < 0 && reversedAngle > 0, 'Changing steering direction should pass smoothly through centre');
      return { firstAngle, heldAngle, reversalFirstAngle, reversedAngle };
    } finally { f.dispose(); }
  }));

  results.push(scenario('steering attack and return timing', () => {
    const f = settledFixture();
    try {
      f.run(0.6, { ...IDLE, steer: 1 });
      const fullAngle = Math.abs(f.robot.sim.steeringAngle);
      f.run(0.6, IDLE);
      let attackTicks = 0;
      while (Math.abs(f.robot.sim.steeringAngle) < fullAngle * 0.9 && attackTicks < 60) {
        f.run(FIXED_DT, { ...IDLE, steer: 1 });
        attackTicks++;
      }
      f.run(0.6, { ...IDLE, steer: 1 });
      let returnTicks = 0;
      while (Math.abs(f.robot.sim.steeringAngle) > fullAngle * 0.1 && returnTicks < 60) {
        f.run(FIXED_DT, IDLE);
        returnTicks++;
      }
      const attackTime = attackTicks * FIXED_DT;
      const returnTime = returnTicks * FIXED_DT;
      check(attackTime >= 0.20 && attackTime <= 0.26, 'Steering should reach 90% lock in 200–260ms for smooth keyboard turns');
      check(returnTime >= 0.14 && returnTime <= 0.20, 'Steering should return 90% to centre in 140–200ms');
      return { attackTime, returnTime };
    } finally { f.dispose(); }
  }));

  results.push(scenario('steering snapshot and prediction replay', () => {
    const f = settledFixture({ x: -35, y: 1.4, z: -20 });
    const clientPhysics = new ClientPhysicsWorld();
    const predictor = new LocalPredictor(clientPhysics);
    try {
      f.run(0.8, FORWARD);
      f.run(0.1, { ...FORWARD, steer: 1 });
      const serverRobot = new ServerRobot(1, 'Driving test', 0, 'test-session', f.robot);
      const wire = encodeRobot(serverRobot.toNetState());
      const snapshot = decodeRobot(wire);
      const wireAngleError = Math.abs(snapshot.steeringAngle - f.robot.sim.steeringAngle);
      const wireDemandError = Math.abs(snapshot.driveDemand - f.robot.sim.driveDemand);
      check(wireAngleError <= 0.000051, 'Robot snapshot should preserve the smoothed steering angle');
      check(wireDemandError <= 0.000051, 'Robot snapshot should preserve the propulsion spool');
      check(decodeRobot(wire.slice(0, 28)).steeringAngle === 0, 'Snapshots without the new steering field should remain readable');
      check(decodeRobot(wire.slice(0, 29)).driveDemand === 0, 'Snapshots without the propulsion spool should remain readable');
      predictor.ensure(1, snapshot);
      const restoredOnCreate = predictor.controller!.sim.steeringAngle;
      check(restoredOnCreate === snapshot.steeringAngle, 'Creating the local predictor should restore server steering');
      check(predictor.controller!.sim.driveDemand === snapshot.driveDemand, 'Creating the local predictor should restore server propulsion');
      for (let seq = 1; seq <= 12; seq++) {
        predictor.applyInput({ seq, throttle: 1, steer: seq < 9 ? 1 : -1, aimYaw: 0, aimPitch: 0, buttons: 0, viewT: 0 }, FIXED_DT);
        clientPhysics.step();
        predictor.afterStep();
      }
      const expected = predictor.controller!.getState();
      const expectedAngle = predictor.controller!.sim.steeringAngle;
      const expectedDemand = predictor.controller!.sim.driveDemand;
      // Force a stale local angle and pose; reconcile must restore the snapshot
      // and replay the same pending inputs, rather than reuse that stale state.
      predictor.controller!.sim.steeringAngle = physicsConfig.maxSteerAngle;
      predictor.controller!.sim.driveDemand = -1;
      predictor.controller!.body.setTranslation({ ...expected.p, x: expected.p.x + 1 }, true);
      predictor.reconcile(snapshot, FIXED_DT);
      const actual = predictor.controller!.getState();
      const replayPositionError = Math.hypot(actual.p.x - expected.p.x, actual.p.y - expected.p.y, actual.p.z - expected.p.z);
      const replayAngleError = Math.abs(predictor.controller!.sim.steeringAngle - expectedAngle);
      const replayDemandError = Math.abs(predictor.controller!.sim.driveDemand - expectedDemand);
      // Velocity on the wire is quantized to centimetres per second; the
      // speed-sensitive steering curve magnifies that into a small angle error.
      check(predictor.stats.replayed === 12 && replayPositionError < 0.05 && replayAngleError < 0.003 && replayDemandError < 0.0001, 'Reconciliation should reproduce pending steering and propulsion from authoritative state');
      return { wireAngleError, wireDemandError, restoredOnCreate, replayPositionError, replayAngleError, replayDemandError, replayedInputs: predictor.stats.replayed };
    } finally { predictor.destroy(); clientPhysics.world.free(); f.dispose(); }
  }));

  results.push(scenario('dash impulse survives driving cap', () => {
    const f = settledFixture();
    try {
      f.robot.modifiers.hasDash = true;
      f.run(6, FORWARD);
      const initialSpeed = f.sample().speed;
      const dash = f.run(FIXED_DT, { ...FORWARD, ability: true });
      const afterDash = f.run(0.25, { ...FORWARD, ability: true });
      const maxSpeed = Math.max(dash.end.speed, extrema(afterDash, (s) => s.speed));
      const cooldown = f.robot.sim.dashCooldown;
      check(maxSpeed > cap + tolerance && maxSpeed > initialSpeed + 1, 'Dash should temporarily exceed the driving cap rather than have its impulse clamped');
      check(cooldown > 0 && cooldown < physicsConfig.dashCooldown, 'Dash should enter cooldown instead of firing every held-input tick');
      const recovered = f.run(3, FORWARD);
      check(recovered.end.speed <= cap + tolerance && recovered.end.upY > 0.75, 'Normal driving should settle after a dash');
      return { initialSpeed, maxSpeed, cooldown, settledSpeed: recovered.end.speed, settledUp: recovered.end.upY };
    } finally { f.dispose(); }
  }));

  results.push(scenario('arena jump ramp landing', () => {
    const f = settledFixture({ x: 23, y: 1.4, z: -14 }, true);
    try {
      const t = f.run(6, (s) => s.state.p.z < 6 ? FORWARD : IDLE);
      const maxHeight = extrema(t, (s) => s.state.p.y);
      const airborne = t.samples.some((s) => s.state.p.z > 4.5 && !s.grounded && s.state.p.y > 1);
      const landed = t.samples.some((s) => s.state.p.z > 6 && s.grounded && Math.abs(s.state.v.y) < 0.5 && s.upY > 0.75);
      check(t.end.state.p.z > 6 && maxHeight > 1.5, 'Robot should climb and clear the arena jump ramp');
      check(airborne && landed, 'Ramp traversal should include takeoff and a stable landing');
      check(t.end.upY > 0.8 && Math.abs(t.end.state.v.y) < 0.5, 'Robot should settle upright after landing');
      return { forwardDistance: t.end.state.p.z - t.start.state.p.z, maxHeight, airborne, landed, endUp: t.end.upY, endVerticalSpeed: t.end.state.v.y };
    } finally { f.dispose(); }
  }));

  console.log(`DRIVING HARNESS (m, s, m/s, rad; fixed dt ${FIXED_DT.toFixed(5)} s)`);
  console.log(`Configured normal cap ${cap} m/s (${(cap * 3.6).toFixed(1)} km/h), boost cap ${(cap * physicsConfig.boostMaxSpeedMul).toFixed(1)} m/s, engine ${physicsConfig.engineForce} N`);
  for (const result of results) {
    console.log(`${result.failures.length === 0 ? 'PASS' : 'FAIL'} ${result.scenario}: ${JSON.stringify(result.metrics)}`);
    for (const failure of result.failures) console.error(`  ${failure}`);
  }
  console.log(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${failures.length} failed checks)`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
