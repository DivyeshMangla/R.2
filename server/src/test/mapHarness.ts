/** Physical arena checks. Prints measurements only; never writes reports. */
import assert from 'node:assert/strict';
import {
  ARENA_HALF_SIZE,
  FIXED_DT,
  getArenaDefinition,
  initPhysics,
  MAPS,
  RobotController,
  rotateVec,
  SPAWN_PROTECTION_S,
  WEAPONS,
  type ArenaBlock,
  type MapId,
  type Vec3,
} from '@robot-arena/shared';
import { PhysicsWorld } from '../game/PhysicsWorld';

const IDLE = { throttle: 0, steer: 0, boost: false, ability: false };
const FORWARD = { ...IDLE, throttle: 1 };

function flat(physics: PhysicsWorld, x: number, z: number): boolean {
  return Math.abs(physics.groundHeight(x, z, 20)) < 0.001;
}

function clearFootprint(physics: PhysicsWorld, p: Vec3, radius: number): void {
  for (const dx of [-radius, -radius / 2, 0, radius / 2, radius]) {
    for (const dz of [-radius, -radius / 2, 0, radius / 2, radius]) {
      assert.ok(flat(physics, p.x + dx, p.z + dz), `Blocked ${radius * 2}m footprint at ${p.x},${p.z}; offset ${dx},${dz}`);
    }
  }
}

/** Every spawn and pickup has a connected route with at least a 4m footprint. */
function checkGroundRoutes(physics: PhysicsWorld, points: readonly Vec3[]): number {
  const edge = ARENA_HALF_SIZE - 4;
  const step = 2;
  const size = edge * 2 / step + 1;
  const passable = new Uint8Array(size * size);
  for (let iz = 0; iz < size; iz++) for (let ix = 0; ix < size; ix++) {
    const x = -edge + ix * step, z = -edge + iz * step;
    let clear = true;
    for (const dx of [-2, 0, 2]) for (const dz of [-2, 0, 2]) {
      if (!flat(physics, x + dx, z + dz)) clear = false;
    }
    passable[iz * size + ix] = clear ? 1 : 0;
  }
  const index = (p: Vec3) => Math.round((p.z + edge) / step) * size + Math.round((p.x + edge) / step);
  const visited = new Uint8Array(passable.length);
  const queue = [index(points[0])];
  assert.equal(passable[queue[0]], 1, 'The first spawn must open onto a 4m route');
  visited[queue[0]] = 1;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    const x = current % size, z = Math.floor(current / size);
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nx >= size || nz < 0 || nz >= size) continue;
      const next = nz * size + nx;
      if (!passable[next] || visited[next]) continue;
      visited[next] = 1;
      queue.push(next);
    }
  }
  for (const p of points) assert.equal(visited[index(p)], 1, `No clear 4m route to ${p.x},${p.z}`);
  return queue.length;
}

function driveToPad(physics: PhysicsWorld, spawn: Vec3, target: Vec3): void {
  const yaw = Math.atan2(target.x - spawn.x, target.z - spawn.z);
  const robot = new RobotController(physics.world, spawn, yaw);
  try {
    for (let tick = 0; tick < 60; tick++) { robot.drive(IDLE, FIXED_DT, false); physics.step(); }
    let reached = false;
    for (let tick = 0; tick < 240; tick++) {
      robot.drive(FORWARD, FIXED_DT, false);
      physics.step();
      const p = robot.body.translation();
      assert.ok(Math.abs(p.x) < ARENA_HALF_SIZE && Math.abs(p.z) < ARENA_HALF_SIZE);
      assert.ok(rotateVec(robot.body.rotation(), { x: 0, y: 1, z: 0 }).y > 0.7, 'Starter approach must remain stable');
      if (Math.hypot(p.x - target.x, p.z - target.z) < 1.6) { reached = true; break; }
    }
    assert.ok(reached, `Could not drive from spawn ${spawn.x},${spawn.z} to starter pad ${target.x},${target.z}`);
  } finally { robot.dispose(); }
}

function climbRamp(mapId: MapId, block: ArenaBlock): void {
  const end = (sign: number): Vec3 => {
    const local = rotateVec(block.rotation, { x: 0, y: block.half.y, z: sign * block.half.z });
    return { x: block.center.x + local.x, y: block.center.y + local.y, z: block.center.z + local.z };
  };
  const [low, high] = [end(-1), end(1)].sort((a, b) => a.y - b.y);
  const length = Math.hypot(high.x - low.x, high.z - low.z);
  const direction = { x: (high.x - low.x) / length, z: (high.z - low.z) / length };
  const physics = new PhysicsWorld(mapId);
  const robot = new RobotController(physics.world, { x: low.x - direction.x * 4, y: 1.4, z: low.z - direction.z * 4 }, Math.atan2(direction.x, direction.z));
  try {
    physics.step();
    for (let tick = 0; tick < 60; tick++) { robot.drive(IDLE, FIXED_DT, false); physics.step(); }
    let reached = false;
    for (let tick = 0; tick < 360; tick++) {
      robot.drive(FORWARD, FIXED_DT, false);
      physics.step();
      const p = robot.body.translation();
      if (Math.hypot(p.x - high.x, p.z - high.z) < 2 && p.y > high.y + 0.5) { reached = true; break; }
    }
    assert.ok(reached, `${mapId}: ramp at ${block.center.x},${block.center.z} cannot be climbed`);
  } finally { robot.dispose(); physics.world.free(); }
}

