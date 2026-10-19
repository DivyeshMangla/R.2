/**
 * Lethality regression: every single-use weapon must kill one robot in one use.
 * For each of the 29 weapons a fresh GameSimulation puts a shooter and an idle
 * target with 125 max HP (more than 100 base HP + one reinforced_plating stack)
 * in an open lane, fires the weapon once through the real input path and ticks
 * until the target dies. Prints results without writing files.
 */
import assert from 'node:assert/strict';
import {
  aimAnglesFrom,
  Buttons,
  computeStats,
  emptyInput,
  FIXED_DT,
  getTurretPivot,
  initPhysics,
  makeAimSolution,
  ROBOT_HITBOX_CENTER,
  rotateVec,
  WEAPONS,
  type Vec3,
  type WeaponId,
} from '@robot-arena/shared';
import { GameSimulation, type NetSink } from '../game/GameSimulation';
import type { ServerRobot } from '../game/ServerRobot';

const quietNet: NetSink = { broadcast: () => undefined, send: () => undefined };
const TARGET_HP = 125;
/** Open, flat lane on the default map (foundry): shooter and target sit on x = LANE_X. */
const LANE_X = -35;
const TARGET_Z = 5;
/** Ticks allowed after the trigger pull (sustained uses, DoT, zones, slow rockets). */
const MAX_SECONDS = 8;

interface Setup {
  /** Centre-to-centre distance from the shooter to the target. */
  range: number;
  /** Shooter faces away from the target (deployables drop behind the user). */
  facingAway?: boolean;
}

/** Engagement distance per weapon: close for melee / spreads, long for snipers. */
const SETUPS: Record<WeaponId, Setup> = {
  torch: { range: 6 }, ray_gun: { range: 35 }, taser: { range: 6 }, syringe: { range: 15 }, knuckles: { range: 4.5 },
  cleaver: { range: 12 }, fire_axe: { range: 4.5 }, darts: { range: 8 }, shield_canister: { range: 6 }, toxic_barrel: { range: 7, facingAway: true },
  spiked_bat: { range: 4.5 }, crowbar: { range: 4.5 }, molotov: { range: 7 }, katana: { range: 10 }, acid_vial: { range: 7 },
  flintlock: { range: 20 }, tesla_gun: { range: 20 }, revolver: { range: 15 }, stun_pistol: { range: 20 }, crossbow: { range: 25 },
  blunderbuss: { range: 5 }, twin_cannon: { range: 15 }, firework: { range: 15 }, storm_kunai: { range: 15 }, compound_bow: { range: 35 },
  rpg: { range: 20 }, chainsaw: { range: 3.5 }, shotgun: { range: 5 }, pistol: { range: 20 },
};

function advance(game: GameSimulation, seconds: number): void {
  for (let i = 0; i < Math.ceil(seconds / FIXED_DT); i++) game.update(FIXED_DT * 1000 + 1e-7);
}

function disableBots(game: GameSimulation): void {
  for (const robot of game.robots()) {
    if (!robot.isBot) continue;
    robot.alive = false;
    robot.respawnTimer = 1e9;
    robot.controller.setEnabled(false);
    robot.controller.teleport({ x: 80, y: -50, z: 80 }, 0);
  }
}

function center(r: ServerRobot): Vec3 {
  const p = r.position();
  const o = rotateVec(r.controller.body.rotation(), ROBOT_HITBOX_CENTER);
  return { x: p.x + o.x, y: p.y + o.y, z: p.z + o.z };
}

interface Result {
  id: WeaponId; range: number; dealt: number; ttk: number; killed: boolean; healed: number;
  /** Damage split of the use: direct hit / DoT (burn, poison) / hazard zone. */
  direct: number; dot: number; zone: number;
}

/**
 * `hp` = target HP for the trial. With a huge HP pool the run measures the whole
 * use instead (window `seconds`) so the report can show damage per use.
 */
