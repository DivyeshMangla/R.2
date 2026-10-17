/**
 * Aim / hit-registration harness (npm run test:aim).
 *
 * Runs the authoritative WeaponSystem + LagCompensator against a virtual
 * client that sees the world the way the real one does: snapshots at 30 Hz
 * delayed by half the RTT, rendered 100 ms in the past, the orbit camera from
 * shared/aim.ts, and the shared aim solver turning the screen-centre ray into
 * turret yaw/pitch. Inputs reach the server half an RTT later.
 *
 * Static targets: the client centres the crosshair on the hitbox centre.
 * Moving target: the client leads using the velocity it sees. Every shell is
 * also flown client-side against what the shooter's screen shows, so the
 * report separates "the shooter aimed badly" from "the server disagreed".
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aimDirection,
  buildArenaColliders,
  Buttons,
  cameraOrigin,
  castHitTargets,
  computeShots,
  createEnvCaster,
  createPhysicsWorld,
  DEFAULT_CAMERA_RIG,
  DEFAULT_PHYSICS_CONFIG,
  FIXED_DT,
  getTurretPivot,
  initPhysics,
  makeAimSolution,
  makeHitTarget,
  makeStepResult,
  Msg,
  physicsConfig,
  quatFromYaw,
  RobotController,
  ROBOT_HITBOX_CENTER,
  SNAPSHOT_EVERY_TICKS,
  solveAim,
  StepKind,
  stepProjectile,
  targetAimPoint,
  TICK_RATE,
  type GameEvent,
  type HitTarget,
  type InputFrame,
  type ProjectileState,
  type ProjectileWorld,
  type Quat,
  type RobotPhysState,
  type ShotResultMsg,
  type Vec3,
} from '@robot-arena/shared';
import type { GameHost } from '../game/GameHost';
import { LagCompensator } from '../game/LagCompensator';
import { PhysicsWorld } from '../game/PhysicsWorld';
import { ServerRobot } from '../game/ServerRobot';
import { WeaponSystem } from '../game/WeaponSystem';

interface Scenario {
  name: string;
  shooter: Vec3;
  shooterYaw: number;
  target: Vec3;
  /** Ping-pong along +X at this speed (m/s) between target.x and target.x + span. */
  speed?: number;
  span?: number;
  /** Chassis-space point the player puts the crosshair on (default: hitbox centre). */
  aimLocal?: Vec3;
  moving?: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: 'flat 5 m', shooter: { x: -35, y: 1, z: -5 }, shooterYaw: 0, target: { x: -35, y: 1, z: 0 } },
  { name: 'flat 15 m', shooter: { x: -35, y: 1, z: -10 }, shooterYaw: 0, target: { x: -35, y: 1, z: 5 } },
  { name: 'flat 30 m', shooter: { x: -35, y: 1, z: -15 }, shooterYaw: 0, target: { x: -35, y: 1, z: 15 } },
  { name: 'platform -> floor', shooter: { x: 5, y: 2.6, z: -5 }, shooterYaw: Math.PI / 2, target: { x: 20, y: 1, z: -5 } },
  { name: 'floor -> platform', shooter: { x: 20, y: 1, z: -5 }, shooterYaw: -Math.PI / 2, target: { x: 5, y: 2.6, z: -5 } },
  { name: 'mid-ramp -> floor', shooter: { x: 0, y: 1.6, z: 11 }, shooterYaw: 0, target: { x: 0, y: 1, z: 26 } },
  // Only the turret shows above the 1.2 m cover wall.
  { name: 'low profile (cover)', shooter: { x: -15, y: 1, z: -25 }, shooterYaw: 0, target: { x: -15, y: 1, z: -8.4 }, aimLocal: { x: 0, y: 0.8, z: 0 } },
  { name: 'moving 21 m/s @ 15 m', shooter: { x: 16, y: 1, z: -21 }, shooterYaw: Math.PI, target: { x: 0, y: 1, z: -36 }, speed: 21, span: 24, moving: true },
];

const RTTS = [0, 100, 200];
const SHOTS = 100;
const FIRE_EVERY_TICKS = 6;
const INTERP_MS = 100;
const STATIC_BAR = 0.98;
const MOVING_BAR = 0.9;

interface SnapEntry {
  t: number;
  p: Vec3;
  q: Quat;
}

interface ClientShell {
  seq: number;
  state: ProjectileState;
  done: boolean;
  hit: boolean;
}

