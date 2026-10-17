import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BARREL_LENGTH, CHASSIS_HALF, TURRET_HEIGHT, TWIN_BARREL_OFFSET, WHEEL_ANCHORS, physicsConfig, type CharacterId, type MapBiome, type Vec3, type WeaponId } from '@robot-arena/shared';

/** Which transform a part follows. */
export type SlotKind = 'chassis' | 'turret' | 'barrel' | 'wheel' | 'arm' | 'shock';

export type PartMaterial =
  | 'paint'
  | 'canvas'
  | 'steel'
  | 'barrel'
  | 'accent'
  | 'weapon'
  | 'number'
  | 'chrome'
  | 'rubber'
  | 'rim'
  | 'glass'
  | 'lamps'
  | 'emp'
  | 'leech'
  | 'repair'
  | 'nozzle';

export type AddonKey = 'plates' | 'boosters' | 'mines' | 'repair' | 'emp' | 'leech';

/**
 * A named, swappable robot part. Every robot in the fleet shares the part's
 * geometry; per-robot placement comes from the slot transform (× `locals[k]` when
 * a part repeats several times per robot). Swapping in a GLTF mesh means
 * replacing `geometry` (and optionally the material key) for a given name.
 */
export interface PartDef {
  name: string;
  slot: SlotKind;
  material: PartMaterial;
  geometry: THREE.BufferGeometry;
  castShadow: boolean;
  /** Per-robot local transforms within the slot; length = instances per robot. Absent = 1 instance at identity. */
  locals?: THREE.Matrix4[];
  addon?: AddonKey;
  variant?: 'single' | 'twin';
  character?: CharacterId;
  weapon?: WeaponId;
  biome?: MapBiome;
}

/** Turret pivot in chassis space and barrel mount in turret space. */
export const TURRET_MOUNT = new THREE.Vector3(0, TURRET_HEIGHT - 0.12, 0);
export const BARREL_MOUNT = new THREE.Vector3(0, 0.26, 0.4);
export const BARREL_TIP_Z = BARREL_LENGTH - 0.12;
export const TIRE_WIDTH = 0.34;

const m4 = new THREE.Matrix4();
const q4 = new THREE.Quaternion();
const e4 = new THREE.Euler();
const s4 = new THREE.Vector3();
const p4 = new THREE.Vector3();

function place(geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  q4.setFromEuler(e4.set(rx, ry, rz));
  m4.compose(p4.set(x, y, z), q4, s4.set(1, 1, 1));
  return geo.applyMatrix4(m4);
}

/** Box-projects UVs (1 texture repeat per `tile` metres) so detail maps keep a constant scale. */
function projectUV(geo: THREE.BufferGeometry, tile: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    let u: number, v: number;
    if (ay >= ax && ay >= az) {
      u = pos.getX(i);
      v = pos.getZ(i);
    } else if (ax >= az) {
      u = pos.getZ(i);
      v = pos.getY(i);
    } else {
      u = pos.getX(i);
      v = pos.getY(i);
    }
    uv[i * 2] = u / tile + 0.37;
    uv[i * 2 + 1] = v / tile + 0.21;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

function colorize(geo: THREE.BufferGeometry, r: number, g: number, b: number): THREE.BufferGeometry {
  const count = geo.getAttribute('position').count;
  const c = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    c[i * 3] = r;
    c[i * 3 + 1] = g;
    c[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/** Merges into one non-indexed geometry with a uniform attribute set. */
function merge(geos: THREE.BufferGeometry[], keepColor = false): THREE.BufferGeometry {
  const prepared = geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv' && !(keepColor && name === 'color')) n.deleteAttribute(name);
    }
    if (!n.getAttribute('uv')) n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n.getAttribute('position').count * 2), 2));
    return n;
  });
  const merged = mergeGeometries(prepared, false);
  if (!merged) throw new Error('Robot geometry merge failed');
  merged.computeBoundingSphere();
  return merged;
}

const rbox = (w: number, h: number, d: number, r: number, seg = 2): THREE.BufferGeometry => new RoundedBoxGeometry(w, h, d, seg, r);
const cyl = (rt: number, rb: number, h: number, seg = 16): THREE.BufferGeometry => new THREE.CylinderGeometry(rt, rb, h, seg);

// ---------------------------------------------------------------- chassis

