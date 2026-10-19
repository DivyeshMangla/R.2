import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getWeapon, type WeaponId } from '@robot-arena/shared';

/**
 * Stylized low-poly weapon models built from primitives, in the chunky,
 * saturated "Puzzle Raiders" vibe. Every model is two merged, vertex-coloured
 * geometries: a lit `body` and an emissive `glow` (flames, liquids, energy).
 *
 * Model space: +Z is the business end (muzzle / blade tip), +Y is up, and the
 * model spans roughly z ∈ [-0.5, 0.5] (about 1 m long), centred on the origin.
 * Geometries are cached and shared: never dispose them.
 */

export interface WeaponGeometry {
  body: THREE.BufferGeometry;
  /** Emissive parts (null when the weapon has nothing glowing). */
  glow: THREE.BufferGeometry | null;
}

/** Glow vertex colours are baked at this fraction; glow materials multiply them back up to HDR. */
export const GLOW_BAKE = 0.5;

type V3 = readonly [number, number, number];
const O: V3 = [0, 0, 0];

const WOOD = 0xa0663a;
const WOOD_D = 0x6e4224;
const STEEL = 0xbac4ce;
const STEEL_D = 0x5f6873;
const DARK = 0x2e3238;
const BLACK = 0x1d1e23;
const TAPE = 0xeadfc2;
const GOLD = 0xf2c14e;
const COPPER = 0xd8793a;
const WHITE = 0xf4f1ea;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

// ------------------------------------------------------------ primitives (Z = forward)

/** Cylinder along Z: `rBack` at -z, `rFront` at +z. */
const rod = (rBack: number, rFront: number, len: number, seg = 10, open = false): THREE.BufferGeometry =>
  new THREE.CylinderGeometry(rFront, rBack, len, seg, 1, open).rotateX(Math.PI / 2);
/** Partial cylinder shell along Z (for windows / stripes). */
const arcRod = (r: number, len: number, start: number, arc: number, seg = 8): THREE.BufferGeometry =>
  new THREE.CylinderGeometry(r, r, len, seg, 1, true, start, arc).rotateX(Math.PI / 2);
/** Cylinder along Y (upright discs, pulleys...). */
const disc = (r: number, h: number, seg = 10): THREE.BufferGeometry => new THREE.CylinderGeometry(r, r, h, seg);
const sector = (r: number, h: number, start: number, arc: number): THREE.BufferGeometry => new THREE.CylinderGeometry(r, r, h, 6, 1, false, start, arc);
const box = (w: number, h: number, d: number): THREE.BufferGeometry => new THREE.BoxGeometry(w, h, d);
const ball = (r: number, w = 10, h = 7): THREE.BufferGeometry => new THREE.SphereGeometry(r, w, h);
/** Cone pointing +Z. */
const coneZ = (r: number, h: number, seg = 10): THREE.BufferGeometry => new THREE.ConeGeometry(r, h, seg).rotateX(Math.PI / 2);
/** Cone pointing +Y. */
const coneY = (r: number, h: number, seg = 6): THREE.BufferGeometry => new THREE.ConeGeometry(r, h, seg);
/** Ring in the XY plane (axis Z), so it wraps rods along Z. */
const ring = (r: number, tube: number, arc = Math.PI * 2, tubular = 14): THREE.BufferGeometry => new THREE.TorusGeometry(r, tube, 6, tubular, arc);
/** Lathe profile (x = radius, y = position along the axis) revolved about Z. */
const lathe = (profile: readonly [number, number][], seg = 10): THREE.BufferGeometry =>
  new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), seg).rotateX(Math.PI / 2);
const diamond = (r: number): THREE.BufferGeometry => new THREE.OctahedronGeometry(r, 0);

class Kit {
  readonly body: THREE.BufferGeometry[] = [];
  readonly glow: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, color: number, pos: V3 = O, rot: V3 = O, scale: V3 = [1, 1, 1]): this {
    this.body.push(prepare(geo, color, 1, pos, rot, scale));
    return this;
  }

  lit(geo: THREE.BufferGeometry, color: number, pos: V3 = O, rot: V3 = O, scale: V3 = [1, 1, 1]): this {
    this.glow.push(prepare(geo, color, GLOW_BAKE, pos, rot, scale));
    return this;
  }

  /** Jagged lightning bolt (glowing) from a to b with `kinks` zig-zags. */
  bolt(a: V3, b: V3, kinks: number, amp: number, color: number, thick = 0.022, seed = 1): this {
    let prev = new THREE.Vector3(...a);
    const end = new THREE.Vector3(...b);
    const side = new THREE.Vector3().subVectors(end, prev).cross(new THREE.Vector3(0.3, 1, 0.2)).normalize();
    for (let i = 1; i <= kinks + 1; i++) {
      const t = i / (kinks + 1);
      const next = new THREE.Vector3().lerpVectors(new THREE.Vector3(...a), end, t);
      if (i <= kinks) next.addScaledVector(side, (i % 2 === 0 ? -1 : 1) * amp * (0.7 + 0.3 * Math.sin(seed * 7 + i * 3)));
      const len = prev.distanceTo(next);
      const mid = new THREE.Vector3().addVectors(prev, next).multiplyScalar(0.5);
      const g = box(thick, thick, len + thick);
      _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3().subVectors(next, prev).normalize());
      _m.compose(mid, _q, _s.set(1, 1, 1));
      this.glow.push(prepare(g.applyMatrix4(_m), color, GLOW_BAKE, O, O, [1, 1, 1]));
      prev = next;
    }
    return this;
  }

  build(): WeaponGeometry {
    const body = mergeAll(this.body) ?? new THREE.BufferGeometry();
    const glow = mergeAll(this.glow);
    return { body, glow };
  }
}

function prepare(geo: THREE.BufferGeometry, color: number, intensity: number, pos: V3, rot: V3, scale: V3): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
  _m.compose(_p.set(pos[0], pos[1], pos[2]), _q, _s.set(scale[0], scale[1], scale[2]));
  g.applyMatrix4(_m);
  _c.setHex(color).multiplyScalar(intensity);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = _c.r;
    col[i * 3 + 1] = _c.g;
    col[i * 3 + 2] = _c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geos.length === 0) return null;
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) throw new Error('Weapon geometry merge failed');
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  merged.userData.shared = true;
  return merged;
}

// ------------------------------------------------------------ the arsenal

/** Thin cheap band around a rod along Z (8-sided, ~32 triangles). */
const band = (r: number, len = 0.035): THREE.BufferGeometry => rod(r, r, len, 8);

