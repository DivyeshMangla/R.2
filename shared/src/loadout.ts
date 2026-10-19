import { aimDirection, computeShots, shotSeed, type ShotSpec } from './aim';
import type { MapId } from './maps';
import { clamp, type Quat, type Vec3 } from './math';
import { physicsConfig } from './physicsConfig';

export type CharacterId = 'striker' | 'bulwark' | 'spectre';
export type WeaponId =
  | 'torch' | 'ray_gun' | 'taser' | 'syringe' | 'knuckles'
  | 'cleaver' | 'fire_axe' | 'darts' | 'shield_canister' | 'toxic_barrel'
  | 'spiked_bat' | 'crowbar' | 'molotov' | 'katana' | 'acid_vial'
  | 'flintlock' | 'tesla_gun' | 'revolver' | 'stun_pistol' | 'crossbow'
  | 'blunderbuss' | 'twin_cannon' | 'firework' | 'storm_kunai' | 'compound_bow'
  | 'rpg' | 'chainsaw' | 'shotgun' | 'pistol';

/**
 * How a single use of the weapon resolves. Every weapon is single-use: one
 * trigger pull spends it (a burst/duration counts as one use) and the robot
 * goes back to unarmed until it drives over another pad.
 *  - projectile: straight shells (computeWeaponShots), optional burst/pierce/chain/homing/explode/status/teleport
 *  - lob:        thrown arc (uses `gravity`), may explode and/or leave a `zone` where it lands
 *  - beam:       instant hitscan ray up to `range`
 *  - cone:       flame/spray cone in front (`range`, `arc`), applies `status`
 *  - melee:      short swing in front (`range`, `arc`), optional `lunge`, `launch`, `disarm`; `duration` > 0 = sustained (chainsaw)
 *  - dash:       lunge forward `range` metres damaging everyone along the path
 *  - pulse:      radial burst around self (`range`), applies `status`
 *  - self:       buff on self (`heal`, `shield`, `speedBoost`); with `damage` and `range` > 0 it also
 *                releases a lethal shockwave around the user (resolved like a pulse, emits `explode`)
 *  - deploy:     drops an object behind the robot that becomes a `zone`; with `triggerRadius` > 0 the
 *                barrel is a proximity bomb that blasts (`damage`, `explodeRadius`, `push`) when an enemy nears
 */
export type WeaponKind = 'projectile' | 'lob' | 'beam' | 'cone' | 'melee' | 'dash' | 'pulse' | 'self' | 'deploy';

export type StatusEffect = 'burn' | 'poison' | 'stun' | 'slow';
export type ZoneKind = 'fire' | 'toxic' | 'acid';

export interface StatusSpec {
  effect: StatusEffect;
  /** Seconds. */
  duration: number;
  /** Damage per second while active (burn / poison). */
  dps?: number;
}

