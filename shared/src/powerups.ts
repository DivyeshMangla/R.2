import { BASE_HP } from './constants';
import type { Vec3 } from './math';

export type Rarity = 'common' | 'rare' | 'epic';

export type PowerUpId =
  | 'reinforced_plating'
  | 'overclocked_motor'
  | 'rapid_loader'
  | 'heavy_rounds'
  | 'grip_tires'
  | 'field_repair'
  | 'ricochet_rounds'
  | 'twin_barrel'
  | 'leech_core'
  | 'rocket_dash'
  | 'emp_burst'
  | 'magnet_mines';

export type AbilityId = 'dash' | 'emp';

export type PowerUpStacks = Partial<Record<PowerUpId, number>>;

/** Final derived stats for a robot after every power-up modifier has been applied. */
export interface RobotStats {
  maxHp: number;
  speedMul: number;
  engineMul: number;
  fireRateMul: number;
  damageMul: number;
  knockbackMul: number;
  gripMul: number;
  regenPerSec: number;
  regenDelay: number;
  ricochetBounces: number;
  projectileCount: number;
  leechFraction: number;
  minesOnKill: number;
  abilities: AbilityId[];
}

export function baseStats(): RobotStats {
  return {
    maxHp: BASE_HP,
    speedMul: 1,
    engineMul: 1,
    fireRateMul: 1,
    damageMul: 1,
    knockbackMul: 1,
    gripMul: 1,
    regenPerSec: 0,
    regenDelay: 4,
    ricochetBounces: 0,
    projectileCount: 1,
    leechFraction: 0,
    minesOnKill: 0,
    abilities: [],
  };
}

/** Services the authoritative simulation exposes to power-up event hooks. */
export interface PowerUpHookContext {
  readonly selfId: number;
  readonly stats: RobotStats;
  heal(amount: number): void;
  spawnMines(position: Vec3, count: number): void;
}

export interface HitEvent {
  targetId: number;
  damage: number;
  point: Vec3;
}

export interface KillEvent {
  victimId: number;
  position: Vec3;
}

export interface DamagedEvent {
  attackerId: number | null;
  damage: number;
}

export interface PowerUpHooks {
  onHit?(ctx: PowerUpHookContext, e: HitEvent, stacks: number): void;
  onKill?(ctx: PowerUpHookContext, e: KillEvent, stacks: number): void;
  onDamaged?(ctx: PowerUpHookContext, e: DamagedEvent, stacks: number): void;
}

export interface PowerUpDef {
  id: PowerUpId;
  name: string;
  rarity: Rarity;
  description: string;
  /** Short glyph shown on the card and HUD. */
  icon: string;
  maxStacks: number;
  /** Stat modifier, applied once with the current stack count. */
  modify?(stats: RobotStats, stacks: number): void;
  hooks?: PowerUpHooks;
  ability?: AbilityId;
}