interface ShotRecord {
  seq: number;
  aimPoint: Vec3;
  /** Target kept a constant velocity from the client's velocity estimate until impact. */
  steady: boolean;
  clientHit: boolean | null;
  server: ShotResultMsg | null;
}

interface RunResult {
  shots: number;
  hits: number;
  clientHits: number;
  agreeHits: number;
  falseHits: number;
  vErr: number;
  assisted: number;
  misses: Map<string, number>;
  rewindMs: number;
  steadyShots: number;
  steadyHits: number;
}

function delayTicks(ms: number): number {
  return Math.round(ms / (1000 / TICK_RATE));
}

function settle(physics: PhysicsWorld, robots: ServerRobot[]): void {
  for (let i = 0; i < 180; i++) {
    for (const r of robots) r.controller.drive({ throttle: 0, steer: 0, boost: false, ability: false }, FIXED_DT, false);
    physics.step();
  }
}

function runScenario(sc: Scenario, rttMs: number): RunResult {
  const oneWay = delayTicks(rttMs / 2);
  const physics = new PhysicsWorld();
  const robots = new Map<number, ServerRobot>();
  const results: ShotResultMsg[] = [];
  const events: GameEvent[] = [];
  let tick = 0;
  const host: GameHost = {
    physics,
    get time() {
      return tick * FIXED_DT;
    },
    robots: () => robots.values(),
    robotById: (id) => robots.get(id),
    emit: (e) => events.push(e),
    applyDamage: (_t, amount) => amount,
    heal: () => undefined,
    combatEnabled: () => true,
    sendTo: (_r, type, msg) => {
      if (type === Msg.SHOT_RESULT) results.push(msg as ShotResultMsg);
    },
    markRosterDirty: () => undefined,
  };
  const mk = (id: number, session: string | null, p: Vec3, yaw: number): ServerRobot => {
    const r = new ServerRobot(id, `r${id}`, 0, session, new RobotController(physics.world, p, yaw));
    physics.registerRobot(r.controller.collider, id);
    robots.set(id, r);
    return r;
  };
  const shooter = mk(1, 'human', sc.shooter, sc.shooterYaw);
  const target = mk(2, null, sc.target, sc.moving ? Math.PI / 2 : sc.shooterYaw + Math.PI);
  settle(physics, [shooter, target]);
  const shooterState: RobotPhysState = shooter.controller.getState();
  const targetRest: RobotPhysState = target.controller.getState();
  const lag = new LagCompensator();
  const weapons = new WeaponSystem(host, lag);

  // Client side: its own copy of the static arena for the aim solver and shell prediction.
  const clientWorld = createPhysicsWorld();
  buildArenaColliders(clientWorld);
  const clientEnv = createEnvCaster(clientWorld);
  const clientTargets: HitTarget[] = [makeHitTarget(), makeHitTarget()];
  let clientTargetCount = 0;
  const clientProjWorld: ProjectileWorld = {
    castEnv: clientEnv,
    castRobots: (o, d, max, radius, padH, padV, ignore, out) => castHitTargets(clientTargets, clientTargetCount, o, d, max, radius, padH, padV, ignore, out),
  };

  const targetPoseAt = (timeMs: number): RobotPhysState => {
    if (!sc.moving) return targetRest;
    const span = sc.span ?? 10;
    const travel = ((timeMs / 1000) * (sc.speed ?? 0)) % (span * 2);
    const dirSign = travel < span ? 1 : -1;
    const x = sc.target.x + (travel < span ? travel : span * 2 - travel);
    return {
      p: { x, y: targetRest.p.y, z: targetRest.p.z },
      q: quatFromYaw(dirSign > 0 ? Math.PI / 2 : -Math.PI / 2),
      v: { x: dirSign * (sc.speed ?? 0), y: 0, z: 0 },
      w: { x: 0, y: 0, z: 0 },
    };
  };

  // Leg index of the ping-pong path; a change means the target turned around.
  const legAt = (timeMs: number): number => Math.floor(((timeMs / 1000) * (sc.speed ?? 0)) / (sc.span ?? 10));
  const steadyAround = (viewT: number): boolean => !sc.moving || legAt(viewT - 120) === legAt(viewT + 450);

  const snaps: { arrive: number; entry: SnapEntry }[] = [];
  const clientSnaps: SnapEntry[] = [];
  const inputs: { arrive: number; frame: InputFrame }[] = [];
  const shots = new Map<number, ShotRecord>();
  const clientShells: ClientShell[] = [];
  const sol = makeAimSolution();
  const camO: Vec3 = { x: 0, y: 0, z: 0 };
  const camD: Vec3 = { x: 0, y: 0, z: 0 };
  const pivot: Vec3 = { x: 0, y: 0, z: 0 };
  const step = makeStepResult();
  let seq = 0;
  let fired = 0;
  let lastInput: InputFrame | null = null;

  const interpTarget = (renderT: number, out: HitTarget): { ok: boolean; v: Vec3 } => {
    const s = clientSnaps;
    if (s.length === 0) return { ok: false, v: { x: 0, y: 0, z: 0 } };
    let a = s[0], b = s[0];
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].t <= renderT) {
        a = s[i - 1];
        b = s[i];
        break;
      }
    }
    // Past the newest snapshot: extrapolate up to 120 ms like client/net/SnapshotBuffer.
    let extrap = 0;
    if (renderT >= s[s.length - 1].t) {
      b = s[s.length - 1];
      a = s.length > 1 ? s[s.length - 2] : b;
      extrap = Math.min(renderT - b.t, 120) / 1000;
    }
    const span = b.t - a.t;
    const v = span > 0 ? { x: (b.p.x - a.p.x) / (span / 1000), y: 0, z: (b.p.z - a.p.z) / (span / 1000) } : { x: 0, y: 0, z: 0 };
    const k = extrap > 0 ? 1 : span > 0 ? Math.min(1, Math.max(0, (renderT - a.t) / span)) : 0;
    out.id = 2;
    out.p.x = a.p.x + (b.p.x - a.p.x) * k + v.x * extrap;
    out.p.y = a.p.y + (b.p.y - a.p.y) * k;
    out.p.z = a.p.z + (b.p.z - a.p.z) * k + v.z * extrap;
    // Robots only yaw in these scenarios; pick the nearer key's rotation.
    const q = k < 0.5 ? a.q : b.q;
    out.q.x = q.x; out.q.y = q.y; out.q.z = q.z; out.q.w = q.w;
    return { ok: true, v };
  };

  const maxTicks = 60 + SHOTS * FIRE_EVERY_TICKS + 200;
  while (tick < maxTicks) {
    tick++;
    const now = tick * (1000 / TICK_RATE);

    // ---------------- client (runs on the same server-time axis; perfect clock sync)
    while (snaps.length > 0 && snaps[0].arrive <= tick) clientSnaps.push(snaps.shift()!.entry);
    const renderT = now - INTERP_MS;
    const seen = interpTarget(renderT, clientTargets[1]);
    clientTargets[0].id = 1;
    clientTargets[0].p = { ...shooterState.p };
    clientTargets[0].q = { ...shooterState.q };
    clientTargetCount = seen.ok ? 2 : 1;

    // Fly every predicted shell against what this screen shows right now.
    for (const cs of clientShells) {
      if (cs.done) continue;
      const k = stepProjectile(clientProjWorld, cs.state, FIXED_DT, step);
      if (k === StepKind.FLY || k === StepKind.BOUNCE) continue;
      cs.done = true;
      cs.hit = k === StepKind.HIT_ROBOT && step.targetId === 2;
      const rec = shots.get(cs.seq);
      if (rec) rec.clientHit = cs.hit;
    }

    let buttons = 0;
    let aimYaw = lastInput?.aimYaw ?? sc.shooterYaw;
    let aimPitch = lastInput?.aimPitch ?? 0;
    if (seen.ok && tick > 40 + oneWay * 2) {
      getTurretPivot(shooterState.p, shooterState.q, pivot);
      // Where the player puts the crosshair: hitbox centre, led by the velocity they see.
      const aimAt = targetAimPoint(clientTargets[1], { x: 0, y: 0, z: 0 }, sc.aimLocal ?? ROBOT_HITBOX_CENTER);
      if (sc.moving) {
        const base = { ...aimAt };
        for (let it = 0; it < 4; it++) {
          const tFlight = (Math.hypot(aimAt.x - pivot.x, aimAt.y - pivot.y, aimAt.z - pivot.z) - 1.7) / physicsConfig.projectileSpeed;
          aimAt.x = base.x + seen.v.x * tFlight;
          aimAt.z = base.z + seen.v.z * tFlight;
        }
      }
      // Orbit camera whose centre ray passes through aimAt (fixed-point on the camera position).
      let vy = sc.shooterYaw, vp = 0;
      for (let it = 0; it < 8; it++) {
        cameraOrigin(shooterState.p, vy, vp, DEFAULT_CAMERA_RIG, camO);
        const dx = aimAt.x - camO.x, dy = aimAt.y - camO.y, dz = aimAt.z - camO.z;
        vy = Math.atan2(dx, dz);
        vp = Math.atan2(dy, Math.hypot(dx, dz));
      }
      cameraOrigin(shooterState.p, vy, vp, DEFAULT_CAMERA_RIG, camO);
      aimDirection(vy, vp, camD);
      // Leading a mover puts the crosshair on empty space; the solver then converges on whatever is behind it, as in game.
      const query = { world: clientProjWorld, targets: clientTargets, targetCount: clientTargetCount, selfId: 1, camOrigin: camO, camDir: camD, pivot };
      solveAim(query, sol);
      aimYaw = sol.yaw;
      aimPitch = sol.pitch;
      if (fired < SHOTS && tick % FIRE_EVERY_TICKS === 0) {
        buttons = Buttons.FIRE;
        fired++;
        const fseq = seq + 1;
        shots.set(fseq, { seq: fseq, aimPoint: { ...aimAt }, steady: steadyAround(renderT), clientHit: null, server: null });
        // Predicted shell: same shared shot spec + stepper the real client uses.
        const spec = computeShots(shooterState.p, shooterState.q, aimYaw, aimPitch, 1, 1, fseq)[0];
        clientShells.push({
          seq: fseq,
          done: false,
          hit: false,
          state: {
            id: -fseq, owner: 1, pos: { ...spec.origin },
            vel: { x: spec.dir.x * physicsConfig.projectileSpeed, y: spec.dir.y * physicsConfig.projectileSpeed, z: spec.dir.z * physicsConfig.projectileSpeed },
            bouncesLeft: 0, age: 0, lifetime: physicsConfig.projectileLifetime, damage: 0, knockback: 0,
            radius: physicsConfig.projectileRadius, assist: true, dist: 0,
          },
        });
      }
    }
    seq++;
    const frame: InputFrame = { seq, throttle: 0, steer: 0, aimYaw, aimPitch, buttons, viewT: renderT };
    inputs.push({ arrive: tick + oneWay, frame });

    // ---------------- server tick (same order as GameSimulation.step)
    weapons.beginTick(tick);
    shooter.fireCooldown = Math.max(0, shooter.fireCooldown - FIXED_DT);
    let input: InputFrame | null = null;
    if (inputs.length > 0 && inputs[0].arrive <= tick) input = inputs.shift()!.frame;
    if (input) lastInput = input;
    shooter.controller.setState(shooterState);
    target.controller.setState(targetPoseAt(now));
    if (input) {
      shooter.aimYaw = input.aimYaw;
      shooter.aimPitch = input.aimPitch;
      if (input.buttons & Buttons.FIRE) weapons.tryFire(shooter, input);
    }
    physics.step();
    // Record the scripted pose exactly (the step nudges bodies by contact/gravity).
    shooter.controller.setState(shooterState);
    target.controller.setState(targetPoseAt(now));
    lag.record(now, [
      { id: 1, alive: true, p: shooterState.p, q: shooterState.q },
      { id: 2, alive: true, p: targetPoseAt(now).p, q: targetPoseAt(now).q },
    ]);
    weapons.update(FIXED_DT);
    if (tick % SNAPSHOT_EVERY_TICKS === 0) {
      const tp = targetPoseAt(now);
      snaps.push({ arrive: tick + oneWay, entry: { t: now, p: { ...tp.p }, q: { ...tp.q } } });
    }
  }

  for (const r of results) {
    const rec = shots.get(r.seq);
    if (rec) rec.server = r;
  }
  const res: RunResult = {
    shots: 0, hits: 0, clientHits: 0, agreeHits: 0, falseHits: 0, vErr: 0, assisted: 0, misses: new Map(), rewindMs: 0, steadyShots: 0, steadyHits: 0,
  };
  for (const rec of shots.values()) {
    const s = rec.server;
    if (!s) continue;
    res.shots++;
    res.rewindMs += s.rewindMs;
    const hit = s.hit && s.target === 2;
    if (hit) res.hits++;
    if (rec.steady) {
      res.steadyShots++;
      if (hit) res.steadyHits++;
    }
    if (hit && s.assisted) res.assisted++;
    if (rec.clientHit) res.clientHits++;
    if (rec.clientHit && hit) res.agreeHits++;
    if (!rec.clientHit && hit) res.falseHits++;
    if (!hit) res.misses.set(s.reason, (res.misses.get(s.reason) ?? 0) + 1);
    // Vertical error of the server's shell line at the aim point's horizontal distance.
    const flat = Math.hypot(rec.aimPoint.x - s.muzzle.x, rec.aimPoint.z - s.muzzle.z);
    const dFlat = Math.hypot(s.dir.x, s.dir.z) || 1;
    const yAt = s.muzzle.y + (s.dir.y / dFlat) * flat;
    res.vErr += Math.abs(yAt - rec.aimPoint.y);
  }
  if (res.shots > 0) {
    res.vErr /= res.shots;
    res.rewindMs /= res.shots;
  }
  clientWorld.free();
  physics.world.free();
  return res;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '  -  ';
}