export interface ZoneSpec {
  kind: ZoneKind;
  radius: number;
  duration: number;
  dps: number;
  /** Optional status refreshed on robots standing inside (e.g. slow for acid). */
  status?: StatusSpec;
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  role: string;
  description: string;
  color: number;
  kind: WeaponKind;
  /** Short power word shown on HUD / pad label (e.g. "BURN", "STUN"). */
  power: string;
  // --- projectile / lob tuning (multipliers on physicsConfig projectile values)
  damageMul: number;
  /** Gap between burst shots, as a multiple of physicsConfig.fireInterval. */
  fireIntervalMul: number;
  speedMul: number;
  lifetimeMul: number;
  pellets: number;
  /** Additional cone half-angle in radians. */
  spread: number;
  knockbackMul: number;
  /** Shots in the single use (revolver = 6). */
  burst: number;
  /** Per-shell gravity m/s^2 (lob weapons). */
  gravity: number;
  bounces: number;
  /** Robots a shell passes through before stopping. */
  pierce: number;
  /** Explosion radius on impact (0 = none). */
  explodeRadius: number;
  /** Homing turn rate rad/s (0 = none). */
  homing: number;
  /** Extra chain-lightning jumps after a hit. */
  chain: number;
  /** Owner teleports to the impact point. */
  teleport: boolean;
  status?: StatusSpec;
  zone?: ZoneSpec;
  // --- melee / cone / beam / pulse / dash / self
  /** Flat damage for non-projectile kinds (per tick-second when `duration` > 0). */
  damage: number;
  range: number;
  /** Full arc in radians for melee / cone. */
  arc: number;
  /** Forward impulse on the user (multiples of chassis mass). */
  lunge: number;
  /** Upward launch on victims (multiples of chassis mass). */
  launch: number;
  /** Knockback on victims for non-projectile kinds (multiples of chassis mass). */
  push: number;
  /** Sustained use time in seconds (chainsaw, torch). 0 = instant. */
  duration: number;
  /** Knocks the victim's weapon out of their hands. */
  disarm: boolean;
  heal: number;
  shield: number;
  /** Shield / speed boost duration. */
  buffDuration: number;
  speedBoost: number;
  /** Visual + hitbox scale for the weapon model and its projectiles (1 = baseline). */
  sizeMul: number;
  /** Fraction of damage dealt by this weapon's hits that heals the user (syringe leech dart). 0 = none. */
  lifesteal: number;
  /**
   * Deploy only: the dropped barrel arms and detonates when an enemy comes within this many metres,
   * dealing `damage` (with falloff) in `explodeRadius` and `push` knockback; the owner is immune.
   * 0 = no proximity blast (zone only).
   */
  triggerRadius: number;
}

export interface CharacterDef {
  id: CharacterId;
  name: string;
  role: string;
  description: string;
  color: number;
  accent: number;
}

export interface LobbySelection {
  name: string;
  characterId: CharacterId;
  mapId: MapId;
}

export const CHARACTERS: readonly Readonly<CharacterDef>[] = [
  {
    id: 'striker', name: 'Striker', role: 'Assault',
    description: 'A balanced expedition chassis with agile fins. Find a weapon in the field.',
    color: 0x29d6ff, accent: 0xd6f8ff,
  },
  {
    id: 'bulwark', name: 'Bulwark', role: 'Brawler',
    description: 'A broad armored chassis with a sturdy shielded silhouette. Find a weapon in the field.',
    color: 0xffad54, accent: 0xffe7bf,
  },
  {
    id: 'spectre', name: 'Spectre', role: 'Precision',
    description: 'A sleek scouting chassis with a distinctive sensor mast. Find a weapon in the field.',
    color: 0xb499ff, accent: 0xeee5ff,
  },
];

const BASE: Omit<WeaponDef, 'id' | 'name' | 'role' | 'description' | 'color' | 'kind' | 'power'> = {
  damageMul: 1, fireIntervalMul: 1, speedMul: 1, lifetimeMul: 1, pellets: 1, spread: 0, knockbackMul: 1,
  burst: 1, gravity: 0, bounces: 0, pierce: 0, explodeRadius: 0, homing: 0, chain: 0, teleport: false,
  damage: 0, range: 0, arc: 0, lunge: 0, launch: 0, push: 0, duration: 0, disarm: false,
  heal: 0, shield: 0, buffDuration: 0, speedBoost: 0, sizeMul: 1.6, lifesteal: 0, triggerRadius: 0,
};

type WeaponInit = Pick<WeaponDef, 'id' | 'name' | 'role' | 'description' | 'color' | 'kind' | 'power'> & Partial<WeaponDef>;
const w = (init: WeaponInit): WeaponDef => ({ ...BASE, ...init });
const DEG = Math.PI / 180;

