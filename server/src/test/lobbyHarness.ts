/** Headless lobby/loadout/map checks. Prints results without writing files. */
import assert from 'node:assert/strict';
import {
  aimAnglesFrom,
  Buttons,
  emptyInput,
  FIXED_DT,
  getArenaDefinition,
  getMap,
  getTurretPivot,
  initPhysics,
  makeAimSolution,
  MATCH_DURATION_S,
  MAPS,
  Msg,
  RESPAWN_DELAY_S,
  RESULTS_DURATION_S,
  ROBOT_HITBOX_CENTER,
  RobotController,
  rotateVec,
  weaponStats,
  getWeapon,
  physicsConfig,
  WEAPONS,
  type ArenaBlock,
  type GameEvent,
  type MapId,
  type SnapshotMsg,
  type WeaponId,
} from '@robot-arena/shared';
import { GameSimulation, type NetSink } from '../game/GameSimulation';
import type { GameHost } from '../game/GameHost';
import { LagCompensator } from '../game/LagCompensator';
import { PhysicsWorld } from '../game/PhysicsWorld';
import { ServerRobot } from '../game/ServerRobot';
import { WeaponSystem } from '../game/WeaponSystem';

const quietNet: NetSink = { broadcast: () => undefined, send: () => undefined };

function advance(game: GameSimulation, seconds: number): void {
  for (let i = 0; i < Math.ceil(seconds / FIXED_DT); i++) game.update(FIXED_DT * 1000 + 1e-7);
}

function disableBots(game: GameSimulation): void {
  for (const robot of game.robots()) {
    if (!robot.isBot) continue;
    robot.alive = false;
    robot.respawnTimer = 1e9;
    robot.controller.setEnabled(false);
  }
}

function selections(): void {
  const game = new GameSimulation(quietNet);
  try {
    const selected = game.addHuman('selected', '  Driver  ', 'spectre', 'rail');
    assert.equal(selected.name, 'Driver');
    assert.equal(selected.characterId, 'spectre');
    assert.equal(selected.weaponId, null, 'Legacy starter requests must be ignored');
    assert.equal(selected.toPlayerInfo().characterId, 'spectre');
    assert.equal(selected.toPlayerInfo().weaponId, null);
    const defaultWeapon = game.addHuman('character-default', 'Armour', 'bulwark');
    assert.equal(defaultWeapon.weaponId, null);
    const invalid = game.addHuman('invalid', {}, '__proto__', { id: 'rail' });
    assert.equal(invalid.characterId, 'striker');
    assert.equal(invalid.weaponId, null);
    const invalidWeapon = game.addHuman('invalid-weapon', 'Fallback', 'spectre', 'not-a-weapon');
    assert.equal(invalidWeapon.weaponId, null);
    assert.equal(game.welcomeFor(selected).mapId, 'foundry');
    assert.ok([...game.robots()].every((robot) => robot.weaponId === null), 'Every human and bot starts unarmed');
    console.log('PASS selected characters, ignored legacy weapons, unarmed humans/bots, and invalid-option fallbacks');
  } finally { game.dispose(); }
}

