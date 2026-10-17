import { ARENA_BLOCKS, ARENA_HALF_SIZE, BARRIER_HEIGHT, SPAWN_POINTS, type ArenaBlock, type ArenaBlockKind, type SpawnPoint } from './arena';
import type { WeaponId } from './loadout';
import { add, length, quatFromAxisAngle, quatFromYaw, quatMul, rotateVec, scale, sub, type Vec3 } from './math';

export type MapId = 'foundry' | 'crossroads' | 'verdant' | 'dunes' | 'frost' | 'ruins';
export type MapBiome = 'volcanic' | 'urban' | 'forest' | 'desert' | 'arctic' | 'ancient';

export interface MapPalette {
  ground: number;
  stone: number;
  foliage: number;
  accent: number;
  sky: number;
  fog: number;
  robotPaint: number;
  robotAccent: number;
}

export interface MapDef {
  id: MapId;
  name: string;
  description: string;
  tagline: string;
  color: number;
  biome: MapBiome;
  palette: Readonly<MapPalette>;
  /** Hotspot position on the illustrated world atlas, in percent. */
  atlas: Readonly<{ x: number; y: number }>;
  robotFinish: string;
  difficulty: string;
  /** Width and depth of the playable arena, in meters. */
  arenaSize: number;
}

export interface WeaponPad {
  id: number;
  weaponId: WeaponId;
  /** Ground position; visuals add their own hovering offset. */
  position: Vec3;
}

export interface ArenaDefinition {
  blocks: readonly ArenaBlock[];
  spawns: readonly SpawnPoint[];
  pickups: readonly WeaponPad[];
}

export const MAPS: readonly Readonly<MapDef>[] = [
  {
    id: 'foundry', name: 'Ember Citadel', tagline: 'Rule the molten crown', color: 0xff914d, arenaSize: ARENA_HALF_SIZE * 2,
    description: 'A sprawling volcanic fortress: four outer bastions, furnace yards, and a raised central keep.',
    biome: 'volcanic', atlas: { x: 30, y: 22 }, robotFinish: 'Obsidian armor · molten copper trim', difficulty: 'Challenging',
    palette: { ground: 0x382c33, stone: 0x665057, foliage: 0x65433c, accent: 0xff914d, sky: 0xa66d66, fog: 0xbb8b7b, robotPaint: 0x76505b, robotAccent: 0xffac60 },
  },
  {
    id: 'crossroads', name: 'Neon Harbor', tagline: 'Race the electric skyline', color: 0x4fe1d0, arenaSize: ARENA_HALF_SIZE * 2,
    description: 'A wide harbor city with elevated freight terminals, container yards, and intersecting avenues.',
    biome: 'urban', atlas: { x: 76, y: 69 }, robotFinish: 'Pearl titanium · neon teal circuits', difficulty: 'Balanced',
    palette: { ground: 0x354d58, stone: 0x87a0a9, foliage: 0x397e76, accent: 0x4fe1d0, sky: 0x97c8d0, fog: 0xb7d7db, robotPaint: 0x67a6b2, robotAccent: 0x6effdf },
  },
  {
    id: 'verdant', name: 'Mosswild Grove', tagline: 'Disappear into the green', color: 0x9bd774, arenaSize: ARENA_HALF_SIZE * 2,
    description: 'An expansive woodland of giant trunk groves, mossy overlooks, fallen logs, and winding clearings.',
    biome: 'forest', atlas: { x: 68, y: 42 }, robotFinish: 'Moss enamel · warm brass details', difficulty: 'Welcoming',
    palette: { ground: 0x5f815a, stone: 0x8f9b79, foliage: 0x427653, accent: 0xb8df83, sky: 0xc0d7ad, fog: 0xc3d7ad, robotPaint: 0x739362, robotAccent: 0xd9c47c },
  },
  {
    id: 'dunes', name: 'Saffron Dunes', tagline: 'Carve a path through gold', color: 0xeab46a, arenaSize: ARENA_HALF_SIZE * 2,
    description: 'Vast sandstone canyons connect twin mesas, weathered outcrops, and a broad central dune ridge.',
    biome: 'desert', atlas: { x: 27, y: 44 }, robotFinish: 'Sand ceramic · oxidized bronze trim', difficulty: 'Balanced',
    palette: { ground: 0xc6a26d, stone: 0xb57e53, foliage: 0x8e9870, accent: 0xffd790, sky: 0xeacfa1, fog: 0xe5c79c, robotPaint: 0xd3ae76, robotAccent: 0x88634d },
  },
  {
    id: 'frost', name: 'Frostline Basin', tagline: 'Break the frozen silence', color: 0xadddec, arenaSize: ARENA_HALF_SIZE * 2,
    description: 'A large snow basin with outer glacier shelves, broken ice fields, and long central sightlines.',
    biome: 'arctic', atlas: { x: 74, y: 20 }, robotFinish: 'Frost white · glacial blue panels', difficulty: 'Challenging',
    palette: { ground: 0xc4dce1, stone: 0x96bacb, foliage: 0x6d9b9d, accent: 0xd9fcff, sky: 0xb6d1dd, fog: 0xd4e5eb, robotPaint: 0xd6e5e9, robotAccent: 0x72cce7 },
  },
  {
    id: 'ruins', name: 'Sunken Relic', tagline: 'Wake the forgotten stones', color: 0x91bda6, arenaSize: ARENA_HALF_SIZE * 2,
    description: 'Four forgotten temple courts surround an ancient central plaza, with colonnades and broken gateways.',
    biome: 'ancient', atlas: { x: 31, y: 68 }, robotFinish: 'Patinated jade · antique gold inlay', difficulty: 'Tactical',
    palette: { ground: 0x7d9b8d, stone: 0xa4ae91, foliage: 0x4f7c62, accent: 0xe2ca89, sky: 0xb4cfca, fog: 0xc4d7cb, robotPaint: 0x66968b, robotAccent: 0xdec17e },
  },
];