/** The full single-use arsenal (ordered as in the Puzzle Raiders reference sheet). */
export const WEAPONS: readonly Readonly<WeaponDef>[] = [
  // Every single use is tuned to kill one robot on its own: >= 125 damage to a single target
  // (100 base HP + one reinforced_plating stack), mostly from the direct hit.
  // Row 1
  w({ id: 'torch', name: 'Blaze Torch', role: 'Flame cone', power: 'BURN', color: 0xff7a1a, kind: 'cone',
    description: 'Breathe a roaring jet of fire for 2 seconds. Anything in front of you is incinerated.',
    damage: 66, range: 13, arc: 65 * DEG, duration: 2, push: 1.5, status: { effect: 'burn', duration: 4, dps: 10 }, sizeMul: 1.8 }),
  w({ id: 'ray_gun', name: 'Ray Gun', role: 'Instant beam', power: 'BEAM', color: 0x3dffc8, kind: 'beam',
    description: 'A searing instant beam that vaporises whatever it touches. No travel time, no mercy.',
    damage: 150, range: 120, push: 9, status: { effect: 'stun', duration: 0.6 }, sizeMul: 1.7 }),
  w({ id: 'taser', name: 'Shock Box', role: 'Stun pulse', power: 'STUN', color: 0x2f7dff, kind: 'pulse',
    description: 'Discharge a lethal ring of lightning that fries and stuns everyone nearby.',
    damage: 140, range: 14, push: 7, launch: 3, status: { effect: 'stun', duration: 3.2 }, sizeMul: 1.8 }),
  w({ id: 'syringe', name: 'Nano Syringe', role: 'Leech dart', power: 'LEECH', color: 0x5dff5d, kind: 'projectile',
    description: 'Fire a nanite leech dart that drains a robot dry and pours its health into you, plus a speed rush.',
    damageMul: 8.5, speedMul: 1.5, lifetimeMul: 1.3, knockbackMul: 0.8, lifesteal: 1, speedBoost: 1.4, buffDuration: 4,
    status: { effect: 'slow', duration: 2 }, sizeMul: 1.5 }),
  w({ id: 'knuckles', name: 'Brass Knuckles', role: 'Knockout punch', power: 'KO', color: 0x27d3d3, kind: 'melee',
    description: 'Lunge forward and land a knockout punch that sends a robot flying across the arena.',
    damage: 135, range: 6, arc: 90 * DEG, lunge: 12, push: 34, launch: 10, sizeMul: 1.7 }),
  // Row 2
  w({ id: 'cleaver', name: 'Meat Cleaver', role: 'Bouncing throw', power: 'RICOCHET', color: 0x9fb8ff, kind: 'projectile',
    description: 'A huge spinning cleaver that ricochets off walls three times and splits a robot in two.',
    damageMul: 8.2, speedMul: 0.8, lifetimeMul: 2, bounces: 3, gravity: 4, knockbackMul: 2.4, sizeMul: 2 }),
  w({ id: 'fire_axe', name: 'Fire Axe', role: 'Heavy chop', power: 'CRUSH', color: 0xff3b3b, kind: 'melee',
    description: 'One enormous overhead chop. Slow, brutal, decisive: nothing survives it.',
    damage: 170, range: 6.6, arc: 85 * DEG, lunge: 7, push: 20, launch: 6, status: { effect: 'stun', duration: 1 }, sizeMul: 2.3 }),
  w({ id: 'darts', name: 'Venom Darts', role: 'Poison volley', power: 'POISON', color: 0x9cff3b, kind: 'projectile',
    description: 'Three heavy darts that hit hard and flood the target with lethal venom.',
    damageMul: 2.3, speedMul: 1.5, pellets: 3, spread: 0.04, knockbackMul: 0.3, status: { effect: 'poison', duration: 6, dps: 9 }, sizeMul: 1.5 }),
  w({ id: 'shield_canister', name: 'Shield Canister', role: 'Shockwave shield', power: 'SHIELD', color: 0x55e0ff, kind: 'self',
    description: 'Crack open a canister: a lethal shockwave blasts everyone around you away and a 100 HP shield wraps you.',
    shield: 100, buffDuration: 12, damage: 140, range: 12, push: 16, launch: 4, status: { effect: 'stun', duration: 1 }, sizeMul: 1.8 }),
  w({ id: 'toxic_barrel', name: 'Toxic Barrel', role: 'Proximity bomb', power: 'TOXIC', color: 0xffd400, kind: 'deploy',
    description: 'Drop a volatile barrel behind you. It detonates when a pursuer gets close, then leaks a poison cloud.',
    damage: 200, explodeRadius: 10, triggerRadius: 6, push: 14,
    status: { effect: 'poison', duration: 4, dps: 8 },
    zone: { kind: 'toxic', radius: 9, duration: 10, dps: 16, status: { effect: 'poison', duration: 2, dps: 8 } }, sizeMul: 2.2 }),
  // Row 3
  w({ id: 'spiked_bat', name: 'Spiked Bat', role: 'Launcher', power: 'LAUNCH', color: 0xc98a4a, kind: 'melee',
    description: 'A huge wide swing that smashes robots sky-high.',
    damage: 140, range: 6.2, arc: 140 * DEG, lunge: 5, push: 12, launch: 26, sizeMul: 2 }),
  w({ id: 'crowbar', name: 'Crowbar', role: 'Disarm', power: 'DISARM', color: 0xd23a4a, kind: 'melee',
    description: 'A crushing pry that rips the weapon out of an enemy\'s hands and dazes them.',
    damage: 135, range: 6, arc: 100 * DEG, lunge: 8, push: 10, disarm: true, status: { effect: 'stun', duration: 1.2 }, sizeMul: 1.8 }),
  w({ id: 'molotov', name: 'Molotov', role: 'Fire pool', power: 'FIRE', color: 0xff9a2e, kind: 'lob',
    description: 'Lob a bottle that bursts in a fireball and leaves a raging pool of fire.',
    damageMul: 6, speedMul: 0.45, lifetimeMul: 3, gravity: 16, explodeRadius: 5, status: { effect: 'burn', duration: 4, dps: 10 },
    zone: { kind: 'fire', radius: 7.5, duration: 7, dps: 26, status: { effect: 'burn', duration: 2, dps: 10 } }, sizeMul: 1.8 }),
  w({ id: 'katana', name: 'Katana', role: 'Dash slash', power: 'DASH', color: 0xb9c4d6, kind: 'dash',
    description: 'Blink far forward in a straight line, cutting down everything you pass.',
    damage: 150, range: 24, push: 9, launch: 3, sizeMul: 1.9 }),
  w({ id: 'acid_vial', name: 'Acid Vial', role: 'Slow pool', power: 'SLOW', color: 0x39ff6a, kind: 'lob',
    description: 'Shatter a vial of corrosive acid. Robots in the splash melt and crawl.',
    damageMul: 6, speedMul: 0.45, lifetimeMul: 3, gravity: 16, explodeRadius: 4.5, status: { effect: 'slow', duration: 3 },
    zone: { kind: 'acid', radius: 8, duration: 8, dps: 25, status: { effect: 'slow', duration: 2 } }, sizeMul: 1.7 }),
  // Row 4
  w({ id: 'flintlock', name: 'Flintlock', role: 'Hand cannon', power: 'BLAST', color: 0xd9a066, kind: 'projectile',
    description: 'One enormous lead ball with a devastating kick.',
    damageMul: 8.5, speedMul: 1.3, knockbackMul: 5, sizeMul: 1.9 }),
  w({ id: 'tesla_gun', name: 'Tesla Gun', role: 'Chain lightning', power: 'CHAIN', color: 0x7ff3ff, kind: 'projectile',
    description: 'A lethal bolt that arcs to up to five more nearby robots and stuns them all.',
    damageMul: 8, speedMul: 1.7, chain: 5, status: { effect: 'stun', duration: 1.4 }, sizeMul: 1.8 }),
  w({ id: 'revolver', name: 'Six Shooter', role: '6-shot burst', power: 'BURST', color: 0xc0c6cf, kind: 'projectile',
    description: 'Fan the hammer: six heavy rounds in one pull.',
    damageMul: 1.45, speedMul: 1.35, burst: 6, fireIntervalMul: 0.3, spread: 0.015, knockbackMul: 0.6, sizeMul: 1.5 }),
  w({ id: 'stun_pistol', name: 'Stun Pistol', role: 'Stun shot', power: 'STUN', color: 0x2dc4ff, kind: 'projectile',
    description: 'A massive charged dart that fries the target and freezes it for 4 seconds.',
    damageMul: 8, speedMul: 1.3, status: { effect: 'stun', duration: 4 }, sizeMul: 1.6 }),
  w({ id: 'crossbow', name: 'Crossbow', role: 'Piercing bolt', power: 'PIERCE', color: 0xa64dff, kind: 'projectile',
    description: 'A heavy bolt that punches through up to four robots in a line.',
    damageMul: 8.5, speedMul: 1.8, lifetimeMul: 1.4, pierce: 4, gravity: 2, knockbackMul: 2, sizeMul: 1.8 }),
  // Row 5
  w({ id: 'blunderbuss', name: 'Ember Blunderbuss', role: 'Burning spread', power: 'BURN', color: 0xff8c2a, kind: 'projectile',
    description: 'A wide blast of white-hot embers that shreds and sets everything ablaze.',
    damageMul: 0.9, speedMul: 0.85, lifetimeMul: 0.55, pellets: 9, spread: 0.13, knockbackMul: 0.5, status: { effect: 'burn', duration: 4, dps: 10 }, sizeMul: 2 }),
  w({ id: 'twin_cannon', name: 'Twin Cannon', role: 'Double slug', power: 'KNOCKBACK', color: 0x6c5cff, kind: 'projectile',
    description: 'Two colossal slugs side by side with brutal knockback.',
    damageMul: 4.2, speedMul: 1.1, pellets: 2, spread: 0.025, knockbackMul: 4, sizeMul: 2.3 }),
  w({ id: 'firework', name: 'Firework Launcher', role: 'Homing rocket', power: 'HOMING', color: 0xff4d2e, kind: 'projectile',
    description: 'A blazing rocket that hunts the nearest enemy and erupts in a huge burst.',
    damageMul: 8, speedMul: 0.75, lifetimeMul: 3, homing: 3.8, explodeRadius: 6.5, knockbackMul: 2.4, sizeMul: 2 }),
  w({ id: 'storm_kunai', name: 'Storm Kunai', role: 'Teleport', power: 'BLINK', color: 0x8fd8ff, kind: 'projectile',
    description: 'Throw a storm-charged kunai and teleport to wherever it strikes.',
    damageMul: 8, speedMul: 1.5, lifetimeMul: 1.3, teleport: true, status: { effect: 'stun', duration: 1.5 }, sizeMul: 1.6 }),
  w({ id: 'compound_bow', name: 'Compound Bow', role: 'Sniper arrow', power: 'SNIPE', color: 0x3a8cff, kind: 'projectile',
    description: 'A blisteringly fast long-range arrow that one-shots and pierces two targets.',
    damageMul: 10, speedMul: 2.6, lifetimeMul: 2, pierce: 2, gravity: 1.5, knockbackMul: 2, sizeMul: 1.7 }),
  // Row 6
  w({ id: 'rpg', name: 'RPG', role: 'Rocket blast', power: 'EXPLODE', color: 0xb5c43a, kind: 'projectile',
    description: 'A rocket with a colossal explosion. Splash damage flattens everyone nearby.',
    damageMul: 9, speedMul: 0.8, lifetimeMul: 2.4, explodeRadius: 10, knockbackMul: 4.5, sizeMul: 2.4 }),
  w({ id: 'chainsaw', name: 'Chainsaw', role: 'Shredder', power: 'SHRED', color: 0xff8a1e, kind: 'melee',
    description: 'Rev for 3 seconds and shred anything you drive into.',
    damage: 75, range: 5.6, arc: 80 * DEG, duration: 3, push: 0.5, speedBoost: 1.4, sizeMul: 2.3 }),
  w({ id: 'shotgun', name: 'Pump Shotgun', role: 'Close spread', power: 'SPREAD', color: 0xb07a45, kind: 'projectile',
    description: 'Eight heavy pellets in a tight cone. Obliterating up close.',
    damageMul: 1.15, speedMul: 0.9, lifetimeMul: 0.55, pellets: 8, spread: 0.1, knockbackMul: 0.7, sizeMul: 1.8 }),
  w({ id: 'pistol', name: 'Combat Pistol', role: '3-round burst', power: 'BURST', color: 0x4a5368, kind: 'projectile',
    description: 'Three accurate high-calibre rounds in quick succession.',
    damageMul: 2.7, speedMul: 1.3, burst: 3, fireIntervalMul: 0.35, knockbackMul: 0.8, sizeMul: 1.4 }),
];