const BUILDERS: Record<WeaponId, (k: Kit) => void> = {
  torch(k) {
    k.add(rod(0.05, 0.066, 0.62, 8), WOOD, [0, 0, -0.17])
      .add(rod(0.08, 0.08, 0.07, 10), WOOD_D, [0, 0, -0.47])
      .add(coneZ(0.06, 0.06, 8), STEEL_D, [0, 0, -0.53], [Math.PI, 0, 0]);
    for (const z of [-0.36, -0.26, -0.16, -0.06]) k.add(band(0.068, 0.035), z === -0.36 || z === -0.06 ? STEEL_D : TAPE, [0, 0, z]);
    // Iron brazier cup with prongs holding the fire.
    k.add(rod(0.07, 0.14, 0.17, 10), STEEL_D, [0, 0, 0.12])
      .add(ring(0.135, 0.022, Math.PI * 2, 12), COPPER, [0, 0, 0.2]);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      k.add(coneZ(0.025, 0.16, 5), STEEL_D, [Math.cos(a) * 0.13, Math.sin(a) * 0.13, 0.29], [-Math.sin(a) * 0.35, Math.cos(a) * 0.35, 0]);
    }
    // Roaring flame: outer tongue, hot core, side licks and embers.
    k.lit(ball(0.17, 10, 7), 0xff6a10, [0, 0.02, 0.27])
      .lit(coneZ(0.16, 0.36, 10), 0xff7a1a, [0, 0.04, 0.44])
      .lit(coneZ(0.08, 0.26, 6), 0xff5a10, [0.11, 0.06, 0.38], [0.15, 0.55, 0])
      .lit(coneZ(0.08, 0.26, 6), 0xff5a10, [-0.11, 0.06, 0.38], [0.15, -0.55, 0])
      .lit(coneZ(0.07, 0.22, 6), 0xff4a10, [0, 0.14, 0.36], [-0.5, 0, 0])
      .lit(ball(0.11, 8, 6), 0xffe070, [0, 0.06, 0.29])
      .lit(coneZ(0.06, 0.2, 6), 0xfff0b0, [0, 0.07, 0.42]);
    for (const [x, y, z] of [[0.08, 0.2, 0.5], [-0.1, 0.16, 0.56], [0.02, 0.26, 0.42]] as const) k.lit(diamond(0.025), 0xffb040, [x, y, z]);
  },
  ray_gun(k) {
    const teal = 0x2ec4b6;
    const tealD = 0x1d8a80;
    k.add(ball(0.19, 12, 8), teal, [0, 0.03, -0.17], O, [1, 0.95, 1.35])
      .add(rod(0.13, 0.08, 0.38, 12), teal, [0, 0.03, 0.13])
      .add(rod(0.09, 0.12, 0.07, 12), STEEL, [0, 0.03, 0.34])
      .add(box(0.05, 0.2, 0.26), teal, [0, 0.25, -0.2], [0.25, 0, 0])
      .add(box(0.3, 0.04, 0.16), tealD, [0, 0.03, -0.32], [0, 0, 0])
      .add(box(0.13, 0.32, 0.14), 0x7b3fbf, [0, -0.23, -0.26], [0.35, 0, 0])
      .add(box(0.14, 0.05, 0.15), 0x5a2b99, [0, -0.38, -0.32], [0.35, 0, 0])
      .add(ring(0.07, 0.025), 0x5a2b99, [0, -0.08, -0.15], [0, Math.PI / 2, 0]);
    // Three emitter prongs around the muzzle.
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3 + Math.PI / 2;
      k.add(box(0.035, 0.035, 0.18), STEEL_D, [Math.cos(a) * 0.12, 0.03 + Math.sin(a) * 0.12, 0.44], [-Math.sin(a) * 0.3, Math.cos(a) * 0.3, 0])
        .lit(ball(0.026, 6, 4), 0x9dfff0, [Math.cos(a) * 0.15, 0.03 + Math.sin(a) * 0.15, 0.53]);
    }
    // Reactor core in a window on the rear bulb + energy rings down the barrel.
    k.lit(ball(0.12, 10, 7), 0x3dffc8, [0, 0.1, -0.2])
      .lit(ring(0.11, 0.024), 0x3dffc8, [0, 0.03, 0.02])
      .lit(ring(0.095, 0.022), 0x3dffc8, [0, 0.03, 0.13])
      .lit(ring(0.085, 0.02), 0x3dffc8, [0, 0.03, 0.24])
      .lit(ball(0.08, 8, 6), 0xc8fff6, [0, 0.03, 0.42])
      .lit(box(0.012, 0.03, 0.22), 0x9dfff0, [0.135, 0.03, -0.17])
      .lit(box(0.012, 0.03, 0.22), 0x9dfff0, [-0.135, 0.03, -0.17]);
  },
  taser(k) {
    const blue = 0x2f6bff;
    k.add(box(0.42, 0.34, 0.5), blue, [0, 0, -0.05])
      .add(box(0.44, 0.07, 0.52), 0x1f48b8, [0, -0.18, -0.05])
      .add(box(0.24, 0.12, 0.16), DARK, [0, 0.22, -0.16])
      .add(box(0.44, 0.3, 0.06), 0x1f48b8, [0, 0, 0.22]);
    // Heat-sink fins on top.
    for (let i = 0; i < 4; i++) k.add(box(0.03, 0.08, 0.26), DARK, [-0.15 + i * 0.1, 0.21, 0.04]);
    for (const s of [-1, 1]) {
      k.add(rod(0.035, 0.035, 0.28, 8), STEEL, [s * 0.12, 0.02, 0.38])
        .add(rod(0.055, 0.055, 0.05, 8), DARK, [s * 0.12, 0.02, 0.27])
        .lit(ball(0.06, 8, 6), 0x9fe6ff, [s * 0.12, 0.02, 0.53])
        .lit(ring(0.05, 0.012, Math.PI * 2, 10), 0x2f9dff, [s * 0.12, 0.02, 0.36]);
      // Lightning-bolt decal on both flanks.
      k.lit(box(0.02, 0.2, 0.06), 0xffe23a, [s * 0.215, 0.06, -0.1], [0.6, 0, 0])
        .lit(box(0.02, 0.06, 0.16), 0xffe23a, [s * 0.215, 0.0, -0.06])
        .lit(box(0.02, 0.2, 0.06), 0xffe23a, [s * 0.215, -0.07, -0.02], [0.6, 0, 0]);
    }
    k.bolt([0.12, 0.02, 0.53], [-0.12, 0.02, 0.53], 3, 0.05, 0xbff0ff, 0.022, 1)
      .bolt([0.12, 0.06, 0.5], [-0.12, -0.02, 0.5], 2, 0.06, 0x7fc8ff, 0.016, 2)
      .lit(box(0.16, 0.04, 0.12), 0x6fc8ff, [0, 0.29, -0.16]);
  },
  syringe(k) {
    const glass = 0xd8e6ee;
    k.add(ring(0.11, 0.026), WHITE, [0, 0, -0.22])
      .add(ring(0.11, 0.026), WHITE, [0, 0, 0.18])
      .add(rod(0.115, 0.115, 0.04, 12), glass, [0, 0, -0.25])
      .add(rod(0.07, 0.04, 0.09, 10), glass, [0, 0, 0.245])
      .add(rod(0.012, 0.008, 0.22, 6), STEEL, [0, 0, 0.39])
      .add(rod(0.03, 0.03, 0.2, 8), glass, [0, 0, -0.35])
      .add(rod(0.09, 0.09, 0.035, 12), glass, [0, 0, -0.46]);
    for (const s of [-1, 1]) k.add(ring(0.06, 0.022), glass, [s * 0.17, 0, -0.25]);
    // Dose ticks + glowing nano serum.
    for (let i = 0; i < 4; i++) k.add(box(0.03, 0.012, 0.012), WHITE, [0, 0.1, -0.12 + i * 0.08]);
    k.lit(rod(0.095, 0.095, 0.38, 12), 0x5dff5d, [0, 0, -0.02])
      .lit(rod(0.04, 0.04, 0.39, 8), 0xd0ffd0, [0, 0, -0.02])
      .lit(disc(0.05, 0.02, 8), 0x5dff5d, [0, 0, -0.48], [Math.PI / 2, 0, 0])
      .lit(diamond(0.03), 0xb0ffb0, [0, 0, 0.53]);
  },
  knuckles(k) {
    const teal = 0x27d3d3;
    for (let i = 0; i < 4; i++) k.add(ring(0.09, 0.045, Math.PI * 2, 12), teal, [-0.27 + i * 0.18, 0.06, 0.1]);
    k.add(box(0.76, 0.14, 0.12), 0x1fa7a7, [0, -0.08, 0.1])
      .add(box(0.64, 0.16, 0.12), teal, [0, -0.16, -0.02], [-0.4, 0, 0])
      .add(box(0.74, 0.05, 0.05), 0x9ff5f5, [0, 0.17, 0.13]);
    for (let i = 0; i < 4; i++) {
      k.add(coneZ(0.05, 0.14, 5), 0x9ff5f5, [-0.27 + i * 0.18, 0.15, 0.22])
        .lit(coneZ(0.02, 0.06, 4), 0x8affff, [-0.27 + i * 0.18, 0.15, 0.31]);
    }
    k.lit(box(0.66, 0.035, 0.03), 0x5affff, [0, -0.02, 0.17])
      .lit(diamond(0.05), 0x5affff, [0, -0.16, 0.06]);
  },
  cleaver(k) {
    k.add(box(0.055, 0.42, 0.56), 0xc9d3df, [0, -0.02, 0.18])
      .add(box(0.04, 0.05, 0.56), WHITE, [0, -0.24, 0.18])
      .add(box(0.07, 0.09, 0.56), 0x8e9bab, [0, 0.15, 0.18])
      .add(box(0.06, 0.04, 0.4), 0x8e9bab, [0, 0.0, 0.14])
      .add(disc(0.05, 0.065, 8), DARK, [0, 0.08, 0.38], [0, 0, Math.PI / 2])
      .add(rod(0.05, 0.058, 0.42, 8), WOOD, [0, 0.13, -0.29])
      .add(rod(0.064, 0.064, 0.05, 8), STEEL_D, [0, 0.13, -0.08])
      .add(rod(0.066, 0.066, 0.04, 8), STEEL_D, [0, 0.13, -0.49]);
    for (const z of [-0.38, -0.22]) k.add(disc(0.02, 0.13, 6), STEEL, [0, 0.13, z], [0, 0, Math.PI / 2]);
    // Honed glowing edge and spine studs.
    k.lit(box(0.06, 0.026, 0.52), 0x9fb8ff, [0, -0.27, 0.18])
      .lit(box(0.062, 0.02, 0.12), 0xdfe8ff, [0, -0.27, 0.42])
      .lit(ring(0.035, 0.012, Math.PI * 2, 8), 0x9fb8ff, [0, 0.08, 0.38], [0, Math.PI / 2, 0]);
    for (let i = 0; i < 3; i++) k.add(ball(0.02, 6, 4), STEEL, [0, 0.2, 0.0 + i * 0.16]);
  },
  fire_axe(k) {
    k.add(rod(0.045, 0.052, 1.0, 8), WOOD, [0, 0, -0.02])
      .add(rod(0.058, 0.058, 0.18, 8), BLACK, [0, 0, -0.42])
      .add(rod(0.058, 0.058, 0.03, 8), STEEL_D, [0, 0, -0.52])
      .add(box(0.13, 0.22, 0.2), 0xd62828, [0, 0.04, 0.36])
      .add(box(0.09, 0.3, 0.3), 0xe63838, [0, 0.22, 0.36])
      .add(box(0.08, 0.08, 0.38), STEEL, [0, 0.38, 0.36])
      .add(coneY(0.07, 0.24, 4), 0xd62828, [0, -0.17, 0.36], [Math.PI, Math.PI / 4, 0])
      .add(box(0.135, 0.04, 0.06), STEEL_D, [0, 0.04, 0.36]);
    for (const z of [-0.1, -0.25]) k.add(band(0.054, 0.04), TAPE, [0, 0, z]);
    // Molten edge + hot spike tip.
    k.lit(box(0.085, 0.028, 0.38), 0xffb0a0, [0, 0.425, 0.36])
      .lit(box(0.07, 0.02, 0.3), 0xff4a2a, [0, 0.4, 0.36])
      .lit(coneY(0.03, 0.08, 4), 0xff8a5a, [0, -0.32, 0.36], [Math.PI, 0, 0])
      .lit(diamond(0.04), 0xff5a3a, [0.07, 0.2, 0.36]);
  },
  darts(k) {
    for (const [x, z] of [[-0.15, -0.04], [0, 0.04], [0.15, -0.04]] as const) {
      k.add(rod(0.016, 0.016, 0.36, 6), STEEL_D, [x, 0, z - 0.05])
        .add(rod(0.045, 0.036, 0.16, 8), 0x3d7a2a, [x, 0, z + 0.08])
        .add(coneZ(0.036, 0.16, 8), STEEL, [x, 0, z + 0.24])
        .add(box(0.006, 0.15, 0.16), 0x7ad13c, [x, 0, z - 0.22])
        .add(box(0.15, 0.006, 0.16), 0x7ad13c, [x, 0, z - 0.22])
        .lit(rod(0.04, 0.04, 0.08, 8), 0x9cff3b, [x, 0, z + 0.08])
        .lit(coneZ(0.016, 0.08, 6), 0xd4ff8a, [x, 0, z + 0.34]);
    }
  },
  shield_canister(k) {
    const navy = 0x1d2b5e;
    k.add(rod(0.19, 0.19, 0.54, 14), navy, [0, 0, -0.02])
      .add(rod(0.21, 0.21, 0.08, 14), STEEL, [0, 0, -0.3])
      .add(rod(0.21, 0.21, 0.08, 14), STEEL, [0, 0, 0.26])
      .add(rod(0.14, 0.09, 0.1, 12), STEEL_D, [0, 0, 0.35])
      .add(rod(0.065, 0.065, 0.08, 10), STEEL, [0, 0, 0.43])
      .add(rod(0.16, 0.16, 0.04, 12), STEEL_D, [0, 0, -0.36]);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      k.add(box(0.04, 0.04, 0.5), STEEL_D, [Math.cos(a) * 0.2, Math.sin(a) * 0.2, -0.02], [0, 0, a]);
    }
    // Energy windows, glowing hex emitter at the nozzle.
    k.lit(arcRod(0.195, 0.32, -Math.PI / 3, (Math.PI * 2) / 3), 0x55e0ff, [0, 0, -0.02])
      .lit(arcRod(0.195, 0.32, Math.PI * 0.75, Math.PI / 2), 0x55e0ff, [0, 0, -0.02])
      .lit(ring(0.21, 0.02, Math.PI * 2, 16), 0x9ff0ff, [0, 0, -0.02])
      .lit(rod(0.07, 0.04, 0.06, 6), 0xbff6ff, [0, 0, 0.5])
      .lit(ring(0.08, 0.016, Math.PI * 2, 10), 0x55e0ff, [0, 0, 0.47]);
  },
  toxic_barrel(k) {
    const yellow = 0xffd400;
    k.add(rod(0.24, 0.24, 0.62, 14), yellow, [0, 0, 0])
      .add(ring(0.245, 0.03, Math.PI * 2, 16), 0x2a2a2a, [0, 0, -0.18])
      .add(ring(0.245, 0.03, Math.PI * 2, 16), 0x2a2a2a, [0, 0, 0.18])
      .add(rod(0.22, 0.22, 0.64, 14), 0xc9a400, [0, 0, 0])
      .add(disc(0.05, 0.03, 10), STEEL_D, [0, 0.25, 0.12]);
    // Radiation trefoil on top (three dark sectors around a yellow hub).
    for (let i = 0; i < 3; i++) k.add(sector(0.17, 0.014, i * (Math.PI * 2 / 3), Math.PI / 3), BLACK, [0, 0.242, -0.04]);
    k.add(disc(0.035, 0.026, 8), BLACK, [0, 0.246, -0.04]);
    // Radioactive sludge glowing through the seams and oozing over the rim.
    k.lit(ring(0.236, 0.02, Math.PI * 2, 16), 0xb6ff3b, [0, 0, 0.31])
      .lit(ring(0.236, 0.02, Math.PI * 2, 16), 0xb6ff3b, [0, 0, -0.31])
      .lit(disc(0.19, 0.02, 14), 0x9cff2b, [0, 0, 0.315], [Math.PI / 2, 0, 0])
      .lit(ball(0.06, 8, 6), 0xb6ff3b, [0.1, 0.17, 0.32], O, [1, 1.6, 1])
      .lit(ball(0.045, 6, 4), 0xb6ff3b, [-0.12, 0.13, 0.33], O, [1, 1.8, 1])
      .lit(ball(0.04, 6, 4), 0xd8ff6a, [0.17, -0.02, 0.33], O, [1, 2, 1])
      .lit(arcRod(0.243, 0.08, Math.PI * 1.1, Math.PI * 0.5, 8), 0xb6ff3b, [0, 0, 0.0]);
  },
  spiked_bat(k) {
    k.add(lathe([[0, -0.52], [0.065, -0.52], [0.065, -0.48], [0.042, -0.46], [0.05, -0.2], [0.095, 0.1], [0.125, 0.38], [0.12, 0.47], [0, 0.5]], 10), 0xc98a4a)
      .add(rod(0.052, 0.056, 0.22, 10), 0x555a5f, [0, 0, -0.34])
      .add(rod(0.1, 0.104, 0.06, 10), TAPE, [0, 0, 0.12])
      .add(ring(0.112, 0.012, Math.PI * 2, 12), STEEL_D, [0, 0, 0.3], [0.2, 0, 0])
      .add(ring(0.118, 0.012, Math.PI * 2, 12), STEEL_D, [0, 0, 0.4], [-0.2, 0, 0]);
    for (let i = 0; i < 14; i++) {
      const a = i * 2.2;
      const z = 0.16 + (i % 4) * 0.09;
      const r = 0.1 + (i % 4) * 0.008;
      k.add(coneY(0.024, 0.16, 4), STEEL, [Math.cos(a) * (r + 0.06), Math.sin(a) * (r + 0.06), z], [0, 0, a - Math.PI / 2])
        .lit(coneY(0.01, 0.05, 4), 0xffa040, [Math.cos(a) * (r + 0.13), Math.sin(a) * (r + 0.13), z], [0, 0, a - Math.PI / 2]);
    }
  },
  crowbar(k) {
    k.add(rod(0.042, 0.042, 0.62, 8), BLACK, [0, 0, 0.02])
      .add(rod(0.054, 0.054, 0.28, 8), 0xd23a4a, [0, 0, -0.38])
      .add(rod(0.054, 0.054, 0.1, 8), 0xd23a4a, [0, 0, 0.12])
      .add(ring(0.12, 0.042, Math.PI * 1.15, 10), BLACK, [0, 0.12, 0.33], [0, -Math.PI / 2, 0])
      .add(box(0.05, 0.07, 0.14), 0xd23a4a, [0, 0.22, 0.26], [0.6, 0, 0])
      .add(box(0.1, 0.025, 0.14), STEEL_D, [0, 0.04, -0.56], [-0.3, 0, 0]);
    for (const z of [-0.46, -0.36, -0.26]) k.add(band(0.058, 0.025), BLACK, [0, 0, z]);
    // Glowing hot claw tips.
    k.lit(box(0.07, 0.03, 0.04), 0xff5a5a, [0, 0.27, 0.22], [0.6, 0, 0])
      .lit(box(0.11, 0.02, 0.05), 0xff5a5a, [0, 0.025, -0.62], [-0.3, 0, 0])
      .lit(box(0.012, 0.025, 0.5), 0xff6a6a, [0.043, 0, 0.02]);
  },
  molotov(k) {
    k.add(lathe([[0, -0.3], [0.15, -0.3], [0.16, -0.26], [0.16, 0.05], [0.1, 0.14], [0.055, 0.2], [0.055, 0.3], [0, 0.3]], 12), 0x3fa34d)
      .add(rod(0.066, 0.066, 0.04, 10), 0x2c7a37, [0, 0, 0.29])
      .add(box(0.15, 0.035, 0.2), TAPE, [0, 0.03, 0.35], [0.4, 0.2, 0])
      .add(box(0.06, 0.14, 0.16), 0xd9c9a0, [0.04, -0.03, 0.34], [0, -0.3, 0.3])
      .add(box(0.24, 0.14, 0.014), TAPE, [0, 0, -0.06])
      .add(box(0.025, 0.2, 0.02), 0x8a6a3a, [0.0, 0.0, -0.05], [0, 0, 0.5]);
    // Burning fuel inside, lit rag + fuse sparks.
    k.lit(lathe([[0, -0.27], [0.14, -0.27], [0.145, -0.05], [0, -0.05]], 10), 0xff9a2e)
      .lit(coneZ(0.1, 0.24, 7), 0xff7a1a, [0, 0.06, 0.5])
      .lit(coneZ(0.05, 0.16, 6), 0xff5a10, [0.07, 0.1, 0.46], [-0.3, 0.5, 0])
      .lit(ball(0.07, 8, 6), 0xffd04a, [0, 0.05, 0.42])
      .lit(diamond(0.02), 0xffe080, [0.06, 0.16, 0.56])
      .lit(diamond(0.018), 0xffb040, [-0.05, 0.13, 0.6]);
  },
  katana(k) {
    k.add(box(0.032, 0.09, 0.62), 0xdfe6ef, [0, 0, 0.18])
      .add(box(0.034, 0.025, 0.62), WHITE, [0, -0.055, 0.18])
      .add(box(0.032, 0.085, 0.14), 0xdfe6ef, [0, 0.018, 0.52], [-0.35, 0, 0])
      .add(rod(0.13, 0.13, 0.035, 12), GOLD, [0, 0, -0.15])
      .add(rod(0.045, 0.05, 0.06, 8), GOLD, [0, 0, -0.12])
      .add(rod(0.046, 0.046, 0.28, 8), 0x22283a, [0, 0, -0.31])
      .add(rod(0.052, 0.052, 0.035, 8), GOLD, [0, 0, -0.46]);
    for (let i = 0; i < 4; i++) k.add(box(0.1, 0.035, 0.035), 0xe8e2d0, [0, 0, -0.42 + i * 0.07], [0, 0, i % 2 ? 0.6 : -0.6]);
    k.add(coneY(0.04, 0.18, 6), 0xd8322a, [0, -0.11, -0.5], [Math.PI, 0, 0])
      .add(ball(0.035, 6, 4), 0xd8322a, [0, -0.03, -0.49]);
    // Glowing hamon edge and a charged gem in the guard.
    k.lit(box(0.036, 0.02, 0.6), 0xe8f4ff, [0, -0.07, 0.18])
      .lit(box(0.036, 0.018, 0.13), 0xe8f4ff, [0, -0.02, 0.54], [-0.35, 0, 0])
      .lit(box(0.016, 0.014, 0.56), 0xa8d0ff, [0.018, 0.02, 0.17])
      .lit(diamond(0.04), 0x8fd0ff, [0, 0.1, -0.15]);
  },
  acid_vial(k) {
    k.add(ring(0.095, 0.026), 0xd8f0e6, [0, 0, 0.18])
      .add(rod(0.098, 0.098, 0.04, 12), 0xd8f0e6, [0, 0, 0.15])
      .add(rod(0.078, 0.066, 0.14, 10), 0xa0703c, [0, 0, 0.26])
      .add(rod(0.08, 0.08, 0.03, 10), 0x7c5428, [0, 0, 0.34]);
    // Steel cage bands around the glass.
    for (const z of [-0.2, 0.02]) k.add(ring(0.09, 0.012, Math.PI * 2, 12), STEEL_D, [0, 0, z]);
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3;
      k.add(box(0.016, 0.016, 0.46), STEEL_D, [Math.cos(a) * 0.088, Math.sin(a) * 0.088, -0.06]);
    }
    k.lit(rod(0.084, 0.084, 0.42, 12), 0x39ff6a, [0, 0, -0.07])
      .lit(ball(0.084, 12, 6), 0x39ff6a, [0, 0, -0.28])
      .lit(ball(0.03, 6, 4), 0xc8ffb0, [0.04, 0.05, -0.08])
      .lit(ball(0.022, 6, 4), 0xc8ffb0, [-0.03, -0.03, 0.04])
      .lit(ball(0.018, 6, 4), 0xc8ffb0, [0.02, -0.04, -0.2])
      .lit(ball(0.03, 6, 4), 0x39ff6a, [0.06, 0.05, 0.37], O, [1, 1.6, 1]);
  },
  flintlock(k) {
    k.add(rod(0.065, 0.07, 0.6, 10), STEEL, [0, 0.06, 0.17])
      .add(lathe([[0.07, 0.42], [0.095, 0.47], [0.095, 0.5], [0.06, 0.5]], 10), STEEL_D, [0, 0.06, 0])
      .add(rod(0.076, 0.076, 0.06, 10), GOLD, [0, 0.06, 0.25])
      .add(rod(0.076, 0.076, 0.05, 10), GOLD, [0, 0.06, 0.06])
      .add(box(0.12, 0.12, 0.62), WOOD, [0, -0.03, 0.0])
      .add(box(0.12, 0.4, 0.16), WOOD, [0, -0.19, -0.34], [0.55, 0, 0])
      .add(rod(0.085, 0.085, 0.06, 8), GOLD, [0, -0.32, -0.43], [0.55, 0, 0])
      .add(box(0.05, 0.14, 0.06), STEEL_D, [0, 0.14, -0.17], [-0.4, 0, 0])
      .add(box(0.06, 0.06, 0.1), STEEL_D, [0.07, 0.06, -0.12])
      .add(box(0.03, 0.08, 0.2), GOLD, [0.065, 0.0, -0.05])
      .add(ring(0.055, 0.014, Math.PI, 8), GOLD, [0, -0.1, -0.15], [0, Math.PI / 2, Math.PI]);
    // Smouldering powder pan + muzzle glow.
    k.lit(disc(0.05, 0.02, 8), 0xffb060, [0, 0.06, 0.505], [Math.PI / 2, 0, 0])
      .lit(ball(0.03, 6, 4), 0xff8a2a, [0.08, 0.1, -0.12])
      .lit(diamond(0.022), 0xffd080, [0.09, 0.15, -0.1]);
  },
  tesla_gun(k) {
    k.add(box(0.18, 0.2, 0.42), WOOD, [0, 0, -0.18])
      .add(box(0.14, 0.32, 0.15), WOOD_D, [0, -0.21, -0.3], [0.4, 0, 0])
      .add(rod(0.07, 0.07, 0.52, 10), COPPER, [0, 0.02, 0.17])
      .add(rod(0.1, 0.06, 0.08, 10), COPPER, [0, 0.02, 0.44])
      .add(box(0.2, 0.04, 0.3), BLACK, [0, 0.12, -0.18]);
    for (const z of [0.0, 0.1, 0.2, 0.3]) k.add(ring(0.095, 0.024, Math.PI * 2, 8), 0xb8602a, [0, 0.02, z]);
    // Tesla coil tower: stacked discs topped by a crackling orb.
    k.add(rod(0.045, 0.045, 0.1, 8), STEEL_D, [0, 0.18, -0.14], [Math.PI / 2, 0, 0]);
    for (let i = 0; i < 3; i++) k.add(disc(0.075 - i * 0.015, 0.025, 10), COPPER, [0, 0.2 + i * 0.045, -0.14]);
    k.lit(ball(0.09, 10, 7), 0x7ff3ff, [0, 0.36, -0.14])
      .lit(ring(0.11, 0.012, Math.PI * 2, 12), 0xbff9ff, [0, 0.36, -0.14], [Math.PI / 2, 0, 0])
      .lit(ball(0.075, 8, 6), 0x7ff3ff, [0, 0.02, 0.52])
      .lit(ring(0.07, 0.014, Math.PI * 2, 10), 0x7ff3ff, [0, 0.02, 0.45])
      .bolt([0.1, 0.08, -0.05], [0.07, 0.03, 0.52], 4, 0.07, 0x7ff3ff, 0.024, 1)
      .bolt([-0.1, -0.03, -0.05], [-0.07, 0.02, 0.52], 4, 0.07, 0x7ff3ff, 0.024, 2)
      .bolt([0, 0.36, -0.14], [0, 0.1, 0.4], 4, 0.06, 0xbff9ff, 0.02, 3)
      .bolt([0.07, 0.36, -0.14], [0.14, 0.12, 0.1], 3, 0.05, 0xbff9ff, 0.016, 4);
  },
  revolver(k) {
    const silver = 0xc0c6cf;
    k.add(rod(0.055, 0.055, 0.48, 10), silver, [0, 0.05, 0.25])
      .add(box(0.05, 0.08, 0.36), 0xa7aeb8, [0, -0.02, 0.3])
      .add(box(0.04, 0.05, 0.48), silver, [0, 0.12, 0.25])
      .add(box(0.035, 0.06, 0.035), silver, [0, 0.16, 0.47])
      .add(rod(0.13, 0.13, 0.18, 6), 0xa7aeb8, [0, 0.0, -0.03], [0, 0, Math.PI / 6])
      .add(box(0.12, 0.22, 0.3), silver, [0, 0.0, -0.08])
      .add(box(0.12, 0.34, 0.15), 0x7a4a26, [0, -0.21, -0.28], [0.45, 0, 0])
      .add(box(0.125, 0.06, 0.06), GOLD, [0, -0.08, -0.2], [0.45, 0, 0])
      .add(box(0.05, 0.1, 0.06), STEEL_D, [0, 0.13, -0.21], [-0.5, 0, 0])
      .add(ring(0.055, 0.014, Math.PI, 8), STEEL_D, [0, -0.11, -0.06], [0, Math.PI / 2, Math.PI]);
    // Six hot chambers glowing in the cylinder face + muzzle.
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      k.lit(disc(0.026, 0.02, 6), 0xffc070, [Math.cos(a) * 0.08, Math.sin(a) * 0.08, 0.065], [Math.PI / 2, 0, 0]);
    }
    k.lit(disc(0.038, 0.02, 8), 0xffa040, [0, 0.05, 0.495], [Math.PI / 2, 0, 0])
      .lit(box(0.012, 0.02, 0.4), 0xffd090, [0.03, 0.05, 0.24]);
  },
  stun_pistol(k) {
    const blue = 0x2d7dff;
    const yellow = 0xffcc22;
    k.add(box(0.22, 0.24, 0.44), blue, [0, 0.03, -0.02])
      .add(box(0.25, 0.27, 0.13), yellow, [0, 0.03, 0.25])
      .add(box(0.23, 0.05, 0.44), yellow, [0, 0.17, -0.02])
      .add(box(0.17, 0.32, 0.15), 0x1b4fb0, [0, -0.21, -0.17], [0.35, 0, 0])
      .add(box(0.18, 0.06, 0.16), yellow, [0, -0.35, -0.23], [0.35, 0, 0])
      .add(rod(0.025, 0.025, 0.14, 6), STEEL, [0.07, 0.03, 0.38])
      .add(rod(0.025, 0.025, 0.14, 6), STEEL, [-0.07, 0.03, 0.38]);
    for (const z of [-0.14, -0.06, 0.02, 0.1]) k.lit(ring(0.1, 0.01, Math.PI, 8), 0x2dc4ff, [0, 0.03, z], [0, 0, 0]);
    k.lit(box(0.016, 0.07, 0.24), 0x2dc4ff, [0.115, 0.04, -0.05])
      .lit(box(0.016, 0.07, 0.24), 0x2dc4ff, [-0.115, 0.04, -0.05])
      .lit(ball(0.035, 6, 4), 0x9fe6ff, [0.07, 0.03, 0.46])
      .lit(ball(0.035, 6, 4), 0x9fe6ff, [-0.07, 0.03, 0.46])
      .bolt([0.07, 0.03, 0.47], [-0.07, 0.03, 0.47], 2, 0.04, 0xbff0ff, 0.02, 1)
      .bolt([0.07, 0.06, 0.45], [-0.07, 0.0, 0.45], 2, 0.03, 0x7fc8ff, 0.014, 2);
  },
  crossbow(k) {
    const purple = 0xa64dff;
    k.add(box(0.12, 0.12, 0.82), WOOD, [0, 0, -0.08])
      .add(box(0.1, 0.22, 0.13), WOOD_D, [0, -0.13, -0.3], [0.3, 0, 0])
      .add(box(0.15, 0.1, 0.14), purple, [0, 0, 0.3])
      .add(box(0.04, 0.1, 0.16), STEEL_D, [0, 0.1, -0.12]);
    for (const s of [-1, 1]) {
      k.add(box(0.4, 0.075, 0.09), purple, [s * 0.24, 0, 0.24], [0, s * 0.35, 0])
        .add(box(0.06, 0.1, 0.06), STEEL_D, [s * 0.42, 0, 0.17])
        .lit(box(0.03, 0.03, 0.42), 0xd9a8ff, [s * 0.21, 0.0, 0.01], [0, -s * 1.05, 0])
        .lit(diamond(0.03), 0xd9a8ff, [s * 0.43, 0.06, 0.17]);
    }
    k.add(ring(0.07, 0.018, Math.PI, 8), STEEL_D, [0, 0, 0.43], [Math.PI / 2, 0, 0])
      .add(rod(0.018, 0.018, 0.62, 6), WOOD_D, [0, 0.08, 0.04])
      .add(coneZ(0.04, 0.11, 6), STEEL, [0, 0.08, 0.4])
      .add(box(0.006, 0.07, 0.09), purple, [0, 0.11, -0.24])
      .lit(box(0.022, 0.022, 0.12), 0xd9a8ff, [0, 0.08, 0.3])
      .lit(coneZ(0.02, 0.06, 5), 0xe8c8ff, [0, 0.08, 0.47]);
  },
  blunderbuss(k) {
    k.add(lathe([[0.11, -0.15], [0.095, 0.1], [0.1, 0.3], [0.17, 0.44], [0.19, 0.49], [0.13, 0.49]], 12), WOOD)
      .add(box(0.16, 0.18, 0.38), WOOD_D, [0, -0.04, -0.25])
      .add(box(0.14, 0.32, 0.17), WOOD, [0, -0.18, -0.45], [0.6, 0, 0])
      .add(box(0.05, 0.12, 0.08), STEEL_D, [0, 0.11, -0.2], [-0.4, 0, 0]);
    for (const z of [-0.05, 0.12, 0.27]) k.add(rod(0.11, 0.11, 0.06, 12), GOLD, [0, 0, z], [0, 0, z * 3]);
    k.add(ring(0.18, 0.02, Math.PI * 2, 14), GOLD, [0, 0, 0.48]);
    // Ember-packed bell + cracks glowing through the barrel.
    k.lit(disc(0.14, 0.02, 10), 0xff8c2a, [0, 0, 0.485], [Math.PI / 2, 0, 0])
      .lit(ball(0.06, 6, 4), 0xffd060, [0, 0, 0.47], O, [1, 1, 0.5]);
    for (const [x, y, z] of [[0.1, 0.03, 0.03], [-0.09, 0.05, 0.2], [0.06, 0.09, 0.36], [-0.07, -0.07, 0.38], [0.03, -0.1, 0.12]] as const) {
      k.lit(diamond(0.032), 0xff8c2a, [x, y, z]);
    }
  },
  twin_cannon(k) {
    const purple = 0x6c5cff;
    for (const s of [-1, 1]) {
      k.add(rod(0.1, 0.088, 0.68, 12), STEEL, [s * 0.11, 0.02, 0.16])
        .add(rod(0.112, 0.112, 0.06, 12), STEEL_D, [s * 0.11, 0.02, 0.47])
        .add(rod(0.104, 0.104, 0.04, 12), STEEL_D, [s * 0.11, 0.02, 0.15])
        .lit(ring(0.07, 0.02), purple, [s * 0.11, 0.02, 0.5])
        .lit(disc(0.05, 0.02, 8), 0xb0a8ff, [s * 0.11, 0.02, 0.49], [Math.PI / 2, 0, 0])
        .lit(box(0.016, 0.05, 0.2), 0x9a8cff, [s * 0.235, 0.0, -0.18]);
    }
    k.add(box(0.46, 0.25, 0.32), purple, [0, 0.0, -0.18])
      .add(box(0.48, 0.07, 0.09), 0x4637c2, [0, 0.0, -0.08])
      .add(box(0.14, 0.3, 0.13), DARK, [0, -0.21, -0.3], [0.35, 0, 0])
      .add(box(0.32, 0.09, 0.16), DARK, [0, 0.16, -0.22])
      .add(box(0.1, 0.06, 0.4), DARK, [0, 0.11, 0.12]);
    // Plasma core on top.
    k.lit(ball(0.075, 10, 7), 0xb0a8ff, [0, 0.24, -0.22])
      .add(ring(0.08, 0.018, Math.PI * 2, 10), STEEL_D, [0, 0.24, -0.22], [Math.PI / 2, 0, 0]);
  },
  firework(k) {
    const red = 0xd8322a;
    const green = 0x3fae4a;
    k.add(rod(0.15, 0.15, 0.72, 12), red, [0, 0, -0.05]);
    for (const z of [-0.3, -0.1, 0.1]) k.add(rod(0.155, 0.155, 0.06, 12), green, [0, 0, z]);
    k.add(rod(0.17, 0.17, 0.05, 12), GOLD, [0, 0, 0.3])
      .add(box(0.12, 0.26, 0.13), DARK, [0, -0.22, -0.15], [0.3, 0, 0])
      .add(coneZ(0.12, 0.14, 10), green, [0, 0, 0.38])
      .add(rod(0.16, 0.12, 0.05, 12), DARK, [0, 0, -0.43]);
    // Star decals, glowing tip and a lit fuse fizzing at the back.
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3;
      k.lit(diamond(0.045), 0xffe070, [Math.cos(a) * 0.15, Math.sin(a) * 0.15, 0.0], O, [1, 1, 0.4]);
    }
    k.lit(coneZ(0.09, 0.2, 8), 0xffb02e, [0, 0, 0.52])
      .lit(ball(0.06, 6, 4), 0xffe070, [0, 0.0, 0.44])
      .add(rod(0.01, 0.01, 0.14, 4), 0x5a4a3a, [0.06, 0.08, -0.5], [0.6, 0, 0])
      .lit(diamond(0.035), 0xffd040, [0.06, 0.14, -0.56])
      .lit(diamond(0.02), 0xffa020, [0.09, 0.18, -0.58]);
  },
  storm_kunai(k) {
    k.lit(diamond(0.15), 0x8fd8ff, [0, 0, 0.22], O, [0.9, 0.2, 2.2])
      .add(diamond(0.17), 0x3a5aa0, [0, 0, 0.18], O, [0.9, 0.12, 1.8])
      .add(rod(0.06, 0.06, 0.06, 8), STEEL_D, [0, 0, -0.06])
      .add(rod(0.042, 0.042, 0.26, 8), 0x1b3a7a, [0, 0, -0.22])
      .add(ring(0.075, 0.022, Math.PI * 2, 12), STEEL, [0, 0, -0.42])
      .lit(ring(0.075, 0.012, Math.PI * 2, 12), 0xbfe8ff, [0, 0, -0.42], [0, 0, 0], [1.15, 1.15, 1])
      .bolt([0.12, 0.03, -0.1], [0.04, 0.02, 0.52], 5, 0.07, 0xd0f0ff, 0.02, 4)
      .bolt([-0.12, -0.03, -0.12], [-0.04, -0.02, 0.47], 5, 0.07, 0xd0f0ff, 0.02, 5)
      .bolt([0, 0.08, -0.3], [0, 0.05, 0.3], 4, 0.06, 0x8fd8ff, 0.016, 6);
    for (let i = 0; i < 3; i++) k.add(box(0.09, 0.03, 0.03), 0x8fd8ff, [0, 0, -0.3 + i * 0.07], [0, 0, i % 2 ? 0.6 : -0.6]);
  },
  compound_bow(k) {
    const blue = 0x3a8cff;
    k.add(box(0.14, 0.18, 0.14), blue, [0, 0, 0.1])
      .add(box(0.07, 0.26, 0.09), DARK, [0, -0.17, 0.08])
      .add(box(0.04, 0.1, 0.1), STEEL_D, [0.08, 0.06, 0.1]);
    for (const s of [-1, 1]) {
      k.add(box(0.4, 0.06, 0.08), blue, [s * 0.24, 0, 0.04], [0, s * 0.35, 0])
        .add(disc(0.075, 0.045, 10), DARK, [s * 0.43, 0, -0.04])
        .add(disc(0.035, 0.055, 8), STEEL, [s * 0.43, 0, -0.04])
        .lit(ring(0.075, 0.012, Math.PI * 2, 10), 0x7fbfff, [s * 0.43, 0, -0.04], [Math.PI / 2, 0, 0])
        .lit(box(0.014, 0.014, 0.54), 0xbfe0ff, [s * 0.215, 0, -0.2], [0, s * 0.95, 0]);
    }
    k.add(rod(0.016, 0.016, 0.9, 6), 0x2a2a2a, [0, 0.05, 0.0])
      .add(coneZ(0.036, 0.1, 6), STEEL, [0, 0.05, 0.48])
      .add(box(0.006, 0.08, 0.11), 0x9fd0ff, [0, 0.09, -0.38])
      .add(box(0.08, 0.006, 0.11), 0x9fd0ff, [0, 0.05, -0.38])
      .lit(box(0.024, 0.024, 0.07), 0x9fd0ff, [0, 0.12, 0.12])
      .lit(coneZ(0.02, 0.07, 5), 0xd8ecff, [0, 0.05, 0.55]);
  },
  rpg(k) {
    const olive = 0x6b7a2f;
    const oliveD = 0x4d5a20;
    k.add(rod(0.105, 0.105, 0.78, 12), olive, [0, 0, -0.12])
      .add(rod(0.13, 0.155, 0.12, 12), oliveD, [0, 0, -0.52])
      .add(rod(0.118, 0.118, 0.05, 12), oliveD, [0, 0, 0.0])
      .add(rod(0.118, 0.118, 0.05, 12), oliveD, [0, 0, -0.3])
      // Warhead: big yellow bulb with a red band and glowing contact fuse.
      .add(lathe([[0.06, 0.24], [0.155, 0.32], [0.155, 0.43], [0.07, 0.52], [0, 0.54]], 12), 0xf2c430)
      .add(rod(0.06, 0.07, 0.05, 10), oliveD, [0, 0, 0.255])
      .add(box(0.09, 0.26, 0.11), BLACK, [0, -0.17, -0.05], [0.25, 0, 0])
      .add(box(0.09, 0.22, 0.11), BLACK, [0, -0.15, -0.3], [0.25, 0, 0])
      .add(box(0.06, 0.12, 0.14), BLACK, [0.1, 0.14, -0.1])
      .add(box(0.05, 0.04, 0.04), STEEL_D, [0.1, 0.22, -0.04]);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      k.add(box(0.012, 0.09, 0.1), oliveD, [Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0.3], [0, 0, a + Math.PI / 2]);
    }
    k.lit(ring(0.156, 0.016, Math.PI * 2, 14), 0xff3b2e, [0, 0, 0.375])
      .lit(diamond(0.04), 0xffe070, [0, 0, 0.55])
      .lit(box(0.035, 0.035, 0.025), 0xff3b2e, [0.1, 0.18, -0.03])
      .lit(disc(0.12, 0.02, 10), 0xff8a2e, [0, 0, -0.585], [Math.PI / 2, 0, 0]);
  },
  chainsaw(k) {
    const orange = 0xff8a1e;
    k.add(box(0.3, 0.34, 0.44), orange, [0, 0, -0.24])
      .add(box(0.31, 0.07, 0.45), DARK, [0, -0.16, -0.24])
      .add(ring(0.13, 0.035, Math.PI, 8), BLACK, [0, 0.17, -0.26], [0, Math.PI / 2, 0])
      .add(box(0.06, 0.06, 0.18), BLACK, [0, 0.0, -0.52])
      .add(box(0.05, 0.18, 0.6), STEEL, [0, -0.02, 0.24])
      .add(disc(0.09, 0.05, 10), STEEL, [0, -0.02, 0.54], [0, 0, Math.PI / 2])
      .add(box(0.08, 0.22, 0.05), STEEL_D, [0, -0.02, -0.02])
      .add(rod(0.04, 0.05, 0.1, 8), DARK, [0.16, 0.08, -0.36], [0, Math.PI / 2, 0]);
    for (let i = 0; i < 4; i++) k.add(box(0.31, 0.02, 0.03), DARK, [0, 0.06, -0.38 + i * 0.07]);
    for (let i = 0; i < 10; i++) {
      const z = 0.0 + i * 0.058;
      k.add(coneY(0.024, 0.06, 4), DARK, [0, 0.09, z])
        .add(coneY(0.024, 0.06, 4), DARK, [0, -0.13, z], [Math.PI, 0, 0]);
    }
    // Hot chain edge, exhaust and engine light.
    k.lit(box(0.055, 0.016, 0.58), 0xff6a1a, [0, 0.075, 0.24])
      .lit(box(0.055, 0.016, 0.58), 0xff6a1a, [0, -0.115, 0.24])
      .lit(disc(0.035, 0.02, 8), 0xff4a1a, [0.215, 0.08, -0.36], [0, 0, Math.PI / 2])
      .lit(box(0.012, 0.05, 0.14), 0xff4a1a, [0.155, 0.06, -0.2]);
  },
  shotgun(k) {
    k.add(rod(0.05, 0.05, 0.84, 10), STEEL_D, [0, 0.06, 0.1])
      .add(rod(0.044, 0.044, 0.62, 10), STEEL, [0, -0.04, 0.12])
      .add(box(0.13, 0.12, 0.24), WOOD, [0, -0.04, 0.18])
      .add(box(0.12, 0.18, 0.26), DARK, [0, 0.01, -0.2])
      .add(box(0.12, 0.18, 0.32), WOOD, [0, -0.07, -0.42], [0.25, 0, 0])
      .add(box(0.125, 0.19, 0.045), BLACK, [0, -0.11, -0.58], [0.25, 0, 0])
      .add(ring(0.05, 0.014, Math.PI, 8), BLACK, [0, -0.08, -0.18], [0, Math.PI / 2, Math.PI])
      .add(rod(0.06, 0.06, 0.04, 10), STEEL_D, [0, 0.06, 0.5])
      .add(box(0.025, 0.035, 0.025), 0xffd04a, [0, 0.12, 0.48]);
    // Side saddle with glowing shells.
    for (let i = 0; i < 4; i++) {
      k.add(rod(0.026, 0.026, 0.1, 6), 0xd23a2a, [0.075, 0.0, -0.3 + i * 0.06], [Math.PI / 2, 0, 0])
        .lit(disc(0.022, 0.012, 6), 0xffc040, [0.075, 0.055, -0.3 + i * 0.06]);
    }
    k.lit(disc(0.035, 0.02, 8), 0xffa040, [0, 0.06, 0.525], [Math.PI / 2, 0, 0]);
  },
  pistol(k) {
    const grey = 0x4a5368;
    k.add(box(0.12, 0.13, 0.5), grey, [0, 0.06, 0.06])
      .add(box(0.125, 0.04, 0.38), 0x3a4152, [0, -0.01, 0.0])
      .add(box(0.11, 0.32, 0.15), 0x2b3040, [0, -0.16, -0.12], [0.3, 0, 0])
      .add(box(0.12, 0.05, 0.14), 0x2b3040, [0, -0.3, -0.17], [0.3, 0, 0])
      .add(ring(0.055, 0.014, Math.PI, 8), 0x2b3040, [0, -0.05, 0.03], [0, Math.PI / 2, Math.PI])
      .add(box(0.08, 0.06, 0.12), 0x2b3040, [0, -0.05, 0.25]);
    for (let i = 0; i < 4; i++) k.add(box(0.125, 0.09, 0.014), 0x3a4152, [0, 0.07, -0.13 + i * 0.03]);
    k.lit(disc(0.03, 0.02, 8), 0x7dff9a, [0, 0.06, 0.315], [Math.PI / 2, 0, 0])
      .lit(box(0.125, 0.014, 0.3), 0x7dff9a, [0, 0.025, 0.1])
      .lit(box(0.025, 0.025, 0.025), 0x7dff9a, [0, 0.135, 0.28])
      .lit(box(0.025, 0.025, 0.025), 0x7dff9a, [0.035, 0.135, -0.15])
      .lit(box(0.025, 0.025, 0.025), 0x7dff9a, [-0.035, 0.135, -0.15]);
  },
};