function chassisParts(): PartDef[] {
  const H = CHASSIS_HALF;
  const paint: THREE.BufferGeometry[] = [];
  const steel: THREE.BufferGeometry[] = [];
  const chrome: THREE.BufferGeometry[] = [];
  const accent: THREE.BufferGeometry[] = [];
  const lamps: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];

  // Hull, hood, rear deck, fenders, side armor.
  paint.push(place(rbox(H.x * 1.9, 0.5, H.z * 1.9, 0.1, 3), 0, 0.02, 0));
  paint.push(place(rbox(1.3, 0.12, 0.72, 0.045), 0, 0.31, 0.62, -0.1));
  paint.push(place(rbox(1.42, 0.16, 0.62, 0.05), 0, 0.33, -0.72));
  for (const a of WHEEL_ANCHORS) {
    const sx = Math.sign(a.x);
    paint.push(place(rbox(0.46, 0.1, 0.98, 0.045), a.x * 0.98, 0.27, a.z, 0, 0, -sx * 0.12));
    steel.push(place(rbox(0.38, 0.05, 0.9, 0.02), a.x * 0.98, 0.2, a.z));
  }
  for (const sx of [-1, 1]) {
    paint.push(place(rbox(0.09, 0.32, 0.72, 0.03), sx * (H.x + 0.02), -0.02, 0));
    // Exhaust vents on the flanks.
    for (let i = 0; i < 4; i++) steel.push(place(rbox(0.04, 0.035, 0.32, 0.01), sx * (H.x + 0.07), 0.1 - i * 0.07, 0));
  }

  // Underbody frame, plow, bumper, vents, turret mount, axle housings.
  steel.push(place(new THREE.BoxGeometry(1.42, 0.12, 2.0), 0, -0.27, 0));
  steel.push(place(rbox(1.84, 0.38, 0.14, 0.04), 0, -0.08, H.z + 0.12, -0.55));
  for (const x of [-0.6, 0, 0.6]) steel.push(place(new THREE.BoxGeometry(0.06, 0.3, 0.12), x, -0.08, H.z + 0.04, -0.55));
  steel.push(place(rbox(1.5, 0.18, 0.16, 0.05), 0, -0.05, -H.z - 0.04));
  for (let i = 0; i < 5; i++) steel.push(place(new THREE.BoxGeometry(0.9, 0.025, 0.05), 0, 0.42, -0.5 - i * 0.09));
  steel.push(place(cyl(0.6, 0.62, 0.07, 32), TURRET_MOUNT.x, 0.4, TURRET_MOUNT.z));
  for (const a of WHEEL_ANCHORS) {
    steel.push(place(cyl(0.07, 0.07, 0.3, 10), a.x * 0.72, -0.15, a.z, 0, 0, Math.PI / 2));
    steel.push(place(new THREE.BoxGeometry(0.12, 0.2, 0.18), a.x * 0.62, 0.02, a.z));
  }

  // Chrome: plow edge, exhaust stacks, antenna, grab rails.
  chrome.push(place(new THREE.BoxGeometry(1.86, 0.035, 0.05), 0, -0.24, H.z + 0.21));
  for (const sx of [-1, 1]) {
    chrome.push(place(cyl(0.055, 0.065, 0.42, 12), sx * 0.34, 0.45, -1.02, -0.35));
    chrome.push(place(cyl(0.07, 0.055, 0.06, 12), sx * 0.34, 0.65, -1.09, -0.35));
    chrome.push(place(new THREE.TorusGeometry(0.11, 0.015, 6, 12, Math.PI), sx * 0.55, 0.42, -0.25, 0, Math.PI / 2, 0));
  }
  chrome.push(place(cyl(0.01, 0.016, 0.75, 6), -0.62, 0.72, -0.92));

  // Accent strips, antenna tip.
  for (const sx of [-1, 1]) accent.push(place(new THREE.BoxGeometry(0.03, 0.04, 1.7), sx * (H.x + 0.075), 0.17, 0));
  accent.push(place(new THREE.BoxGeometry(1.2, 0.035, 0.03), 0, 0.27, H.z + 0.02));
  accent.push(place(new THREE.BoxGeometry(1.2, 0.035, 0.03), 0, 0.24, -H.z - 0.12));
  accent.push(place(new THREE.SphereGeometry(0.04, 8, 6), -0.62, 1.1, -0.92));

  // Lamps (vertex-coloured, unlit HDR).
  for (const sx of [-1, 1]) {
    lamps.push(colorize(place(rbox(0.26, 0.08, 0.04, 0.015), sx * 0.5, 0.08, H.z + 0.01), 1, 0.97, 0.9));
    lamps.push(colorize(place(rbox(0.22, 0.07, 0.04, 0.015), sx * 0.55, 0.08, -H.z - 0.13), 1, 0.06, 0.05));
    lamps.push(colorize(place(new THREE.BoxGeometry(0.03, 0.05, 0.1), sx * (H.x + 0.08), 0.0, H.z * 0.8), 1, 0.45, 0.05));
  }

  glass.push(place(rbox(0.7, 0.15, 0.38, 0.05), 0, 0.44, 0.78, -0.12));

  const numberPlates: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const plane = new THREE.PlaneGeometry(0.46, 0.3);
    numberPlates.push(place(plane, sx * (H.x + 0.068), -0.02, 0, 0, sx * Math.PI / 2, 0));
  }

  return [
    { name: 'chassis.paint', slot: 'chassis', material: 'paint', geometry: merge(paint.map((g) => projectUV(g, 1.4))), castShadow: true },
    { name: 'chassis.steel', slot: 'chassis', material: 'steel', geometry: merge(steel.map((g) => projectUV(g, 1.0))), castShadow: true },
    { name: 'chassis.chrome', slot: 'chassis', material: 'chrome', geometry: merge(chrome), castShadow: false },
    { name: 'chassis.accent', slot: 'chassis', material: 'accent', geometry: merge(accent), castShadow: false },
    { name: 'chassis.lamps', slot: 'chassis', material: 'lamps', geometry: merge(lamps, true), castShadow: false },
    { name: 'chassis.glass', slot: 'chassis', material: 'glass', geometry: merge(glass), castShadow: false },
    { name: 'chassis.number', slot: 'chassis', material: 'number', geometry: merge(numberPlates), castShadow: false },
  ];
}