export function isMapId(value: unknown): value is MapId {
  return MAPS.some((map) => map.id === value);
}

export function getMap(value: unknown): Readonly<MapDef> {
  return MAPS.find((map) => map.id === value) ?? MAPS[0];
}

function box(kind: ArenaBlockKind, x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw = 0): ArenaBlock {
  return { kind, center: { x, y, z }, half: { x: hx, y: hy, z: hz }, rotation: quatFromYaw(yaw) };
}

/** A solid ramp whose upper surface connects two points. */
function ramp(low: Vec3, high: Vec3, width: number): ArenaBlock {
  const direction = sub(high, low);
  const distance = length(direction);
  const rotation = quatMul(
    quatFromYaw(Math.atan2(direction.x, direction.z)),
    quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.asin(direction.y / distance)),
  );
  const thickness = 1.6;
  const normal = rotateVec(rotation, { x: 0, y: 1, z: 0 });
  return {
    kind: 'ramp', rotation,
    center: sub(scale(add(low, high), 0.5), scale(normal, thickness / 2)),
    half: { x: width / 2, y: thickness / 2, z: distance / 2 },
  };
}

function arenaBounds(): ArenaBlock[] {
  const h = ARENA_HALF_SIZE;
  const bh = BARRIER_HEIGHT / 2;
  return [
    box('floor', 0, -0.5, 0, h + 2, 0.5, h + 2),
    box('barrier', 0, bh, h + 0.6, h + 1.2, bh, 0.6),
    box('barrier', 0, bh, -h - 0.6, h + 1.2, bh, 0.6),
    box('barrier', h + 0.6, bh, 0, 0.6, bh, h + 1.2),
    box('barrier', -h - 0.6, bh, 0, 0.6, bh, h + 1.2),
  ];
}

function buildCrossroads(): ArenaBlock[] {
  const blocks = arenaBounds();
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // Four separate decks leave a wide open crossing and an outer ring road.
      blocks.push(box('platform', sx * 20, 0.7, sz * 20, 6, 0.7, 6));
      blocks.push(ramp({ x: sx * 7, y: 0, z: sz * 20 }, { x: sx * 14, y: 1.4, z: sz * 20 }, 5.5));
      blocks.push(ramp({ x: sx * 20, y: 0, z: sz * 7 }, { x: sx * 20, y: 1.4, z: sz * 14 }, 5.5));
      blocks.push(box('pillar', sx * 9, 1.8, sz * 9, 1.1, 1.8, 1.1));
      // Low cover sits on the decks, leaving both ramp approaches unobstructed.
      blocks.push(box('cover', sx * 22, 2, sz * 23, 2.5, 0.6, 0.4));
    }
  }
  return blocks;
}

function buildVerdant(): ArenaBlock[] {
  const blocks = arenaBounds();
  // A single long ridge splits the grove; the forest lanes remain at ground level.
  blocks.push(box('platform', 0, 0.6, 0, 5, 0.6, 11));
  for (const sign of [-1, 1]) {
    blocks.push(ramp({ x: 0, y: 0, z: sign * 20 }, { x: 0, y: 1.2, z: sign * 11 }, 7));
    blocks.push(box('cover', sign * 15, 0.55, sign * 25, 3.8, 0.55, 0.65, sign * Math.PI / 6));
    blocks.push(box('cover', sign * 29, 0.8, sign * 28, 2, 0.8, 1.5, Math.PI / 5));
  }
  for (const [x, z] of [[-19, -14], [19, 14], [-24, 6], [24, -6], [-16, 20], [16, -20]]) {
    // These solid trunks are part of both the rendered grove and the collider map.
    blocks.push(box('pillar', x, 2.8, z, 1.35, 2.8, 1.35));
  }
  return blocks;
}

function buildDunes(): ArenaBlock[] {
  const blocks = arenaBounds();
  blocks.push(box('platform', 0, 1.1, 0, 12, 1.1, 4));
  for (const sign of [-1, 1]) {
    blocks.push(ramp({ x: sign * 23, y: 0, z: 0 }, { x: sign * 12, y: 2.2, z: 0 }, 7));
    for (const side of [-1, 1]) {
      blocks.push(box('cover', sign * 16, 0.9, side * 15, 7, 0.9, 0.75, sign * side * Math.PI / 6));
      blocks.push(box('pillar', sign * 27, 2.2, side * 23, 2, 2.2, 2));
    }
  }
  return blocks;
}