async function main(): Promise<void> {
  await initPhysics();
  assert.equal(ARENA_HALF_SIZE, 100);
  assert.equal(SPAWN_PROTECTION_S, 6);
  const profiles = new Set<string>();
  let starterDrives = 0, rampsClimbed = 0;
  for (const map of MAPS) {
    const definition = getArenaDefinition(map.id);
    const physics = new PhysicsWorld(map.id);
    const outer = definition.blocks.filter((b) => b.kind !== 'floor' && b.kind !== 'barrier' && Math.max(Math.abs(b.center.x), Math.abs(b.center.z)) > 38);
    try {
      assert.equal(map.arenaSize, 200);
      assert.ok(definition.blocks.length >= 60, `${map.id} needs a populated arena`);
      assert.ok(outer.length >= 35, `${map.id} needs physical outer districts`);
      assert.ok(definition.pickups.length >= 12);
      assert.equal(new Set(definition.pickups.map((p) => p.id)).size, definition.pickups.length);
      // Pads restock with random weapons, so a map only needs a varied starting spread.
      assert.ok(new Set(definition.pickups.map((p) => p.weaponId)).size >= 12);
      assert.ok(definition.pickups.every((p) => WEAPONS.some((weapon) => weapon.id === p.weaponId)));
      assert.equal(definition.spawns.length, 8);
      for (const block of definition.blocks) {
        if (block.kind === 'floor' || block.kind === 'barrier') continue;
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
          const corner = rotateVec(block.rotation, { x: sx * block.half.x, y: sy * block.half.y, z: sz * block.half.z });
          assert.ok(Math.abs(block.center.x + corner.x) < ARENA_HALF_SIZE && Math.abs(block.center.z + corner.z) < ARENA_HALF_SIZE, `${map.id}: object outside boundaries`);
        }
      }
      physics.step();
      const points = [...definition.spawns.map((s) => s.position), ...definition.pickups.map((p) => p.position)];
      for (const p of points) clearFootprint(physics, p, 3);
      // A continuous outer ring leaves a 10m-wide alternative route around each district.
      for (let along = -94; along <= 94; along += 4) {
        for (const side of [-94, 94]) {
          clearFootprint(physics, { x: side, y: 0, z: along }, 5);
          clearFootprint(physics, { x: along, y: 0, z: side }, 5);
        }
      }
      const routeCells = checkGroundRoutes(physics, points);
      for (const [index, spawn] of definition.spawns.entries()) {
        assert.ok(Math.hypot(spawn.position.x, spawn.position.z) >= 80);
        for (const other of definition.spawns.slice(index + 1)) assert.ok(Math.hypot(other.position.x - spawn.position.x, other.position.z - spawn.position.z) > 55, 'Spawn zones must be widely separated');
        const nearest = [...definition.pickups].sort((a, b) => Math.hypot(a.position.x - spawn.position.x, a.position.z - spawn.position.z) - Math.hypot(b.position.x - spawn.position.x, b.position.z - spawn.position.z))[0];
        assert.ok(Math.hypot(nearest.position.x - spawn.position.x, nearest.position.z - spawn.position.z) <= 12, 'Every unarmed spawn needs a nearby weapon');
        driveToPad(physics, spawn.position, nearest.position);
        starterDrives++;
      }
      const heights: number[] = [];
      for (let x = -90; x <= 90; x += 10) for (let z = -90; z <= 90; z += 10) heights.push(Math.round(physics.groundHeight(x, z, 20) * 100));
      profiles.add(JSON.stringify(heights));
      console.log(`PASS ${map.id}: ${map.arenaSize}m, ${definition.blocks.length} objects (${outer.length} outer), ${definition.pickups.length} pickups, ${routeCells} connected 4m route cells`);
    } finally { physics.world.free(); }
    for (const block of definition.blocks) if (block.kind === 'ramp' || block.kind === 'jump') { climbRamp(map.id, block); rampsClimbed++; }
  }
  assert.equal(profiles.size, MAPS.length, 'All six maps must retain distinct physical layouts');
  console.log(`MAP HARNESS: PASS (${starterDrives} real starter drives, ${rampsClimbed} ramp climbs, 6m turning footprints, 10m outer lanes, shared 200m boundaries)`);
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