/** Small hand weapons are drawn a bit larger so every model reads at about the same size. */
const DISPLAY_SCALE: Partial<Record<WeaponId, number>> = {
  pistol: 1.4, darts: 1.3, knuckles: 1.15, stun_pistol: 1.2, molotov: 1.2, acid_vial: 1.25, toxic_barrel: 1.1, taser: 1.1,
};

/** Every model is thickened across X/Y (length unchanged) for a chunkier, heavier silhouette. */
const CHUNK: V3 = [1.18, 1.18, 1];

const cache = new Map<WeaponId, WeaponGeometry>();

/** Shared, cached geometries for one weapon (do not dispose). */
export function weaponGeometry(id: WeaponId): WeaponGeometry {
  let g = cache.get(id);
  if (!g) {
    const kit = new Kit();
    BUILDERS[id](kit);
    g = kit.build();
    const scale = DISPLAY_SCALE[id] ?? 1;
    for (const geo of [g.body, g.glow]) {
      if (!geo) continue;
      geo.scale(scale * CHUNK[0], scale * CHUNK[1], scale * CHUNK[2]);
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
    }
    cache.set(id, g);
  }
  return g;
}

/** Front-most model-space Z of a weapon (its muzzle / blade tip), body and glow combined. */
export function weaponTipZ(id: WeaponId): number {
  const g = weaponGeometry(id);
  return Math.max(g.body.boundingBox?.max.z ?? 0.5, g.glow?.boundingBox?.max.z ?? -Infinity);
}

