import * as THREE from 'three';
import { DecalKind, DecalSystem, type DecalKindValue } from './DecalSystem';
import { ElectricArcs } from './ElectricArcs';
import { LightPool } from './LightPool';
import { MineRenderer } from './MineRenderer';
import { createCurveTexture, createParticleAtlas, PType, TYPE_DEFS } from './ParticleAtlas';
import { makeParticleSpec, ParticleSystem, type ParticleSpec } from './Particles';
import { ProjectileRenderer } from './ProjectileRenderer';
import { SkidMarks } from './SkidMarks';
import { TransientMeshes } from './TransientMeshes';
import { WeaponFX } from './WeaponFX';
import { ZoneRenderer, type Zone } from './ZoneRenderer';
import type { StatusEffect, ZoneKind } from '@robot-arena/shared';

export type ImpactSurface = 'metal' | 'wall' | 'ground' | 'robot';

const _u = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);
const FLASH_WARM = new THREE.Color(1, 0.62, 0.3);
const EMP_BLUE = new THREE.Color(0.35, 0.75, 1);
const LEECH_RED = new THREE.Color(1, 0.15, 0.3);
const REPAIR_GREEN = new THREE.Color(0.3, 1, 0.5);
const SPARK_WHITE = new THREE.Color(1, 0.85, 0.6);
const LEVEL_GOLD = new THREE.Color(1, 0.75, 0.25);
const FIRE_ORANGE = new THREE.Color(1, 0.45, 0.08);
const TOXIC_YELLOW = new THREE.Color(0.85, 1, 0.1);
const ACID_GREEN = new THREE.Color(0.25, 1, 0.35);
const POISON_GREEN = new THREE.Color(0.45, 1, 0.2);
const SHIELD_CYAN = new THREE.Color(0.35, 0.9, 1.4);
const _w = new THREE.Vector3();
const _w2 = new THREE.Color();

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function randomUnit(out: THREE.Vector3): THREE.Vector3 {
  const u = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return out.set(s * Math.cos(t), u, s * Math.sin(t));
}

/** Random direction inside a cone of half-angle `spread` (radians) around `axis`. */
function cone(axis: THREE.Vector3, spread: number, out: THREE.Vector3): THREE.Vector3 {
  randomUnit(out);
  out.multiplyScalar(Math.sin(spread)).add(_b.copy(axis).multiplyScalar(1)).normalize();
  return out;
}

export interface VFXStats {
  particles: number;
  lights: number;
}

/**
 * Facade over every visual effect system. All entry points take plain vectors,
 * reuse one scratch particle spec and never allocate, so they can be called
 * from per-frame gameplay code. Particle counts scale with `density`
 * (the preset's particleDensity).
 */
export class VFXSystem {
  readonly add: ParticleSystem;
  readonly alpha: ParticleSystem;
  readonly lights: LightPool;
  readonly decals: DecalSystem;
  readonly skids: SkidMarks;
  readonly arcs: ElectricArcs;
  readonly transients: TransientMeshes;
  readonly projectiles: ProjectileRenderer;
  readonly mines: MineRenderer;
  readonly weaponFx: WeaponFX;
  readonly zones: ZoneRenderer;
  readonly particleScene = new THREE.Scene();
  density = 1;
  /** Visual time (s): slowed during hitstop. */
  time = 0;
  private readonly s: ParticleSpec = makeParticleSpec();

  constructor(scene: THREE.Scene, distortionScene: THREE.Scene, maxLights: number, maxDecals: number) {
    const atlas = createParticleAtlas();
    const curves = createCurveTexture();
    this.add = new ParticleSystem(12000, 'add', atlas, curves);
    this.alpha = new ParticleSystem(6000, 'alpha', atlas, curves);
    this.particleScene.name = 'ParticleScene';
    // Alpha (smoke) first, additive sparks on top.
    this.particleScene.add(this.alpha.mesh, this.add.mesh);
    this.lights = new LightPool(scene, maxLights);
    this.decals = new DecalSystem(scene, maxDecals);
    this.skids = new SkidMarks(scene);
    this.arcs = new ElectricArcs(scene);
    this.transients = new TransientMeshes(scene, distortionScene);
    this.projectiles = new ProjectileRenderer(scene, distortionScene);
    this.mines = new MineRenderer(scene);
    this.weaponFx = new WeaponFX(scene);
    this.zones = new ZoneRenderer(scene);
  }

  // ---------------------------------------------------------------- plumbing

  /** Stochastic rounding of `n * density` so low densities still emit occasionally. */
  private n(count: number): number {
    const v = count * this.density;
    const f = Math.floor(v);
    return f + (Math.random() < v - f ? 1 : 0);
  }

  private begin(type: PType, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number): ParticleSpec {
    const s = this.s;
    s.type = type;
    s.x = x; s.y = y; s.z = z;
    s.vx = vx; s.vy = vy; s.vz = vz;
    s.life = life;
    s.size = size;
    s.gravity = 0;
    s.drag = 0;
    s.stretch = 0;
    s.rot = Math.random() * Math.PI * 2;
    s.rotSpeed = 0;
    s.r = s.g = s.b = 1;
    s.intensity = 1;
    return s;
  }

  private commit(): void {
    const s = this.s;
    (TYPE_DEFS[s.type].blend === 'add' ? this.add : this.alpha).emit(s);
  }

  private tint(c: THREE.Color, intensity: number): void {
    const s = this.s;
    s.r = c.r; s.g = c.g; s.b = c.b;
    s.intensity = intensity;
  }

  // ---------------------------------------------------------------- weapons