function maps(): void {
  assert.equal(MAPS.length, 6);
  assert.equal(new Set(MAPS.map((map) => map.biome)).size, 6);
  assert.equal(getMap('unknown-map').id, 'foundry');
  const heightProfiles = new Set<string>();
  let clearanceChecks = 0;
  let rampsClimbed = 0;
  for (const map of MAPS) {
    const physics = new PhysicsWorld(map.id);
    const game = new GameSimulation(quietNet, undefined, map.id);
    const definition = getArenaDefinition(map.id);
    try {
      assert.ok(map.atlas.x > 0 && map.atlas.x < 100 && map.atlas.y > 0 && map.atlas.y < 100);
      assert.ok(Object.values(map.palette).every((color) => Number.isInteger(color) && color >= 0 && color <= 0xffffff));
      assert.ok(definition.pickups.length >= 12);
      assert.equal(new Set(definition.pickups.map((pad) => pad.id)).size, definition.pickups.length);
      // 29 single-use weapons rotate through restocking pads; each map starts with a varied spread.
      assert.ok(new Set(definition.pickups.map((pad) => pad.weaponId)).size >= 12, `${map.id} must start with a varied arsenal`);
      assert.ok(definition.pickups.every((pad) => WEAPONS.some((weapon) => weapon.id === pad.weaponId)));
      assert.equal(definition.spawns.length, 8);
      physics.step();
      for (const point of [...definition.pickups.map((pad) => pad.position), ...definition.spawns.map((spawn) => spawn.position)]) {
        for (const dx of [-1.2, 0, 1.2]) for (const dz of [-1.2, 0, 1.2]) {
          assert.ok(Math.abs(physics.groundHeight(point.x + dx, point.z + dz, 12)) < 0.001, `${map.id}: obstructed spawn/pad footprint at ${point.x}, ${point.z}`);
          clearanceChecks++;
        }
      }
      const heights: number[] = [];
      for (let x = -30; x <= 30; x += 5) for (let z = -30; z <= 30; z += 5) heights.push(Math.round(physics.groundHeight(x, z, 12) * 100));
      heightProfiles.add(JSON.stringify(heights));
      const player = game.addHuman(`${map.id}-driver`, map.name);
      assert.equal(game.welcomeFor(player).mapId, map.id);
      assert.deepEqual(game.spawnPoints, definition.spawns);
      assert.deepEqual(game.pickupSnapshot().map((pad) => [pad.id, pad.weaponId, pad.position]), definition.pickups.map((pad) => [pad.id, pad.weaponId, pad.position]));
      assert.ok(game.spawnPoints.some((spawn) => Math.hypot(spawn.position.x - player.position().x, spawn.position.z - player.position().z) < 0.01));
      assert.ok(game.pickupSnapshot().every((pad) => pad.available));
    } finally { physics.world.free(); game.dispose(); }
    for (const block of definition.blocks) {
      if (block.kind !== 'ramp' && block.kind !== 'jump') continue;
      climbRamp(map.id, block);
      rampsClimbed++;
    }
  }
  assert.equal(heightProfiles.size, MAPS.length, 'Every biome must have distinct physical geometry');
  const fallback = new GameSimulation(quietNet, undefined, 'unknown-map' as MapId);
  try { assert.equal(fallback.mapId, 'foundry'); } finally { fallback.dispose(); }
  console.log(`PASS all ${MAPS.length} distinct biome maps, authoritative selection, ${clearanceChecks} spawn/pad clearance probes and ${rampsClimbed} driveable ramps`);
}

function climbRamp(mapId: MapId, block: ArenaBlock): void {
  const end = (sign: number) => {
    const rotated = rotateVec(block.rotation, { x: 0, y: block.half.y, z: sign * block.half.z });
    return { x: block.center.x + rotated.x, y: block.center.y + rotated.y, z: block.center.z + rotated.z };
  };
  const ends = [end(-1), end(1)].sort((a, b) => a.y - b.y);
  const [low, high] = ends;
  const length = Math.hypot(high.x - low.x, high.z - low.z);
  const direction = { x: (high.x - low.x) / length, z: (high.z - low.z) / length };
  const physics = new PhysicsWorld(mapId);
  const robot = new RobotController(physics.world, { x: low.x - direction.x * 4, y: 1.4, z: low.z - direction.z * 4 }, Math.atan2(direction.x, direction.z));
  try {
    physics.step();
    for (let tick = 0; tick < 60; tick++) {
      robot.drive({ throttle: 0, steer: 0, boost: false, ability: false }, FIXED_DT, false);
      physics.step();
    }
    let reached = false;
    for (let tick = 0; tick < 300; tick++) {
      robot.drive({ throttle: 1, steer: 0, boost: false, ability: false }, FIXED_DT, false);
      physics.step();
      const p = robot.body.translation();
      if (Math.hypot(p.x - high.x, p.z - high.z) < 2 && p.y > high.y + 0.5) { reached = true; break; }
    }
    assert.ok(reached, `${mapId}: robot could not climb the ramp at ${block.center.x}, ${block.center.z}`);
  } finally { robot.dispose(); physics.world.free(); }
}

