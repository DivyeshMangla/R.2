import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ARENA_HALF_SIZE, getArenaDefinition, getMap, type ArenaBlock, type MapDef, type MapId } from '@robot-arena/shared';
import { ScoreboardScreen } from './ScoreboardScreen';

export interface ArenaVisuals {
  group: THREE.Group;
  scoreboard: ScoreboardScreen;
  sparkPoints: readonly THREE.Vector3[];
  update(time: number, dt: number): void;
}

/** Landscapes merge into a handful of material batches regardless of prop count. */
class GeometryBatch {
  private readonly geometries: THREE.BufferGeometry[] = [];
  constructor(readonly name: string, readonly material: THREE.Material, readonly shadow = true) {}

  add(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, matrix?: THREE.Matrix4): void {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    geometry.dispose();
    if (matrix) g.applyMatrix4(matrix);
    for (const key of Object.keys(g.attributes)) if (key !== 'position' && key !== 'normal' && key !== 'uv') g.deleteAttribute(key);
    const count = g.getAttribute('position').count;
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    const c = new THREE.Color(color);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geometries.push(g);
  }

  build(group: THREE.Group, ink: THREE.BufferGeometry[]): void {
    if (!this.geometries.length) return;
    const merged = mergeGeometries(this.geometries, false);
    for (const geometry of this.geometries) geometry.dispose();
    if (!merged) throw new Error(`Cannot merge biome batch ${this.name}`);
    const mesh = new THREE.Mesh(merged, this.material);
    mesh.name = `biome.${this.name}`;
    mesh.castShadow = this.shadow;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (this.name !== 'accents' && this.name !== 'ground') ink.push(new THREE.EdgesGeometry(merged, 28));
  }
}

type Batches = Record<'ground' | 'stone' | 'dark' | 'foliage' | 'detail' | 'glow', GeometryBatch>;
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function tone(color: number, value: number): THREE.Color { return new THREE.Color(color).multiplyScalar(value); }
function box(w: number, h: number, d: number, x: number, y: number, z: number, yaw = 0): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).rotateY(yaw).translate(x, y, z);
}
function matrixFor(block: ArenaBlock): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(block.center.x, block.center.y, block.center.z), new THREE.Quaternion(block.rotation.x, block.rotation.y, block.rotation.z, block.rotation.w), new THREE.Vector3(1, 1, 1));
}
function worldUV(geometry: THREE.BufferGeometry, tile: number): THREE.BufferGeometry {
  const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(n.getY(i)) > 0.5) uv.setXY(i, p.getX(i) / tile, p.getZ(i) / tile);
    else if (Math.abs(n.getX(i)) > 0.5) uv.setXY(i, p.getZ(i) / tile, p.getY(i) / tile);
    else uv.setXY(i, p.getX(i) / tile, p.getY(i) / tile);
  }
  return geometry;
}

/** Subtle drawn detail leaves the large terrain colors readable from a distance. */
function terrainTexture(map: Readonly<MapDef>, anisotropy: number, stone = false): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const rng = random(stone ? 71 : 179);
  ctx.fillStyle = '#e7e5df'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1900; i++) {
    ctx.fillStyle = `rgba(${rng() > 0.5 ? '255,255,255' : '50,45,35'},${0.025 + rng() * 0.055})`;
    ctx.fillRect(rng() * 256, rng() * 256, 1 + rng() * 4, 1 + rng() * 2);
  }
  ctx.strokeStyle = 'rgba(30,40,45,0.12)'; ctx.lineWidth = stone ? 2 : 1;
  if (stone || map.biome === 'urban' || map.biome === 'ancient') {
    for (let y = 0; y < 256; y += 64) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
      for (let x = (y / 64) % 2 ? 32 : 0; x < 256; x += 64) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 64); ctx.stroke(); }
    }
  } else if (map.biome === 'desert') {
    ctx.strokeStyle = 'rgba(110,75,20,0.11)';
    for (let y = -20; y < 280; y += 15) {
      ctx.beginPath();
      for (let x = 0; x <= 256; x += 8) ctx.lineTo(x, y + Math.sin(x * 0.025 + y) * 6);
      ctx.stroke();
    }
  } else if (map.biome === 'forest') {
    ctx.strokeStyle = 'rgba(45,70,35,0.17)';
    for (let i = 0; i < 110; i++) {
      const x = rng() * 256, y = rng() * 256;
      ctx.beginPath(); ctx.moveTo(x - 2, y); ctx.lineTo(x, y - 6); ctx.lineTo(x + 3, y); ctx.stroke();
    }
  } else {
    ctx.strokeStyle = map.biome === 'arctic' ? 'rgba(55,130,160,0.11)' : 'rgba(40,20,10,0.22)';
    for (let i = 0; i < 55; i++) {
      const x = rng() * 256, y = rng() * 256;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + rng() * 25, y + 10); ctx.lineTo(x + 20, y + 26); ctx.stroke();
    }
  }
  // Broken diagonal pen strokes sit over the painted terrain instead of glossy noise.
  ctx.strokeStyle = 'rgba(34,28,25,0.15)'; ctx.lineWidth = 1.4;
  for (let i = 0; i < 75; i++) {
    const x = rng() * 256, y = rng() * 256, length = 5 + rng() * 14;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + length, y - length * 0.6 + rng()); ctx.stroke();
    if (i % 3 === 0) { ctx.beginPath(); ctx.moveTo(x + 1, y + 4); ctx.lineTo(x + length + 1, y - length * 0.6 + 4); ctx.stroke(); }
  }
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.anisotropy = anisotropy;
  return texture;
}