export const WEAPON_IDS: readonly WeaponId[] = WEAPONS.map((weapon) => weapon.id);

/** Deterministic-ish pick used by pads when they restock. */
export function randomWeaponId(rand: () => number = Math.random, exclude?: WeaponId | null): WeaponId {
  for (let i = 0; i < 4; i++) {
    const id = WEAPON_IDS[Math.floor(rand() * WEAPON_IDS.length) % WEAPON_IDS.length];
    if (id !== exclude) return id;
  }
  return WEAPON_IDS[0];
}

export function isCharacterId(value: unknown): value is CharacterId {
  return CHARACTERS.some((character) => character.id === value);
}

export function isWeaponId(value: unknown): value is WeaponId {
  return WEAPONS.some((weapon) => weapon.id === value);
}

export function getCharacter(value: unknown): Readonly<CharacterDef> {
  return CHARACTERS.find((character) => character.id === value) ?? CHARACTERS[0];
}

export function getWeapon(value: unknown): Readonly<WeaponDef> {
  return WEAPONS.find((weapon) => weapon.id === value) ?? WEAPONS[0];
}

/** Resolve live tuning at fire time so all weapons track authoritative settings. */
export function weaponStats(weaponId: WeaponId): {
  damage: number; speed: number; interval: number; lifetime: number; radius: number; knockback: number;
} {
  const weapon = getWeapon(weaponId);
  return {
    damage: physicsConfig.projectileDamage * weapon.damageMul,
    speed: physicsConfig.projectileSpeed * weapon.speedMul,
    interval: physicsConfig.fireInterval * weapon.fireIntervalMul,
    lifetime: physicsConfig.projectileLifetime * weapon.lifetimeMul,
    // Bigger weapons fire bigger shells: the hitbox grows with the model.
    radius: physicsConfig.projectileRadius * weapon.sizeMul,
    knockback: physicsConfig.projectileImpulse * weapon.knockbackMul,
  };
}