function pickups(): void {
  let lastSnapshot: SnapshotMsg | undefined;
  const events: GameEvent[] = [];
  const game = new GameSimulation({
    send: () => undefined,
    broadcast: (type, message) => {
      if (type === Msg.SNAPSHOT) lastSnapshot = message as SnapshotMsg;
      if (type === Msg.EVENTS) events.push(...(message as { e: GameEvent[] }).e);
    },
  });
  const isolated = new GameSimulation(quietNet);
  try {
    const human = game.addHuman('pickup-driver', 'Pickup driver', 'striker', 'pulse');
    disableBots(game);
    const firstPad = game.pickupSnapshot()[0];
    const pad = game.pickupSnapshot().find((p) => p.weaponId !== firstPad.weaponId)!;
    assert.ok(pad, 'Map needs different weapon types');
    let seq = 0;
    const input = (buttons: number) => {
      game.queueInput('pickup-driver', { ...emptyInput(++seq), buttons });
      advance(game, FIXED_DT);
    };
    const near = (position: typeof pad.position) => human.controller.teleport({ ...position, y: position.y + 0.7 }, 0);
    human.controller.teleport({ x: 0, y: 10, z: 0 }, 0);
    input(Buttons.INTERACT);
    assert.equal(human.weaponId, null, 'Distant interaction must not collect a weapon');
    near(firstPad.position);
    input(0);
    assert.equal(human.weaponId, firstPad.weaponId, 'First weapon auto-equips without E');
    near(pad.position);
    input(0);
    assert.equal(human.weaponId, firstPad.weaponId, 'Later swaps require E');
    assert.equal(game.pickupSnapshot().find((p) => p.id === pad.id)!.available, true);
    human.controller.teleport({ ...pad.position, y: 10 }, 0);
    input(Buttons.INTERACT);
    assert.equal(human.weaponId, firstPad.weaponId, 'Armed swaps must also be in range');
    near(pad.position);
    human.fireCooldown = 2;
    input(Buttons.INTERACT);
    assert.equal(human.weaponId, pad.weaponId);
    assert.equal(human.fireCooldown, 0, 'Equipping a pickup clears the previous weapon cooldown');
    const pickupShots = new WeaponSystem(game, new LagCompensator());
    assert.equal(pickupShots.tryFire(human, { aimYaw: 0, aimPitch: 0, seq: 100, viewT: 0 }), true);
    assert.equal(human.weaponId, null, 'Weapons are single-use: one trigger pull spends them');
    pickupShots.clear();
    const consumed = game.pickupSnapshot().find((p) => p.id === pad.id)!;
    assert.equal(consumed.available, false);
    assert.ok(consumed.respawnIn > 5 && consumed.respawnIn <= 6);
    assert.notEqual(consumed.weaponId, pad.weaponId, 'A consumed pad restocks with a different weapon');
    const restocked = consumed;
    assert.ok(events.some((event) => event.k === 'weapon' && event.id === human.id && event.weaponId === pad.weaponId));
    assert.equal(isolated.pickupSnapshot().find((p) => p.id === pad.id)!.available, true);
    human.weaponId = firstPad.weaponId;
    input(Buttons.INTERACT);
    assert.equal(human.weaponId, firstPad.weaponId, 'An empty pad cannot be collected twice');
    human.controller.teleport({ x: 0, y: 10, z: 0 }, 0);
    input(0);
    advance(game, 12.1);
    assert.equal(game.pickupSnapshot().find((p) => p.id === pad.id)!.available, true);
    assert.ok(lastSnapshot?.pickups?.some((p) => p.id === pad.id && p.available));
    near(pad.position);
    human.weaponId = restocked.weaponId;
    input(Buttons.INTERACT);
    assert.equal(game.pickupSnapshot().find((p) => p.id === pad.id)!.available, true, 'Same weapon does not consume a pad');
    human.weaponId = null;
    human.alive = false;
    human.respawnTimer = 1e9;
    input(Buttons.INTERACT);
    assert.equal(human.weaponId, null, 'Dead robots cannot collect weapons');
    human.alive = true;
    human.weaponId = pad.weaponId;
    human.protectTimer = 0;
    game.applyDamage(human, human.hp + 1, null, 'ram', human.position());
    advance(game, RESPAWN_DELAY_S + 0.1);
    assert.equal(human.alive, true);
    assert.equal(human.weaponId, null, 'Respawn is unarmed');
    assert.ok(human.protectTimer > 5, 'Respawn provides a safe six-second window');
    assert.ok(events.some((event) => event.k === 'weapon' && event.id === human.id && event.weaponId === null));
    near(pad.position);
    input(0);
    assert.equal(human.weaponId, restocked.weaponId, 'A respawned robot auto-equips its first weapon again');
    advance(game, MATCH_DURATION_S - 0.5 - game.time);
    near(pad.position);
    human.weaponId = firstPad.weaponId;
    input(Buttons.INTERACT);
    assert.equal(game.pickupSnapshot().find((p) => p.id === pad.id)!.available, false);
    advance(game, MATCH_DURATION_S + RESULTS_DURATION_S - game.time + 3 * FIXED_DT);
    assert.equal(human.weaponId, null, 'New match starts unarmed');
    assert.ok([...game.robots()].every((robot) => robot.weaponId === null), 'Bots also reset unarmed');
    assert.equal(game.pickupSnapshot().find((p) => p.id === pad.id)!.available, true);
    assert.equal(game.pickupSnapshot().find((p) => p.id === pad.id)!.weaponId, pad.weaponId, 'A new match restores the map\'s starting pads');
    console.log('PASS pickup distance, interaction, duplicate/dead protection, snapshot cooldown, match isolation, restock and respawn/reset');
  } finally { game.dispose(); isolated.dispose(); }
}