/** Rivets: one shared bolt-head geometry, instanced along hull edges. */
function rivetPart(): PartDef {
  const H = CHASSIS_HALF;
  const geo = new THREE.CylinderGeometry(0.022, 0.026, 0.02, 8);
  const locals: THREE.Matrix4[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const add = (x: number, y: number, z: number, nx: number, ny: number, nz: number): void => {
    const q = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(nx, ny, nz));
    locals.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1)));
  };
  for (let i = 0; i < 8; i++) {
    const z = -0.95 + i * 0.27;
    add(0.7, 0.275, z, 0, 1, 0);
    add(-0.7, 0.275, z, 0, 1, 0);
  }
  for (const sx of [-1, 1]) {
    for (const z of [-0.32, 0.32]) for (const y of [-0.13, 0.09]) add(sx * (H.x + 0.068), y, z, sx, 0, 0);
  }
  for (const x of [-0.55, -0.2, 0.2, 0.55]) add(x, 0.385, 0.97, 0, 0.99, 0.12);
  return { name: 'chassis.rivets', slot: 'chassis', material: 'steel', geometry: geo, castShadow: false, locals };
}

// ---------------------------------------------------------------- turret & barrels

function turretParts(): PartDef[] {
  const paint: THREE.BufferGeometry[] = [];
  const steel: THREE.BufferGeometry[] = [];
  const accent: THREE.BufferGeometry[] = [];
  const chrome: THREE.BufferGeometry[] = [];

  steel.push(place(cyl(0.5, 0.56, 0.2, 32), 0, 0, 0));
  steel.push(place(new THREE.TorusGeometry(0.53, 0.03, 8, 40), 0, 0.06, 0, Math.PI / 2));
  paint.push(place(rbox(0.86, 0.36, 0.92, 0.09, 3), 0, 0.26, -0.02));
  for (const sx of [-1, 1]) {
    paint.push(place(rbox(0.12, 0.3, 0.7, 0.04), sx * 0.47, 0.24, 0.02, 0, 0, sx * 0.18));
  }
  paint.push(place(rbox(0.42, 0.06, 0.36, 0.025), 0.12, 0.46, -0.15));
  steel.push(place(rbox(0.52, 0.26, 0.16, 0.04), 0, 0.26, 0.44));
  steel.push(place(new THREE.BoxGeometry(0.3, 0.12, 0.3), -0.18, 0.47, -0.3));
  accent.push(place(new THREE.BoxGeometry(0.5, 0.05, 0.03), 0, 0.33, 0.475));
  accent.push(place(new THREE.TorusGeometry(0.51, 0.018, 6, 40), 0, 0.11, 0, Math.PI / 2));
  chrome.push(place(cyl(0.06, 0.06, 0.08, 14), 0.3, 0.36, 0.45, Math.PI / 2));
  chrome.push(place(cyl(0.012, 0.012, 0.35, 6), -0.3, 0.6, -0.35));

  return [
    { name: 'turret.paint', slot: 'turret', material: 'paint', geometry: merge(paint.map((g) => projectUV(g, 1.2))), castShadow: true },
    { name: 'turret.steel', slot: 'turret', material: 'steel', geometry: merge(steel.map((g) => projectUV(g, 1.0))), castShadow: true },
    { name: 'turret.accent', slot: 'turret', material: 'accent', geometry: merge(accent), castShadow: false },
    { name: 'turret.chrome', slot: 'turret', material: 'chrome', geometry: merge(chrome), castShadow: false },
  ];
}

