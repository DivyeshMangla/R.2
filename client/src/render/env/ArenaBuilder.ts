import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ARENA_BLOCKS, ARENA_HALF_SIZE, BARRIER_HEIGHT, PLATFORM_HALF, PLATFORM_HEIGHT, type ArenaBlock } from '@robot-arena/shared';
import { concreteTextures, floorTextures, hazardTextures, metalPanelTextures, treadPlateTextures, type SurfaceTextures } from '../ProceduralTextures';
import { ScoreboardScreen } from './ScoreboardScreen';

/** Everything the game needs from the arena after it is built. */
export interface ArenaVisuals {
  group: THREE.Group;
  scoreboard: ScoreboardScreen;
  /** Points on the hanging cables that spit sparks now and then. */
  sparkPoints: readonly THREE.Vector3[];
  update(time: number, dt: number): void;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** Accumulates transformed geometry per material and merges it into one mesh (one draw call). */
class Batch {
  private readonly geos: THREE.BufferGeometry[] = [];
  constructor(readonly name: string, readonly material: THREE.Material, readonly castShadow: boolean, private readonly withColor = false) {}

  add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4 | null, color?: THREE.Color): void {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    if (this.withColor) {
      const n = g.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      const c = color ?? _c.set(1, 1, 1);
      for (let i = 0; i < n; i++) {
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    geo.dispose();
    this.geos.push(g);
  }

  build(group: THREE.Group): THREE.Mesh | null {
    if (this.geos.length === 0) return null;
    const merged = mergeGeometries(this.geos, false);
    for (const g of this.geos) g.dispose();
    if (!merged) return null;
    const mesh = new THREE.Mesh(merged, this.material);
    mesh.name = `arena.${this.name}`;
    mesh.castShadow = this.castShadow;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }
}

/** Rewrites UVs in world units (triplanar-style box mapping) so textures tile evenly. */
function worldUVs(geo: THREE.BufferGeometry, tile: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  let uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) {
    uv = new THREE.Float32BufferAttribute(new Float32Array(pos.count * 2), 2);
    geo.setAttribute('uv', uv);
  }
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i));
    if (ny > 0.5) uv.setXY(i, x / tile, z / tile);
    else if (nx > 0.5) uv.setXY(i, z / tile, y / tile);
    else uv.setXY(i, x / tile, y / tile);
  }
  uv.needsUpdate = true;
  return geo;
}

function blockMatrix(b: ArenaBlock): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(b.center.x, b.center.y, b.center.z), new THREE.Quaternion(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w), new THREE.Vector3(1, 1, 1));
}

function surface(tex: SurfaceTextures, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map: tex.map, roughnessMap: tex.roughnessMap, normalMap: tex.normalMap ?? null, emissiveMap: tex.emissiveMap ?? null, ...params });
}

/** Transformed box placed in world space with world-unit UVs. */
function box(w: number, h: number, d: number, x: number, y: number, z: number, yaw = 0, tile = 2): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.applyMatrix4(_m.compose(_p.set(x, y, z), _q.setFromAxisAngle(_s.set(0, 1, 0), yaw), _s.set(1, 1, 1)));
  return worldUVs(g, tile);
}

function crateTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.fillStyle = '#4a4f38';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const v = Math.random() < 0.5 ? 255 : 0;
    ctx.fillStyle = `rgba(${v},${v},${v},${0.03 + Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  ctx.strokeStyle = '#2a2d20';
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, size - 14, size - 14);
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(14, 14);
  ctx.lineTo(size - 14, size - 14);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,190,40,0.85)';
  ctx.font = 'bold 34px monospace';
  ctx.fillText('R-ARENA', 40, size - 40);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

/** Builds the industrial pit around the shared collider layout. */
export function buildArena(anisotropy: number): ArenaVisuals {
  const group = new THREE.Group();
  group.name = 'Arena';
  const H = ARENA_HALF_SIZE;

  const floorTex = floorTextures(anisotropy);
  const panelTex = metalPanelTextures(anisotropy, [70, 76, 86]);
  const hazardTex = hazardTextures(anisotropy);
  const treadTex = treadPlateTextures(anisotropy);
  const concreteTex = concreteTextures(anisotropy);

  const floorMat = surface(floorTex, { roughness: 0.82, metalness: 0.4, emissive: new THREE.Color(0x2bd6ff), emissiveIntensity: 0.55, normalScale: new THREE.Vector2(0.7, 0.7) });
  const batches = {
    floor: new Batch('floor', floorMat, false),
    hazard: new Batch('hazard', surface(hazardTex, { roughness: 0.75, metalness: 0.2 }), false),
    panel: new Batch('panels', surface(panelTex, { roughness: 0.5, metalness: 0.8, envMapIntensity: 1.1 }), true),
    tread: new Batch('tread', surface(treadTex, { roughness: 0.45, metalness: 0.85, envMapIntensity: 1.2 }), true),
    concrete: new Batch('concrete', surface(concreteTex, { roughness: 0.95, metalness: 0.05 }), true),
    steel: new Batch('steel', new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.55, metalness: 0.85 }), true),
    trim: new Batch('trim', new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true }), false, true),
  };
  const trimMaterial = batches.trim.material as THREE.MeshBasicMaterial;
  const amber = new THREE.Color(0xffb020).multiplyScalar(3);
  const cyan = new THREE.Color(0x19d3ff).multiplyScalar(3.5);
  const pink = new THREE.Color(0xff3b6b).multiplyScalar(3);
  const lime = new THREE.Color(0x7dff4a).multiplyScalar(2.4);
  const violet = new THREE.Color(0xb66bff).multiplyScalar(3.5);
  const lampWhite = new THREE.Color(0xfff2d0).multiplyScalar(8);

  // ---------------------------------------------------------------- gameplay blocks (match colliders exactly)
  for (const b of ARENA_BLOCKS) {
    const geo = new THREE.BoxGeometry(b.half.x * 2, b.half.y * 2, b.half.z * 2);
    const m = blockMatrix(b);
    switch (b.kind) {
      case 'floor':
        geo.applyMatrix4(m);
        batches.floor.add(worldUVs(geo, 8), null);
        break;
      case 'barrier':
        geo.applyMatrix4(m);
        batches.panel.add(worldUVs(geo, 2.4), null);
        break;
      case 'platform':
        geo.applyMatrix4(m);
        batches.panel.add(worldUVs(geo, 3.5), null);
        break;
      case 'ramp':
      case 'jump':
        geo.applyMatrix4(m);
        batches.tread.add(worldUVs(geo, 2), null);
        addRampRails(batches.trim, b, b.kind === 'jump' ? amber : lime);
        break;
      case 'cover':
        geo.dispose();
        batches.concrete.add(jerseyBarrier(b), null);
        break;
      case 'pillar':
        geo.dispose();
        addMachineColumn(batches, b, violet);
        break;
    }
  }

  // Hazard border strips just inside the barriers, and around the platform top.
  for (let side = 0; side < 4; side++) {
    const yaw = (side * Math.PI) / 2;
    const d = H - 0.75;
    batches.hazard.add(box(H * 2 - 1.5, 0.02, 1.2, Math.sin(yaw) * d, 0.011, Math.cos(yaw) * d, yaw, 1.2), null);
    const e = PLATFORM_HALF - 0.3;
    batches.hazard.add(box(PLATFORM_HALF * 2 - 0.6, 0.02, 0.5, Math.sin(yaw) * e, PLATFORM_HEIGHT + 0.011, Math.cos(yaw) * e, yaw, 0.6), null);
    // Platform edge lights + barrier top trims.
    batches.trim.add(box(PLATFORM_HALF * 2, 0.06, 0.08, Math.sin(yaw) * (PLATFORM_HALF + 0.01), PLATFORM_HEIGHT - 0.12, Math.cos(yaw) * (PLATFORM_HALF + 0.01), yaw), null, cyan);
    batches.trim.add(box(H * 2 + 2.4, 0.08, 1.22, Math.sin(yaw) * (H + 0.6), BARRIER_HEIGHT + 0.04, Math.cos(yaw) * (H + 0.6), yaw), null, amber);
    // Barrier support ribs on the outside face (never inside the play area).
    for (let k = -6; k <= 6; k++) {
      const along = k * 6.5;
      const out = H + 1.45;
      const x = Math.sin(yaw) * out + Math.cos(yaw) * along;
      const z = Math.cos(yaw) * out - Math.sin(yaw) * along;
      batches.steel.add(box(0.35, BARRIER_HEIGHT + 0.6, 0.5, x, (BARRIER_HEIGHT + 0.6) / 2, z, yaw), null);
    }
  }
  // Platform emblem rings.
  const ring = (r0: number, r1: number, color: THREE.Color): void => {
    const g = new THREE.RingGeometry(r0, r1, 96);
    g.rotateX(-Math.PI / 2);
    g.translate(0, PLATFORM_HEIGHT + 0.014, 0);
    batches.trim.add(g, null, color);
  };
  ring(3.2, 3.45, cyan);
  ring(1.2, 1.3, pink);

  // ---------------------------------------------------------------- perimeter industry (outside the barriers)
  const crates: THREE.Matrix4[] = [];
  const fans: { x: number; y: number; z: number; r: number; speed: number; axis: 'y' | 'z'; yaw: number }[] = [];
  const warn: THREE.Vector3[] = [];
  for (let side = 0; side < 4; side++) {
    const yaw = (side * Math.PI) / 2;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    // Machinery blocks with exhaust fans, between the barrier and the stands.
    for (const along of [-24, 8, 30]) {
      const d = H + 4.2;
      const x = fx * d + rx * along, z = fz * d + rz * along;
      batches.panel.add(box(5, 2.8, 2.6, x, 1.4, z, yaw, 2), null);
      batches.steel.add(box(5.2, 0.25, 2.8, x, 2.92, z, yaw), null);
      batches.steel.add(new THREE.CylinderGeometry(0.9, 0.9, 0.5, 24).translate(x + rx * 1.2, 3.2, z + rz * 1.2), null);
      fans.push({ x: x + rx * 1.2, y: 3.5, z: z + rz * 1.2, r: 0.8, speed: 7 + Math.random() * 5, axis: 'y', yaw: 0 });
      batches.trim.add(box(4.6, 0.06, 0.06, x - fx * 1.32, 2.4, z - fz * 1.32, yaw), null, side % 2 ? cyan : amber);
      warn.push(new THREE.Vector3(x - rx * 2, 3.1, z - rz * 2));
    }
    // Crate stacks.
    for (const along of [-10, 18, 36]) {
      for (let k = 0; k < 5; k++) {
        const d = H + 3.6 + (k % 2) * 1.6;
        const a = along + Math.floor(k / 2) * 1.7;
        const level = k === 4 ? 1 : 0;
        const s = 1.5;
        _m.compose(
          _p.set(fx * d + rx * a, s / 2 + level * s, fz * d + rz * a),
          _q.setFromAxisAngle(_s.set(0, 1, 0), yaw + (Math.random() - 0.5) * 0.3),
          _s.set(s, s, s),
        );
        crates.push(_m.clone());
      }
    }
    // Tiered stands, pushed back behind the machinery.
    for (let tier = 0; tier < 3; tier++) {
      const depth = 4;
      const dist = H + 10 + tier * depth;
      const h = 3 + tier * 2.4;
      const len = dist * 2;
      batches.steel.add(box(len, h, depth, fx * dist, h / 2, fz * dist, yaw), null);
      batches.trim.add(box(len, 0.06, 0.06, fx * (dist - depth / 2), h + 0.03, fz * (dist - depth / 2), yaw), null, cyan);
    }
  }

  // Floodlight towers with additive light cones, cables between them.
  const coneGeos: THREE.BufferGeometry[] = [];
  const towerTops: THREE.Vector3[] = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const) {
    // Diagonally behind the outermost stand tier.
    const d = H + 22;
    const x = sx * d, z = sz * d;
    batches.steel.add(new THREE.CylinderGeometry(0.5, 0.85, 26, 12).translate(x, 13, z), null);
    batches.steel.add(box(5, 0.4, 1.6, x, 25.9, z, Math.atan2(-x, -z)), null);
    const top = new THREE.Vector3(x, 26.5, z);
    towerTops.push(top);
    const yaw = Math.atan2(-x, -z);
    batches.trim.add(box(4.4, 1.2, 0.2, x - Math.sin(yaw) * 0.85, 26.6, z - Math.cos(yaw) * 0.85, yaw), null, lampWhite);
    // Light cone: from the lamp toward the arena centre.
    const len = Math.hypot(x, 26, z) * 0.8;
    const cone = new THREE.ConeGeometry(9, len, 24, 1, true);
    cone.translate(0, -len / 2, 0);
    const dir = new THREE.Vector3(-x, -26, -z).normalize();
    cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir));
    cone.translate(top.x, top.y, top.z);
    coneGeos.push(cone);
  }
  const cones = new THREE.Mesh(
    mergeGeometries(coneGeos.map((g) => g.toNonIndexed()), false) ?? new THREE.BufferGeometry(),
    new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 0.16 } },
      vertexShader: /* glsl */ `
        varying float vH;
        varying vec3 vN; varying vec3 vV;
        void main() {
          vH = uv.y;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uIntensity; uniform float uTime;
        varying float vH; varying vec3 vN; varying vec3 vV;
        void main() {
          float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.5);
          float a = vH * vH * edge * uIntensity * (0.95 + 0.05 * sin(uTime * 13.0));
          gl_FragColor = vec4(vec3(1.0, 0.93, 0.78) * a, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  cones.name = 'arena.lightCones';
  cones.renderOrder = 5;
  for (const g of coneGeos) g.dispose();
  group.add(cones);

  // Sagging cables between neighbouring towers; sparks at frayed points.
  const sparkPoints: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const a = towerTops[i], b = towerTops[(i + 1) % 4];
    const mid = a.clone().lerp(b, 0.5);
    mid.y -= 7;
    const curve = new THREE.QuadraticBezierCurve3(a.clone().setY(a.y - 1), mid, b.clone().setY(b.y - 1));
    batches.steel.add(new THREE.TubeGeometry(curve, 40, 0.07, 5, false), null);
    sparkPoints.push(curve.getPoint(0.37), curve.getPoint(0.71));
  }

  // Cooling towers far outside (hyperboloid lathe).
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    profile.push(new THREE.Vector2(7 - 3.2 * Math.sin(t * Math.PI * 0.85), t * 30));
  }
  for (const [x, z] of [[78, 24], [-74, -36], [30, -82]] as const) {
    const lathe = new THREE.LatheGeometry(profile, 40);
    lathe.translate(x, 0, z);
    batches.concrete.add(worldUVs(lathe, 4), null);
    batches.trim.add(new THREE.TorusGeometry(4.2, 0.08, 6, 48).rotateX(Math.PI / 2).translate(x, 29.5, z), null, amber);
  }

  // Merge every batch: one draw call per material.
  for (const b of Object.values(batches)) b.build(group);

  // Crates: one instanced draw.
  const crateMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ map: crateTexture(anisotropy), roughness: 0.8, metalness: 0.15 }),
    crates.length,
  );
  crates.forEach((m, i) => crateMesh.setMatrixAt(i, m));
  crateMesh.castShadow = true;
  crateMesh.receiveShadow = true;
  crateMesh.name = 'arena.crates';
  group.add(crateMesh);

  // Fans: one instanced draw, rotated per frame.
  const bladeGeo = mergeGeometries(
    [0, 1, 2, 3, 4].map((k) => new THREE.BoxGeometry(0.16, 0.04, 0.75).translate(0, 0, 0.38).rotateY((k / 5) * Math.PI * 2).toNonIndexed()),
    false,
  ) ?? new THREE.BufferGeometry();
  const fanMesh = new THREE.InstancedMesh(bladeGeo, new THREE.MeshStandardMaterial({ color: 0x8a919b, roughness: 0.35, metalness: 0.9 }), fans.length);
  fanMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  fanMesh.name = 'arena.fans';
  group.add(fanMesh);

  // Blinking warning lights: one instanced draw.
  for (let side = 0; side < 4; side++) {
    const yaw = (side * Math.PI) / 2;
    for (let k = -3; k <= 3; k++) {
      const along = k * 12 + 6;
      warn.push(new THREE.Vector3(Math.sin(yaw) * (H + 0.6) + Math.cos(yaw) * along, BARRIER_HEIGHT + 0.2, Math.cos(yaw) * (H + 0.6) - Math.sin(yaw) * along));
    }
  }
  const warnMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.14, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), warn.length);
  warnMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(warn.length * 3), 3);
  warn.forEach((p, i) => warnMesh.setMatrixAt(i, _m.makeTranslation(p.x, p.y, p.z)));
  warnMesh.name = 'arena.warningLights';
  group.add(warnMesh);
  const warnPhase = warn.map(() => Math.random() * Math.PI * 2);

  const scoreboard = new ScoreboardScreen(10.5, 5.5);
  group.add(scoreboard.mesh);

  const floorBase = floorMat.emissiveIntensity;
  const warnColor = new THREE.Color(1, 0.35, 0.05);
  return {
    group,
    scoreboard,
    sparkPoints,
    update(time: number, dt: number) {
      void dt;
      floorMat.emissiveIntensity = floorBase + Math.sin(time * 0.9) * 0.12;
      trimMaterial.color.setScalar(0.92 + Math.sin(time * 2.2) * 0.08);
      (cones.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
      for (let i = 0; i < fans.length; i++) {
        const f = fans[i];
        _m.compose(_p.set(f.x, f.y, f.z), _q.setFromAxisAngle(_s.set(0, 1, 0), time * f.speed), _s.set(f.r * 1.4, 1, f.r * 1.4));
        fanMesh.setMatrixAt(i, _m);
      }
      fanMesh.instanceMatrix.needsUpdate = true;
      for (let i = 0; i < warn.length; i++) {
        const on = Math.sin(time * 3 + warnPhase[i]) > 0.2 ? 6 : 0.25;
        warnMesh.setColorAt(i, _c.copy(warnColor).multiplyScalar(on));
      }
      if (warnMesh.instanceColor) warnMesh.instanceColor.needsUpdate = true;
      scoreboard.update(time);
    },
  };
}