/** The balance agent's per-weapon visual/hitbox scale, defended against missing / bad values. */
export function weaponSizeMul(id: WeaponId): number {
  const s = getWeapon(id).sizeMul;
  return Number.isFinite(s) && s > 0 ? s : 1.6;
}

/** Held-on-turret scale: grows with sizeMul but clamped so it never swallows the chassis or the camera. */
export function heldWeaponScale(id: WeaponId): number {
  return THREE.MathUtils.clamp(0.55 + 0.5 * weaponSizeMul(id), 1.2, 1.8);
}

/** Floating pad scale: much larger than held so pads read from across the arena. */
export function padWeaponScale(id: WeaponId): number {
  return THREE.MathUtils.clamp(0.95 + 0.75 * weaponSizeMul(id), 1.8, 3.0);
}

// ------------------------------------------------------------ materials for standalone models

let bodyMaterial: THREE.MeshStandardMaterial | null = null;
let glowMaterial: THREE.MeshBasicMaterial | null = null;

/** Lit, vertex-coloured, flat-shaded material shared by every weapon body. */
export function weaponBodyMaterial(): THREE.MeshStandardMaterial {
  bodyMaterial ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.05, flatShading: true });
  return bodyMaterial;
}

/** HDR vertex-coloured glow (multiplies GLOW_BAKE back up so bloom catches it). */
export function weaponGlowMaterial(): THREE.MeshBasicMaterial {
  glowMaterial ??= new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(4.5, 4.5, 4.5), toneMapped: true });
  return glowMaterial;
}