/** Inside the boundary, solid-looking obstacles always follow a shared collider exactly. */
function addGameplay(b: Batches, block: ArenaBlock, map: Readonly<MapDef>): void {
  const p = map.palette, transform = matrixFor(block);
  const geometry = new THREE.BoxGeometry(block.half.x * 2, block.half.y * 2, block.half.z * 2).applyMatrix4(transform);
  const isFloor = block.kind === 'floor', isRamp = block.kind === 'ramp' || block.kind === 'jump';
  const stoneColor = block.kind === 'pillar' && map.biome === 'forest' ? 0x796045 : isRamp ? tone(p.stone, 1.15) : p.stone;
  (isFloor ? b.ground : b.stone).add(worldUV(geometry, isFloor ? 8 : 5), isFloor ? p.ground : stoneColor);
  if (isFloor) return;
  const top = block.half.y;
  if (block.kind === 'platform' || isRamp) {
    for (const side of [-1, 1]) b.detail.add(new THREE.BoxGeometry(0.13, 0.018, Math.max(0.2, block.half.z * 2 - 0.1)).translate(side * (block.half.x - 0.15), top + 0.012, 0), tone(p.accent, 0.72), transform);
    if (block.kind === 'platform') b.detail.add(new THREE.BoxGeometry(block.half.x * 2 - 0.1, 0.025, 0.15).translate(0, top + 0.012, block.half.z - 0.15), p.accent, transform);
    if (map.biome === 'desert' || map.biome === 'volcanic') {
      for (const y of [-0.4, 0.12]) if (Math.abs(y) < block.half.y) b.dark.add(new THREE.BoxGeometry(block.half.x * 2 + 0.012, 0.05, block.half.z * 2 + 0.012).translate(0, y, 0), tone(p.stone, 0.68), transform);
    }
  }
  if (block.kind === 'cover' || block.kind === 'barrier') {
    b.detail.add(new THREE.BoxGeometry(block.half.x * 2, 0.12, block.half.z * 2 + 0.02).translate(0, top - 0.08, 0), tone(p.stone, 1.22), transform);
    b.dark.add(new THREE.BoxGeometry(block.half.x * 1.65, 0.035, block.half.z * 2 + 0.025), tone(p.stone, 0.6), transform);
  }
  if (block.kind === 'pillar') {
    b.detail.add(new THREE.BoxGeometry(block.half.x * 2, 0.2, block.half.z * 2).translate(0, top - 0.1, 0), tone(p.stone, 1.25), transform);
    if (map.biome === 'forest') {
      const position = new THREE.Vector3(0, top, 0).applyMatrix4(transform);
      canopy(b, position.x, position.y + 1.6, position.z, 2.6, p.foliage, 1);
    } else for (const side of [-1, 1]) b.glow.add(new THREE.BoxGeometry(0.045, block.half.y * 1.25, 0.055).translate(side * (block.half.x - 0.15), 0, block.half.z + 0.015), tone(p.accent, map.biome === 'urban' || map.biome === 'volcanic' ? 1.7 : 0.9), transform);
  }
}

