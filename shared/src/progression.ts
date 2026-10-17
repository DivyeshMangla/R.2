import { CARDS_PER_OFFER, MAX_LEVEL, RARITY_WEIGHTS, xpToNext } from './constants';
import { POWERUPS, type PowerUpDef, type PowerUpId, type PowerUpStacks, type Rarity } from './powerups';

export interface LevelState {
  level: number;
  xp: number;
}

/** Adds XP and returns how many levels were gained. Mutates `state`. */
export function grantXp(state: LevelState, amount: number): number {
  if (state.level >= MAX_LEVEL) return 0;
  state.xp += amount;
  let gained = 0;
  while (state.level < MAX_LEVEL && state.xp >= xpToNext(state.level)) {
    state.xp -= xpToNext(state.level);
    state.level += 1;
    gained += 1;
  }
  if (state.level >= MAX_LEVEL) state.xp = 0;
  return gained;
}

function pickRarity(rand: () => number, available: ReadonlySet<Rarity>): Rarity | null {
  let total = 0;
  for (const r of available) total += RARITY_WEIGHTS[r];
  if (total <= 0) return null;
  let roll = rand() * total;
  for (const r of available) {
    roll -= RARITY_WEIGHTS[r];
    if (roll <= 0) return r;
  }
  return [...available][available.size - 1] ?? null;
}

/**
 * Draws up to 3 distinct cards: rarity first (60/30/10), then a uniform pick
 * among that rarity's power-ups that are not maxed and not already drawn.
 */
export function drawCards(stacks: PowerUpStacks, rand: () => number = Math.random): PowerUpId[] {
  const pool: PowerUpDef[] = POWERUPS.filter((p) => (stacks[p.id] ?? 0) < p.maxStacks);
  const result: PowerUpId[] = [];
  while (result.length < CARDS_PER_OFFER) {
    const remaining = pool.filter((p) => !result.includes(p.id));
    if (remaining.length === 0) break;
    const rarities = new Set<Rarity>(remaining.map((p) => p.rarity));
    const rarity = pickRarity(rand, rarities);
    if (!rarity) break;
    const candidates = remaining.filter((p) => p.rarity === rarity);
    const choice = candidates[Math.floor(rand() * candidates.length)];
    if (!choice) break;
    result.push(choice.id);
  }
  return result;
}