function barrelGeometry(x: number): { steel: THREE.BufferGeometry[]; chrome: THREE.BufferGeometry[] } {
  const len = BARREL_LENGTH - 0.25;
  const steel = [
    place(cyl(0.082, 0.1, len, 18), x, 0, len / 2, Math.PI / 2),
    place(cyl(0.11, 0.11, 0.18, 18), x, 0, 0.14, Math.PI / 2),
    place(cyl(0.095, 0.095, 0.06, 18), x, 0, len * 0.55, Math.PI / 2),
  ];
  const chrome = [place(cyl(0.12, 0.13, 0.2, 18), x, 0, len + 0.04, Math.PI / 2)];
  for (const s of [-1, 1]) chrome.push(place(new THREE.BoxGeometry(0.04, 0.06, 0.12), x + s * 0.12, 0, len + 0.04));
  return { steel, chrome };
}

function barrelParts(): PartDef[] {
  const single = barrelGeometry(0);
  const left = barrelGeometry(-TWIN_BARREL_OFFSET);
  const right = barrelGeometry(TWIN_BARREL_OFFSET);
  return [
    { name: 'barrel.single.steel', slot: 'barrel', material: 'barrel', geometry: merge(single.steel.map((g) => projectUV(g, 0.8))), castShadow: true, variant: 'single' },
    { name: 'barrel.single.chrome', slot: 'barrel', material: 'chrome', geometry: merge(single.chrome), castShadow: false, variant: 'single' },
    {
      name: 'barrel.twin.steel',
      slot: 'barrel',
      material: 'barrel',
      geometry: merge([...left.steel, ...right.steel].map((g) => projectUV(g, 0.8))),
      castShadow: true,
      variant: 'twin',
    },
    { name: 'barrel.twin.chrome', slot: 'barrel', material: 'chrome', geometry: merge([...left.chrome, ...right.chrome]), castShadow: false, variant: 'twin' },
  ];
}

// ---------------------------------------------------------------- wheels & suspension

function tireGeometry(): THREE.BufferGeometry {
  const R = physicsConfig.wheelRadius;
  const w = TIRE_WIDTH / 2;
  const profile: THREE.Vector2[] = [];
  const inner = R * 0.64;
  profile.push(new THREE.Vector2(inner, -w * 0.92));
  profile.push(new THREE.Vector2(R * 0.82, -w));
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
    profile.push(new THREE.Vector2(R - 0.05 + Math.cos(a) * 0.05, -w + 0.05 + Math.sin(a) * 0.05));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    profile.push(new THREE.Vector2(R - 0.05 + Math.cos(a) * 0.05, w - 0.05 + Math.sin(a) * 0.05));
  }
  profile.push(new THREE.Vector2(R * 0.82, w));
  profile.push(new THREE.Vector2(inner, w * 0.92));
  const body = new THREE.LatheGeometry(profile, 40).rotateZ(Math.PI / 2);
  const parts: THREE.BufferGeometry[] = [projectUV(body, 0.6)];
  // Chevron tread blocks.
  const blocks = 22;
  for (let i = 0; i < blocks; i++) {
    const a = (i / blocks) * Math.PI * 2;
    for (const s of [-1, 1]) {
      const b = new THREE.BoxGeometry(0.15, 0.04, 0.075);
      b.rotateY(s * 0.45);
      b.translate(s * 0.075, 0, 0);
      b.translate(0, R + 0.005, 0);
      b.rotateX(a + (s > 0 ? Math.PI / blocks : 0));
      parts.push(projectUV(b, 0.3));
    }
  }
  return merge(parts);
}

function rimGeometry(): THREE.BufferGeometry {
  const R = physicsConfig.wheelRadius * 0.62;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(place(new THREE.CylinderGeometry(R, R, TIRE_WIDTH * 0.86, 28, 1, true), 0, 0, 0, 0, 0, Math.PI / 2));
  for (const s of [-1, 1]) {
    parts.push(place(new THREE.TorusGeometry(R, 0.022, 6, 28), s * TIRE_WIDTH * 0.43, 0, 0, 0, Math.PI / 2, 0));
    parts.push(place(new THREE.CylinderGeometry(0.085, 0.085, 0.04, 14), s * 0.12, 0, 0, 0, 0, Math.PI / 2));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const spoke = new THREE.BoxGeometry(0.035, R - 0.06, 0.05);
      spoke.translate(0, (R + 0.06) / 2, 0);
      spoke.rotateX(a);
      spoke.translate(s * 0.12, 0, 0);
      parts.push(spoke);
    }
  }
  return merge(parts);
}

function wheelParts(): PartDef[] {
  const hub = merge([place(cyl(0.05, 0.05, TIRE_WIDTH + 0.04, 10), 0, 0, 0, 0, 0, Math.PI / 2)]);
  return [
    { name: 'wheel.tire', slot: 'wheel', material: 'rubber', geometry: tireGeometry(), castShadow: true },
    { name: 'wheel.rim', slot: 'wheel', material: 'rim', geometry: rimGeometry(), castShadow: false },
    { name: 'wheel.hub', slot: 'wheel', material: 'accent', geometry: hub, castShadow: false },
  ];
}