function table(title: string): { lines: string[]; pass: boolean } {
  const lines: string[] = [title, ''];
  lines.push(
    'scenario                RTT   hits     rate    steady-motion  client-saw-hit  server-agreed  false+  |vErr| m  rewind ms  assisted  misses',
  );
  lines.push('-'.repeat(146));
  let pass = true;
  for (const sc of SCENARIOS) {
    for (const rtt of RTTS) {
      const r = runScenario(sc, rtt);
      const rate = r.shots > 0 ? r.hits / r.shots : 0;
      const reg = r.clientHits > 0 ? r.agreeHits / r.clientHits : 0;
      // Static: the shot must land. Moving: steady-motion shots must land and what the shooter saw hit must register.
      const steadyRate = r.steadyShots > 0 ? r.steadyHits / r.steadyShots : 0;
      const ok = sc.moving ? steadyRate >= MOVING_BAR && reg >= MOVING_BAR && r.falseHits <= r.shots * 0.05 : rate >= STATIC_BAR;
      if (!ok) pass = false;
      const misses = [...r.misses.entries()].map(([k, v]) => `${k}:${v}`).join(' ') || '-';
      lines.push(
        `${sc.name.padEnd(22)} ${String(rtt).padStart(4)}  ${String(r.hits).padStart(3)}/${String(r.shots).padEnd(3)}  ${pct(r.hits, r.shots).padStart(6)}  ` +
          `${`${r.steadyHits}/${r.steadyShots}`.padStart(7)} ${pct(r.steadyHits, r.steadyShots).padStart(6)}  ` +
          `${String(r.clientHits).padStart(8)}        ${pct(r.agreeHits, r.clientHits).padStart(7)}       ${String(r.falseHits).padStart(4)}   ${r.vErr.toFixed(3).padStart(7)}   ` +
          `${r.rewindMs.toFixed(0).padStart(6)}    ${String(r.assisted).padStart(5)}    ${misses}   ${ok ? 'PASS' : 'FAIL'}`,
      );
    }
  }
  lines.push('');
  lines.push(
    `Bars: static >= ${STATIC_BAR * 100}% hits. Moving: >= ${MOVING_BAR * 100}% of steady-motion shots hit (target did not turn around between the ` +
      `client's velocity estimate and impact), >= ${MOVING_BAR * 100}% of shots the shooter's own screen showed hitting are confirmed, <= 5% false positives.`,
  );
  lines.push('Misses outside the steady subset are lead errors at the path turnaround; the client-side prediction misses them too.');
  return { lines, pass };
}

async function main(): Promise<void> {
  await initPhysics();
  Object.assign(physicsConfig, DEFAULT_PHYSICS_CONFIG);
  physicsConfig.fireInterval = 0.05;
  const out: string[] = [];
  const header = `AIM HARNESS  ${SHOTS} shots/run, ${INTERP_MS} ms interpolation, RTT ${RTTS.join('/')} ms (half each way), camera rig ${JSON.stringify(DEFAULT_CAMERA_RIG)}`;
  out.push(header, '');
  const on = table('Aim assist ON (defaults)');
  out.push(...on.lines, '');
  physicsConfig.aimAssistEnabled = 0;
  const off = table('Aim assist OFF');
  out.push(...off.lines, '');
  out.push(`RESULT: assist ON ${on.pass ? 'PASS' : 'FAIL'}, assist OFF ${off.pass ? 'PASS' : 'FAIL'}`);
  const text = out.join('\n');
  console.log(text);
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, '../../test-results/aim-after.txt');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text + '\n');
  process.exit(on.pass ? 0 : 1);
}

void main();