/**
 * A ready-to-display model (~1 m long, centred, +Z forward). Geometries and
 * materials are shared: release with `disposeWeaponModel`, never a deep dispose.
 */
export function buildWeaponModel(id: WeaponId): THREE.Group {
  const geo = weaponGeometry(id);
  const group = new THREE.Group();
  group.name = `weaponModel:${id}`;
  group.userData.sharedWeaponModel = true;
  const body = new THREE.Mesh(geo.body, weaponBodyMaterial());
  body.castShadow = true;
  group.add(body);
  if (geo.glow) group.add(new THREE.Mesh(geo.glow, weaponGlowMaterial()));
  return group;
}

/** Detaches a model from the scene graph; shared GPU resources stay alive. */
export function disposeWeaponModel(model: THREE.Object3D): void {
  model.removeFromParent();
  model.clear();
}

// ------------------------------------------------------------ projectiles

/**
 * Visual families for in-flight projectiles. Sizes are at sizeMul 1: the
 * renderer multiplies every model by the firing weapon's `sizeMul`.
 */
export type ProjectileModel =
  | 'blade' | 'dart' | 'bottle' | 'vial' | 'bolt' | 'arrow' | 'rocket' | 'firework' | 'kunai' | 'ball' | 'spark'
  | 'needle' | 'canister' | 'barrel' | 'orb' | 'fireball' | 'lance' | 'slug';

