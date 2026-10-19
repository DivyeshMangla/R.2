/** Independent behavioural checks for the arcade drivetrain. No files are written. */
import RAPIER from '@dimforge/rapier3d-compat';
import { Client } from '@colyseus/sdk';
import {
  ARENA_BLOCKS, Buttons, CollisionGroups, FIXED_DT, MatchPhase, Msg, ROOM_NAME, RobotController, RobotFlags,
  createPhysicsWorld, decodeInput, decodeRobot, encodeInput, encodeRobot, initPhysics,
  physicsConfig, rotateVec, type DriveInput, type InputFrame, type RobotPhysState,
  type SnapshotMsg, type WelcomeMsg,
} from '@robot-arena/shared';
import { LocalPredictor } from '../../../client/src/physics/LocalPredictor';
import { PhysicsWorld } from '../../../client/src/physics/PhysicsWorld';
import { ServerRobot } from '../game/ServerRobot';

const IDLE: DriveInput = { throttle: 0, steer: 0, boost: false, ability: false, drift: false };
const GO: DriveInput = { ...IDLE, throttle: 1 };
const failures: string[] = [];
const results: { scenario: string; metrics: Record<string, number | boolean>; failures: string[] }[] = [];
function check(ok: boolean, reason: string): void { if (!ok) failures.push(reason); }
function scenario(name: string, test: () => Record<string, number | boolean>): void {
  const start = failures.length;
  let metrics = {};
  try { metrics = test(); } catch (error) { failures.push(String(error)); }
  results.push({ scenario: name, metrics, failures: failures.slice(start) });
}

interface Sample {
  state: RobotPhysState;
  speed: number;
  forward: number;
  slip: number;
  up: number;
  grounded: boolean;
  drift: number;
  angle: number;
}

function fixture(options: { airborne?: boolean; ramp?: boolean; wall?: boolean; settle?: boolean } = {}) {
  const world = createPhysicsWorld();
  const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(1000, 0.5, 1000)
    .setTranslation(0, -0.5, 0).setCollisionGroups(CollisionGroups.ENV).setFriction(0.9), floor);
  const start = options.airborne ? { x: 0, y: 20, z: 0 }
    : options.ramp ? { x: 23, y: 1.4, z: -14 } : { x: 0, y: 1.4, z: 0 };
  if (options.ramp) {
    const ramp = ARENA_BLOCKS.find((block) => block.kind === 'jump' && block.center.x > 0)!;
    world.createCollider(RAPIER.ColliderDesc.cuboid(ramp.half.x, ramp.half.y, ramp.half.z)
      .setTranslation(ramp.center.x, ramp.center.y, ramp.center.z).setRotation(ramp.rotation)
      .setCollisionGroups(CollisionGroups.ENV).setFriction(0.9), floor);
  }
  if (options.wall) world.createCollider(RAPIER.ColliderDesc.cuboid(15, 2.5, 0.75)
    .setTranslation(0, 2.5, 32).setCollisionGroups(CollisionGroups.ENV), floor);
  const robot = new RobotController(world, start, 0);
  let invalid = false;
  function measure(grounded = false): Sample {
    const state = robot.getState();
    const forward = rotateVec(state.q, { x: 0, y: 0, z: 1 });
    const right = rotateVec(state.q, { x: 1, y: 0, z: 0 });
    const forwardSpeed = state.v.x * forward.x + state.v.z * forward.z;
    const lateralSpeed = state.v.x * right.x + state.v.z * right.z;
    const q = state.q;
    if (!invalid && (!Object.values(state).flatMap(Object.values).every(Number.isFinite)
      || Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > 0.005
      || Math.hypot(state.v.x, state.v.y, state.v.z) > 100
      || Math.hypot(state.w.x, state.w.y, state.w.z) > 30
      || state.p.y < -1 || Math.max(Math.abs(state.p.x), Math.abs(state.p.z)) > 900)) {
      invalid = true;
      failures.push('Drivetrain produced a nonfinite, tunnelling, or explosive state');
    }
    return { state, speed: Math.hypot(state.v.x, state.v.z), forward: forwardSpeed,
      slip: Math.atan2(lateralSpeed, Math.abs(forwardSpeed)),
      up: rotateVec(state.q, { x: 0, y: 1, z: 0 }).y, grounded,
      drift: robot.sim.driftAmount, angle: robot.sim.steeringAngle };
  }
  let current = measure();
  function step(input: DriveInput, stunned = false): Sample {
    const result = robot.drive(input, FIXED_DT, stunned);
    world.step();
    return current = measure(result.grounded);
  }
  function run(seconds: number, input: DriveInput | ((sample: Sample, elapsed: number) => DriveInput), stunned = false): Sample[] {
    return Array.from({ length: Math.round(seconds / FIXED_DT) }, (_, tick) =>
      step(typeof input === 'function' ? input(current, tick * FIXED_DT) : input, stunned));
  }
  if (options.settle !== false && !options.airborne) run(2, IDLE);
  return { world, robot, step, run, sample: () => current, dispose: () => { robot.dispose(); world.free(); } };
}