function suspensionParts(): PartDef[] {
  // Unit-length links along +X; the fleet scales/aims them between mount and hub every frame.
  const arm = merge([new THREE.BoxGeometry(1, 0.055, 0.11).translate(0.5, 0, 0)]);
  const shock = merge([
    new THREE.CylinderGeometry(0.035, 0.035, 1, 8).rotateZ(-Math.PI / 2).translate(0.5, 0, 0),
    new THREE.CylinderGeometry(0.06, 0.06, 0.45, 10, 1, true).rotateZ(-Math.PI / 2).translate(0.35, 0, 0),
  ]);
  return [
    { name: 'suspension.arm', slot: 'arm', material: 'steel', geometry: projectUV(arm, 0.5), castShadow: false },
    { name: 'suspension.shock', slot: 'shock', material: 'chrome', geometry: shock, castShadow: false },
  ];
}

// ---------------------------------------------------------------- add-ons

function addonParts(): PartDef[] {
  const H = CHASSIS_HALF;
  const plate = merge([
    projectUV(rbox(0.07, 0.4, 0.62, 0.02), 1),
    place(cyl(0.022, 0.022, 0.09, 6), 0.03, 0.14, 0.24, 0, 0, Math.PI / 2),
    place(cyl(0.022, 0.022, 0.09, 6), 0.03, -0.14, 0.24, 0, 0, Math.PI / 2),
    place(cyl(0.022, 0.022, 0.09, 6), 0.03, 0.14, -0.24, 0, 0, Math.PI / 2),
    place(cyl(0.022, 0.022, 0.09, 6), 0.03, -0.14, -0.24, 0, 0, Math.PI / 2),
  ]);
  const plateLocals = [
    [H.x + 0.13, -0.02, 0.36, 0],
    [-H.x - 0.13, -0.02, 0.36, Math.PI],
    [H.x + 0.13, -0.02, -0.4, 0],
    [-H.x - 0.13, -0.02, -0.4, Math.PI],
    [0, 0.05, H.z + 0.06, -Math.PI / 2],
  ].map(([x, y, z, ry]) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(1, 1, 1)));

  const boosterSteel: THREE.BufferGeometry[] = [];
  const boosterGlow: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    boosterSteel.push(place(cyl(0.14, 0.17, 0.75, 16), s * 0.42, H.y + 0.2, -H.z + 0.05, Math.PI / 2));
    boosterSteel.push(place(new THREE.TorusGeometry(0.16, 0.02, 6, 18), s * 0.42, H.y + 0.2, -H.z + 0.3));
    boosterGlow.push(place(cyl(0.12, 0.08, 0.08, 16), s * 0.42, H.y + 0.2, -H.z - 0.36, Math.PI / 2));
  }

  const mineRack: THREE.BufferGeometry[] = [];
  const mineLights: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    mineRack.push(place(cyl(0.16, 0.16, 0.08, 16), (i - 1) * 0.36, H.y + 0.44, -0.62, Math.PI / 2));
    mineLights.push(colorize(place(new THREE.SphereGeometry(0.035, 8, 6), (i - 1) * 0.36, H.y + 0.44, -0.67), 1, 0.08, 0.05));
  }

  const repair = merge([
    place(new THREE.BoxGeometry(0.2, 0.05, 0.06), 0.5, H.y + 0.45, -0.85),
    place(new THREE.BoxGeometry(0.06, 0.05, 0.2), 0.5, H.y + 0.45, -0.85),
  ]);
  const emp: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) emp.push(place(new THREE.TorusGeometry(0.2 - i * 0.04, 0.026, 8, 24), -0.2, 0.52 + i * 0.07, -0.2, Math.PI / 2));
  emp.push(place(new THREE.ConeGeometry(0.045, 0.3, 8), -0.2, 0.82, -0.2));
  const leech = merge([place(new THREE.IcosahedronGeometry(0.11, 1), 0.2, 0.55, -0.28)]);

  return [
    { name: 'addon.plates', slot: 'chassis', material: 'paint', geometry: plate, castShadow: true, locals: plateLocals, addon: 'plates' },
    { name: 'addon.boosters', slot: 'chassis', material: 'steel', geometry: merge(boosterSteel.map((g) => projectUV(g, 0.8))), castShadow: true, addon: 'boosters' },
    { name: 'addon.boosterGlow', slot: 'chassis', material: 'nozzle', geometry: merge(boosterGlow), castShadow: false, addon: 'boosters' },
    { name: 'addon.mineRack', slot: 'chassis', material: 'steel', geometry: merge(mineRack.map((g) => projectUV(g, 0.8))), castShadow: false, addon: 'mines' },
    { name: 'addon.mineLights', slot: 'chassis', material: 'lamps', geometry: merge(mineLights, true), castShadow: false, addon: 'mines' },
    { name: 'addon.repair', slot: 'chassis', material: 'repair', geometry: repair, castShadow: false, addon: 'repair' },
    { name: 'addon.empCoil', slot: 'turret', material: 'emp', geometry: merge(emp), castShadow: false, addon: 'emp' },
    { name: 'addon.leechCore', slot: 'turret', material: 'leech', geometry: leech, castShadow: false, addon: 'leech' },
  ];
}