const PROJECTILE_BUILDERS: Record<ProjectileModel, (k: Kit) => void> = {
  blade(k) {
    k.add(box(0.045, 0.32, 0.44), 0xc9d3df, [0, -0.02, 0.06])
      .add(box(0.055, 0.075, 0.44), 0x8e9bab, [0, 0.13, 0.06])
      .add(rod(0.045, 0.05, 0.3, 8), WOOD, [0, 0.12, -0.3])
      .add(disc(0.04, 0.06, 8), DARK, [0, 0.07, 0.22], [0, 0, Math.PI / 2])
      .lit(box(0.05, 0.026, 0.42), 0x9fb8ff, [0, -0.19, 0.06])
      .lit(box(0.052, 0.02, 0.1), 0xe0e8ff, [0, -0.19, 0.26]);
  },
  dart(k) {
    k.add(rod(0.014, 0.014, 0.28, 5), STEEL_D, [0, 0, -0.04])
      .add(rod(0.034, 0.028, 0.12, 6), 0x3d7a2a, [0, 0, 0.06])
      .add(coneZ(0.028, 0.12, 6), STEEL, [0, 0, 0.18])
      .add(box(0.005, 0.11, 0.12), 0x7ad13c, [0, 0, -0.16])
      .add(box(0.11, 0.005, 0.12), 0x7ad13c, [0, 0, -0.16])
      .lit(rod(0.03, 0.03, 0.06, 6), 0x9cff3b, [0, 0, 0.06])
      .lit(coneZ(0.014, 0.07, 5), 0xd4ff8a, [0, 0, 0.27]);
  },
  bottle(k) {
    BUILDERS.molotov(k);
  },
  vial(k) {
    BUILDERS.acid_vial(k);
  },
  bolt(k) {
    k.add(rod(0.022, 0.022, 0.72, 6), WOOD_D, [0, 0, -0.05])
      .add(coneZ(0.045, 0.12, 6), STEEL, [0, 0, 0.36])
      .add(box(0.006, 0.09, 0.14), 0xa64dff, [0, 0, -0.34])
      .add(box(0.09, 0.006, 0.14), 0xa64dff, [0, 0, -0.34])
      .lit(box(0.028, 0.028, 0.1), 0xd9a8ff, [0, 0, 0.27])
      .lit(coneZ(0.02, 0.08, 5), 0xf0e0ff, [0, 0, 0.44]);
  },
  arrow(k) {
    k.add(rod(0.016, 0.016, 0.92, 6), 0x2a2a2a, [0, 0, -0.05])
      .add(coneZ(0.04, 0.12, 6), STEEL, [0, 0, 0.46])
      .add(box(0.005, 0.09, 0.16), 0x9fd0ff, [0, 0, -0.42])
      .add(box(0.09, 0.005, 0.16), 0x3a8cff, [0, 0, -0.42])
      .lit(coneZ(0.02, 0.07, 5), 0xd8ecff, [0, 0, 0.55])
      .lit(ring(0.025, 0.008, Math.PI * 2, 8), 0x9fd0ff, [0, 0, 0.38]);
  },
  rocket(k) {
    k.add(rod(0.095, 0.095, 0.4, 10), 0x6b7a2f, [0, 0, -0.1])
      .add(lathe([[0.05, 0.06], [0.14, 0.12], [0.14, 0.24], [0.06, 0.33], [0, 0.35]], 10), 0xf2c430)
      .add(rod(0.11, 0.08, 0.06, 10), 0x4d5a20, [0, 0, -0.32])
      .lit(ring(0.14, 0.014, Math.PI * 2, 12), 0xff3b2e, [0, 0, 0.18])
      .lit(diamond(0.035), 0xffe070, [0, 0, 0.36])
      // Exhaust plume: long outer flame + white-hot core.
      .lit(coneZ(0.09, 0.46, 8), 0xff8a2e, [0, 0, -0.56], [Math.PI, 0, 0])
      .lit(coneZ(0.05, 0.3, 6), 0xfff0b0, [0, 0, -0.48], [Math.PI, 0, 0])
      .lit(ball(0.095, 8, 6), 0xffd060, [0, 0, -0.34]);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      k.add(box(0.016, 0.15, 0.14), 0x4d5a20, [Math.cos(a) * 0.12, Math.sin(a) * 0.12, -0.24], [0, 0, a]);
    }
  },
  firework(k) {
    k.add(rod(0.08, 0.08, 0.36, 10), 0xd8322a, [0, 0, -0.04])
      .add(rod(0.084, 0.084, 0.06, 10), 0x3fae4a, [0, 0, 0.0])
      .add(coneZ(0.09, 0.18, 10), 0x3fae4a, [0, 0, 0.23])
      .add(rod(0.01, 0.01, 0.42, 4), WOOD, [0.06, 0, -0.36])
      .lit(diamond(0.035), 0xffe070, [0.08, 0, -0.04], O, [0.5, 1, 1])
      .lit(diamond(0.035), 0xffe070, [-0.08, 0, -0.04], O, [0.5, 1, 1])
      .lit(coneZ(0.075, 0.38, 8), 0xffb02e, [0, 0, -0.4], [Math.PI, 0, 0])
      .lit(coneZ(0.04, 0.24, 6), 0xfff0b0, [0, 0, -0.33], [Math.PI, 0, 0])
      .lit(ball(0.07, 6, 4), 0xfff0a0, [0, 0, -0.22]);
  },
  kunai(k) {
    BUILDERS.storm_kunai(k);
  },
  ball(k) {
    k.add(new THREE.IcosahedronGeometry(0.16, 1), 0x6b6f76)
      .add(new THREE.IcosahedronGeometry(0.065, 0), 0x9aa0a8, [0.06, 0.09, 0.06])
      .lit(ring(0.15, 0.018, Math.PI * 2, 12), 0xffa040, [0, 0, -0.04]);
  },
  spark(k) {
    // Crackling electric sheath around a bright core (the core itself is the shell sprite).
    k.bolt([0, 0.1, -0.5], [0, -0.06, 0.3], 4, 0.1, 0x7ff3ff, 0.026, 1)
      .bolt([0.1, -0.05, -0.45], [-0.06, 0.05, 0.28], 4, 0.09, 0xbff9ff, 0.022, 2)
      .bolt([-0.1, 0, -0.4], [0.06, 0.02, 0.3], 3, 0.09, 0x7ff3ff, 0.022, 3)
      .bolt([0, -0.1, -0.35], [0.02, 0.08, 0.25], 3, 0.08, 0xbff9ff, 0.018, 4);
  },
  needle(k) {
    // Leech dart: a small syringe with a glowing serum chamber.
    k.add(rod(0.05, 0.05, 0.22, 8), 0xd8e6ee, [0, 0, -0.04])
      .add(rod(0.04, 0.02, 0.06, 8), 0xd8e6ee, [0, 0, 0.1])
      .add(rod(0.006, 0.004, 0.16, 5), STEEL, [0, 0, 0.21])
      .add(box(0.005, 0.1, 0.08), WHITE, [0, 0, -0.18])
      .add(box(0.1, 0.005, 0.08), WHITE, [0, 0, -0.18])
      .lit(rod(0.042, 0.042, 0.2, 8), 0x5dff5d, [0, 0, -0.04])
      .lit(diamond(0.02), 0xb0ffb0, [0, 0, 0.3]);
  },
  canister(k) {
    k.add(rod(0.1, 0.1, 0.3, 10), 0x1d2b5e, [0, 0, 0])
      .add(rod(0.11, 0.11, 0.04, 10), STEEL, [0, 0, -0.16])
      .add(rod(0.11, 0.11, 0.04, 10), STEEL, [0, 0, 0.16])
      .lit(ring(0.105, 0.016, Math.PI * 2, 12), 0x55e0ff, [0, 0, 0])
      .lit(rod(0.04, 0.03, 0.05, 6), 0xbff6ff, [0, 0, 0.2]);
  },
  barrel(k) {
    k.add(rod(0.16, 0.16, 0.38, 12), 0xffd400, [0, 0, 0])
      .add(ring(0.165, 0.02, Math.PI * 2, 12), 0x2a2a2a, [0, 0, -0.1])
      .add(ring(0.165, 0.02, Math.PI * 2, 12), 0x2a2a2a, [0, 0, 0.1])
      .lit(disc(0.13, 0.02, 12), 0x9cff2b, [0, 0, 0.195], [Math.PI / 2, 0, 0])
      .lit(ball(0.05, 6, 4), 0xb6ff3b, [0.08, 0.12, 0.2], O, [1, 1.6, 1]);
  },
  orb(k) {
    // Stun pulse ball: caged energy sphere wrapped in arcs.
    k.lit(new THREE.IcosahedronGeometry(0.14, 1), 0x6fc8ff)
      .lit(ring(0.19, 0.014, Math.PI * 2, 14), 0xbff0ff, O, [Math.PI / 2, 0, 0])
      .lit(ring(0.19, 0.014, Math.PI * 2, 14), 0x2f9dff, O, [0, Math.PI / 2, 0])
      .bolt([-0.22, 0.05, 0], [0.22, -0.05, 0.05], 3, 0.08, 0xbff0ff, 0.02, 1);
  },
  fireball(k) {
    k.lit(new THREE.IcosahedronGeometry(0.16, 1), 0xff7a1a)
      .lit(new THREE.IcosahedronGeometry(0.1, 0), 0xffe070, [0, 0, 0.04])
      .lit(coneZ(0.14, 0.42, 8), 0xff5a10, [0, 0, -0.28], [Math.PI, 0, 0])
      .lit(diamond(0.05), 0xffb040, [0.1, 0.08, -0.12])
      .lit(diamond(0.04), 0xff8a2a, [-0.1, -0.06, -0.18]);
  },
  lance(k) {
    // Ray-gun energy lance: a long bright needle of light with ring pulses.
    k.lit(rod(0.035, 0.05, 0.9, 6), 0x3dffc8, [0, 0, -0.1])
      .lit(coneZ(0.05, 0.16, 6), 0xc8fff6, [0, 0, 0.43])
      .lit(ring(0.08, 0.014, Math.PI * 2, 10), 0x3dffc8, [0, 0, 0.18])
      .lit(ring(0.07, 0.012, Math.PI * 2, 10), 0x3dffc8, [0, 0, -0.18]);
  },
  slug(k) {
    // Heavy cannon slug with a glowing driving band.
    k.add(lathe([[0, -0.22], [0.11, -0.22], [0.12, 0.05], [0.09, 0.16], [0.04, 0.22], [0, 0.23]], 10), STEEL_D)
      .lit(rod(0.125, 0.125, 0.05, 10), 0xb0a8ff, [0, 0, -0.1])
      .lit(disc(0.1, 0.02, 10), 0xffffff, [0, 0, -0.23], [Math.PI / 2, 0, 0]);
  },
};

const projectileCache = new Map<ProjectileModel, WeaponGeometry>();

/** Shared, cached in-flight projectile geometry (+Z = direction of travel). */
export function projectileGeometry(model: ProjectileModel): WeaponGeometry {
  let g = projectileCache.get(model);
  if (!g) {
    const kit = new Kit();
    PROJECTILE_BUILDERS[model](kit);
    g = kit.build();
    projectileCache.set(model, g);
  }
  return g;
}
