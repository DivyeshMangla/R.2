import { getWeapon, weaponStats, type WeaponDef, type WeaponId } from '@robot-arena/shared';

/** A robot's hull; a single use at or above this is advertised as a one-shot. */
export const ONE_SHOT_DAMAGE = 125;

type Def = Readonly<WeaponDef>;

/** Reads an optional numeric field that a newer WeaponDef may carry (e.g. a shockwave radius). */
export function extraNumber(def: Def, ...keys: string[]): number {
  const bag = def as unknown as Record<string, unknown>;
  for (const key of keys) {
    const v = bag[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/** Radius of any obviously visual "shockwave"-style field a weapon might grow. */
export function shockwaveRadius(def: Def): number {
  return extraNumber(def, 'shockwaveRadius', 'shockwave', 'shockRadius', 'pulseRadius', 'blastRadius');
}

/** Rough total damage of one use, from whatever fields the def carries. */
export function estimateDamage(def: Def): number {
  let dmg = 0;
  switch (def.kind) {
    case 'projectile':
    case 'lob':
      dmg = weaponStats(def.id).damage * Math.max(1, def.pellets) * Math.max(1, def.burst);
      break;
    case 'melee':
    case 'cone':
      dmg = def.duration > 0 ? def.damage * def.duration : def.damage;
      break;
    case 'deploy':
      dmg = def.damage + (def.zone ? def.zone.dps * def.zone.duration : 0);
      break;
    default:
      dmg = def.damage;
  }
  if (def.status?.dps) dmg += def.status.dps * def.status.duration;
  return Math.max(0, dmg);
}

/** Visual / audio weight: ~1 for an ordinary weapon, up to ~1.8 for huge one-shot cannons. */
export function weaponWeight(weaponId: WeaponId | Def | null | undefined): number {
  if (!weaponId) return 1;
  const def = typeof weaponId === 'string' ? getWeapon(weaponId) : weaponId;
  const size = Number.isFinite(def.sizeMul) && def.sizeMul > 0 ? def.sizeMul : 1.6;
  const w = 0.7 + (size - 1.4) * 0.35 + Math.min(250, estimateDamage(def)) / 330 + (def.explodeRadius > 0 ? 0.12 : 0);
  return Math.max(0.75, Math.min(1.8, w));
}

/** Particle / mesh scale derived from the weapon's model size (sizeMul 1.6 ≈ 1.2). */
export function fxSize(def: Def | null | undefined): number {
  if (!def) return 1;
  const size = Number.isFinite(def.sizeMul) && def.sizeMul > 0 ? def.sizeMul : 1.6;
  return Math.max(0.9, Math.min(2.2, size * 0.75));
}

const KIND_ICON: Record<string, string> = {
  projectile: '➤', lob: '☄', beam: 'ϟ', cone: '♨', melee: '⚔', dash: '≫', pulse: '◎', self: '✚', deploy: '☢',
};

export function weaponIcon(def: Def): string {
  return KIND_ICON[def.kind] ?? '✖';
}

const fmt = (n: number): string => (Math.round(n * 10) / 10).toString();
/** "a 10 m" / "an 8 m" / "an 11 m". */
const article = (n: number): string => (/^(8|11|18)(\D|$)/.test(fmt(n)) ? 'an' : 'a');

/**
 * One-line summary built from the weapon's actual fields, so it stays true
 * whatever the balance pass changes, e.g. "one-shot rocket with an 8 m blast".
 */
export function weaponSummary(def: Def): string {
  const parts: string[] = [];
  const dmg = estimateDamage(def);
  const lead = dmg >= ONE_SHOT_DAMAGE ? 'one-shot' : dmg > 0 ? `${Math.round(dmg)} dmg` : '';
  let noun: string;
  switch (def.kind) {
    case 'projectile':
      noun = def.explodeRadius > 0 ? (def.homing > 0 ? 'homing rocket' : 'rocket')
        : def.pellets > 1 ? `${def.pellets}-pellet spread`
        : def.burst > 1 ? `${def.burst}-shot burst`
        : def.chain > 0 ? 'lightning bolt'
        : extraNumber(def, 'lifesteal') > 0 ? 'leech dart'
        : def.homing > 0 ? 'homing shot' : 'round';
      break;
    case 'lob': noun = 'throw'; break;
    case 'beam': noun = def.range > 0 ? `${fmt(def.range)} m beam` : 'beam'; break;
    case 'cone': noun = `${fmt(def.range)} m flame cone`; break;
    case 'melee': noun = def.duration > 0 ? `${fmt(def.duration)} s shredder` : `${fmt(def.range)} m swing`; break;
    case 'dash': noun = `${fmt(def.range)} m dash`; break;
    case 'pulse': noun = `${fmt(def.range)} m shock pulse`; break;
    case 'self': noun = def.damage > 0 && def.range > 0 ? `${fmt(def.range)} m shockwave` : 'self buff'; break;
    case 'deploy': noun = extraNumber(def, 'triggerRadius') > 0 ? 'proximity bomb' : 'trap'; break;
    default: noun = 'weapon';
  }
  parts.push([lead, noun].filter(Boolean).join(' '));
  const extras: string[] = [];
  const shock = shockwaveRadius(def);
  if (def.explodeRadius > 0) extras.push(`with ${article(def.explodeRadius)} ${fmt(def.explodeRadius)} m blast`);
  else if (def.kind === 'pulse' && def.range > 0 && def.damage > 0) extras.push('that hits everyone around you');
  else if (shock > 0) extras.push(`with ${article(shock)} ${fmt(shock)} m shockwave`);
  if (def.chain > 0) extras.push(`arcs to ${def.chain} more`);
  if (def.pierce > 0) extras.push(`pierces ${def.pierce}`);
  if (def.bounces > 0) extras.push(`ricochets ${def.bounces}×`);
  if (def.teleport) extras.push('blinks you to impact');
  if (extraNumber(def, 'lifesteal') > 0) extras.push('drains their HP into you');
  if (def.launch > 0) extras.push('launches');
  if (def.disarm) extras.push('disarms');
  if (def.status) extras.push(`${def.status.effect} ${fmt(def.status.duration)} s`);
  if (def.zone) extras.push(`leaves ${article(def.zone.radius)} ${fmt(def.zone.radius)} m ${def.zone.kind} pool`);
  if (def.heal > 0) extras.push(`+${def.heal} HP`);
  if (def.shield > 0) extras.push(`+${def.shield} shield`);
  if (def.speedBoost > 1) extras.push('speed rush');
  const tail = extras.slice(0, 3);
  const sep = tail.length && /^(with|that) /.test(tail[0]) ? ' ' : ', ';
  return (tail.length ? `${parts[0]}${sep}${tail.join(', ')}` : parts[0]).replace(/^\w/, (c) => c.toLowerCase());
}