function weapons(): void {
  const physics = new PhysicsWorld();
  const shooter = new ServerRobot(1, 'Shooter', 0, 'shooter', new RobotController(physics.world, { x: -35, y: 1, z: -10 }, 0));
  const target = new ServerRobot(2, 'Target', 0, null, new RobotController(physics.world, { x: -35, y: 1, z: 5 }, Math.PI));
  const robots = [shooter, target];
  const lag = new LagCompensator();
  const events: GameEvent[] = [];
  const damages: number[] = [];
  const host: GameHost = {
    physics,
    time: 0,
    robots: () => robots,
    robotById: (id) => robots.find((robot) => robot.id === id),
    emit: (event) => events.push(event),
    applyDamage: (_target, damage) => { damages.push(damage); return damage; },
    heal: () => undefined,
    combatEnabled: () => true,
    sendTo: () => undefined,
    markRosterDirty: () => undefined,
  };
  const system = new WeaponSystem(host, lag);
  try {
    assert.equal(system.tryFire(shooter, { aimYaw: 0, aimPitch: 0, seq: 0, viewT: 0 }), false, 'Unarmed input must not fire');
    assert.equal(shooter.fireCooldown, 0);
    assert.equal(system.fireIntervalFor(shooter), 0);
    assert.equal(events.length, 0, 'Unarmed input must not create projectiles');
    for (let tick = 0; tick < 180; tick++) {
      for (const robot of robots) robot.controller.drive({ throttle: 0, steer: 0, boost: false, ability: false }, FIXED_DT, false);
      physics.step();
    }
    lag.record(1000, robots.map((robot) => ({ id: robot.id, alive: true, ...robot.controller.getState() })));
    const offset = rotateVec(target.controller.body.rotation(), ROBOT_HITBOX_CENTER);
    const tp = target.position();
    const aim = aimAnglesFrom(getTurretPivot(shooter.position(), shooter.controller.body.rotation(), { x: 0, y: 0, z: 0 }), { x: tp.x + offset.x, y: tp.y + offset.y, z: tp.z + offset.z }, makeAimSolution());
    const metrics: Record<string, { projectiles: number; speed: number; damage: number }> = {};
    shooter.aimYaw = aim.yaw;
    shooter.aimPitch = aim.pitch;
    for (const id of ['pistol', 'shotgun', 'compound_bow', 'revolver'] satisfies WeaponId[]) {
      shooter.weaponId = id;
      shooter.fireCooldown = 0;
      events.length = 0;
      damages.length = 0;
      const spec = weaponStats(id);
      const def = getWeapon(id);
      assert.equal(system.tryFire(shooter, { aimYaw: aim.yaw, aimPitch: aim.pitch, seq: 1, viewT: 0 }), true);
      assert.equal(shooter.weaponId, null, `${id} is spent by one trigger pull`);
      assert.ok(events.some((event) => event.k === 'use' && event.weaponId === id));
      assert.ok(events.some((event) => event.k === 'weapon' && event.id === shooter.id && event.weaponId === null), 'Spending emits weapon:null');
      assert.equal(system.tryFire(shooter, { aimYaw: aim.yaw, aimPitch: aim.pitch, seq: 2, viewT: 0 }), false, 'A spent weapon cannot fire again');
      const burstTime = (def.burst - 1) * physicsConfig.fireInterval * def.fireIntervalMul;
      for (let tick = 0; tick < Math.ceil((burstTime + spec.lifetime + 2 * FIXED_DT) / FIXED_DT); tick++) system.update(FIXED_DT);
      const shots = events.filter((event) => event.k === 'shot');
      assert.equal(shots.length, def.pellets * def.burst, `${id} fires its whole burst from one use`);
      assert.ok(shots.every((shot) => shot.weaponId === id && shot.lifetime === spec.lifetime && Math.abs(Math.hypot(shot.v.x, shot.v.y, shot.v.z) - spec.speed) < 1e-5));
      assert.equal(new Set(shots.map((shot) => shot.b)).size, shots.length, 'Every shell of a use has a unique barrel key');
      assert.ok(damages.length > 0, `${id} should hit a centred target`);
      assert.ok(damages.every((damage) => Math.abs(damage - spec.damage) < 1e-6));
      metrics[id] = { projectiles: shots.length, speed: spec.speed, damage: damages[0] };
      system.clear();
    }
    assert.ok(metrics.shotgun.projectiles > metrics.compound_bow.projectiles, 'Shotgun must fire multiple pellets');
    assert.ok(metrics.compound_bow.speed > metrics.pistol.speed && metrics.compound_bow.damage > metrics.pistol.damage, 'Bow should be a distinct fast, high-damage projectile');
    assert.equal(metrics.revolver.projectiles, 6, 'Revolver fans six shots in one use');
    console.log(`PASS single-use weapons, bursts, projectile speeds/lifetimes and damage: ${JSON.stringify(metrics)}`);
  } finally { shooter.controller.dispose(); target.controller.dispose(); physics.world.free(); }
}

async function main(): Promise<void> {
  await initPhysics();
  selections();
  maps();
  pickups();
  weapons();
  console.log('LOBBY HARNESS: PASS');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