function canopy(b: Batches, x: number, y: number, z: number, radius: number, color: number, seed: number): void {
  const rng = random(seed);
  for (let i = 0; i < 4; i++) {
    const a = i * 2.399, r = i === 0 ? 0 : radius * 0.5;
    b.foliage.add(new THREE.DodecahedronGeometry(radius * (0.65 + rng() * 0.2), 0).scale(1, 0.85, 1).rotateY(rng() * 3).translate(x + Math.cos(a) * r, y + (i === 0 ? radius * 0.4 : 0), z + Math.sin(a) * r), tone(color, 0.8 + rng() * 0.4));
  }
}
function tree(b: Batches, x: number, z: number, size: number, map: Readonly<MapDef>, seed: number): void {
  const snow = map.biome === 'arctic';
  b.dark.add(new THREE.CylinderGeometry(0.2 * size, 0.34 * size, 3.8 * size, 5).translate(x, 1.9 * size, z), snow ? 0x566b69 : 0x69513d);
  if (snow) for (let i = 0; i < 3; i++) {
    const y = (2.8 + i * 1.2) * size, r = (2.2 - i * 0.52) * size;
    b.foliage.add(new THREE.ConeGeometry(r, 3 * size, 7).translate(x, y, z), map.palette.foliage);
    b.detail.add(new THREE.ConeGeometry(r * 0.95, 2 * size, 7).translate(x, y + 0.65 * size, z), 0xf0f8f5);
  } else canopy(b, x, 4.7 * size, z, 2.9 * size, map.palette.foliage, seed);
}
function crystal(b: Batches, x: number, y: number, z: number, size: number, color: number): void {
  for (let i = 0; i < 3; i++) {
    const s = size * (i === 0 ? 1 : 0.65);
    b.detail.add(new THREE.CylinderGeometry(0, 0.42 * s, 2.7 * s, 5).translate(0, 1.35 * s, 0).rotateZ((i - 1) * 0.3).translate(x + (i - 1) * size * 0.42, y, z), tone(color, i === 1 ? 1.22 : 0.88));
  }
}
function arch(b: Batches, x: number, z: number, height: number, yaw: number, map: Readonly<MapDef>, broken = false): void {
  const color = map.palette.stone, m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, 0, z);
  for (const side of [-1, 1]) {
    const h = broken && side === 1 ? height * 0.6 : height;
    b.stone.add(new THREE.CylinderGeometry(0.9, 1.05, h, 8).translate(side * 3.4, h / 2, 0), tone(color, 0.9), m);
    b.detail.add(box(2.5, 0.55, 2.5, side * 3.4, 0.3, 0), tone(color, 1.2), m);
    b.detail.add(box(2.5, 0.55, 2.5, side * 3.4, h, 0), tone(color, 1.2), m);
  }
  if (!broken) b.stone.add(box(9.4, 1.3, 2.3, 0, height + 0.7, 0), color, m);
}
function mesa(b: Batches, x: number, z: number, height: number, radius: number, map: Readonly<MapDef>): void {
  for (let i = 0; i < 4; i++) {
    const r = radius * (1 - i * 0.12);
    b.stone.add(new THREE.CylinderGeometry(r * 0.9, r, height / 4 + 0.1, 7).rotateY(i * 0.03).translate(x, height * (i + 0.5) / 4, z), tone(map.palette.stone, 0.86 + i * 0.09));
  }
}
function mountain(b: Batches, x: number, z: number, height: number, radius: number, snowy: boolean, map: Readonly<MapDef>): void {
  // Large mountain feet must clear the walls too, including the diagonal corners.
  const scale = Math.max(1, (ARENA_HALF_SIZE + 3 + radius) / Math.max(Math.abs(x), Math.abs(z)));
  x *= scale; z *= scale;
  b.stone.add(new THREE.ConeGeometry(radius, height, 6).rotateY(x * 0.2).translate(x, height / 2 - 1, z), tone(map.palette.stone, 0.75));
  if (snowy) b.detail.add(new THREE.ConeGeometry(radius * 0.47, height * 0.47, 6).rotateY(x * 0.2).translate(x, height * 0.765 - 0.85, z), 0xf3fbff);
}
function building(b: Batches, x: number, z: number, height: number, width: number, yaw: number, map: Readonly<MapDef>): void {
  b.stone.add(box(width, height, width * 0.8, x, height / 2, z, yaw), tone(map.palette.stone, 0.8));
  b.detail.add(box(width + 0.35, 0.5, width * 0.8 + 0.35, x, height, z, yaw), tone(map.palette.stone, 1.35));
  for (let y = 2; y < height - 1; y += 2.2) for (let k = -1; k <= 1; k++) {
    const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, 0, z);
    b.glow.add(box(width * 0.2, 0.75, 0.03, k * width * 0.28, y, -width * 0.4 - 0.02), tone(map.palette.accent, 0.8), m);
  }
}