  /** Muzzle blast; `size` (≈ weapon sizeMul × 0.75) scales the flash, spark spray, smoke and light. */
  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, color: THREE.Color, size = 1): void {
    const k = Math.max(0.6, Math.min(2.4, size));
    const s = this.begin(PType.FLASH, pos.x + dir.x * 0.1 * k, pos.y + dir.y * 0.1 * k, pos.z + dir.z * 0.1 * k, dir.x * 2, dir.y * 2, dir.z * 2, 0.06 + 0.03 * k, 0.9 * k);
    s.intensity = 5;
    this.commit();
    // A second, tinted forward flare pushed out along the barrel.
    const f2 = this.begin(PType.FLASH, pos.x + dir.x * 0.55 * k, pos.y + dir.y * 0.55 * k, pos.z + dir.z * 0.55 * k, dir.x * 6, dir.y * 6, dir.z * 6, 0.08, 0.75 * k);
    f2.intensity = 4;
    f2.r = color.r; f2.g = color.g; f2.b = color.b;
    this.commit();
    for (let i = 0, n = this.n(10 * k); i < n; i++) {
      cone(dir, 0.35, _u);
      const sp = rand(12, 26) * (0.8 + 0.2 * k);
      const p = this.begin(PType.SPARK, pos.x, pos.y, pos.z, _u.x * sp, _u.y * sp, _u.z * sp, rand(0.08, 0.2), rand(0.05, 0.09) * Math.sqrt(k));
      p.stretch = 0.025;
      p.drag = 6;
      p.gravity = 6;
      this.tint(_c.copy(color).lerp(WHITE, 0.6), 4);
      this.commit();
    }
    for (let i = 0, n = this.n(3 * k); i < n; i++) {
      const sp = rand(1.5, 3) * k;
      const p = this.begin(PType.SMOKE, pos.x, pos.y, pos.z, dir.x * sp, dir.y * sp + 0.6, dir.z * sp, rand(0.4, 0.7) * Math.sqrt(k), rand(0.35, 0.6) * k);
      p.drag = 2.5;
      p.gravity = -0.6;
      p.rotSpeed = rand(-1, 1);
      this.commit();
    }
    this.lights.flash(pos.x + dir.x * 0.4, pos.y + dir.y * 0.4, pos.z + dir.z * 0.4, FLASH_WARM, 9 * k, 0.08 + 0.02 * k, 8 * k);
  }

  /** Shell hits a surface or robot. */
  impact(pos: THREE.Vector3, normal: THREE.Vector3, surface: ImpactSurface, color: THREE.Color, strength = 1): void {
    const metal = surface === 'metal' || surface === 'robot';
    const sparks = this.n((metal ? 26 : 12) * strength);
    for (let i = 0; i < sparks; i++) {
      cone(normal, 1.0, _u);
      const sp = rand(5, metal ? 17 : 10);
      const p = this.begin(PType.SPARK, pos.x, pos.y, pos.z, _u.x * sp, _u.y * sp, _u.z * sp, rand(0.2, 0.55), rand(0.04, 0.08));
      p.stretch = 0.03;
      p.gravity = 14;
      p.drag = 1.5;
      this.tint(_c.copy(color).lerp(SPARK_WHITE, 0.55), 4);
      this.commit();
    }
    const flash = this.begin(PType.FLASH, pos.x + normal.x * 0.1, pos.y + normal.y * 0.1, pos.z + normal.z * 0.1, 0, 0, 0, 0.09, 1.1 * strength);
    flash.intensity = 4;
    flash.r = color.r; flash.g = color.g; flash.b = color.b;
    this.commit();
    // Dust puff off walls / floor; dark smoke off metal.
    const puffs = this.n(surface === 'robot' ? 2 : 4);
    for (let i = 0; i < puffs; i++) {
      cone(normal, 0.8, _u);
      const sp = rand(0.6, 2.2);
      const p = this.begin(metal ? PType.SMOKE : PType.DUST, pos.x, pos.y, pos.z, _u.x * sp, _u.y * sp, _u.z * sp, rand(0.6, 1.2), rand(0.4, 0.8));
      p.drag = 2;
      p.gravity = metal ? -0.4 : 0.6;
      p.rotSpeed = rand(-1, 1);
      this.commit();
    }
    if (!metal || surface === 'metal') {
      for (let i = 0, n = this.n(4); i < n; i++) {
        cone(normal, 0.9, _u);
        const sp = rand(3, 7);
        const p = this.begin(PType.CHUNK, pos.x, pos.y, pos.z, _u.x * sp, _u.y * sp + 2, _u.z * sp, rand(0.5, 0.9), rand(0.05, 0.1));
        p.gravity = 16;
        p.rotSpeed = rand(-12, 12);
        this.commit();
      }
    }
    this.lights.flash(pos.x + normal.x * 0.5, pos.y + normal.y * 0.5, pos.z + normal.z * 0.5, _c.copy(color).lerp(WHITE, 0.4), 6 * strength, 0.12, 7);
    if (surface !== 'robot') this.decals.add(pos, normal, rand(0.7, 1.1) * strength, surface === 'metal' ? DecalKind.SPARK : DecalKind.SCORCH, this.time, 24);
  }

  /**
   * Layered explosion: flash, fireball + heat haze, a fast white shock front
   * plus a slower coloured ring, ground dust wave, sparks, embers, a smoke
   * column, tumbling debris and a scorch decal. `scale` ≈ blast radius / 5.5.
   */
  explosion(pos: THREE.Vector3, scale: number, color: THREE.Color): void {
    const t = this.time;
    const s = Math.max(0.4, Math.min(2.6, scale));
    this.lights.flash(pos.x, pos.y + 1, pos.z, FLASH_WARM, 40 * s, 0.45 + 0.15 * s, 22 * s, true);
    this.lights.flash(pos.x, pos.y + 3 * s, pos.z, _c.copy(color).lerp(WHITE, 0.5), 18 * s, 0.25, 16 * s);
    const f = this.begin(PType.FLASH, pos.x, pos.y + 0.4, pos.z, 0, 0, 0, 0.18, 3.4 * s);
    f.intensity = 4;
    this.commit();
    this.transients.fireball(pos.x, pos.y + 0.5, pos.z, 2.6 * s, WHITE, t);
    if (s > 0.9) this.transients.fireball(pos.x, pos.y + 1.4 * s, pos.z, 1.6 * s, FLASH_WARM, t);
    // Shock front races out first; the coloured blast ring follows.
    this.transients.ring(pos.x, pos.y + 0.18, pos.z, 13 * s, WHITE, 5, 0.32, t);
    this.transients.ring(pos.x, pos.y + 0.12, pos.z, 9 * s, _c.copy(color).lerp(FLASH_WARM, 0.5), 4, 0.6, t);
    if (s > 1.1) this.transients.dome(pos.x, pos.y, pos.z, 4.2 * s, _c.copy(color).lerp(FLASH_WARM, 0.6), t);
    for (let i = 0, n = this.n(70 * s); i < n; i++) {
      randomUnit(_u);
      _u.y = Math.abs(_u.y) * 0.8 + 0.2;
      const sp = rand(8, 26) * s;
      const p = this.begin(PType.SPARK, pos.x, pos.y + 0.4, pos.z, _u.x * sp, _u.y * sp, _u.z * sp, rand(0.4, 1.1), rand(0.05, 0.11));
      p.stretch = 0.03;
      p.gravity = 12;
      p.drag = 1.2;
      this.tint(_c.copy(color).lerp(SPARK_WHITE, 0.6), 5);
      this.commit();
    }
    for (let i = 0, n = this.n(26 * s); i < n; i++) {
      randomUnit(_u);
      const sp = rand(2, 6) * Math.sqrt(s);
      const p = this.begin(PType.FIRE, pos.x + _u.x * 0.6 * s, pos.y + 0.6 + Math.abs(_u.y) * 0.5 * s, pos.z + _u.z * 0.6 * s, _u.x * sp, Math.abs(_u.y) * sp + 2, _u.z * sp, rand(0.35, 0.75), rand(1.1, 2.0) * s);
      p.drag = 3;
      p.gravity = -3;
      p.rotSpeed = rand(-2, 2);
      p.intensity = 3;
      this.commit();
    }
    for (let i = 0, n = this.n(30 * s); i < n; i++) {
      randomUnit(_u);
      const sp = rand(3, 9) * Math.sqrt(s);
      const p = this.begin(PType.EMBER, pos.x, pos.y + 0.5, pos.z, _u.x * sp, Math.abs(_u.y) * sp + 3, _u.z * sp, rand(1.0, 2.4), rand(0.05, 0.11));
      p.gravity = 5;
      p.drag = 1.2;
      p.intensity = 3;
      this.commit();
    }
    for (let i = 0, n = this.n(22 * s); i < n; i++) {
      randomUnit(_u);
      const sp = rand(1, 3.5);
      const p = this.begin(PType.SMOKE, pos.x + _u.x * 0.8 * s, pos.y + 0.8, pos.z + _u.z * 0.8 * s, _u.x * sp, rand(1.5, 4.5), _u.z * sp, rand(1.8, 3.6), rand(1.6, 3.0) * s);
      p.drag = 1.1;
      p.gravity = -0.9;
      p.rotSpeed = rand(-0.6, 0.6);
      this.commit();
    }
    // Ground-hugging dust wave that rolls out to the blast radius.
    for (let i = 0, n = this.n(28 * s); i < n; i++) {
      const a = (i / Math.max(1, n)) * Math.PI * 2 + Math.random() * 0.3;
      const sp = rand(8, 14) * s;
      const p = this.begin(PType.DUST, pos.x + Math.cos(a) * 0.8, pos.y + 0.2, pos.z + Math.sin(a) * 0.8, Math.cos(a) * sp, rand(0.3, 1.2), Math.sin(a) * sp, rand(0.8, 1.4), rand(0.9, 1.5) * Math.sqrt(s));
      p.drag = 2.6;
      p.rotSpeed = rand(-1, 1);
      this.commit();
    }
    // Debris: chunks plus long-lived heavy shrapnel.
    for (let i = 0, n = this.n(18 * s); i < n; i++) {
      randomUnit(_u);
      const sp = rand(6, 15) * Math.sqrt(s);
      const p = this.begin(PType.CHUNK, pos.x, pos.y + 0.5, pos.z, _u.x * sp, Math.abs(_u.y) * sp + 5, _u.z * sp, rand(1.0, 1.9), rand(0.09, 0.22) * Math.sqrt(s));
      p.gravity = 20;
      p.rotSpeed = rand(-14, 14);
      this.commit();
    }
    this.decals.add(_t.set(pos.x, pos.y + 0.02, pos.z), UP, 4.5 * s, DecalKind.BLAST, t, 30);
    if (s > 1) this.decals.add(_t.set(pos.x, pos.y + 0.025, pos.z), UP, 2.2 * s, DecalKind.SCORCH, t, 30);
  }

  shockwave(pos: THREE.Vector3, radius: number, color: THREE.Color, life: number): void {
    this.transients.ring(pos.x, pos.y + 0.15, pos.z, radius, color, 3, life, this.time);
  }

  // ---------------------------------------------------------------- abilities

  empBurst(pos: THREE.Vector3, radius: number): void {
    const t = this.time;
    this.transients.dome(pos.x, pos.y, pos.z, radius, EMP_BLUE, t);
    this.transients.ring(pos.x, pos.y + 0.1, pos.z, radius, EMP_BLUE, 4, 0.6, t);
    this.lights.flash(pos.x, pos.y + 1.5, pos.z, EMP_BLUE, 30, 0.5, radius * 1.5, true);
    for (let i = 0, n = this.n(10); i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * rand(0.5, 1);
      this.arcs.bolt(pos.x, pos.y + 0.8, pos.z, pos.x + Math.cos(a) * r, pos.y + rand(0.2, 1.5), pos.z + Math.sin(a) * r, 7, 0.7, EMP_BLUE, 5, t, rand(0.18, 0.35));
    }
    for (let i = 0, n = this.n(40); i < n; i++) {
      randomUnit(_u);
      const sp = rand(6, 16);
      const p = this.begin(PType.ELECTRIC, pos.x, pos.y + 0.8, pos.z, _u.x * sp, Math.abs(_u.y) * sp * 0.4, _u.z * sp, rand(0.25, 0.5), rand(0.2, 0.45));
      p.drag = 3;
      p.intensity = 3;
      this.commit();
    }
  }

  /** Electric arc onto a robot hit by an EMP. */
  empArc(from: THREE.Vector3, to: THREE.Vector3): void {
    this.arcs.bolt(from.x, from.y + 0.8, from.z, to.x, to.y + 0.6, to.z, 10, 0.8, EMP_BLUE, 6, this.time, 0.3);
  }

  stunSparks(pos: THREE.Vector3): void {
    if (Math.random() > 0.35 * this.density) return;
    const a = Math.random() * Math.PI * 2;
    this.arcs.bolt(pos.x + Math.cos(a) * 0.8, pos.y + 0.4, pos.z + Math.sin(a) * 0.8, pos.x - Math.cos(a) * 0.6, pos.y + rand(0.2, 1.0), pos.z - Math.sin(a) * 0.6, 5, 0.25, EMP_BLUE, 4, this.time, 0.08);
  }

  /** Rocket dash: hot thruster plume + speed streaks. */
  dashThrusters(nozzle: THREE.Vector3, back: THREE.Vector3): void {
    for (let i = 0, n = this.n(14); i < n; i++) {
      cone(back, 0.18, _u);
      const sp = rand(10, 22);
      const p = this.begin(PType.THRUSTER, nozzle.x, nozzle.y, nozzle.z, _u.x * sp, _u.y * sp, _u.z * sp, rand(0.15, 0.3), rand(0.35, 0.6));
      p.drag = 4;
      p.intensity = 3;
      this.commit();
    }
    this.lights.flash(nozzle.x, nozzle.y, nozzle.z, FLASH_WARM, 12, 0.25, 9);
  }

  /** Speed streaks rushing past a dashing robot. */
  dashStreaks(pos: THREE.Vector3, back: THREE.Vector3): void {
    for (let i = 0, n = this.n(6); i < n; i++) {
      randomUnit(_u).multiplyScalar(1.4);
      const sp = rand(18, 30);
      const p = this.begin(PType.STREAK, pos.x + _u.x, pos.y + 0.5 + _u.y * 0.5, pos.z + _u.z, back.x * sp, back.y * sp, back.z * sp, 0.18, 0.06);
      p.stretch = 0.03;
      this.commit();
    }
  }

  exhaust(pos: THREE.Vector3, back: THREE.Vector3, hot: boolean): void {
    if (Math.random() > this.density) return;
    const sp = rand(3, 6);
    const p = this.begin(hot ? PType.THRUSTER : PType.SMOKE, pos.x, pos.y, pos.z, back.x * sp, back.y * sp + 0.3, back.z * sp, hot ? 0.18 : 0.6, hot ? 0.3 : 0.3);
    p.drag = 3;
    p.gravity = hot ? 0 : -0.5;
    p.intensity = hot ? 2.5 : 1;
    this.commit();
  }

  leechTether(from: THREE.Vector3, to: THREE.Vector3): void {
    const t = this.time;
    this.arcs.bolt(from.x, from.y + 0.6, from.z, to.x, to.y + 0.7, to.z, 12, 0.35, LEECH_RED, 4, t, 0.35);
    this.arcs.bolt(from.x, from.y + 0.6, from.z, to.x, to.y + 0.7, to.z, 16, 0.7, REPAIR_GREEN, 5, t, 0.5);
    this.lights.flash(to.x, to.y + 1, to.z, REPAIR_GREEN, 14, 0.4, 9);
    for (let i = 0, n = this.n(40); i < n; i++) {
      // Motes flow from the victim to the leech.
      const k = Math.random();
      const x = from.x + (to.x - from.x) * k, y = from.y + 0.6 + (to.y - from.y) * k, z = from.z + (to.z - from.z) * k;
      _u.set(to.x - from.x, to.y - from.y, to.z - from.z).multiplyScalar(-1.6);
      const p = this.begin(PType.LEECH, x, y, z, _u.x, _u.y + rand(-0.5, 0.5), _u.z, rand(0.3, 0.6), rand(0.12, 0.22));
      p.intensity = 3;
      this.commit();
    }
  }

  repairSwirl(pos: THREE.Vector3): void {
    for (let i = 0, n = this.n(3); i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(0.9, 1.4);
      const p = this.begin(PType.NANO, pos.x + Math.cos(a) * r, pos.y + rand(-0.2, 0.6), pos.z + Math.sin(a) * r, -Math.sin(a) * 2.5, rand(0.8, 1.6), Math.cos(a) * 2.5, rand(0.6, 1.0), rand(0.08, 0.14));
      p.intensity = 2.5;
      this.tint(REPAIR_GREEN, 2.5);
      this.commit();
    }
  }

  levelUp(pos: THREE.Vector3, color: THREE.Color): void {
    const t = this.time;
    this.transients.pillar(pos.x, pos.y - 0.6, pos.z, 0.9, 7, _c.copy(color).lerp(LEVEL_GOLD, 0.5), t);
    this.transients.ring(pos.x, pos.y - 0.4, pos.z, 6, LEVEL_GOLD, 3, 0.7, t);
    this.lights.flash(pos.x, pos.y + 2, pos.z, LEVEL_GOLD, 20, 0.8, 14);
    for (let i = 0, n = this.n(40); i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(0.4, 1.4);
      const p = this.begin(PType.GLOW, pos.x + Math.cos(a) * r, pos.y + rand(-0.4, 0.4), pos.z + Math.sin(a) * r, 0, rand(3, 9), 0, rand(0.6, 1.2), rand(0.08, 0.16));
      p.drag = 1;
      this.tint(LEVEL_GOLD, 3);
      this.commit();
    }
  }

  // ---------------------------------------------------------------- single-use arsenal

  /**
   * Hitscan beam: a thick, lingering ray (width scales with `size` ≈ sizeMul × 0.75),
   * a twisting lightning core, flashes at both ends, a shock ring + scorch at the hit.
   */
  beam(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, hitRobot: boolean, size = 1): void {
    const t = this.time;
    const k = Math.max(0.8, Math.min(2.4, size));
    this.weaponFx.beam(from, to, _w2.copy(color).multiplyScalar(2.4), 0.6 * k, 0.32 + 0.08 * k);
    this.weaponFx.beam(from, to, _w2.copy(color).lerp(WHITE, 0.7).multiplyScalar(1.6), 0.2 * k, 0.18);
    this.arcs.bolt(from.x, from.y, from.z, to.x, to.y, to.z, 22, 0.22 * k, color, 4, t, 0.24);
    this.arcs.bolt(from.x, from.y, from.z, to.x, to.y, to.z, 16, 0.4 * k, _c.copy(color).lerp(WHITE, 0.4), 3, t, 0.18);
    _w.subVectors(from, to).normalize();
    const f = this.begin(PType.FLASH, from.x, from.y, from.z, 0, 0, 0, 0.12, 1.6 * k);
    f.intensity = 5;
    f.r = color.r; f.g = color.g; f.b = color.b;
    this.commit();
    const e = this.begin(PType.FLASH, to.x, to.y, to.z, 0, 0, 0, 0.18, (hitRobot ? 3.2 : 2) * k);
    e.intensity = 5;
    e.r = color.r; e.g = color.g; e.b = color.b;
    this.commit();
    for (let i = 0, n = this.n((hitRobot ? 44 : 26) * k); i < n; i++) {
      cone(_w, 1.1, _u);
      const sp = rand(6, 20) * k;
      const p = this.begin(PType.SPARK, to.x, to.y, to.z, _u.x * sp, _u.y * sp, _u.z * sp, rand(0.25, 0.6), rand(0.05, 0.09));
      p.stretch = 0.03;
      p.gravity = 12;
      p.drag = 1.5;
      this.tint(_c.copy(color).lerp(WHITE, 0.5), 5);
      this.commit();
    }
    // Glowing motes left hanging along the beam.
    const len = from.distanceTo(to);
    for (let i = 0, n = this.n(Math.min(70, len * 0.9 * k)); i < n; i++) {
      const q = Math.random();
      randomUnit(_u);
      this.begin(PType.GLOW, from.x + (to.x - from.x) * q, from.y + (to.y - from.y) * q, from.z + (to.z - from.z) * q, _u.x * 0.8, _u.y * 0.8 + 0.3, _u.z * 0.8, rand(0.3, 0.7), rand(0.1, 0.2) * k);
      this.tint(color, 3);
      this.commit();
    }
    this.transients.ring(to.x, to.y, to.z, (hitRobot ? 4.5 : 3) * k, color, 4, 0.35, t);
    if (!hitRobot) this.decals.add(to, _w, 1.4 * k, DecalKind.SCORCH, t, 24);
    this.lights.flash(from.x, from.y, from.z, color, 14 * k, 0.16, 10 * k);
    this.lights.flash(to.x, to.y, to.z, color, (hitRobot ? 24 : 14) * k, 0.24, 12 * k);
  }

  /**
   * Area blast sized by radius `r`. Molotov / acid / toxic splash their liquid
   * across the radius; everything else (rockets, fireworks, proximity mines) gets
   * the full fireball. Toxic adds a fireball too: a barrel going up is violent.
   */
  blast(pos: THREE.Vector3, r: number, color: THREE.Color, style: 'fire' | 'acid' | 'toxic' | 'rocket'): void {
    const t = this.time;
    const radius = Math.max(1, r);
    if (style === 'rocket' || style === 'toxic') this.explosion(pos, Math.max(0.5, Math.min(2.6, radius / 5.5)), color);
    if (style === 'rocket') return;
    const tint = style === 'fire' ? FIRE_ORANGE : style === 'toxic' ? TOXIC_YELLOW : ACID_GREEN;
    const k = Math.max(0.7, Math.min(2.2, radius / 4));
    this.transients.ring(pos.x, pos.y + 0.12, pos.z, radius * 1.4, tint, 4, 0.5, t);
    this.transients.ring(pos.x, pos.y + 0.2, pos.z, radius * 1.9, WHITE, 3, 0.3, t);
    const f = this.begin(PType.FLASH, pos.x, pos.y + 0.4, pos.z, 0, 0, 0, 0.16, 1.6 + radius * 0.5);
    f.intensity = 4;
    if (style !== 'fire') { f.r = tint.r; f.g = tint.g; f.b = tint.b; }
    this.commit();
    if (style === 'fire') this.transients.fireball(pos.x, pos.y + 0.3, pos.z, 1.2 + radius * 0.35, WHITE, t);
    // Glass shards.
    for (let i = 0, n = this.n(22 * k); i < n; i++) {
      randomUnit(_u);
      const sp = rand(4, 11) * k;
      const p = this.begin(PType.SPARK, pos.x, pos.y + 0.3, pos.z, _u.x * sp, Math.abs(_u.y) * sp + 2, _u.z * sp, rand(0.3, 0.7), rand(0.04, 0.08));
      p.stretch = 0.02;
      p.gravity = 16;
      this.tint(_c.copy(tint).lerp(WHITE, 0.6), 3);
      this.commit();
    }
    // Liquid splash: droplets thrown out low across the radius.
    for (let i = 0, n = this.n(Math.min(160, 40 + radius * 8)); i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(0.5, 1.2) * radius * 1.6;
      const type = style === 'fire' ? PType.FIRE : PType.GLOW;
      const p = this.begin(type, pos.x, pos.y + 0.3, pos.z, Math.cos(a) * sp, rand(2, 7), Math.sin(a) * sp, rand(0.35, 0.8), style === 'fire' ? rand(0.7, 1.4) : rand(0.14, 0.28));
      p.gravity = style === 'fire' ? 4 : 14;
      p.drag = 1.6;
      p.rotSpeed = rand(-2, 2);
      if (style !== 'fire') this.tint(tint, 3);
      else p.intensity = 2.5;
      this.commit();
    }
    for (let i = 0, n = this.n(14 * k); i < n; i++) {
      randomUnit(_u);
      const p = this.begin(PType.SMOKE, pos.x + _u.x * k, pos.y + 0.5, pos.z + _u.z * k, _u.x * k, rand(1, 2.8), _u.z * k, rand(1.2, 2.2), rand(1, 1.9) * k);
      p.drag = 1.2;
      p.gravity = -0.6;
      if (style !== 'fire') this.tint(tint, 2.2);
      this.commit();
    }
    this.lights.flash(pos.x, pos.y + 1, pos.z, tint, 30 * k, 0.4, radius * 2.5 + 6, true);
    this.decals.add(_t.set(pos.x, pos.y + 0.02, pos.z), UP, 1.5 + radius * 0.5, DecalKind.SCORCH, t, 30);
  }

  /**
   * Melee swing: a fat bright crescent (plus an inner echo arc) in front of the
   * robot, streaks flung along it and, for heavy weapons, a ground shock ring.
   */
  slash(pos: THREE.Vector3, yaw: number, arc: number, range: number, color: THREE.Color, heavy: boolean, size = 1): void {
    const k = Math.max(0.8, Math.min(2.2, size));
    const reach = range * (0.9 + 0.15 * k);
    this.weaponFx.slash(pos, yaw, arc, reach, _w2.copy(color).lerp(WHITE, 0.35).multiplyScalar(heavy ? 3 : 2.3), heavy ? 0.34 : 0.26, heavy ? -0.35 : 0);
    this.weaponFx.slash(pos, yaw, arc * 0.9, reach * 0.72, _w2.copy(color).lerp(WHITE, 0.7).multiplyScalar(1.8), heavy ? 0.24 : 0.18, heavy ? 0.2 : 0.12);
    const half = Math.max(0.3, arc) / 2;
    for (let i = 0, n = this.n((heavy ? 34 : 22) * k); i < n; i++) {
      const a = yaw + rand(-half, half);
      const r = reach * rand(0.55, 1.05);
      const x = pos.x + Math.sin(a) * r, z = pos.z + Math.cos(a) * r;
      // Tangent direction of the sweep.
      const sp = rand(7, 14) * k;
      const p = this.begin(PType.STREAK, x, pos.y + 0.7 + rand(-0.3, 0.5), z, Math.cos(a) * sp, rand(-0.5, 1), -Math.sin(a) * sp, rand(0.14, 0.26), 0.08 * k);
      p.stretch = 0.03;
      p.drag = 4;
      this.tint(_c.copy(color).lerp(WHITE, 0.5), 3.5);
      this.commit();
    }
    if (heavy) this.transients.ring(pos.x + Math.sin(yaw) * reach * 0.5, pos.y + 0.12, pos.z + Math.cos(yaw) * reach * 0.5, reach * 0.9, color, 3, 0.3, this.time);
    this.lights.flash(pos.x + Math.sin(yaw) * reach * 0.6, pos.y + 1, pos.z + Math.cos(yaw) * reach * 0.6, color, (heavy ? 16 : 9) * k, 0.14, reach * 1.7);
  }

  /**
   * Impact frame for a landed melee / dash / one-shot hit: a blinding flash, a
   * ring punched out along the hit normal, radial streaks and heavy sparks.
   * `power` ≈ damage / 100 (1 = a kill-tier hit).
   */
  impactFrame(pos: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, power: number): void {
    const t = this.time;
    const k = Math.max(0.5, Math.min(2, power));
    const f = this.begin(PType.FLASH, pos.x, pos.y, pos.z, 0, 0, 0, 0.12, 3.4 * k);
    f.intensity = 6;
    this.commit();
    const g = this.begin(PType.FLASH, pos.x, pos.y, pos.z, 0, 0, 0, 0.2, 2.2 * k);
    g.intensity = 4;
    g.r = color.r; g.g = color.g; g.b = color.b;
    this.commit();
    _q.setFromUnitVectors(UP, _b.copy(normal).normalize());
    this.transients.ring(pos.x, pos.y, pos.z, 3.6 * k, _c.copy(color).lerp(WHITE, 0.4), 5, 0.28, t, _q);
    for (let i = 0, n = this.n(26 * k); i < n; i++) {
      randomUnit(_u);
      const sp = rand(14, 28) * k;
      const p = this.begin(PType.STREAK, pos.x, pos.y, pos.z, _u.x * sp, _u.y * sp * 0.6, _u.z * sp, rand(0.1, 0.18), 0.07);
      p.stretch = 0.035;
      p.drag = 5;
      this.tint(_c.copy(color).lerp(WHITE, 0.6), 4);
      this.commit();
    }
    for (let i = 0, n = this.n(30 * k); i < n; i++) {
      cone(normal, 1.0, _u);
      const sp = rand(6, 18) * k;
      const p = this.begin(PType.SPARK, pos.x, pos.y, pos.z, _u.x * sp, _u.y * sp + 2, _u.z * sp, rand(0.3, 0.7), rand(0.05, 0.1));
      p.stretch = 0.03;
      p.gravity = 16;
      p.drag = 1.4;
      this.tint(_c.copy(color).lerp(SPARK_WHITE, 0.5), 5);
      this.commit();
    }
    for (let i = 0, n = this.n(8 * k); i < n; i++) {
      cone(normal, 0.9, _u);
      const sp = rand(5, 10);
      const p = this.begin(PType.CHUNK, pos.x, pos.y, pos.z, _u.x * sp, _u.y * sp + 3, _u.z * sp, rand(0.6, 1.1), rand(0.06, 0.12));
      p.gravity = 18;
      p.rotSpeed = rand(-12, 12);
      this.commit();
    }
    this.lights.flash(pos.x, pos.y + 0.5, pos.z, _c.copy(color).lerp(WHITE, 0.5), 30 * k, 0.16, 12 * k);
  }

  /** Katana dash: a long, thick slash streak from start to end with afterimage streaks. */
  dashSlash(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, size = 1): void {
    const t = this.time;
    const k = Math.max(0.8, Math.min(2.2, size));
    _t.set(from.x, from.y + 0.7, from.z);
    _b.set(to.x, to.y + 0.7, to.z);
    this.weaponFx.beam(_t, _b, _w2.copy(color).lerp(WHITE, 0.4).multiplyScalar(2.4), 0.55 * k, 0.5);
    this.weaponFx.beam(_t, _b, _w2.copy(color).lerp(WHITE, 0.85).multiplyScalar(2), 0.16 * k, 0.3);
    const len = from.distanceTo(to);
    for (let i = 0, n = this.n(Math.min(90, 14 + len * 4 * k)); i < n; i++) {
      const q = Math.random();
      const p = this.begin(PType.STREAK, from.x + (to.x - from.x) * q + rand(-0.9, 0.9), from.y + 0.7 + rand(-0.5, 0.8), from.z + (to.z - from.z) * q + rand(-0.9, 0.9), (to.x - from.x) * 0.6, rand(0, 1), (to.z - from.z) * 0.6, rand(0.2, 0.45), 0.09 * k);
      p.stretch = 0.03;
      p.drag = 5;
      this.tint(_c.copy(color).lerp(WHITE, 0.5), 3.5);
      this.commit();
    }
    this.transients.ring(from.x, from.y + 0.15, from.z, 3 * k, color, 3, 0.3, t);
    this.transients.ring(to.x, to.y + 0.15, to.z, 5 * k, _c.copy(color).lerp(WHITE, 0.3), 4, 0.4, t);
    this.lights.flash(to.x, to.y + 1, to.z, color, 20 * k, 0.25, 12 * k);
  }

  /** Continuous flame cone (call every frame while the torch burns). */
  flameCone(pos: THREE.Vector3, dir: THREE.Vector3, range: number, arc: number, dt: number, size = 1): void {
    const k = Math.max(0.8, Math.min(2, size));
    const half = Math.max(0.1, arc / 2) * 0.75;
    const speed = range / 0.42;
    for (let i = 0, n = this.n(190 * dt * k); i < n; i++) {
      cone(dir, half, _u);
      const sp = speed * rand(0.7, 1.1);
      const p = this.begin(PType.FIRE, pos.x, pos.y, pos.z, _u.x * sp, _u.y * sp, _u.z * sp, rand(0.32, 0.5), rand(0.45, 0.8) * k);
      p.drag = 1.2;
      p.gravity = -3;
      p.rotSpeed = rand(-3, 3);
      p.intensity = 2.8;
      this.commit();
    }
    for (let i = 0, n = this.n(40 * dt * k); i < n; i++) {
      cone(dir, half, _u);
      const sp = speed * rand(0.5, 1);
      const p = this.begin(PType.EMBER, pos.x, pos.y, pos.z, _u.x * sp, _u.y * sp + 1, _u.z * sp, rand(0.5, 0.9), rand(0.04, 0.09));
      p.gravity = 3;
      p.drag = 1;
      p.intensity = 3;
      this.commit();
    }
    for (let i = 0, n = this.n(12 * dt * k); i < n; i++) {
      cone(dir, half, _u);
      const sp = speed * 0.5;
      const p = this.begin(PType.SMOKE, pos.x + dir.x * range * 0.6, pos.y + 0.3, pos.z + dir.z * range * 0.6, _u.x * sp * 0.4, rand(1, 2), _u.z * sp * 0.4, rand(0.8, 1.4), rand(0.9, 1.6) * k);
      p.drag = 1.5;
      p.gravity = -0.8;
      this.commit();
    }
    if (Math.random() < dt * 20) this.lights.flash(pos.x + dir.x * range * 0.4, pos.y + 0.5, pos.z + dir.z * range * 0.4, FIRE_ORANGE, 18 * k, 0.09, range * 1.8, true);
  }

  /** Chainsaw: sparks and smoke spraying off the spinning chain while it runs. */
  sawSparks(pos: THREE.Vector3, dir: THREE.Vector3, dt: number, size = 1): void {
    const k = Math.max(0.8, Math.min(2, size));
    for (let i = 0, n = this.n(100 * dt * k); i < n; i++) {
      cone(dir, 0.6, _u);
      const sp = rand(5, 13) * k;
      const p = this.begin(PType.SPARK, pos.x, pos.y, pos.z, _u.x * sp, Math.abs(_u.y) * sp + 2, _u.z * sp, rand(0.15, 0.4), rand(0.035, 0.07));
      p.stretch = 0.03;
      p.gravity = 14;
      p.intensity = 4;
      this.commit();
    }
    if (Math.random() < dt * 8) {
      const p = this.begin(PType.SMOKE, pos.x, pos.y, pos.z, dir.x, 1.2, dir.z, 0.7, 0.5 * k);
      p.gravity = -0.5;
      this.commit();
    }
    if (Math.random() < dt * 14) this.lights.flash(pos.x, pos.y, pos.z, SPARK_WHITE, 6 * k, 0.06, 5);
  }

  /** Shock pulse: twin lightning rings blasting outwards to `radius`, bolt count scales with the radius. */
  shockRing(pos: THREE.Vector3, radius: number, color: THREE.Color): void {
    const t = this.time;
    const r0 = Math.max(2, radius);
    this.transients.ring(pos.x, pos.y + 0.2, pos.z, r0, color, 6, 0.5, t);
    this.transients.ring(pos.x, pos.y + 0.6, pos.z, r0 * 0.7, WHITE, 4, 0.3, t);
    this.transients.ring(pos.x, pos.y + 0.1, pos.z, r0 * 1.25, color, 2.5, 0.75, t);
    this.transients.dome(pos.x, pos.y, pos.z, r0 * 0.85, color, t);
    this.lights.flash(pos.x, pos.y + 1.2, pos.z, color, 40, 0.45, r0 * 1.8, true);
    const f = this.begin(PType.FLASH, pos.x, pos.y + 0.8, pos.z, 0, 0, 0, 0.18, 2 + r0 * 0.25);
    f.intensity = 5;
    f.r = color.r; f.g = color.g; f.b = color.b;
    this.commit();
    for (let i = 0, n = Math.max(8, this.n(Math.min(28, 8 + r0 * 1.2))); i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.2, 0.2);
      const r = r0 * rand(0.7, 1.05);
      this.arcs.bolt(pos.x, pos.y + 0.8, pos.z, pos.x + Math.cos(a) * r, pos.y + rand(0.1, 1.2), pos.z + Math.sin(a) * r, 10, 0.9, color, 7, t, rand(0.25, 0.45));
    }
    for (let i = 0, n = this.n(Math.min(140, 40 + r0 * 4)); i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(10, 22) * Math.max(1, r0 / 11);
      const p = this.begin(PType.ELECTRIC, pos.x, pos.y + 0.6, pos.z, Math.cos(a) * sp, rand(0, 2), Math.sin(a) * sp, rand(0.25, 0.5), rand(0.25, 0.45));
      p.drag = 3;
      this.tint(_c.copy(color).lerp(WHITE, 0.3), 3);
      this.commit();
    }
  }

  /**
   * Energy shockwave (shield canister burst): no fireball, just a blinding cyan
   * flash, stacked expanding rings, a dome and lightning crawling out to `radius`.
   */
  energyBlast(pos: THREE.Vector3, radius: number, color: THREE.Color): void {
    const t = this.time;
    const r = Math.max(3, radius);
    this.shockRing(pos, r, color);
    this.transients.ring(pos.x, pos.y + 0.3, pos.z, r * 1.5, WHITE, 5, 0.28, t);
    this.transients.ring(pos.x, pos.y + 1.2, pos.z, r * 0.9, _c.copy(color).lerp(WHITE, 0.5), 3, 0.5, t);
    this.transients.dome(pos.x, pos.y, pos.z, r * 0.55, WHITE, t);
    const f = this.begin(PType.FLASH, pos.x, pos.y + 1, pos.z, 0, 0, 0, 0.22, 3 + r * 0.35);
    f.intensity = 6;
    this.commit();
    for (let i = 0, n = this.n(Math.min(120, 30 + r * 5)); i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(14, 26) * Math.max(1, r / 10);
      const p = this.begin(PType.GLOW, pos.x, pos.y + rand(0.3, 1.5), pos.z, Math.cos(a) * sp, rand(-0.5, 1.5), Math.sin(a) * sp, rand(0.3, 0.55), rand(0.12, 0.22));
      p.drag = 2.5;
      this.tint(_c.copy(color).lerp(WHITE, 0.3), 3.5);
      this.commit();
    }
    this.landingDust(pos, 12);
    this.lights.flash(pos.x, pos.y + 2, pos.z, _c.copy(color).lerp(WHITE, 0.4), 50, 0.5, r * 2.2, true);
  }

  /** Heal: a column of green nanite sparkles spiralling up around the robot. */
  healBurst(pos: THREE.Vector3, size = 1): void {
    const t = this.time;
    const k = Math.max(0.8, Math.min(2, size));
    this.transients.pillar(pos.x, pos.y - 0.5, pos.z, 1.3 * k, 5 * k, REPAIR_GREEN, t);
    this.transients.ring(pos.x, pos.y - 0.3, pos.z, 5 * k, REPAIR_GREEN, 3, 0.5, t);
    this.lights.flash(pos.x, pos.y + 1.5, pos.z, REPAIR_GREEN, 22 * k, 0.6, 12 * k);
    for (let i = 0, n = this.n(60 * k); i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(0.6, 1.6) * k;
      const p = this.begin(i % 3 === 0 ? PType.GLOW : PType.NANO, pos.x + Math.cos(a) * r, pos.y + rand(-0.5, 0.5), pos.z + Math.sin(a) * r, -Math.sin(a) * 2.5, rand(2, 6), Math.cos(a) * 2.5, rand(0.6, 1.2), rand(0.08, 0.18));
      p.drag = 1;
      this.tint(REPAIR_GREEN, 3);
      this.commit();
    }
  }

  /** Shield canister cracking open: an expanding dome that settles into the persistent bubble. */
  shieldUp(pos: THREE.Vector3, size = 1): void {
    const t = this.time;
    const k = Math.max(0.8, Math.min(2.2, size));
    this.transients.dome(pos.x, pos.y, pos.z, 4.2 * k, SHIELD_CYAN, t);
    this.transients.ring(pos.x, pos.y + 0.1, pos.z, 6 * k, SHIELD_CYAN, 4, 0.55, t);
    this.transients.ring(pos.x, pos.y + 0.5, pos.z, 3.5 * k, WHITE, 3, 0.3, t);
    this.lights.flash(pos.x, pos.y + 1, pos.z, SHIELD_CYAN, 24 * k, 0.45, 12 * k);
    for (let i = 0, n = this.n(44 * k); i < n; i++) {
      randomUnit(_u);
      this.begin(PType.GLOW, pos.x + _u.x * 3 * k, pos.y + 0.5 + Math.abs(_u.y) * 2 * k, pos.z + _u.z * 3 * k, -_u.x * 4, 0, -_u.z * 4, rand(0.3, 0.55), rand(0.1, 0.16));
      this.tint(SHIELD_CYAN, 2.8);
      this.commit();
    }
  }

  /** Shield shattered: shards of the bubble fly off. */
  shieldBreak(pos: THREE.Vector3): void {
    const t = this.time;
    this.transients.ring(pos.x, pos.y + 0.6, pos.z, 4.5, SHIELD_CYAN, 5, 0.32, t);
    this.lights.flash(pos.x, pos.y + 1, pos.z, SHIELD_CYAN, 18, 0.22, 10);
    for (let i = 0, n = this.n(55); i < n; i++) {
      randomUnit(_u);
      const sp = rand(5, 12);
      const p = this.begin(PType.SPARK, pos.x + _u.x * 2.6, pos.y + 0.5 + _u.y * 1.8, pos.z + _u.z * 2.6, _u.x * sp, Math.abs(_u.y) * sp, _u.z * sp, rand(0.3, 0.7), rand(0.06, 0.11));
      p.stretch = 0.02;
      p.gravity = 14;
      this.tint(SHIELD_CYAN, 3);
      this.commit();
    }
  }

  /** Deployable dropped (toxic barrel): heavy thud with dust ring. */
  deployThud(pos: THREE.Vector3, color: THREE.Color, size = 1): void {
    const k = Math.max(0.8, Math.min(2, size));
    this.landingDust(pos, 14 * k);
    this.transients.ring(pos.x, pos.y + 0.1, pos.z, 4 * k, color, 3, 0.4, this.time);
    this.lights.flash(pos.x, pos.y + 1, pos.z, color, 10 * k, 0.25, 8 * k);
    for (let i = 0, n = this.n(12 * k); i < n; i++) {
      randomUnit(_u);
      const sp = rand(3, 7);
      const p = this.begin(PType.CHUNK, pos.x, pos.y + 0.3, pos.z, _u.x * sp, Math.abs(_u.y) * sp + 2, _u.z * sp, rand(0.5, 0.9), rand(0.05, 0.11));
      p.gravity = 16;
      p.rotSpeed = rand(-10, 10);
      this.commit();
    }
  }

  /** Blink: implosion at `from`, burst at `to`, a thick streak of light between. */
  teleport(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, size = 1): void {
    const t = this.time;
    const k = Math.max(0.8, Math.min(2.2, size));
    _t.set(from.x, from.y + 0.6, from.z);
    _b.set(to.x, to.y + 0.6, to.z);
    this.weaponFx.beam(_t, _b, _w2.copy(color).lerp(WHITE, 0.5).multiplyScalar(2), 0.45 * k, 0.45);
    this.arcs.bolt(from.x, from.y + 0.6, from.z, to.x, to.y + 0.6, to.z, 18, 0.7 * k, color, 5, t, 0.3);
    this.arcs.bolt(from.x, from.y + 0.6, from.z, to.x, to.y + 0.6, to.z, 12, 0.4 * k, WHITE, 3, t, 0.2);
    for (const [p, out] of [[from, -1], [to, 1]] as const) {
      const f = this.begin(PType.FLASH, p.x, p.y + 0.6, p.z, 0, 0, 0, 0.18, 3.2 * k);
      f.intensity = 5;
      f.r = color.r; f.g = color.g; f.b = color.b;
      this.commit();
      this.transients.ring(p.x, p.y + 0.15, p.z, 5 * k, color, 4, 0.4, t);
      this.transients.pillar(p.x, p.y - 0.5, p.z, 1.1 * k, 5 * k, color, t);
      this.lights.flash(p.x, p.y + 1, p.z, color, 22 * k, 0.28, 12 * k);
      for (let i = 0, n = this.n(34 * k); i < n; i++) {
        randomUnit(_u);
        const r = out > 0 ? 0.3 : 2.8 * k;
        const sp = out > 0 ? rand(5, 11) * k : rand(-10, -6) * k;
        const q = this.begin(PType.GLOW, p.x + _u.x * r, p.y + 0.6 + _u.y * r, p.z + _u.z * r, _u.x * sp, _u.y * sp, _u.z * sp, rand(0.2, 0.45), rand(0.09, 0.17));
        q.drag = 2;
        this.tint(color, 3);
        this.commit();
      }
    }
  }

  /** Chain lightning through every point in order: three braided bolts per hop, a flash and ring per node. */
  chain(pts: readonly { x: number; y: number; z: number }[], color: THREE.Color, size = 1): void {
    const t = this.time;
    const k = Math.max(0.8, Math.min(2, size));
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      if (i + 1 < pts.length) {
        const b = pts[i + 1];
        this.arcs.bolt(a.x, a.y + 0.5, a.z, b.x, b.y + 0.5, b.z, 18, 1.3 * k, color, 9, t, 0.45);
        this.arcs.bolt(a.x, a.y + 0.5, a.z, b.x, b.y + 0.5, b.z, 14, 0.9 * k, color, 6, t, 0.35);
        this.arcs.bolt(a.x, a.y + 0.5, a.z, b.x, b.y + 0.5, b.z, 10, 0.5 * k, WHITE, 5, t, 0.25);
      }
      const f = this.begin(PType.FLASH, a.x, a.y + 0.6, a.z, 0, 0, 0, 0.14, 2.2 * k);
      f.intensity = 5;
      f.r = color.r; f.g = color.g; f.b = color.b;
      this.commit();
      if (i > 0) this.transients.ring(a.x, a.y + 0.2, a.z, 3.2 * k, color, 4, 0.3, t);
      this.lights.flash(a.x, a.y + 0.8, a.z, color, 22 * k, 0.3, 11 * k, true);
      for (let q = 0, n = this.n(22 * k); q < n; q++) {
        randomUnit(_u);
        const sp = rand(4, 12) * k;
        const p = this.begin(PType.ELECTRIC, a.x, a.y + 0.5, a.z, _u.x * sp, _u.y * sp, _u.z * sp, rand(0.2, 0.4), rand(0.18, 0.34));
        p.drag = 3;
        this.tint(color, 3);
        this.commit();
      }
    }
  }

  /** One-shot puff the moment a status effect lands on a robot. */
  statusBurst(pos: THREE.Vector3, effect: StatusEffect): void {
    if (effect === 'stun') {
      const t = this.time;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        this.arcs.bolt(pos.x + Math.cos(a) * 1.2, pos.y + 0.3, pos.z + Math.sin(a) * 1.2, pos.x - Math.cos(a) * 0.8, pos.y + rand(0.6, 1.6), pos.z - Math.sin(a) * 0.8, 6, 0.35, EMP_BLUE, 5, t, 0.2);
      }
      this.transients.ring(pos.x, pos.y + 0.3, pos.z, 3, EMP_BLUE, 3, 0.3, t);
      this.lights.flash(pos.x, pos.y + 1, pos.z, EMP_BLUE, 16, 0.25, 8, true);
      return;
    }
    const color = effect === 'burn' ? FIRE_ORANGE : effect === 'poison' ? POISON_GREEN : ACID_GREEN;
    for (let i = 0, n = this.n(18); i < n; i++) {
      randomUnit(_u);
      const sp = rand(1.5, 4);
      const p = this.begin(effect === 'burn' ? PType.FIRE : PType.GLOW, pos.x + _u.x * 0.8, pos.y + 0.6, pos.z + _u.z * 0.8, _u.x * sp, Math.abs(_u.y) * sp + 1, _u.z * sp, rand(0.3, 0.6), effect === 'burn' ? rand(0.4, 0.7) : rand(0.1, 0.18));
      p.drag = 2;
      if (effect === 'burn') p.intensity = 2.5;
      else this.tint(color, 3);
      this.commit();
    }
    this.lights.flash(pos.x, pos.y + 1, pos.z, color, 8, 0.2, 6);
  }

  /** Persistent: robot on fire (call every frame while BURNING). */
  burning(pos: THREE.Vector3, dt: number): void {
    for (let i = 0, n = this.n(40 * dt); i < n; i++) {
      const p = this.begin(PType.FIRE, pos.x + rand(-0.8, 0.8), pos.y + rand(0.2, 0.8), pos.z + rand(-0.9, 0.9), rand(-0.3, 0.3), rand(1.5, 3), rand(-0.3, 0.3), rand(0.3, 0.5), rand(0.35, 0.65));
      p.gravity = -2;
      p.rotSpeed = rand(-2, 2);
      p.intensity = 2.4;
      this.commit();
    }
    for (let i = 0, n = this.n(8 * dt); i < n; i++) {
      const p = this.begin(PType.SMOKE, pos.x + rand(-0.5, 0.5), pos.y + 1, pos.z + rand(-0.5, 0.5), 0, rand(1.2, 2.2), 0, rand(0.9, 1.5), rand(0.5, 0.8));
      p.gravity = -0.6;
      this.commit();
    }
    if (Math.random() < dt * 8) this.lights.flash(pos.x, pos.y + 1, pos.z, FIRE_ORANGE, 6, 0.15, 6, true);
  }

  /** Persistent: poison bubbles rising off the hull. */
  poisoned(pos: THREE.Vector3, dt: number): void {
    for (let i = 0, n = this.n(16 * dt); i < n; i++) {
      this.begin(PType.GLOW, pos.x + rand(-0.8, 0.8), pos.y + rand(0.3, 0.9), pos.z + rand(-0.9, 0.9), rand(-0.2, 0.2), rand(0.6, 1.4), rand(-0.2, 0.2), rand(0.6, 1.1), rand(0.1, 0.2));
      this.tint(POISON_GREEN, 2.5);
      this.commit();
    }
    for (let i = 0, n = this.n(4 * dt); i < n; i++) {
      const p = this.begin(PType.SMOKE, pos.x + rand(-0.5, 0.5), pos.y + 0.8, pos.z + rand(-0.5, 0.5), 0, rand(0.4, 0.9), 0, rand(1, 1.6), rand(0.5, 0.8));
      p.gravity = -0.3;
      this.tint(POISON_GREEN, 2.4);
      this.commit();
    }
  }

  /** Persistent: acid dripping off the chassis while slowed. */
  acidDrip(pos: THREE.Vector3, dt: number): void {
    for (let i = 0, n = this.n(18 * dt); i < n; i++) {
      const p = this.begin(PType.GLOW, pos.x + rand(-0.9, 0.9), pos.y + rand(0.1, 0.5), pos.z + rand(-1, 1), 0, rand(-0.5, 0), 0, rand(0.35, 0.6), rand(0.07, 0.12));
      p.gravity = 9;
      this.tint(ACID_GREEN, 3);
      this.commit();
    }
    if (Math.random() < dt * 3) {
      const p = this.begin(PType.SMOKE, pos.x + rand(-0.5, 0.5), pos.y + 0.2, pos.z + rand(-0.5, 0.5), 0, 0.8, 0, 0.9, 0.5);
      p.gravity = -0.4;
      this.tint(ACID_GREEN, 2);
      this.commit();
    }
  }

  /** Persistent shield bubble around a robot (call every frame while SHIELDED). */
  shieldBubble(id: number, pos: THREE.Vector3, size = 1.3): void {
    this.weaponFx.shield(id, pos, SHIELD_CYAN, size);
  }

  addZone(zid: number, kind: ZoneKind, pos: { x: number; y: number; z: number }, r: number, dur: number): void {
    this.zones.add(zid, kind, pos.x, pos.y, pos.z, r, dur, this.time);
    const color = kind === 'fire' ? FIRE_ORANGE : kind === 'toxic' ? TOXIC_YELLOW : ACID_GREEN;
    const t = this.time;
    this.transients.ring(pos.x, pos.y + 0.1, pos.z, r * 1.15, color, 3.5, 0.6, t);
    this.transients.ring(pos.x, pos.y + 0.2, pos.z, r * 0.7, WHITE, 2, 0.35, t);
    this.lights.flash(pos.x, pos.y + 1.2, pos.z, color, 20, 0.5, r * 2.4, true);
    // Initial gush that fills the whole radius at once.
    for (let i = 0, n = this.n(Math.min(120, 20 + r * 6)); i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(0.4, 1) * r * 1.4;
      const p = this.begin(kind === 'fire' ? PType.FIRE : PType.SMOKE, pos.x, pos.y + 0.3, pos.z, Math.cos(a) * sp, rand(0.5, 2.5), Math.sin(a) * sp, rand(0.5, 1.1), kind === 'fire' ? rand(0.8, 1.5) : rand(1.2, 2.2));
      p.drag = 2.4;
      p.gravity = -0.5;
      p.rotSpeed = rand(-1, 1);
      if (kind === 'fire') p.intensity = 2.6;
      else this.tint(color, 3);
      this.commit();
    }
  }

  private zoneParticles(zone: Zone, dt: number): void {
    const fade = Math.min(1, (zone.until - this.time) / 0.8);
    // Denser than area alone so big hazards read as a solid wall of fire / gas.
    const area = Math.min(400, zone.r * zone.r * 1.7);
    const pick = (): void => {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * zone.r * 0.85;
      _w.set(zone.x + Math.cos(a) * r, zone.y + 0.1, zone.z + Math.sin(a) * r);
    };
    if (zone.kind === 'fire') {
      for (let i = 0, n = this.n(area * 1.6 * dt * fade); i < n; i++) {
        pick();
        const p = this.begin(PType.FIRE, _w.x, _w.y + 0.1, _w.z, rand(-0.3, 0.3), rand(1.5, 3.5), rand(-0.3, 0.3), rand(0.35, 0.7), rand(0.5, 1.1));
        p.gravity = -2;
        p.rotSpeed = rand(-2, 2);
        p.intensity = 2.4;
        this.commit();
      }
      for (let i = 0, n = this.n(area * 0.12 * dt * fade); i < n; i++) {
        pick();
        const p = this.begin(PType.SMOKE, _w.x, _w.y + 1.5, _w.z, 0, rand(1.5, 2.5), 0, rand(1.4, 2.2), rand(1, 1.6));
        p.gravity = -0.5;
        this.commit();
      }
      for (let i = 0, n = this.n(area * 0.25 * dt * fade); i < n; i++) {
        pick();
        const p = this.begin(PType.EMBER, _w.x, _w.y + 0.3, _w.z, rand(-1, 1), rand(2, 5), rand(-1, 1), rand(0.8, 1.6), rand(0.04, 0.08));
        p.gravity = 1.5;
        p.intensity = 3;
        this.commit();
      }
      if (Math.random() < dt * 10) this.lights.flash(zone.x, zone.y + 1.2, zone.z, FIRE_ORANGE, 12 * fade, 0.18, zone.r * 2.2, true);
    } else if (zone.kind === 'toxic') {
      for (let i = 0, n = this.n(area * 0.22 * dt * fade); i < n; i++) {
        pick();
        const p = this.begin(PType.SMOKE, _w.x, _w.y + 0.4, _w.z, rand(-0.4, 0.4), rand(0.3, 0.8), rand(-0.4, 0.4), rand(2, 3.2), rand(1.6, 2.8));
        p.drag = 0.6;
        p.gravity = -0.15;
        p.rotSpeed = rand(-0.5, 0.5);
        this.tint(TOXIC_YELLOW, 3.2);
        this.commit();
      }
      for (let i = 0, n = this.n(area * 0.3 * dt * fade); i < n; i++) {
        pick();
        this.begin(PType.GLOW, _w.x, _w.y, _w.z, 0, rand(0.5, 1.5), 0, rand(0.5, 1), rand(0.1, 0.22));
        this.tint(TOXIC_YELLOW, 2.5);
        this.commit();
      }
      if (Math.random() < dt * 2) this.lights.flash(zone.x, zone.y + 1, zone.z, TOXIC_YELLOW, 6 * fade, 0.6, zone.r * 2);
    } else {
      for (let i = 0, n = this.n(area * 0.35 * dt * fade); i < n; i++) {
        pick();
        this.begin(PType.GLOW, _w.x, _w.y, _w.z, 0, rand(0.3, 1), 0, rand(0.3, 0.6), rand(0.08, 0.18));
        this.tint(ACID_GREEN, 3);
        this.commit();
      }
      for (let i = 0, n = this.n(area * 0.05 * dt * fade); i < n; i++) {
        pick();
        const p = this.begin(PType.SMOKE, _w.x, _w.y + 0.2, _w.z, 0, rand(0.6, 1.2), 0, rand(1, 1.6), rand(0.6, 1));
        p.gravity = -0.3;
        this.tint(ACID_GREEN, 1.8);
        this.commit();
      }
    }
  }

  // ---------------------------------------------------------------- driving

  /** Tyre smoke from a sliding wheel. `amount` ~0..1. */
  tireSmoke(pos: THREE.Vector3, vel: THREE.Vector3, amount: number): void {
    if (Math.random() > amount * this.density) return;
    const p = this.begin(PType.TIRE_SMOKE, pos.x, pos.y + 0.15, pos.z, vel.x * 0.2 + rand(-0.4, 0.4), rand(0.4, 1.1), vel.z * 0.2 + rand(-0.4, 0.4), rand(1.0, 1.8), rand(0.7, 1.2));
    p.drag = 1.5;
    p.gravity = -0.4;
    p.rotSpeed = rand(-0.8, 0.8);
    this.commit();
  }

  dust(pos: THREE.Vector3, vel: THREE.Vector3, amount: number): void {
    if (Math.random() > amount * this.density) return;
    const p = this.begin(PType.DUST, pos.x, pos.y + 0.1, pos.z, vel.x * 0.15 + rand(-0.6, 0.6), rand(0.3, 1.0), vel.z * 0.15 + rand(-0.6, 0.6), rand(0.7, 1.3), rand(0.5, 0.9));
    p.drag = 2;
    p.gravity = 0.4;
    this.commit();
  }

  landingDust(pos: THREE.Vector3, strength: number): void {
    const k = Math.min(1.5, strength / 8);
    for (let i = 0, n = this.n(16 * k); i < n; i++) {
      const a = (i / Math.max(1, n)) * Math.PI * 2 + Math.random() * 0.4;
      const sp = rand(3, 6) * k;
      const p = this.begin(PType.DUST, pos.x + Math.cos(a) * 0.9, pos.y + 0.1, pos.z + Math.sin(a) * 0.9, Math.cos(a) * sp, rand(0.2, 0.8), Math.sin(a) * sp, rand(0.6, 1.1), rand(0.6, 1.0));
      p.drag = 3;
      this.commit();
    }
  }

  // ---------------------------------------------------------------- damage & ambience

  damageSparks(pos: THREE.Vector3, normal: THREE.Vector3): void {
    for (let i = 0, n = this.n(6); i < n; i++) {
      cone(normal, 0.7, _u);
      const sp = rand(3, 8);
      const p = this.begin(PType.SPARK, pos.x, pos.y, pos.z, _u.x * sp, _u.y * sp, _u.z * sp, rand(0.2, 0.45), rand(0.03, 0.06));
      p.stretch = 0.03;
      p.gravity = 12;
      p.intensity = 4;
      this.commit();
    }
    this.lights.flash(pos.x, pos.y, pos.z, SPARK_WHITE, 3, 0.07, 4);
  }

  damageSmoke(pos: THREE.Vector3, heavy: boolean): void {
    if (Math.random() > this.density) return;
    const p = this.begin(PType.SMOKE, pos.x, pos.y, pos.z, rand(-0.3, 0.3), rand(1.0, 2.0), rand(-0.3, 0.3), rand(1.0, 2.0), heavy ? rand(0.6, 1.0) : rand(0.35, 0.6));
    p.drag = 0.8;
    p.gravity = -0.5;
    p.rotSpeed = rand(-0.6, 0.6);
    if (heavy && Math.random() < 0.35) {
      this.commit();
      const f = this.begin(PType.FIRE, pos.x, pos.y, pos.z, 0, rand(0.8, 1.6), 0, rand(0.25, 0.45), rand(0.3, 0.5));
      f.intensity = 2.5;
    }
    this.commit();
  }

  debrisSmoke(pos: THREE.Vector3): void {
    if (Math.random() > 0.3 * this.density) return;
    const p = this.begin(PType.SMOKE, pos.x, pos.y, pos.z, 0, rand(0.4, 1.0), 0, rand(0.8, 1.4), rand(0.3, 0.5));
    p.gravity = -0.3;
    this.commit();
  }

  /** Ambient sparks off a frayed arena cable. */
  cableSparks(pos: THREE.Vector3): void {
    for (let i = 0, n = this.n(8); i < n; i++) {
      randomUnit(_u);
      const sp = rand(2, 5);
      const p = this.begin(PType.SPARK, pos.x, pos.y, pos.z, _u.x * sp, Math.abs(_u.y) * sp, _u.z * sp, rand(0.3, 0.7), rand(0.03, 0.05));
      p.stretch = 0.03;
      p.gravity = 12;
      p.intensity = 4;
      this.commit();
    }
    this.lights.flash(pos.x, pos.y, pos.z, SPARK_WHITE, 4, 0.1, 6, true);
  }

  decal(pos: THREE.Vector3, normal: THREE.Vector3, size: number, kind: DecalKindValue): void {
    this.decals.add(pos, normal, size, kind, this.time, 24);
  }

  // ---------------------------------------------------------------- frame

  update(dt: number, camera: THREE.Vector3): void {
    this.time += dt;
    const t = this.time;
    this.add.flush(t);
    this.alpha.flush(t);
    this.lights.update(dt, camera);
    this.decals.update(t);
    this.skids.update(t);
    this.arcs.update(t);
    this.transients.update(t);
    this.weaponFx.update(t);
    this.zones.update(t);
    for (const zone of this.zones.zones) this.zoneParticles(zone, dt);
  }

  stats(out: VFXStats, countParticles: boolean): VFXStats {
    out.particles = countParticles ? this.add.countAlive() + this.alpha.countAlive() : 0;
    out.lights = this.lights.activeCount;
    return out;
  }

  clearTransient(): void {
    this.add.clear();
    this.alpha.clear();
    this.lights.clear();
    this.decals.clear();
    this.skids.clear();
    this.arcs.clear();
    this.transients.clear();
    this.weaponFx.clear();
    this.zones.clear();
  }
}