/** Character trim stays close to the common chassis; every character keeps the same collision body. */
function characterParts(): PartDef[] {
  const fin = new THREE.Shape();
  fin.moveTo(-0.3, 0);
  fin.lineTo(0.28, 0);
  fin.lineTo(-0.17, 0.64);
  fin.closePath();
  const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.055, bevelEnabled: false }).rotateY(Math.PI / 2);
  const strikerFins = [-1, 1].map((s) => place(finGeo.clone(), s * 0.62, 0.32, -0.65));
  finGeo.dispose();
  const strikerWing = [place(rbox(1.65, 0.1, 0.3, 0.025), 0, 0.7, -0.84)];
  for (const s of [-1, 1]) strikerWing.push(place(new THREE.BoxGeometry(0.04, 0.2, 0.14), s * 0.55, 0.49, -0.84));

  const bulwarkArmor: THREE.BufferGeometry[] = [];
  const bulwarkTrim: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    bulwarkArmor.push(place(rbox(0.27, 0.55, 1.05, 0.045), s * 0.68, 0.25, -0.1, 0, 0, -s * 0.12));
    bulwarkTrim.push(place(new THREE.BoxGeometry(0.025, 0.08, 0.65), s * 0.8, 0.3, -0.1));
  }
  bulwarkArmor.push(place(rbox(1.36, 0.38, 0.15, 0.045), 0, 0.07, 1.05, -0.2));
  const shield = new THREE.Shape();
  shield.moveTo(-0.19, 0.18); shield.lineTo(0.19, 0.18); shield.lineTo(0.17, -0.08); shield.lineTo(0, -0.23); shield.lineTo(-0.17, -0.08); shield.closePath();
  const shieldGeo = new THREE.ExtrudeGeometry(shield, { depth: 0.035, bevelEnabled: false }).translate(0, 0.14, 1.15);

  const spectreMast = [
    place(cyl(0.018, 0.025, 0.52, 8), 0.27, 0.7, -0.28),
    place(new THREE.TorusGeometry(0.18, 0.025, 6, 24), 0.27, 0.96, -0.28, 0, Math.PI / 4),
    place(rbox(0.22, 0.14, 0.38, 0.03), -0.29, 0.52, 0.08),
  ];
  const spectreTrim = [place(new THREE.SphereGeometry(0.055, 10, 8), 0.27, 0.96, -0.28)];
  for (const s of [-1, 1]) spectreTrim.push(place(new THREE.BoxGeometry(0.035, 0.035, 0.82), s * 0.62, 0.35, -0.32, 0, s * 0.2));
  return [
    { name: 'character.striker.fins', character: 'striker', slot: 'chassis', material: 'paint', geometry: merge(strikerFins), castShadow: true },
    { name: 'character.striker.spoiler', character: 'striker', slot: 'chassis', material: 'accent', geometry: merge(strikerWing), castShadow: true },
    { name: 'character.bulwark.armor', character: 'bulwark', slot: 'chassis', material: 'paint', geometry: merge(bulwarkArmor), castShadow: true },
    { name: 'character.bulwark.shield', character: 'bulwark', slot: 'chassis', material: 'accent', geometry: merge([...bulwarkTrim, shieldGeo]), castShadow: false },
    { name: 'character.bulwark.mantlet', character: 'bulwark', slot: 'turret', material: 'paint', geometry: place(rbox(1.32, 0.46, 0.25, 0.06), 0, 0.28, 0.28), castShadow: true },
    { name: 'character.spectre.sensors', character: 'spectre', slot: 'turret', material: 'chrome', geometry: merge(spectreMast), castShadow: true },
    { name: 'character.spectre.signal', character: 'spectre', slot: 'chassis', material: 'accent', geometry: merge(spectreTrim.slice(1)), castShadow: false },
    { name: 'character.spectre.sensorLight', character: 'spectre', slot: 'turret', material: 'accent', geometry: spectreTrim[0], castShadow: false },
  ];
}