/** Exterior placement is derived from the real arena boundary, independent of each prop's size. */
function addLandscape(b: Batches, map: Readonly<MapDef>): THREE.Vector3[] {
  const rng = random(129 + map.id.length * 29), sparks: THREE.Vector3[] = [], p = map.palette;
  const h = ARENA_HALF_SIZE, island = (h + 9) * Math.SQRT2;
  const rim = (angle: number, margin: number): [number, number] => {
    const x = Math.cos(angle), z = Math.sin(angle), distance = (h + margin) / Math.max(Math.abs(x), Math.abs(z));
    return [x * distance, z * distance];
  };
  b.dark.add(new THREE.CylinderGeometry(island, island - 8, 12, 8).rotateY(Math.PI / 8).translate(0, -7, 0), tone(p.stone, 0.62));
  b.stone.add(new THREE.CylinderGeometry(island, island + 0.5, 2, 8).rotateY(Math.PI / 8).translate(0, -1.5, 0), tone(p.ground, 0.92));
  const sceneryCount = Math.ceil(h * 1.7);
  for (let i = 0; i < sceneryCount; i++) {
    const a = i / sceneryCount * Math.PI * 2, [x, z] = rim(a, 7 + rng() * 11);
    b.stone.add(new THREE.DodecahedronGeometry(1.3 + rng() * 2, 0).scale(1.3, 0.7 + rng(), 1).rotateY(a).translate(x, -0.25, z), tone(p.stone, 0.75 + rng() * 0.45));
  }
  switch (map.biome) {
    case 'forest':
      for (let i = 0; i < sceneryCount; i++) {
        const [x, z] = rim(rng() * Math.PI * 2, 10 + rng() * 24);
        tree(b, x, z, 0.8 + rng() * 0.8, map, i + 7);
      }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const x = sx * (h + 9), z = sz * (h + 7);
        b.dark.add(box(5.8, 0.8, 0.85, x, 0.5, z, 0.5), 0x755b3b);
        for (let i = 0; i < 6; i++) b.detail.add(new THREE.DodecahedronGeometry(0.5, 0).translate(x + rng() * 3, 0.5, z + rng() * 3), i % 2 ? 0xf5ce65 : 0xe9b7ce);
      }
      break;
    case 'desert':
      for (let i = 0; i < 14; i++) {
        const [x, z] = rim(i / 14 * Math.PI * 2, 18 + rng() * 18);
        mesa(b, x, z, 9 + rng() * 15, 7 + rng() * 5, map);
      }
      for (let i = 0; i < 7; i++) b.stone.add(box(24 - i * 2.8, 1.5, 24 - i * 2.8, 0, i * 1.45 + 0.7, -h - 26), tone(p.stone, 0.85 + i * 0.04));
      arch(b, 0, -h - 10, 6.5, 0, map);
      for (let i = 0; i < sceneryCount / 2; i++) {
        const [x, z] = rim(rng() * Math.PI * 2, 7 + rng() * 12), height = 1.8 + rng() * 1.8;
        b.foliage.add(new THREE.CylinderGeometry(0.28, 0.34, height, 6).translate(x, height / 2, z), p.foliage);
        b.foliage.add(new THREE.CylinderGeometry(0.18, 0.18, 1.2, 6).rotateZ(Math.PI / 2).translate(x + 0.45, height * 0.5, z), p.foliage);
        b.foliage.add(new THREE.CylinderGeometry(0.18, 0.2, 0.9, 6).translate(x + 0.95, height * 0.5 + 0.35, z), p.foliage);
      }
      break;
    case 'arctic':
      for (let i = 0; i < 24; i++) {
        const [x, z] = rim(i / 24 * Math.PI * 2, 28 + rng() * 14);
        mountain(b, x, z, 15 + rng() * 20, 9 + rng() * 7, true, map);
      }
      for (let i = 0; i < sceneryCount; i++) {
        const [x, z] = rim(rng() * Math.PI * 2, 10 + rng() * 15);
        tree(b, x, z, 0.7 + rng() * 0.7, map, i);
        if (i % 4 === 0) crystal(b, x - 2, 0, z - 1, 1.4, p.accent);
      }
      break;
    case 'ancient':
      for (const side of [-1, 1]) for (const along of [-h * 0.65, 0, h * 0.65]) {
        arch(b, side * (h + 10), along, 8.5, Math.PI / 2, map, side < 0 && along !== 0);
        arch(b, along, side * (h + 10), 8.5, 0, map, side > 0 && along !== 0);
      }
      for (const side of [-1, 1]) {
        const x = side * (h + 11), z = -side * (h + 11);
        for (let i = 0; i < 3; i++) b.stone.add(box(15 - i * 3, 1.4, 15 - i * 3, x, i * 1.4 + 0.7, z), tone(p.stone, 0.9 + i * 0.1));
        b.stone.add(new THREE.CylinderGeometry(0.9, 2.2, 12, 4).rotateZ(0.07).translate(x, 9, z), p.stone);
        b.glow.add(new THREE.OctahedronGeometry(1.1, 0).translate(x - 0.7, 15, z), tone(p.accent, 1.1));
      }
      for (let i = 0; i < sceneryCount; i++) {
        const [x, z] = rim(rng() * Math.PI * 2, 8 + rng() * 12);
        b.foliage.add(new THREE.DodecahedronGeometry(1.4, 0).scale(1.6, 0.5, 1).translate(x, 0.5, z), p.foliage);
        if (i % 4 === 0) b.detail.add(new THREE.CylinderGeometry(0.5, 0.55, 4, 8).rotateZ(1.1).translate(x, 0.5, z), tone(p.stone, 1.2));
      }
      break;
    case 'volcanic':
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const x = sx * (h + 8), z = sz * (h + 8);
        b.stone.add(box(8, 11, 8, x, 5.2, z), p.stone);
        b.detail.add(box(9.2, 0.8, 9.2, x, 10.7, z), tone(p.stone, 1.35));
        for (const dx of [-3.6, 0, 3.6]) for (const dz of [-3.6, 3.6]) b.stone.add(box(1.3, 1.4, 1.3, x + dx, 11.6, z + dz), p.stone);
        const flame = new THREE.Vector3(x - sx * 3, 6.5, z - sz * 3);
        b.glow.add(new THREE.OctahedronGeometry(0.7, 0).scale(0.6, 1.8, 0.6).translate(flame.x, flame.y, flame.z), tone(p.accent, 1.8));
        sparks.push(flame);
      }
      mountain(b, -h - 32, -h - 30, 34, 22, false, map);
      b.glow.add(new THREE.TorusGeometry(3.1, 0.65, 5, 18).rotateX(Math.PI / 2).translate(-h - 32, 28, -h - 30), tone(p.accent, 2));
      for (let i = 0; i < 22; i++) {
        const [x, z] = rim(i / 22 * Math.PI * 2, 24 + rng() * 14);
        mountain(b, x, z, 7 + rng() * 16, 5 + rng() * 8, false, map);
      }
      break;
    case 'urban':
      for (let side = 0; side < 4; side++) {
        const a = side * Math.PI / 2;
        for (let along = -h + 10; along <= h - 10; along += 14) {
          const x = Math.sin(a) * (h + 10) + Math.cos(a) * along, z = Math.cos(a) * (h + 10) - Math.sin(a) * along;
          building(b, x, z, 9 + rng() * 18, 6 + rng() * 2, a, map);
        }
      }
      for (const side of [-1, 1]) {
        const x = side * (h + 20), z = -h * 0.3;
        b.detail.add(box(0.9, 19, 1.1, x, 9.5, z), 0xe6b45f);
        b.detail.add(box(12, 0.7, 0.9, x - side * 3, 18, z), 0xe6b45f);
        b.dark.add(box(0.08, 7, 0.08, x - side * 8, 14, z), 0x435c6d);
        for (let i = 0; i < 3; i++) b.stone.add(box(5.5, 2.5, 2.6, x, 1.25, z + 5 + i * 3), tone(i % 2 ? p.accent : p.foliage, 0.7));
      }
      break;
  }
  return sparks;
}