/** Each pellet gets a unique barrel key shared by prediction and shot verdicts. */
export function computeWeaponShots(
  p: Vec3, q: Quat, yaw: number, pitch: number, projectileCount: number,
  playerId: number, seq: number, weaponId: WeaponId,
): ShotSpec[] {
  const weapon = getWeapon(weaponId);
  const barrels = computeShots(p, q, yaw, pitch, projectileCount, playerId, seq);
  // Preserve the original cannon's geometry and seeded tuning spread exactly.
  if (weapon.pellets === 1 && weapon.spread === 0) return barrels;

  const shots: ShotSpec[] = [];
  for (const base of barrels) {
    const baseYaw = Math.atan2(base.dir.x, base.dir.z);
    const basePitch = Math.asin(clamp(base.dir.y, -1, 1));
    const phase = shotSeed(playerId, seq, base.barrel) / 4294967296 * Math.PI * 2;
    for (let pellet = 0; pellet < weapon.pellets; pellet++) {
      const barrel = base.barrel * weapon.pellets + pellet;
      const seed = shotSeed(playerId, seq, barrel);
      // A center pellet plus a rotated spiral covers the cone evenly, while
      // a single-shell repeater uses a deterministic random point in its cone.
      const radius = weapon.spread * (weapon.pellets > 1
        ? Math.sqrt(pellet / (weapon.pellets - 1))
        : Math.sqrt(seed / 4294967296));
      const angle = weapon.pellets > 1 ? phase + pellet * 2.399963229728653 : phase;
      shots.push({
        barrel,
        origin: { ...base.origin },
        dir: aimDirection(baseYaw + Math.cos(angle) * radius, basePitch + Math.sin(angle) * radius, { x: 0, y: 0, z: 0 }),
      });
    }
  }
  return shots;
}
