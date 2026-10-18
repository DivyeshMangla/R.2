/** Deterministic decision-level bot regressions; no browser or report writes. */
import assert from 'node:assert/strict';
import { Buttons, FIXED_DT, initPhysics, RobotController, type WeaponPickupState } from '@robot-arena/shared';
import { BotAI, type BotWorldView } from '../game/BotAI';
import { PhysicsWorld } from '../game/PhysicsWorld';
import { ServerRobot } from '../game/ServerRobot';

async function main(): Promise<void> {
  await initPhysics();
  const physics = new PhysicsWorld();
  const bot = new ServerRobot(1, 'Bot', 0, null, new RobotController(physics.world, { x: -65, y: 1, z: -65 }, 0));
  const human = new ServerRobot(2, 'Human', 0, 'human', new RobotController(physics.world, { x: -65, y: 1, z: -50 }, 0));
  const otherBot = new ServerRobot(3, 'Other bot', 0, null, new RobotController(physics.world, { x: -65, y: 1, z: -49 }, 0));
  let lineOfSight = true;
  physics.lineOfSight = () => lineOfSight;
  physics.rayEnvironment = () => null;
  let pads: WeaponPickupState[] = [{ id: 0, weaponId: 'pulse', position: { x: -65, y: 0, z: -50 }, available: true, respawnIn: 0 }];
  const view: BotWorldView = { physics, spawnPoints: [{ position: { x: -65, y: 1, z: -65 }, yaw: 0 }], robots: () => [bot, human], pickupSnapshot: () => pads };
  const run = (ai: BotAI, seconds: number) => Array.from({ length: Math.round(seconds / FIXED_DT) }, () => ai.think(bot, view, FIXED_DT));
  const noFire = (frames: ReturnType<typeof run>, description: string) => assert.ok(frames.every((f) => (f.buttons & Buttons.FIRE) === 0), description);
  try {
    human.weaponId = 'pulse';
    noFire(run(new BotAI(() => 0.25), 5), 'Unarmed bots cannot attack');
    bot.weaponId = 'pulse';
    bot.protectTimer = 6;
    noFire(run(new BotAI(() => 0.25), 5), 'Newly spawned bots should not attack during protection');
    bot.protectTimer = 0;
    human.protectTimer = 6;
    noFire(run(new BotAI(() => 0.25), 5), 'Protected humans must not be targeted');
    human.protectTimer = 0;
    human.weaponId = null;
    noFire(run(new BotAI(() => 0.25), 5), 'Unarmed humans must not be targeted');
    human.weaponId = 'pulse';
    human.controller.teleport({ x: -65, y: 1, z: -35 }, 0);
    noFire(run(new BotAI(() => 0.25), 5), 'Bots must not acquire distant humans');
    human.controller.teleport({ x: -65, y: 1, z: -50 }, 0);
    lineOfSight = false;
    noFire(run(new BotAI(() => 0.25), 5), 'Bots must not fire through cover');
    lineOfSight = true;
    const frames = run(new BotAI(() => 0.25), 6);
    const shots = frames.flatMap((frame, tick) => frame.buttons & Buttons.FIRE ? [tick] : []);
    assert.ok(shots.length >= 2 && shots.length <= 5);
    assert.ok(shots[0] * FIXED_DT >= 1.25, 'Bots must acquire the target before firing');
    for (let i = 1; i < shots.length; i++) assert.ok((shots[i] - shots[i - 1]) * FIXED_DT >= 1.15, 'Single-shot bursts need a noticeable pause');
    assert.ok(frames.every((f) => (f.buttons & (Buttons.BOOST | Buttons.ABILITY)) === 0), 'Bots must not boost/dash into a chase');
    const reacquire = new BotAI(() => 0.25);
    noFire(run(reacquire, 1), 'No shot during initial acquisition');
    lineOfSight = false;
    noFire(run(reacquire, 0.2), 'Cover interrupts acquisition');
    lineOfSight = true;
    noFire(run(reacquire, 1), 'Reappearing target needs a new acquisition window');
    assert.ok(run(reacquire, 0.5).some((f) => f.buttons & Buttons.FIRE));
    otherBot.weaponId = 'pulse';
    human.weaponId = null;
    view.robots = () => [bot, human, otherBot];
    assert.ok(run(new BotAI(() => 0.25), 2).some((f) => f.buttons & Buttons.FIRE), 'Armed bots can still engage each other');
    view.robots = () => [bot, human];
    bot.weaponId = null;
    human.controller.teleport({ x: 50, y: 1, z: 50 }, 0);
    const seek = new BotAI(() => 0.25).think(bot, view, FIXED_DT);
    assert.ok(seek.throttle > 0 && Math.abs(seek.steer) < 0.01, 'Unarmed bot should steer toward the available weapon ahead');
    pads = pads.map((pad) => ({ ...pad, available: false, respawnIn: 5 }));
    const patrol = new BotAI(() => 0.25).think(bot, view, FIXED_DT);
    assert.ok(Math.abs(patrol.steer) > 0.5, 'An unavailable pickup should not attract the bot');
    human.controller.teleport({ x: -65, y: 1, z: -62 }, 0);
    const safe = new BotAI(() => 0.25).think(bot, view, FIXED_DT);
    assert.ok(safe.throttle <= 0, 'Unarmed bots should yield near humans rather than ram');
    console.log(`BOT HARNESS: PASS (unarmed/protected/LOS/range gates, acquisition reset, ${shots.length} spaced shots in 6s, no chase boosts, weapon seeking and player clearance)`);
  } finally { bot.controller.dispose(); human.controller.dispose(); otherBot.controller.dispose(); physics.world.free(); }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