function buildFrost(): ArenaBlock[] {
  const blocks = arenaBounds();
  for (const sign of [-1, 1]) {
    blocks.push(box('platform', sign * 15, 0.8, 0, 5, 0.8, 13));
    for (const side of [-1, 1]) {
      blocks.push(ramp({ x: sign * 15, y: 0, z: side * 24 }, { x: sign * 15, y: 1.6, z: side * 13 }, 7));
      blocks.push(box('cover', sign * 28, 1, side * 17, 2.8, 1, 1.2, sign * side * Math.PI / 5));
    }
    blocks.push(box('pillar', 0, 1.8, sign * 14, 2, 1.8, 2));
  }
  return blocks;
}

function buildRuins(): ArenaBlock[] {
  const blocks = arenaBounds();
  blocks.push(box('platform', 0, 0.75, 0, 8, 0.75, 8));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      blocks.push(ramp({ x: sx * 15, y: 0, z: sz * 15 }, { x: sx * 8, y: 1.5, z: sz * 8 }, 5.5));
      blocks.push(box('cover', sx * 24, 0.75, sz * 21, 4.8, 0.75, 0.6));
      blocks.push(box('cover', sx * 26, 0.75, sz * 16, 0.6, 0.75, 3));
    }
    // The elevated columns leave the diagonal entrances and central plaza clear.
    blocks.push(box('pillar', sx * 5, 3.6, 0, 1, 2.1, 1));
    blocks.push(box('pillar', 0, 3.6, sx * 5, 1, 2.1, 1));
  }
  return blocks;
}

function buildCrossroadsSpawns(): SpawnPoint[] {
  return [
    [-33, 0], [33, 0], [0, -33], [0, 33],
    [-33, -33], [33, -33], [-33, 33], [33, 33],
  ].map(([x, z]) => ({ position: { x, y: 1.4, z }, yaw: Math.atan2(-x, -z) }));
}

function pad(id: number, weaponId: WeaponId, x: number, z: number): WeaponPad {
  return { id, weaponId, position: { x, y: 0, z } };
}

const ARENAS: Readonly<Record<MapId, ArenaDefinition>> = {
  foundry: {
    blocks: ARENA_BLOCKS,
    spawns: SPAWN_POINTS,
    pickups: [
      pad(0, 'scatter', 0, 22), pad(1, 'pulse', 0, -22),
      pad(2, 'rail', 22, 14), pad(3, 'rail', -22, -14),
      pad(4, 'repeater', 30, -12), pad(5, 'repeater', -30, 12),
    ],
  },
  crossroads: {
    blocks: buildCrossroads(),
    spawns: buildCrossroadsSpawns(),
    pickups: [
      pad(0, 'scatter', -9, 0), pad(1, 'scatter', 9, 0),
      pad(2, 'rail', 0, -25), pad(3, 'pulse', 0, 25),
      pad(4, 'repeater', -32, -22), pad(5, 'repeater', 32, 22),
    ],
  },
  verdant: {
    blocks: buildVerdant(),
    spawns: buildCrossroadsSpawns(),
    pickups: [
      pad(0, 'scatter', -12, -10), pad(1, 'pulse', 12, 10),
      pad(2, 'rail', -28, 17), pad(3, 'rail', 28, -17),
      pad(4, 'repeater', 0, -27), pad(5, 'repeater', 0, 27),
    ],
  },
  dunes: {
    blocks: buildDunes(),
    spawns: buildCrossroadsSpawns(),
    pickups: [
      pad(0, 'scatter', 0, -15), pad(1, 'pulse', 0, 15),
      pad(2, 'rail', -29, 8), pad(3, 'rail', 29, -8),
      pad(4, 'repeater', -8, 28), pad(5, 'repeater', 8, -28),
    ],
  },
  frost: {
    blocks: buildFrost(),
    spawns: buildCrossroadsSpawns(),
    pickups: [
      pad(0, 'scatter', 0, 0), pad(1, 'pulse', -27, 0),
      pad(2, 'rail', 27, 0), pad(3, 'rail', 0, -28),
      pad(4, 'repeater', 0, 28), pad(5, 'repeater', -30, -28),
    ],
  },
  ruins: {
    blocks: buildRuins(),
    spawns: buildCrossroadsSpawns(),
    pickups: [
      pad(0, 'scatter', -21, 0), pad(1, 'pulse', 21, 0),
      pad(2, 'rail', 0, -22), pad(3, 'rail', 0, 22),
      pad(4, 'repeater', -28, 28), pad(5, 'repeater', 28, -28),
    ],
  },
};

/** Map choice belongs to each world, so separate rooms can run separate arenas. */
export function getArenaDefinition(mapId: MapId = 'foundry'): ArenaDefinition {
  return ARENAS[getMap(mapId).id];
}
