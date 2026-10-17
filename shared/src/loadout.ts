import { aimDirection, computeShots, shotSeed, type ShotSpec } from './aim';
import type { MapId } from './maps';
import { clamp, type Quat, type Vec3 } from './math';
import { physicsConfig } from './physicsConfig';

export type CharacterId = 'striker' | 'bulwark' | 'spectre';
export type WeaponId = 'pulse' | 'scatter' | 'rail' | 'repeater';

export interface CharacterDef {
  id: CharacterId;
  name: string;
  role: string;
  description: string;
  color: number;
  accent: number;
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  role: string;
  description: string;
  color: number;
  damageMul: number;
  fireIntervalMul: number;
  speedMul: number;
  lifetimeMul: number;
  pellets: number;
  /** Additional cone half-angle in radians. */
  spread: number;
  knockbackMul: number;
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

export const WEAPONS: readonly Readonly<WeaponDef>[] = [
  {
    id: 'pulse', name: 'Pulse Cannon', role: 'Balanced',
    description: 'Accurate shells with a steady rhythm and solid impact.', color: 0x39d9ff,
    damageMul: 1, fireIntervalMul: 1, speedMul: 1, lifetimeMul: 1,
    pellets: 1, spread: 0, knockbackMul: 1,
  },
  {
    id: 'scatter', name: 'Scatter Cannon', role: 'Close range',
    description: 'Five shells in a wide cone. Devastating up close.', color: 0xffad54,
    damageMul: 0.38, fireIntervalMul: 1.7, speedMul: 0.82, lifetimeMul: 0.55,
    pellets: 5, spread: 0.12, knockbackMul: 0.45,
  },
  {
    id: 'rail', name: 'Rail Cannon', role: 'Precision',
    description: 'A fast, heavy projectile with a deliberate reload.', color: 0xba9bff,
    damageMul: 2.6, fireIntervalMul: 2.3, speedMul: 1.9, lifetimeMul: 1.15,
    pellets: 1, spread: 0, knockbackMul: 1.5,
  },
  {
    id: 'repeater', name: 'Arc Repeater', role: 'Rapid fire',
    description: 'A stream of light shells for sustained pressure.', color: 0x92ee77,
    damageMul: 0.48, fireIntervalMul: 0.43, speedMul: 1.15, lifetimeMul: 0.85,
    pellets: 1, spread: 0.018, knockbackMul: 0.45,
  },
];

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
    radius: physicsConfig.projectileRadius,
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
