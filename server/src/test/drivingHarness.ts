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
      check(forwardDistance > cap * 2 && t.end.forwardSpeed > cap * 0.7, 'Forward input should move forward and reach normal driving speed');
      check(maxSpeed <= cap + tolerance, 'Forward driving exceeded the configured normal speed cap');
      check(coast.end.speed < coast.start.speed * 0.8, 'Releasing throttle should noticeably slow the robot');
      check(extrema(coast, (s) => s.speed) <= coast.start.speed + 0.3, 'Coasting should not accelerate the robot');
      return { forwardDistance, endSpeed: t.end.forwardSpeed, maxSpeed, coastEndSpeed: coast.end.speed, coastDistance: coast.end.state.p.z - coast.start.state.p.z };
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
      check(yawChange < -0.5, 'Right steering while driving forward should turn right');
      check(minUp > 0.4 && maxHeight < 2.5 && maxAngularSpeed < 10, 'Full steering on flat ground should remain upright and stable');
      check(extrema(t, (s) => s.speed) <= cap + tolerance, 'Turning should respect the normal speed cap');
      return { yawChange, minUp, maxHeight, maxAngularSpeed, endSpeed: t.end.speed };
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
      check(wireAngleError <= 0.000051, 'Robot snapshot should preserve the smoothed steering angle');
      check(decodeRobot(wire.slice(0, 28)).steeringAngle === 0, 'Snapshots without the new steering field should remain readable');
      predictor.ensure(1, snapshot);
      const restoredOnCreate = predictor.controller!.sim.steeringAngle;
      check(restoredOnCreate === snapshot.steeringAngle, 'Creating the local predictor should restore server steering');
      for (let seq = 1; seq <= 12; seq++) {
        predictor.applyInput({ seq, throttle: 1, steer: seq < 9 ? 1 : -1, aimYaw: 0, aimPitch: 0, buttons: 0, viewT: 0 }, FIXED_DT);
        clientPhysics.step();
        predictor.afterStep();
      }
      const expected = predictor.controller!.getState();
      const expectedAngle = predictor.controller!.sim.steeringAngle;
      // Force a stale local angle and pose; reconcile must restore the snapshot
      // and replay the same pending inputs, rather than reuse that stale state.
      predictor.controller!.sim.steeringAngle = physicsConfig.maxSteerAngle;
      predictor.controller!.body.setTranslation({ ...expected.p, x: expected.p.x + 1 }, true);
      predictor.reconcile(snapshot, FIXED_DT);
      const actual = predictor.controller!.getState();
      const replayPositionError = Math.hypot(actual.p.x - expected.p.x, actual.p.y - expected.p.y, actual.p.z - expected.p.z);
      const replayAngleError = Math.abs(predictor.controller!.sim.steeringAngle - expectedAngle);
      check(predictor.stats.replayed === 12 && replayPositionError < 0.05 && replayAngleError < 0.001, 'Reconciliation should reproduce the pending steering inputs from authoritative state');
      return { wireAngleError, restoredOnCreate, replayPositionError, replayAngleError, replayedInputs: predictor.stats.replayed };
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