/** Distinct weapon housings share the same muzzle point and aim transform. */
function weaponParts(): PartDef[] {
  const result: PartDef[] = [];
  const tip = BARREL_TIP_Z - 0.12;
  for (const weapon of ['pulse', 'scatter', 'rail', 'repeater'] as const) {
    const shell: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];
    switch (weapon) {
      case 'pulse':
        for (const z of [0.42, 0.7, 0.98]) glow.push(place(new THREE.TorusGeometry(0.135, 0.025, 6, 20), 0, 0, z));
        shell.push(place(rbox(0.28, 0.24, 0.48, 0.035), 0, 0, 0.36));
        break;
      case 'scatter':
        shell.push(place(rbox(0.4, 0.3, 0.66, 0.05), 0, 0, 0.86));
        for (const x of [-0.13, 0, 0.13]) glow.push(place(cyl(0.045, 0.045, 0.07, 10), x, 0, tip, Math.PI / 2));
        break;
      case 'rail':
        for (const s of [-1, 1]) {
          shell.push(place(rbox(0.075, 0.19, 1.08, 0.018), s * 0.155, 0, 0.73));
          glow.push(place(new THREE.BoxGeometry(0.025, 0.055, 0.95), s * 0.115, 0.06, 0.76));
        }
        shell.push(place(rbox(0.2, 0.12, 0.33, 0.02), 0, 0.2, 0.2));
        break;
      case 'repeater':
        shell.push(place(cyl(0.25, 0.25, 0.36, 12), 0, -0.06, 0.38, Math.PI / 2));
        for (let i = 0; i < 4; i++) {
          const a = i * Math.PI / 2;
          shell.push(place(cyl(0.04, 0.04, 0.65, 10), Math.cos(a) * 0.13, Math.sin(a) * 0.13, 0.94, Math.PI / 2));
          glow.push(place(cyl(0.04, 0.04, 0.035, 10), Math.cos(a) * 0.13, Math.sin(a) * 0.13, tip, Math.PI / 2));
        }
        break;
    }
    for (const [material, geos] of [['barrel', shell], ['weapon', glow]] as const) {
      const geometry = merge(geos);
      result.push({ name: `weapon.${weapon}.${material}.single`, weapon, slot: 'barrel', material, geometry, castShadow: material === 'barrel', variant: 'single' });
      result.push({ name: `weapon.${weapon}.${material}.twin`, weapon, slot: 'barrel', material, geometry, castShadow: material === 'barrel', variant: 'twin', locals: [new THREE.Matrix4().makeTranslation(-TWIN_BARREL_OFFSET, 0, 0), new THREE.Matrix4().makeTranslation(TWIN_BARREL_OFFSET, 0, 0)] });
    }
  }
  return result;
}