function trial(id: WeaponId, hp = TARGET_HP, seconds = MAX_SECONDS): Result {
  const setup = SETUPS[id];
  const game = new GameSimulation(quietNet);
  try {
    const shooter = game.addHuman('shooter', 'Shooter', 'striker');
    const target = game.addHuman('target', 'Target', 'bulwark');
    disableBots(game);
    const shooterZ = TARGET_Z - setup.range;
    // Facing away: the shooter looks down -z so its deployable lands between it and the target.
    shooter.controller.teleport({ x: LANE_X, y: 1, z: shooterZ }, setup.facingAway ? Math.PI : 0);
    target.controller.teleport({ x: LANE_X, y: 1, z: TARGET_Z }, Math.PI);
    shooter.protectTimer = 0;
    target.protectTimer = 0;
    advance(game, 1);
    target.protectTimer = 0;
    shooter.protectTimer = 0;
    target.stats = { ...target.stats, maxHp: hp };
    target.hp = hp;
    shooter.hp = 40;
    assert.ok(game.physics.lineOfSight(center(shooter), center(target)), `${id}: lane must be open`);

    let dealt = 0;
    const split = { direct: 0, dot: 0, zone: 0 };
    const applyDamage = game.applyDamage.bind(game);
    game.applyDamage = (victim, amount, attacker, cause, point) => {
      if (victim === target && victim.alive && victim.protectTimer <= 0) {
        const landed = Math.min(amount, victim.hp + victim.shield);
        dealt += landed;
        split[cause === 'zone' ? 'zone' : cause === 'burn' || cause === 'poison' ? 'dot' : 'direct'] += landed;
      }
      return applyDamage(victim, amount, attacker, cause, point);
    };

    const aim = setup.facingAway
      ? { yaw: Math.PI, pitch: 0 }
      : aimAnglesFrom(getTurretPivot(shooter.position(), shooter.controller.body.rotation(), { x: 0, y: 0, z: 0 }), center(target), makeAimSolution());
    shooter.weaponId = id;
    shooter.fireCooldown = 0;
    const deathsBefore = target.deaths;
    const hpBefore = shooter.hp;
    let seq = 1;
    game.queueInput('shooter', { ...emptyInput(seq++), aimYaw: aim.yaw, aimPitch: aim.pitch, buttons: Buttons.FIRE });
    advance(game, FIXED_DT * 2);
    assert.equal(shooter.weaponId, null, `${id}: one trigger pull spends the weapon`);
    // Hold the aim (no fire) so sustained uses keep facing the target.
    game.queueInput('shooter', { ...emptyInput(seq++), aimYaw: aim.yaw, aimPitch: aim.pitch });
    let t = FIXED_DT * 2;
    while (t < seconds && target.deaths === deathsBefore) {
      advance(game, FIXED_DT);
      t += FIXED_DT;
    }
    return { id, range: setup.range, dealt, ttk: t, killed: target.deaths > deathsBefore, healed: Math.max(0, shooter.hp - hpBefore), ...split };
  } finally { game.dispose(); }
}

async function main(): Promise<void> {
  await initPhysics();
  const plated = computeStats({ reinforced_plating: 1 }).maxHp;
  assert.ok(plated <= TARGET_HP, `One plating stack (${plated} HP) must not exceed the ${TARGET_HP} HP lethality bar`);
  assert.equal(WEAPONS.length, 29);
  const failures: string[] = [];
  for (const weapon of WEAPONS) {
    const r = trial(weapon.id);
    const line = `${r.killed ? 'PASS' : 'FAIL'} ${weapon.id.padEnd(16)} ${weapon.kind.padEnd(10)} at ${String(r.range).padStart(4)}m  dealt ${r.dealt.toFixed(0).padStart(4)}  ${r.killed ? `killed in ${r.ttk.toFixed(2)}s` : 'target survived'}${r.healed > 0 ? `  (healed shooter +${r.healed.toFixed(0)})` : ''}`;
    console.log(line);
    if (!r.killed) failures.push(weapon.id);
  }
  // Damage budget of one full use against one idle target (zones count at most 2s of standing in them).
  console.log('\nDamage per use vs one target (direct + DoT + zone<=2s):');
  for (const weapon of WEAPONS) {
    const r = trial(weapon.id, 1e5, 6);
    const zone = Math.min(r.zone, (weapon.zone?.dps ?? 0) * 2);
    const total = r.direct + r.dot + zone;
    console.log(`  ${weapon.id.padEnd(16)} total ${total.toFixed(0).padStart(4)}  = direct ${r.direct.toFixed(0).padStart(4)} + DoT ${r.dot.toFixed(0).padStart(3)} + zone ${zone.toFixed(0).padStart(3)}`);
    if (total < TARGET_HP) failures.push(`${weapon.id} (budget ${total.toFixed(0)})`);
  }
  // The syringe leech dart must refill its user by what it drained.
  const leech = trial('syringe');
  assert.ok(leech.healed >= 50, 'Syringe leech dart must heal the shooter');
  assert.deepEqual(failures, [], `Weapons that failed to kill a ${TARGET_HP} HP robot in one use: ${failures.join(', ')}`);
  console.log(`LETHALITY HARNESS: PASS (all ${WEAPONS.length} weapons kill a ${TARGET_HP} HP robot in one use)`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