export const POWERUPS: readonly PowerUpDef[] = [
  {
    id: 'reinforced_plating',
    name: 'Reinforced Plating',
    rarity: 'common',
    description: '+20% max HP per stack. Adds armor plates.',
    icon: '⛨',
    maxStacks: 5,
    modify: (s, n) => {
      s.maxHp *= 1 + 0.2 * n;
    },
  },
  {
    id: 'overclocked_motor',
    name: 'Overclocked Motor',
    rarity: 'common',
    description: '+12% top speed and engine force per stack.',
    icon: '⚙',
    maxStacks: 4,
    modify: (s, n) => {
      s.speedMul *= 1 + 0.12 * n;
      s.engineMul *= 1 + 0.12 * n;
    },
  },
  {
    id: 'rapid_loader',
    name: 'Rapid Loader',
    rarity: 'common',
    description: '+15% fire rate per stack.',
    icon: '»',
    maxStacks: 5,
    modify: (s, n) => {
      s.fireRateMul *= 1 + 0.15 * n;
    },
  },
  {
    id: 'heavy_rounds',
    name: 'Heavy Rounds',
    rarity: 'common',
    description: '+20% damage and +30% knockback per stack.',
    icon: '●',
    maxStacks: 4,
    modify: (s, n) => {
      s.damageMul *= 1 + 0.2 * n;
      s.knockbackMul *= 1 + 0.3 * n;
    },
  },
  {
    id: 'grip_tires',
    name: 'Grip Tires',
    rarity: 'common',
    description: '+25% traction per stack.',
    icon: '◎',
    maxStacks: 3,
    modify: (s, n) => {
      s.gripMul *= 1 + 0.25 * n;
    },
  },
  {
    id: 'field_repair',
    name: 'Field Repair',
    rarity: 'common',
    description: 'Regenerate 2 HP/s per stack after 4 s out of combat.',
    icon: '✚',
    maxStacks: 3,
    modify: (s, n) => {
      s.regenPerSec += 2 * n;
      s.regenDelay = 4;
    },
  },
  {
    id: 'ricochet_rounds',
    name: 'Ricochet Rounds',
    rarity: 'rare',
    description: 'Projectiles bounce off walls once (per stack).',
    icon: '↯',
    maxStacks: 2,
    modify: (s, n) => {
      s.ricochetBounces += n;
    },
  },
  {
    id: 'twin_barrel',
    name: 'Twin Barrel',
    rarity: 'rare',
    description: 'Fire two projectiles in a tight spread.',
    icon: '‖',
    maxStacks: 1,
    modify: (s) => {
      s.projectileCount = 2;
    },
  },
  {
    id: 'leech_core',
    name: 'Leech Core',
    rarity: 'rare',
    description: 'Heal for 15% of damage dealt per stack.',
    icon: '♥',
    maxStacks: 3,
    modify: (s, n) => {
      s.leechFraction += 0.15 * n;
    },
    hooks: {
      onHit: (ctx, e) => {
        ctx.heal(e.damage * ctx.stats.leechFraction);
      },
    },
  },
  {
    id: 'rocket_dash',
    name: 'Rocket Dash',
    rarity: 'rare',
    description: 'SPACE: violent forward thrust. 6 s cooldown.',
    icon: '➤',
    maxStacks: 1,
    ability: 'dash',
  },
  {
    id: 'emp_burst',
    name: 'EMP Burst',
    rarity: 'epic',
    description: 'SPACE: stun nearby enemies for 1.5 s. 15 s cooldown.',
    icon: 'ϟ',
    maxStacks: 1,
    ability: 'emp',
  },
  {
    id: 'magnet_mines',
    name: 'Magnet Mines',
    rarity: 'epic',
    description: 'Each kill drops 2 homing mines per stack.',
    icon: '✸',
    maxStacks: 3,
    modify: (s, n) => {
      s.minesOnKill += 2 * n;
    },
    hooks: {
      onKill: (ctx, e) => {
        ctx.spawnMines(e.position, ctx.stats.minesOnKill);
      },
    },
  },
];

const POWERUP_MAP = new Map<string, PowerUpDef>(POWERUPS.map((p) => [p.id, p]));

export function getPowerUp(id: string): PowerUpDef | undefined {
  return POWERUP_MAP.get(id);
}

export function isPowerUpId(id: string): id is PowerUpId {
  return POWERUP_MAP.has(id);
}

export function computeStats(stacks: PowerUpStacks): RobotStats {
  const stats = baseStats();
  for (const def of POWERUPS) {
    const n = stacks[def.id] ?? 0;
    if (n <= 0) continue;
    def.modify?.(stats, n);
    if (def.ability && !stats.abilities.includes(def.ability)) stats.abilities.push(def.ability);
  }
  stats.maxHp = Math.round(stats.maxHp);
  return stats;
}

export function forEachHook<K extends keyof PowerUpHooks>(
  stacks: PowerUpStacks,
  hook: K,
  fn: (handler: NonNullable<PowerUpHooks[K]>, stackCount: number) => void,
): void {
  for (const def of POWERUPS) {
    const n = stacks[def.id] ?? 0;
    const h = def.hooks?.[hook];
    if (n > 0 && h) fn(h as NonNullable<PowerUpHooks[K]>, n);
  }
}

export const RARITY_COLORS: Readonly<Record<Rarity, string>> = {
  common: '#9fb4c7',
  rare: '#3fa9ff',
  epic: '#c45bff',
};