function average(samples: Sample[], metric: (s: Sample) => number): number {
  return samples.reduce((sum, sample) => sum + metric(sample), 0) / samples.length;
}
function peak(samples: Sample[], metric: (s: Sample) => number): number {
  return Math.max(...samples.map(metric));
}
function travelYaw(samples: Sample[]): number {
  return samples.reduce((sum, sample) => sum + sample.state.w.y * FIXED_DT, 0);
}

/** Opt-in live protocol regression: start the development server, then pass --network. */
async function networkProtocol(): Promise<void> {
  const client = new Client(process.env.ARENA_URL ?? 'ws://localhost:2567');
  const room = await client.joinOrCreate(ROOM_NAME, { name: 'Drift protocol QA', mapId: 'frost', characterId: 'striker' });
  let welcome: WelcomeMsg | undefined, snapshot: SnapshotMsg | undefined;
  let wireLength = 0, peakDrift = 0, peakSpeed = 0, driftFlag = false, ack = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    room.onMessage('*', (type, message) => {
      if (type === Msg.WELCOME) welcome = message as WelcomeMsg;
      if (type !== Msg.SNAPSHOT) return;
      snapshot = message as SnapshotMsg;
      const wire = snapshot.r.find((r) => r[0] === welcome?.yourId);
      if (!wire) return;
      wireLength = wire.length;
      const state = decodeRobot(wire);
      peakDrift = Math.max(peakDrift, state.driftAmount);
      peakSpeed = Math.max(peakSpeed, Math.hypot(state.v.x, state.v.z));
      driftFlag ||= (state.flags & RobotFlags.DRIFTING) !== 0;
      ack = Math.max(ack, state.lastSeq);
    });
    async function waitFor(predicate: () => boolean, description: string): Promise<void> {
      const until = Date.now() + 9000;
      while (!predicate()) {
        if (Date.now() > until) throw new Error(`Timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await waitFor(() => !!welcome && snapshot?.phase === MatchPhase.PLAYING, 'live match');
    const started = performance.now();
    let seq = 0;
    timer = setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      // Engage while still inside the guaranteed clear spawn approach; later
      // districts deliberately contain physical cover and elevated terrain.
      const drifting = elapsed >= 0.75 && elapsed < 1.55;
      room.send(Msg.INPUT, encodeInput({ seq: ++seq, throttle: elapsed < 4 ? 1 : 0,
        steer: drifting ? 1 : 0, buttons: drifting ? Buttons.DRIFT : 0,
        aimYaw: 0, aimPitch: 0, viewT: 0 }));
    }, 1000 / 60);
    await waitFor(() => ack >= 210, 'acknowledged driving and drift inputs');
    const latest = decodeRobot(snapshot!.r.find((r) => r[0] === welcome!.yourId)!);
    check(wireLength === 31 && welcome!.tuning.maxSpeed >= 20, 'Live server must use the new driving config and 31-field robot wire');
    check(peakDrift > 0.6 && driftFlag, 'Live server must receive the DRIFT input bit and broadcast physical drift state');
    check(peakSpeed > 6 && latest.driftAmount < 0.1, 'Live driving must gain speed and restore grip after releasing drift');
    console.log(`LIVE DRIFT PROTOCOL: ${JSON.stringify({ wireLength, peakDrift, peakSpeed, driftFlag, lastSeq: ack, releasedBlend: latest.driftAmount })}`);
  } finally {
    if (timer) clearInterval(timer);
    await room.leave();
  }
}

async function main(): Promise<void> {
  await initPhysics();
  scenario('a fresh controller has the authoritative mass before its first input', () => {
    const f = fixture({ settle: false });
    try {
      const mass = f.robot.body.mass();
      const com = f.robot.body.localCom().y;
      check(Math.abs(mass - physicsConfig.chassisMass) < 0.01,
        'First-frame driving must use configured chassis mass instead of temporary collider density');
      check(Math.abs(com - physicsConfig.centerOfMassY) < 0.0001,
        'First-frame steering must use the configured centre of mass');
      return { mass, centreOfMassY: com };
    } finally { f.dispose(); }
  });
  scenario('fast launch reaches the requested top speed', () => {
    const f = fixture();
    try {
      const launch = f.run(2.5, GO);
      const t99 = (launch.findIndex((sample) => sample.forward >= physicsConfig.maxSpeed * 0.99) + 1) * FIXED_DT;
      const initial = launch[0].forward;
      const terminal = average(launch.slice(-30), (sample) => sample.forward);
      check(t99 > 0 && t99 <= 1.55, 'Normal 0–99% top speed must take no more than 1.55 seconds');
      check(physicsConfig.maxSpeed >= 20 && terminal > physicsConfig.maxSpeed * 0.99, 'Cruising speed must reach the faster 20 m/s target');
      check(initial > 0 && initial < physicsConfig.maxSpeed * 0.05, 'Launch must not teleport velocity to top speed');
      check(peak(launch, (sample) => sample.speed) < physicsConfig.maxSpeed * 1.04, 'Launch must settle without speed-cap oscillation');
      return { t99, terminal, firstTickSpeed: initial, cap: physicsConfig.maxSpeed };
    } finally { f.dispose(); }
  });

  scenario('left and right corners are symmetric and stable', () => {
    const turns = [-1, 1].map((steer) => {
      const f = fixture();
      try {
        f.run(2.5, GO);
        const trace = f.run(4, { ...GO, steer });
        return { yaw: travelYaw(trace), speed: average(trace.slice(-60), (s) => s.speed),
          minUp: Math.min(...trace.map((s) => s.up)), maxYaw: peak(trace, (s) => Math.abs(s.state.w.y)) };
      } finally { f.dispose(); }
    });
    const symmetry = Math.abs(turns[0].yaw + turns[1].yaw) / Math.max(Math.abs(turns[0].yaw), Math.abs(turns[1].yaw));
    check(turns[0].yaw > 0.7 && turns[1].yaw < -0.7, 'Both steering directions must turn promptly in the expected direction');
    check(symmetry < 0.03, 'Mirrored turns must have within 3% accumulated yaw');
    check(turns.every((turn) => turn.minUp > 0.75 && turn.maxYaw < 2.5), 'Grip turns must remain upright without spinning');
    check(turns.every((turn) => turn.speed > physicsConfig.maxSpeed * 0.75), 'Full-lock grip turns must preserve useful driving speed');
    return { leftYaw: turns[0].yaw, rightYaw: turns[1].yaw, symmetry, leftSpeed: turns[0].speed,
      rightSpeed: turns[1].speed, minUp: Math.min(...turns.map((turn) => turn.minUp)) };
  });

  scenario('repeated opposite turns cross centre smoothly', () => {
    const f = fixture();
    try {
      f.run(2.5, GO);
      const trace = f.run(6, (_sample, elapsed) => ({ ...GO, steer: Math.floor(elapsed / 0.6) % 2 ? -1 : 1 }));
      let maxYawStep = 0, maxAngleStep = 0;
      for (let i = 1; i < trace.length; i++) {
        maxYawStep = Math.max(maxYawStep, Math.abs(trace[i].state.w.y - trace[i - 1].state.w.y));
        maxAngleStep = Math.max(maxAngleStep, Math.abs(trace[i].angle - trace[i - 1].angle));
      }
      const crosses = trace.slice(1).filter((sample, i) => sample.angle * trace[i].angle < 0).length;
      check(crosses >= 8, 'Repeated steering reversals must pass through centre rather than latch one direction');
      check(maxYawStep < 0.35 && maxAngleStep < 0.12, 'Slalom must not snap yaw velocity or front-wheel angle on keyboard edges');
      check(Math.min(...trace.map((sample) => sample.up)) > 0.8, 'Rapid slalom must not roll the robot');
      return { maxYawStep, maxAngleStep, crosses, endSpeed: trace.at(-1)!.speed };
    } finally { f.dispose(); }
  });

  scenario('drift creates a controllable slide with smooth recovery', () => {
    const compare = (drift: boolean, steer: number) => {
      const f = fixture();
      try {
        f.run(2.5, GO);
        const held = f.run(2.5, { ...GO, steer, drift });
        const tail = held.slice(-60);
        const recovered = f.run(1.5, GO);
        return { slip: average(tail, (s) => Math.abs(s.slip)), speed: average(tail, (s) => s.speed),
          yaw: travelYaw(held), maxYaw: peak(held, (s) => Math.abs(s.state.w.y)),
          minUp: Math.min(...held.map((s) => s.up)),
          drift: held.at(-1)!.drift, recoveredDrift: recovered.at(-1)!.drift,
          recoveredSlip: Math.abs(recovered.at(-1)!.slip), recoveredYaw: Math.abs(recovered.at(-1)!.state.w.y),
          angle: held.at(-1)!.angle };
      } finally { f.dispose(); }
    };
    const grip = compare(false, 1), right = compare(true, 1), left = compare(true, -1);
    check(right.drift > 0.8 && left.drift > 0.8, 'Holding drift while turning at speed must sustain drift in both directions');
    check(right.slip > 10 * Math.PI / 180 && right.slip > grip.slip + 0.07,
      'Drift must create clearly visible physical sideslip of at least 10 degrees rather than only an animation');
    check(right.slip < 0.95 && right.maxYaw < 2.8 && right.minUp > 0.65, 'Drift must remain a controlled slide rather than a spin or rollover');
    check(right.speed > physicsConfig.maxSpeed * 0.65, 'Drift must retain enough speed to chain corners');
    check(right.recoveredDrift < 0.02 && right.recoveredSlip < 0.12 && right.recoveredYaw < 0.25,
      'Releasing drift and steering must restore forward grip within 1.5 seconds');
    check(Math.abs(right.slip - left.slip) < 0.03 && Math.abs(right.yaw + left.yaw) < 0.08,
      'Drift behaviour must be symmetric left and right');
    return { gripSlipDeg: grip.slip * 180 / Math.PI, driftSlipDeg: right.slip * 180 / Math.PI,
      speed: right.speed, maxYaw: right.maxYaw, minUp: right.minUp,
      recoveredSlipDeg: right.recoveredSlip * 180 / Math.PI, recoveredYaw: right.recoveredYaw,
      recoveredDrift: right.recoveredDrift };
  });

  scenario('countersteer changes slide direction without a snap', () => {
    const f = fixture();
    try {
      f.run(2.5, GO);
      f.run(1.2, { ...GO, steer: 1, drift: true });
      const before = f.sample();
      const opposite = f.run(1.6, { ...GO, steer: -1, drift: true });
      const first = opposite[0], last = opposite.at(-1)!;
      check(before.state.w.y < -0.3 && last.state.w.y > 0.3, 'Countersteer must recover and establish the opposite corner');
      check(Math.abs(first.state.w.y - before.state.w.y) < 0.35 && first.angle < 0,
        'Countersteer must blend through centre instead of teleporting heading or wheel angle');
      check(last.speed > physicsConfig.maxSpeed * 0.6 && last.up > 0.75, 'Countersteer must preserve speed and stability');
      return { beforeYaw: before.state.w.y, firstYaw: first.state.w.y, endYaw: last.state.w.y, endSpeed: last.speed };
    } finally { f.dispose(); }
  });

  scenario('sustained and linked drifts never collapse into spins', () => {
    const heldMetrics = [-1, 1].map((steer) => {
      const f = fixture();
      try {
        f.run(2.5, GO);
        const held = f.run(10, { ...GO, steer, drift: true });
        const steady = held.slice(60);
        return { minSpeed: Math.min(...steady.map((s) => s.speed)), maxYaw: peak(held, (s) => Math.abs(s.state.w.y)),
          maxSlip: peak(steady, (s) => Math.abs(s.slip)), minDrift: Math.min(...steady.map((s) => s.drift)),
          yaw: travelYaw(held), up: Math.min(...steady.map((s) => s.up)) };
      } finally { f.dispose(); }
    });
    const f = fixture();
    try {
      f.run(2.5, GO);
      const linked = f.run(8, (_sample, t) => ({ ...GO, drift: true, steer: Math.sin(t * Math.PI / 1.2) }));
      const minSpeed = Math.min(...linked.map((s) => s.speed));
      const maxYaw = peak(linked, (s) => Math.abs(s.state.w.y));
      check(heldMetrics.every((m) => m.minSpeed > physicsConfig.maxSpeed * 0.65 && m.maxYaw < 2.8
        && m.maxSlip < 0.95 && m.minDrift > 0.95 && m.up > 0.8),
        'Ten-second drift holds must keep speed, directional control, and stable engagement in both directions');
      check(Math.abs(heldMetrics[0].yaw + heldMetrics[1].yaw) < 0.1, 'Long drift holds must remain left/right symmetric');
      check(minSpeed > physicsConfig.maxSpeed * 0.6 && maxYaw < 2.8,
        'Partial steering and repeated opposite drift transitions must not collapse speed or cause spins');
      return { heldMinSpeed: Math.min(...heldMetrics.map((m) => m.minSpeed)), heldMaxYaw: Math.max(...heldMetrics.map((m) => m.maxYaw)),
        heldMaxSlipDeg: Math.max(...heldMetrics.map((m) => m.maxSlip)) * 180 / Math.PI,
        heldMinBlend: Math.min(...heldMetrics.map((m) => m.minDrift)), linkedMinSpeed: minSpeed, linkedMaxYaw: maxYaw };
    } finally { f.dispose(); }
  });

  scenario('drift gates protect rest, reverse, stun, and airborne momentum', () => {
    const f = fixture(), air = fixture({ airborne: true });
    try {
      f.run(0.6, { ...IDLE, steer: 1, drift: true });
      const restDrift = f.robot.sim.driftAmount;
      f.run(2, { ...GO, throttle: -1, steer: 1, drift: true });
      const reverseDrift = f.robot.sim.driftAmount;
      f.robot.teleport({ x: 0, y: 1.4, z: 0 }, 0);
      f.run(2, IDLE); f.run(2.5, GO);
      f.run(0.6, { ...GO, steer: 1, drift: true, boost: true }, true);
      const stunnedDrift = f.robot.sim.driftAmount;
      air.robot.body.setLinvel({ x: 4, y: 3, z: 20 }, true);
      air.robot.body.setAngvel({ x: 0.2, y: 0.7, z: -0.1 }, true);
      const before = air.robot.getState();
      const airborne = air.robot.drive({ ...GO, steer: 1, drift: true }, FIXED_DT, false);
      const after = air.robot.getState();
      const momentumChange = Math.hypot(after.v.x - before.v.x, after.v.y - before.v.y, after.v.z - before.v.z,
        after.w.x - before.w.x, after.w.y - before.w.y, after.w.z - before.w.z);
      check(restDrift === 0 && reverseDrift === 0 && stunnedDrift === 0, 'Drift must not engage at rest, in reverse, or while stunned');
      check(!airborne.grounded && air.robot.sim.driftAmount === 0 && momentumChange < 0.00001,
        'Drift must not create airborne steering or erase launch/knockback momentum');
      check(!f.robot.sim.boosting, 'Stunned controls must not boost');
      return { restDrift, reverseDrift, stunnedDrift, airDrift: air.robot.sim.driftAmount, momentumChange };
    } finally { f.dispose(); air.dispose(); }
  });

  scenario('an established drift yields immediately to braking and stun', () => {
    const f = fixture();
    try {
      f.run(2, GO); f.run(0.8, { ...GO, steer: 1, drift: true });
      const activeBlend = f.robot.sim.driftAmount;
      const braking = f.run(1, { ...GO, throttle: -1, steer: 1, drift: true, boost: true });
      const brakingBlend = f.robot.sim.driftAmount;
      const brakeSpeed = braking.at(-1)!.speed;
      f.robot.teleport({ x: 0, y: 1.4, z: 0 }, 0);
      f.run(2, IDLE); f.run(2, GO); f.run(0.8, { ...GO, steer: 1, drift: true });
      const stunned = f.run(1, { ...GO, steer: 1, drift: true, boost: true, ability: true }, true);
      check(activeBlend > 0.95 && brakingBlend < 0.02, 'Braking must release an active slide even while drift remains held');
      check(brakeSpeed < physicsConfig.maxSpeed * 0.5, 'Opposite throttle must brake a slide rather than keep accelerating');
      check(f.robot.sim.driftAmount < 0.02 && !f.robot.sim.boosting && stunned.at(-1)!.up > 0.8,
        'Stun during a slide must release drift and boost without destabilizing the chassis');
      return { activeBlend, brakingBlend, brakeSpeed, stunnedBlend: f.robot.sim.driftAmount, stunnedSpeed: stunned.at(-1)!.speed };
    } finally { f.dispose(); }
  });

  scenario('boost through a slide and after release remains bounded', () => {
    const f = fixture();
    try {
      f.run(2, GO);
      const held = f.run(1.5, { ...GO, steer: 1, drift: true, boost: true });
      const after = f.run(2, GO);
      const boosted = peak(held, (s) => s.speed);
      check(boosted > physicsConfig.maxSpeed * 1.05 && boosted < physicsConfig.maxSpeed * physicsConfig.boostMaxSpeedMul * 1.06,
        'Boost in a drift must add speed without runaway velocity');
      check(after.at(-1)!.speed < physicsConfig.maxSpeed * 1.05 && after.at(-1)!.up > 0.85,
        'Releasing boost/drift must settle to the normal cap upright');
      return { boosted, settled: after.at(-1)!.speed, energy: f.robot.sim.boostEnergy };
    } finally { f.dispose(); }
  });

  scenario('ramp and hard cover remain physical at the higher speed', () => {
    const ramp = fixture({ ramp: true }), wall = fixture({ wall: true });
    try {
      const jump = ramp.run(6, (sample) => sample.state.p.z < 7 ? GO : IDLE);
      const collision = wall.run(5, GO);
      const takeoff = jump.some((s) => !s.grounded && s.state.p.y > 1.6);
      const landed = jump.some((s) => s.state.p.z > 7 && s.grounded && Math.abs(s.state.v.y) < 0.5 && s.up > 0.8);
      check(takeoff && landed, 'Fast driving must still launch from ramps and land on wheels');
      check(peak(collision, (s) => s.state.p.z) < 32, 'Full-speed collision must not tunnel through hard cover');
      check(collision.at(-1)!.up > 0.7 && collision.at(-1)!.speed < 1, 'A head-on wall collision must settle without accelerating into instability');
      return { takeoff, landed, peakHeight: peak(jump, (s) => s.state.p.y), wallZ: peak(collision, (s) => s.state.p.z),
        wallEndUp: collision.at(-1)!.up, wallEndSpeed: collision.at(-1)!.speed };
    } finally { ramp.dispose(); wall.dispose(); }
  });

  scenario('input wire and snapshots preserve drift with legacy compatibility', () => {
    const f = fixture();
    const client = new PhysicsWorld();
    const predictor = new LocalPredictor(client);
    try {
      const input: InputFrame = { seq: 42, throttle: 1, steer: 1, aimYaw: 0.3,
        buttons: Buttons.DRIFT | Buttons.BOOST, aimPitch: 0.1, viewT: 17 };
      const decoded = decodeInput(encodeInput(input))!;
      check((decoded.buttons & Buttons.DRIFT) !== 0 && (decoded.buttons & Buttons.BOOST) !== 0,
        'Input serialization must preserve the drift bit alongside boost');
      check(decodeInput([1, 127, 0, 100, 2])?.buttons === Buttons.BOOST, 'Legacy five-entry inputs must remain valid');
      check(decodeInput([1, 127, 0, 100, 65535, 0, 0])?.buttons === 31, 'Unknown input bits must be rejected by the allowed mask');
      f.run(2, GO); f.run(0.4, { ...GO, steer: 1, drift: true });
      const serverRobot = new ServerRobot(17, 'QA', 0xffffff, 'drift-qa', f.robot);
      const state = serverRobot.toNetState();
      const wire = encodeRobot(state);
      const restored = decodeRobot(wire);
      check((state.flags & RobotFlags.DRIFTING) !== 0, 'Authoritative snapshots must mark the active drift');
      check(Math.abs(restored.driftAmount - f.robot.sim.driftAmount) < 0.0001, 'Snapshot must preserve drift blend state');
      check(decodeRobot(wire.slice(0, 30)).driftAmount === 0, 'Older snapshots must default drift state to zero');
      predictor.ensure(17, restored);
      check(Math.abs(predictor.controller!.sim.driftAmount - restored.driftAmount) < 0.00001,
        'Predictor creation must restore authoritative drift state');
      predictor.controller!.sim.driftAmount = 0;
      predictor.reconcile(restored, FIXED_DT);
      const restoredError = Math.abs(predictor.controller!.sim.driftAmount - restored.driftAmount);
      check(restoredError < 0.00001, 'Reconciliation must restore authoritative drift state before replay');
      f.robot.teleport({ x: 0, y: 1.4, z: 0 }, 0);
      check(f.robot.sim.driftAmount === 0, 'Respawn teleport must clear drift state');
      return { driftBit: decoded.buttons & Buttons.DRIFT, snapshotBlend: restored.driftAmount,
        restoredError, legacyBlend: decodeRobot(wire.slice(0, 30)).driftAmount };
    } finally { predictor.destroy(); client.world.free(); f.dispose(); }
  });

  scenario('pending drift inputs replay from the authoritative blend', () => {
    const physics = new PhysicsWorld();
    const predictor = new LocalPredictor(physics);
    const sourceWorld = new PhysicsWorld();
    const source = new RobotController(sourceWorld.world, { x: -35, y: 1.4, z: -20 }, 0);
    try {
      for (let tick = 0; tick < 120; tick++) { source.drive(IDLE, FIXED_DT, false); sourceWorld.step(); }
      for (let tick = 0; tick < 60; tick++) { source.drive(GO, FIXED_DT, false); sourceWorld.step(); }
      for (let tick = 0; tick < 8; tick++) {
        source.drive({ ...GO, steer: 1, drift: true }, FIXED_DT, false); sourceWorld.step();
      }
      const server = new ServerRobot(3, 'Replay QA', 0xffffff, 'qa', source);
      const snapshot = decodeRobot(encodeRobot(server.toNetState()));
      predictor.ensure(3, snapshot);
      for (let seq = 1; seq <= 12; seq++) {
        predictor.applyInput({ seq, throttle: 1, steer: seq <= 6 ? 1 : -1,
          buttons: seq <= 9 ? Buttons.DRIFT : 0, aimYaw: 0, aimPitch: 0, viewT: 0 }, FIXED_DT);
        physics.step(); predictor.afterStep();
      }
      const expected = predictor.controller!.getState();
      const expectedBlend = predictor.controller!.sim.driftAmount;
      const expectedAngle = predictor.controller!.sim.steeringAngle;
      predictor.controller!.sim.driftAmount = 0;
      predictor.controller!.sim.steeringAngle = -0.5;
      predictor.controller!.body.setTranslation({ ...expected.p, x: expected.p.x + 1 }, true);
      predictor.reconcile(snapshot, FIXED_DT);
      const actual = predictor.controller!.getState();
      const positionError = Math.hypot(actual.p.x - expected.p.x, actual.p.y - expected.p.y, actual.p.z - expected.p.z);
      const blendError = Math.abs(predictor.controller!.sim.driftAmount - expectedBlend);
      const angleError = Math.abs(predictor.controller!.sim.steeringAngle - expectedAngle);
      check(predictor.stats.replayed === 12 && blendError < 0.0001,
        'Reconciliation must replay each pending drift edge from the restored authoritative blend');
      check(positionError < 0.05 && angleError < 0.003,
        'Drift replay must reproduce the trajectory within 5 cm without reusing stale steering');
      return { positionError, blendError, angleError, replayed: predictor.stats.replayed, expectedBlend };
    } finally { predictor.destroy(); physics.world.free(); source.dispose(); sourceWorld.world.free(); }
  });

  if (process.argv.includes('--network')) await networkProtocol();
  console.log(`DRIFT HARNESS: ${physicsConfig.maxSpeed} m/s; fixed dt ${FIXED_DT.toFixed(5)} s`);
  for (const result of results) {
    console.log(`${result.failures.length ? 'FAIL' : 'PASS'} ${result.scenario}: ${JSON.stringify(result.metrics)}`);
    for (const failure of result.failures) console.error(`  ${failure}`);
  }
  console.log(`RESULT: ${failures.length ? 'FAIL' : 'PASS'} (${failures.length} failed checks)`);
  process.exitCode = failures.length ? 1 : 0;
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
