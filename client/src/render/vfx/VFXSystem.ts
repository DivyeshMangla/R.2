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

export type ImpactSurface = 'metal' | 'wall' | 'ground' | 'robot';

const _u = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);
const FLASH_WARM = new THREE.Color(1, 0.62, 0.3);
const EMP_BLUE = new THREE.Color(0.35, 0.75, 1);
const LEECH_RED = new THREE.Color(1, 0.15, 0.3);
const REPAIR_GREEN = new THREE.Color(0.3, 1, 0.5);
const SPARK_WHITE = new THREE.Color(1, 0.85, 0.6);
const LEVEL_GOLD = new THREE.Color(1, 0.75, 0.25);

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

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, color: THREE.Color): void {
    const s = this.begin(PType.FLASH, pos.x + dir.x * 0.1, pos.y + dir.y * 0.1, pos.z + dir.z * 0.1, dir.x * 2, dir.y * 2, dir.z * 2, 0.07, 0.9);
    s.intensity = 5;
    this.commit();
    for (let i = 0, n = this.n(10); i < n; i++) {
      cone(dir, 0.35, _u);
      const sp = rand(12, 26);
      const p = this.begin(PType.SPARK, pos.x, pos.y, pos.z, _u.x * sp, _u.y * sp, _u.z * sp, rand(0.08, 0.2), rand(0.05, 0.09));
      p.stretch = 0.025;
      p.drag = 6;
      p.gravity = 6;
      this.tint(_c.copy(color).lerp(WHITE, 0.6), 4);
      this.commit();
    }
    for (let i = 0, n = this.n(3); i < n; i++) {
      const sp = rand(1.5, 3);
      const p = this.begin(PType.SMOKE, pos.x, pos.y, pos.z, dir.x * sp, dir.y * sp + 0.6, dir.z * sp, rand(0.4, 0.7), rand(0.35, 0.6));
      p.drag = 2.5;
      p.gravity = -0.6;
      p.rotSpeed = rand(-1, 1);
      this.commit();
    }
    this.lights.flash(pos.x + dir.x * 0.4, pos.y + dir.y * 0.4, pos.z + dir.z * 0.4, FLASH_WARM, 9, 0.08, 8);
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

  /** Layered explosion: flash, fireball + heat haze, shockwave, sparks, embers, smoke column, chunks, scorch. */
  explosion(pos: THREE.Vector3, scale: number, color: THREE.Color): void {
    const t = this.time;
    this.lights.flash(pos.x, pos.y + 1, pos.z, FLASH_WARM, 40 * scale, 0.55, 22, true);
    const f = this.begin(PType.FLASH, pos.x, pos.y + 0.4, pos.z, 0, 0, 0, 0.16, 3.2 * scale);
    f.intensity = 3.5;
    this.commit();
    this.transients.fireball(pos.x, pos.y + 0.5, pos.z, 2.6 * scale, WHITE, t);
    this.transients.ring(pos.x, pos.y + 0.12, pos.z, 9 * scale, _c.copy(color).lerp(FLASH_WARM, 0.5), 3.5, 0.5, t);
    for (let i = 0, n = this.n(70 * scale); i < n; i++) {
      randomUnit(_u);
      _u.y = Math.abs(_u.y) * 0.8 + 0.2;
      const sp = rand(8, 26) * scale;
      const p = this.begin(PType.SPARK, pos.x, pos.y + 0.4, pos.z, _u.x * sp, _u.y * sp, _u.z * sp, rand(0.4, 1.1), rand(0.05, 0.1));
      p.stretch = 0.03;
      p.gravity = 12;
      p.drag = 1.2;
      this.tint(_c.copy(color).lerp(SPARK_WHITE, 0.6), 5);
      this.commit();
    }
    for (let i = 0, n = this.n(24 * scale); i < n; i++) {
      randomUnit(_u);
      const sp = rand(2, 6);
      const p = this.begin(PType.FIRE, pos.x + _u.x * 0.6, pos.y + 0.6 + Math.abs(_u.y) * 0.5, pos.z + _u.z * 0.6, _u.x * sp, Math.abs(_u.y) * sp + 2, _u.z * sp, rand(0.35, 0.7), rand(1.1, 2.0) * scale);
      p.drag = 3;
      p.gravity = -3;
      p.rotSpeed = rand(-2, 2);
      p.intensity = 3;
      this.commit();
    }
    for (let i = 0, n = this.n(30 * scale); i < n; i++) {
      randomUnit(_u);
      const sp = rand(3, 9);
      const p = this.begin(PType.EMBER, pos.x, pos.y + 0.5, pos.z, _u.x * sp, Math.abs(_u.y) * sp + 3, _u.z * sp, rand(1.0, 2.2), rand(0.05, 0.1));
      p.gravity = 5;
      p.drag = 1.2;
      p.intensity = 3;
      this.commit();
    }
    for (let i = 0, n = this.n(22 * scale); i < n; i++) {
      randomUnit(_u);
      const sp = rand(1, 3.5);
      const p = this.begin(PType.SMOKE, pos.x + _u.x * 0.8, pos.y + 0.8, pos.z + _u.z * 0.8, _u.x * sp, rand(1.5, 4.5), _u.z * sp, rand(1.8, 3.4), rand(1.6, 3.0) * scale);
      p.drag = 1.1;
      p.gravity = -0.9;
      p.rotSpeed = rand(-0.6, 0.6);
      this.commit();
    }
    for (let i = 0, n = this.n(14 * scale); i < n; i++) {
      randomUnit(_u);
      const sp = rand(6, 14);
      const p = this.begin(PType.CHUNK, pos.x, pos.y + 0.5, pos.z, _u.x * sp, Math.abs(_u.y) * sp + 4, _u.z * sp, rand(0.9, 1.6), rand(0.08, 0.18));
      p.gravity = 20;
      p.rotSpeed = rand(-14, 14);
      this.commit();
    }
    this.decals.add(_t.set(pos.x, pos.y + 0.02, pos.z), UP, 4.5 * scale, DecalKind.BLAST, t, 30);
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
    for (let i = 0, n = this.n(18); i < n; i++) {
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
  }
}