/** Jersey-barrier profile extruded along the cover block (fits inside its collider box). */
function jerseyBarrier(b: ArenaBlock): THREE.BufferGeometry {
  const w = b.half.z, h = b.half.y * 2, len = b.half.x * 2;
  const s = new THREE.Shape();
  s.moveTo(-w, 0);
  s.lineTo(w, 0);
  s.lineTo(w, h * 0.12);
  s.lineTo(w * 0.42, h * 0.3);
  s.lineTo(w * 0.3, h);
  s.lineTo(-w * 0.3, h);
  s.lineTo(-w * 0.42, h * 0.3);
  s.lineTo(-w, h * 0.12);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false });
  g.translate(0, -b.half.y, -len / 2);
  // Extrusion axis (z) -> block local x; profile width (x) -> block local z.
  g.rotateY(Math.PI / 2);
  g.computeVertexNormals();
  g.applyMatrix4(blockMatrix(b));
  return worldUVs(g, 1.2);
}

/** Pillar collider dressed as a machinery column: panels, ribs, vents and light strips. */
function addMachineColumn(batches: { panel: Batch; steel: Batch; trim: Batch }, b: ArenaBlock, glow: THREE.Color): void {
  const cx = b.center.x, cy = b.center.y, cz = b.center.z;
  const hx = b.half.x, hy = b.half.y, hz = b.half.z;
  batches.panel.add(box(hx * 2, hy * 2, hz * 2, cx, cy, cz, 0, 2.4), null);
  // Corner ribs sit flush on the corners (inside the collider footprint + 3 cm).
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    batches.steel.add(box(0.2, hy * 2, 0.2, cx + sx * (hx - 0.07), cy, cz + sz * (hz - 0.07)), null);
    batches.trim.add(box(0.06, hy * 1.5, 0.06, cx + sx * (hx + 0.01), cy, cz + sz * (hz - 0.35)), null, glow);
  }
  // Cap with a vent housing.
  batches.steel.add(box(hx * 2 + 0.1, 0.25, hz * 2 + 0.1, cx, cy + hy + 0.12, cz), null);
  batches.steel.add(new THREE.CylinderGeometry(0.55, 0.75, 0.35, 20).translate(cx, cy + hy + 0.42, cz), null);
}

function addRampRails(trim: Batch, b: ArenaBlock, color: THREE.Color): void {
  const q = new THREE.Quaternion(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w);
  const center = new THREE.Vector3(b.center.x, b.center.y, b.center.z);
  for (const side of [-1, 1]) {
    const local = new THREE.Vector3(side * (b.half.x - 0.05), b.half.y + 0.03, 0);
    const g = new THREE.BoxGeometry(0.1, 0.06, b.half.z * 2 - 0.2);
    g.applyMatrix4(new THREE.Matrix4().compose(local.applyQuaternion(q).add(center), q, new THREE.Vector3(1, 1, 1)));
    trim.add(g, null, color);
  }
}