/** Expedition fittings change the silhouette without moving any gameplay mount. */
function biomeParts(): PartDef[] {
  const result: PartDef[] = [];
  const add = (biome: MapBiome, detail: string, material: PartMaterial, pieces: THREE.BufferGeometry[]): void => {
    result.push({ name: `biome.${biome}.${detail}`, biome, slot: 'chassis', material, geometry: merge(pieces.map((g) => projectUV(g, 1.1))), castShadow: material !== 'accent' });
  };

  const heatArmor: THREE.BufferGeometry[] = [];
  const vents: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    heatArmor.push(place(rbox(0.24, 0.16, 0.86, 0.04), s * 0.94, 0.38, -0.65, 0, 0, -s * 0.2));
    for (let i = 0; i < 4; i++) vents.push(place(new THREE.BoxGeometry(0.16, 0.025, 0.045), s * 0.94, 0.48, -0.91 + i * 0.17, 0, 0, -s * 0.2));
    heatArmor.push(place(rbox(0.32, 0.16, 0.42, 0.03), s * 0.55, 0.43, 0.84, -0.16, 0, s * 0.18));
  }
  add('volcanic', 'heatShields', 'paint', heatArmor);
  add('volcanic', 'heatVents', 'accent', vents);

  const leaf = new THREE.Shape();
  leaf.moveTo(0, -0.38);
  leaf.quadraticCurveTo(0.29, -0.1, 0, 0.42);
  leaf.quadraticCurveTo(-0.29, -0.1, 0, -0.38);
  const leafGeo = new THREE.ExtrudeGeometry(leaf, { depth: 0.035, bevelEnabled: false }).rotateX(-Math.PI / 2);
  const leaves: THREE.BufferGeometry[] = [];
  const veins: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      leaves.push(place(leafGeo.clone(), s * 0.95, 0.38 + i * 0.055, -0.65 + i * 0.43, 0, s * (0.3 + i * 0.2), -s * 0.3));
      veins.push(place(new THREE.BoxGeometry(0.018, 0.018, 0.43), s * 0.95, 0.43 + i * 0.055, -0.65 + i * 0.43, 0, s * (0.3 + i * 0.2), -s * 0.3));
    }
  }
  leafGeo.dispose();
  add('forest', 'camouflageLeaves', 'canvas', leaves);
  add('forest', 'leafVeins', 'paint', veins);

  const canvas = [place(rbox(1.02, 0.21, 0.4, 0.1, 3), 0, 0.49, -1.0)];
  const dustPlates: THREE.BufferGeometry[] = [];
  const straps: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    canvas.push(place(rbox(0.33, 0.16, 0.56, 0.06), s * 0.9, 0.39, 0.64, -0.1, 0, -s * 0.12));
    dustPlates.push(place(rbox(0.1, 0.24, 0.48, 0.02), s * 1.08, -0.01, -1.02, -0.2, 0, -s * 0.1));
    straps.push(place(new THREE.BoxGeometry(0.055, 0.024, 0.44), s * 0.32, 0.605, -1.0));
  }
  add('desert', 'canvasPacks', 'canvas', canvas);
  add('desert', 'dustGuards', 'paint', dustPlates);
  add('desert', 'packStraps', 'steel', straps);

  const insulation: THREE.BufferGeometry[] = [];
  const frost: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    insulation.push(place(rbox(0.37, 0.18, 0.86, 0.075, 3), s * 0.95, 0.39, -0.56));
    insulation.push(place(rbox(0.38, 0.15, 0.4, 0.055), s * 0.51, 0.42, 0.86, -0.12));
    for (let i = 0; i < 3; i++) frost.push(place(new THREE.ConeGeometry(0.055, 0.2 + i * 0.04, 5), s * (0.84 + i * 0.1), 0.57, -0.9 + i * 0.15, s * 0.3, 0, -s * 0.35));
  }
  add('arctic', 'insulatedPanels', 'canvas', insulation);
  add('arctic', 'iceCrystals', 'accent', frost);

  const tablets: THREE.BufferGeometry[] = [];
  const runes: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    tablets.push(place(rbox(0.27, 0.12, 0.74, 0.035), s * 0.96, 0.39, -0.55, 0, 0, -s * 0.15));
    for (let i = 0; i < 3; i++) {
      const z = -0.79 + i * 0.24;
      runes.push(place(new THREE.BoxGeometry(0.11, 0.018, 0.018), s * 0.96, 0.465, z, 0, Math.PI / 4));
      runes.push(place(new THREE.BoxGeometry(0.018, 0.018, 0.11), s * 0.96, 0.465, z, 0, Math.PI / 4));
    }
  }
  tablets.push(place(new THREE.TorusGeometry(0.15, 0.042, 6, 4), 0, 0.405, 0.9, -Math.PI / 2, 0, Math.PI / 4));
  add('ancient', 'bronzeTablets', 'paint', tablets);
  add('ancient', 'etchedRunes', 'accent', runes);

  const aerial = [
    place(cyl(0.016, 0.025, 0.78, 8), -0.83, 0.82, -0.93, 0.12),
    place(new THREE.TorusGeometry(0.13, 0.018, 6, 16), -0.83, 1.15, -0.97, Math.PI / 2),
    place(rbox(0.36, 0.18, 0.58, 0.03), 0.88, 0.39, -0.69),
  ];
  const signal = [place(new THREE.SphereGeometry(0.045, 8, 6), -0.83, 1.22, -0.98)];
  for (let i = 0; i < 3; i++) signal.push(place(new THREE.BoxGeometry(0.25, 0.018, 0.018), 0.88, 0.49, -0.89 + i * 0.19));
  add('urban', 'surveyAerial', 'paint', aerial);
  add('urban', 'signalBands', 'accent', signal);
  return result;
}

export function buildRobotParts(): PartDef[] {
  return [...chassisParts(), rivetPart(), ...turretParts(), ...barrelParts(), ...wheelParts(), ...suspensionParts(), ...addonParts(), ...characterParts(), ...weaponParts(), ...biomeParts()];
}

/** Chassis-space mount points for the suspension links (lower arm + shock top). */
export function suspensionMounts(anchor: Vec3): { arm: THREE.Vector3; shock: THREE.Vector3 } {
  const sx = Math.sign(anchor.x);
  return {
    arm: new THREE.Vector3(sx * 0.5, -0.2, anchor.z),
    shock: new THREE.Vector3(sx * 0.62, 0.16, anchor.z - 0.1),
  };
}

/** Boost exhaust pipe tips and rocket nozzles in chassis space (for particle emitters). */
export const EXHAUST_TIPS: readonly THREE.Vector3[] = [new THREE.Vector3(0.34, 0.69, -1.11), new THREE.Vector3(-0.34, 0.69, -1.11)];
export const NOZZLE_TIPS: readonly THREE.Vector3[] = [
  new THREE.Vector3(0.42, CHASSIS_HALF.y + 0.2, -CHASSIS_HALF.z - 0.45),
  new THREE.Vector3(-0.42, CHASSIS_HALF.y + 0.2, -CHASSIS_HALF.z - 0.45),
];
/** Panels damage sparks can erupt from (chassis space). */
export const DAMAGE_POINTS: readonly THREE.Vector3[] = [
  new THREE.Vector3(0.6, 0.38, 0.5),
  new THREE.Vector3(-0.55, 0.36, -0.3),
  new THREE.Vector3(0.0, 0.42, -0.75),
  new THREE.Vector3(0.88, 0.1, -0.2),
  new THREE.Vector3(-0.88, 0.05, 0.4),
];