function surroundingSurface(map: Readonly<MapDef>): THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial> {
  const lava = map.biome === 'volcanic', water = ['ancient', 'urban', 'arctic'].includes(map.biome);
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(lava ? 0xcc3e16 : water ? (map.biome === 'arctic' ? 0x609cad : 0x3b8e94) : map.palette.ground) }, uAccent: { value: new THREE.Color(map.palette.accent) }, uLava: { value: lava ? 1 : 0 }, uWater: { value: water ? 1 : 0 } },
    vertexShader: `varying vec3 vWorld; void main(){vec4 p=modelMatrix*vec4(position,1.);vWorld=p.xyz;gl_Position=projectionMatrix*viewMatrix*p;}`,
    fragmentShader: `uniform float uTime;uniform vec3 uColor;uniform vec3 uAccent;uniform float uLava;uniform float uWater;varying vec3 vWorld;
      void main(){float wave=sin(vWorld.x*.22+uTime*.45)*sin(vWorld.z*.28-uTime*.3);float ripple=pow(max(0.,sin(vWorld.x*.6+vWorld.z*.4+wave*2.)),12.);vec3 col=uColor*(.92+wave*.06)+uAccent*ripple*(uLava*.7+uWater*.12);gl_FragColor=vec4(col,1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(ARENA_HALF_SIZE * 3 + 60, 64).rotateX(-Math.PI / 2), material);
  mesh.position.y = -6;
  mesh.name = lava ? 'biome.lava' : water ? 'biome.water' : 'biome.outerTerrain';
  return mesh;
}

export function buildBiomeArena(anisotropy: number, mapId: MapId = 'foundry'): ArenaVisuals {
  const map = getMap(mapId), definition = getArenaDefinition(mapId), group = new THREE.Group();
  group.name = `Arena:${map.id}:${map.biome}`;
  const base = { vertexColors: true, flatShading: true, roughness: 1, metalness: 0 };
  const batches: Batches = {
    ground: new GeometryBatch('ground', new THREE.MeshStandardMaterial({ ...base, map: terrainTexture(map, anisotropy) }), false),
    stone: new GeometryBatch('stone', new THREE.MeshStandardMaterial({ ...base, map: terrainTexture(map, anisotropy, true) })),
    dark: new GeometryBatch('structure', new THREE.MeshStandardMaterial(base)),
    foliage: new GeometryBatch('foliage', new THREE.MeshStandardMaterial({ ...base, roughness: 1 })),
    detail: new GeometryBatch('details', new THREE.MeshStandardMaterial(base)),
    glow: new GeometryBatch('accents', new THREE.MeshBasicMaterial({ vertexColors: true }), false),
  };
  for (const batch of Object.values(batches)) {
    if (batch.material instanceof THREE.MeshStandardMaterial) batch.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        outgoingLight = floor(max(outgoingLight, vec3(0.0)) * 7.0 + 0.5) / 7.0;
        #include <opaque_fragment>`);
    };
  }
  for (const block of definition.blocks) addGameplay(batches, block, map);
  const sparkPoints = addLandscape(batches, map);
  if (map.biome === 'urban') for (const side of [-1, 1]) for (let d = -ARENA_HALF_SIZE + 6; d < ARENA_HALF_SIZE - 5; d += 5) {
    batches.detail.add(box(0.1, 0.012, 1.6, side * 3.1, 0.012, d), tone(map.palette.accent, 0.8));
    batches.detail.add(box(1.6, 0.012, 0.1, d, 0.012, side * 3.1), tone(map.palette.accent, 0.8));
  }
  const ink: THREE.BufferGeometry[] = [];
  for (const batch of Object.values(batches)) batch.build(group, ink);
  const edges = mergeGeometries(ink, false);
  for (const geometry of ink) geometry.dispose();
  if (edges) {
    const outlines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x302b29, transparent: true, opacity: 0.8, depthWrite: false }));
    outlines.name = 'biome.ink';
    outlines.renderOrder = 1;
    group.add(outlines);
  }
  group.userData.colliderCount = definition.blocks.length;
  group.userData.arenaHalfSize = ARENA_HALF_SIZE;
  const surround = surroundingSurface(map); group.add(surround);
  const scoreboard = new ScoreboardScreen(13, 5, mapId); group.add(scoreboard.mesh);
  return { group, scoreboard, sparkPoints, update(time: number, dt: number) { void dt; surround.material.uniforms.uTime.value = time; scoreboard.update(time); } };
}
