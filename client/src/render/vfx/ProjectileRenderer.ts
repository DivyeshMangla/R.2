import * as THREE from 'three';
import { projectileGeometry, type ProjectileModel } from '../WeaponModels';

export const MAX_PROJECTILES = 128;
/** Points per trail (history ring length). Shells use up to this many (see `trailLen`). */
export const TRAIL_POINTS = 24;
/** Base ribbon half-width in metres at sizeMul 1. */
const TRAIL_WIDTH = 0.16;

const VERTS_PER_TRAIL = TRAIL_POINTS * 2;
/** Floats per ribbon vertex: side, along, alpha, r | g, b, width, smoke. */
const INFO_STRIDE = 8;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _euler = new THREE.Euler();
const Z = new THREE.Vector3(0, 0, 1);
const X = new THREE.Vector3(1, 0, 0);
const _spin = new THREE.Quaternion();

/** How a modelled projectile animates around its travel direction. */
export type ProjectileSpin = 'none' | 'tumble' | 'roll' | 'wobble';

/**
 * Per-model display tuning: uniform scale (at sizeMul 1), spin style and rate
 * (rad/s), and whether the glow part flickers (electric sheaths, exhaust).
 */
const MODEL_STYLE: Record<ProjectileModel, { scale: number; spin: ProjectileSpin; rate: number; flicker?: 'all' | 'glow' }> = {
  blade: { scale: 0.9, spin: 'tumble', rate: 22 },
  dart: { scale: 1.1, spin: 'roll', rate: 14 },
  bottle: { scale: 0.75, spin: 'tumble', rate: 9 },
  vial: { scale: 0.8, spin: 'tumble', rate: 11 },
  bolt: { scale: 1, spin: 'none', rate: 0 },
  arrow: { scale: 1, spin: 'roll', rate: 6 },
  rocket: { scale: 1.1, spin: 'roll', rate: 5, flicker: 'glow' },
  firework: { scale: 1, spin: 'wobble', rate: 18, flicker: 'glow' },
  kunai: { scale: 0.75, spin: 'roll', rate: 16 },
  ball: { scale: 1, spin: 'tumble', rate: 7 },
  spark: { scale: 1, spin: 'roll', rate: 31, flicker: 'all' },
  needle: { scale: 1, spin: 'roll', rate: 12 },
  canister: { scale: 0.9, spin: 'tumble', rate: 10 },
  barrel: { scale: 0.9, spin: 'tumble', rate: 6 },
  orb: { scale: 1, spin: 'roll', rate: 24, flicker: 'all' },
  fireball: { scale: 1, spin: 'roll', rate: 9, flicker: 'glow' },
  lance: { scale: 1, spin: 'roll', rate: 20, flicker: 'glow' },
  slug: { scale: 1, spin: 'roll', rate: 12 },
};
const MODELS = Object.keys(MODEL_STYLE) as ProjectileModel[];

interface ModelBatch {
  model: ProjectileModel;
  body: THREE.InstancedMesh | null;
  glow: THREE.InstancedMesh | null;
  count: number;
}

/** What the projectile system hands over per live shell each frame. */
export interface ProjectileDrawData {
  /** Current position + direction of travel. */
  x: number; y: number; z: number;
  dx: number; dy: number; dz: number;
  /** HDR colour of the shell. */
  r: number; g: number; b: number;
  /** Trail points, newest first: [x,y,z]*count. */
  trail: Float32Array;
  trailCount: number;
  /** 0..1 opacity (fading shells waiting on the server). */
  alpha: number;
  /** Seconds since spawn (drives spin / flicker). */
  age: number;
  /** Modelled projectile drawn on top of (or instead of) the glowing core; null = core only. */
  model: ProjectileModel | null;
  /** Scale of the glowing core sprite (0 hides it, 1 = standard shell). */
  coreScale: number;
  /** Multiplier on the ribbon trail's opacity (thrown objects leave fainter trails). */
  trailAlpha: number;
  /** Firing weapon's sizeMul: scales model, core and trail width. */
  size: number;
  /** Extra ribbon width multiplier. */
  trailWidth: number;
  /** Ribbon length in history points (clamped to TRAIL_POINTS). */
  trailLen: number;
  /** 0..1 strength of the grey smoke trail drawn under the glowing ribbon. */
  smoke: number;
}

/**
 * All shells in a handful of draw calls: instanced glowing cores (elongated
 * along travel), instanced models per family, one ribbon geometry holding every
 * trail, and the same ribbon drawn again as billowing smoke (rockets, fireworks)
 * and into the distortion scene as heat haze. Ribbons are expanded
 * camera-facing in the vertex shader from centre + tangent, so the CPU only
 * copies points.
 */
export class ProjectileRenderer {
  readonly cores: THREE.InstancedMesh;
  readonly trails: THREE.Mesh;
  readonly smoke: THREE.Mesh;
  readonly heat: THREE.Mesh;
  private readonly coreColor: THREE.InstancedBufferAttribute;
  private readonly center: THREE.BufferAttribute;
  private readonly tangent: THREE.BufferAttribute;
  private readonly infoBuffer: THREE.InterleavedBuffer;
  private readonly heatTime: { value: number };
  private readonly smokeTime: { value: number };
  private count = 0;
  private anySmoke = false;
  private readonly batches = new Map<ProjectileModel, ModelBatch>();

  constructor(scene: THREE.Scene, distortionScene: THREE.Scene) {
    // Modelled projectiles: one lit instanced body + one HDR glow per model family.
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1, flatShading: true });
    const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(6, 6, 6), toneMapped: true });
    const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geo, mat, MAX_PROJECTILES);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.visible = false;
      mesh.name = name;
      scene.add(mesh);
      return mesh;
    };
    for (const model of MODELS) {
      const geo = projectileGeometry(model);
      const body = geo.body.getAttribute('position') ? instanced(geo.body, bodyMat, `projectiles.${model}.body`) : null;
      if (body) body.castShadow = true;
      const glow = geo.glow ? instanced(geo.glow, glowMat, `projectiles.${model}.glow`) : null;
      this.batches.set(model, { model, body, glow, count: 0 });
    }

    // Core: a capsule-ish stretched sphere, coloured per instance (HDR).
    const coreGeo = new THREE.SphereGeometry(0.12, 10, 8).scale(1, 1, 4.5);
    this.coreColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PROJECTILES * 3), 3);
    this.coreColor.setUsage(THREE.DynamicDrawUsage);
    this.cores = new THREE.InstancedMesh(coreGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true }), MAX_PROJECTILES);
    this.cores.instanceColor = this.coreColor;
    this.cores.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cores.frustumCulled = false;
    this.cores.count = 0;
    this.cores.name = 'projectiles.cores';
    scene.add(this.cores);

    // Ribbons: TRAIL_POINTS cross-sections of 2 vertices per shell.
    const g = new THREE.BufferGeometry();
    const n = MAX_PROJECTILES * VERTS_PER_TRAIL;
    this.center = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.tangent = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.center.setUsage(THREE.DynamicDrawUsage);
    this.tangent.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.center);
    g.setAttribute('aTangent', this.tangent);
    this.infoBuffer = new THREE.InterleavedBuffer(new Float32Array(n * INFO_STRIDE), INFO_STRIDE);
    this.infoBuffer.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aInfo0', new THREE.InterleavedBufferAttribute(this.infoBuffer, 4, 0));
    g.setAttribute('aInfo1', new THREE.InterleavedBufferAttribute(this.infoBuffer, 4, 4));
    const index: number[] = [];
    for (let p = 0; p < MAX_PROJECTILES; p++) {
      const base = p * VERTS_PER_TRAIL;
      for (let i = 0; i < TRAIL_POINTS - 1; i++) {
        const a = base + i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    g.setIndex(index);
    g.setDrawRange(0, 0);
    // `taper` shapes width along the trail: >0 narrows to the tail, <0 billows out (smoke).
    const vert = /* glsl */ `
      attribute vec3 aTangent;
      attribute vec4 aInfo0;
      attribute vec4 aInfo1;
      varying float vAlong;
      varying float vSide;
      varying float vAlpha;
      varying float vSmoke;
      varying vec3 vCol;
      uniform float uWidth;
      uniform float uSmokeOnly;
      vec3 ribbon(vec3 c, float along) {
        vec3 toCam = normalize(cameraPosition - c);
        vec3 side = cross(normalize(aTangent + vec3(1e-5)), toCam);
        float shape = mix(1.0 - along * 0.75, 0.7 + along * 2.6, uSmokeOnly);
        float gate = mix(1.0, step(0.001, aInfo1.w), uSmokeOnly);
        float w = uWidth * aInfo1.z * shape * gate;
        return c + normalize(side + vec3(1e-6)) * aInfo0.x * w;
      }
      void main() {
        vAlong = aInfo0.y;
        vSide = aInfo0.x;
        vAlpha = aInfo0.z;
        vSmoke = aInfo1.w;
        vCol = vec3(aInfo0.w, aInfo1.xy);
        vec3 wp = ribbon(position, aInfo0.y);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }
    `;
    const trailMat = new THREE.ShaderMaterial({
      uniforms: { uWidth: { value: 1 }, uSmokeOnly: { value: 0 } },
      vertexShader: vert,
      fragmentShader: /* glsl */ `
        varying float vAlong; varying float vSide; varying float vAlpha; varying float vSmoke; varying vec3 vCol;
        void main() {
          float across = 1.0 - abs(vSide);
          float fade = 1.0 - vAlong;
          float a = fade * fade * vAlpha;
          // White-hot near the head, saturated colour down the tail.
          vec3 c = mix(vCol, vec3(1.0) * length(vCol), pow(fade, 5.0) * 0.6);
          gl_FragColor = vec4(c * a * (0.3 + across * across * 0.9), 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.trails = new THREE.Mesh(g, trailMat);
    this.trails.frustumCulled = false;
    this.trails.renderOrder = 8;
    this.trails.name = 'projectiles.trails';
    scene.add(this.trails);

    // Smoke: same ribbon, widening toward the tail, alpha-blended grey puffs with a warm head.
    const smokeMat = new THREE.ShaderMaterial({
      uniforms: { uWidth: { value: 1.6 }, uSmokeOnly: { value: 1 }, uTime: { value: 0 } },
      vertexShader: vert,
      fragmentShader: /* glsl */ `
        varying float vAlong; varying float vSide; varying float vAlpha; varying float vSmoke; varying vec3 vCol;
        uniform float uTime;
        void main() {
          float across = 1.0 - vSide * vSide;
          float puff = 0.65 + 0.35 * sin(vAlong * 34.0 + vSide * 2.0 - uTime * 3.0);
          float a = vSmoke * (1.0 - vAlong) * smoothstep(0.0, 0.1, vAlong) * across * puff * 0.62;
          vec3 hot = vec3(1.0, 0.62, 0.32);
          vec3 grey = vec3(0.36, 0.34, 0.33);
          vec3 c = mix(hot, grey, smoothstep(0.04, 0.3, vAlong));
          gl_FragColor = vec4(c, a);
        }`,
      blending: THREE.NormalBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.smokeTime = smokeMat.uniforms.uTime;
    this.smoke = new THREE.Mesh(g, smokeMat);
    this.smoke.frustumCulled = false;
    this.smoke.renderOrder = 7;
    this.smoke.name = 'projectiles.smoke';
    scene.add(this.smoke);

    const heatMat = new THREE.ShaderMaterial({
      uniforms: { uWidth: { value: 2.2 }, uSmokeOnly: { value: 0 }, uTime: { value: 0 } },
      vertexShader: vert,
      fragmentShader: /* glsl */ `
        varying float vAlong; varying float vSide; varying float vAlpha; varying float vSmoke; varying vec3 vCol;
        uniform float uTime;
        void main() {
          float a = (1.0 - vAlong) * vAlpha * (1.0 - abs(vSide)) * (1.0 + vSmoke);
          float w = sin(vAlong * 30.0 - uTime * 40.0);
          gl_FragColor = vec4(vec2(w, -w) * 0.006 * a, 0.0, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    this.heatTime = heatMat.uniforms.uTime;
    this.heat = new THREE.Mesh(g, heatMat);
    this.heat.frustumCulled = false;
    distortionScene.add(this.heat);
  }

  /** Starts a frame; call `push` per live shell, then `end`. */
  begin(): void {
    this.count = 0;
    this.anySmoke = false;
    for (const b of this.batches.values()) b.count = 0;
  }

  push(d: ProjectileDrawData): void {
    if (this.count >= MAX_PROJECTILES) return;
    const i = this.count++;
    const size = d.size > 0 ? d.size : 1;
    // Core: grows with the weapon's size (fat glowing slugs for heavy guns).
    _d.set(d.dx, d.dy, d.dz);
    if (_d.lengthSq() < 1e-8) _d.set(0, 0, 1);
    _q.setFromUnitVectors(Z, _d.normalize());
    const core = d.alpha > 0.05 ? d.coreScale * size : 0;
    _m.compose(_p.set(d.x, d.y, d.z), _q, _s.set(core, core, core * (0.8 + 0.2 * size)));
    this.cores.setMatrixAt(i, _m);
    if (d.model) this.pushModel(d, _q, size);
    this.coreColor.setXYZ(i, d.r * 1.8 * d.alpha, d.g * 1.8 * d.alpha, d.b * 1.8 * d.alpha);

    // Ribbon: newest point first; pad missing history with the oldest point.
    const c = this.center.array as Float32Array;
    const t = this.tangent.array as Float32Array;
    const info = this.infoBuffer.array as Float32Array;
    const base = i * VERTS_PER_TRAIL;
    const len = Math.max(2, Math.min(TRAIL_POINTS, Math.round(d.trailLen) || TRAIL_POINTS));
    const pts = Math.max(1, Math.min(d.trailCount, len));
    const width = TRAIL_WIDTH * size * (d.trailWidth > 0 ? d.trailWidth : 1);
    const smoke = Math.max(0, d.smoke) * d.alpha;
    if (smoke > 0) this.anySmoke = true;
    for (let k = 0; k < TRAIL_POINTS; k++) {
      const kk = Math.min(k, len - 1);
      const src = Math.min(kk, pts - 1) * 3;
      const nxt = Math.min(kk + 1, pts - 1) * 3;
      const px = kk === 0 ? d.x : d.trail[src], py = kk === 0 ? d.y : d.trail[src + 1], pz = kk === 0 ? d.z : d.trail[src + 2];
      let tx = px - d.trail[nxt], ty = py - d.trail[nxt + 1], tz = pz - d.trail[nxt + 2];
      if (tx * tx + ty * ty + tz * tz < 1e-8) { tx = d.dx; ty = d.dy; tz = d.dz; }
      // Points past this shell's length collapse onto its tail with zero opacity.
      const along = Math.min(1, k / (len - 1));
      for (let side = 0; side < 2; side++) {
        const v = base + k * 2 + side;
        c[v * 3] = px; c[v * 3 + 1] = py; c[v * 3 + 2] = pz;
        t[v * 3] = tx; t[v * 3 + 1] = ty; t[v * 3 + 2] = tz;
        const o = v * INFO_STRIDE;
        info[o] = side === 0 ? -1 : 1;
        info[o + 1] = along;
        info[o + 2] = d.alpha * d.trailAlpha;
        info[o + 3] = d.r;
        info[o + 4] = d.g;
        info[o + 5] = d.b;
        info[o + 6] = width;
        info[o + 7] = smoke;
      }
    }
  }

  private pushModel(d: ProjectileDrawData, heading: THREE.Quaternion, size: number): void {
    const batch = this.batches.get(d.model as ProjectileModel);
    if (!batch) return;
    const style = MODEL_STYLE[batch.model];
    const angle = d.age * style.rate;
    switch (style.spin) {
      case 'tumble':
        _spin.setFromAxisAngle(X, angle);
        break;
      case 'roll':
        _spin.setFromAxisAngle(Z, angle);
        break;
      case 'wobble':
        _spin.setFromEuler(_euler.set(Math.sin(angle) * 0.12, Math.cos(angle * 0.7) * 0.12, angle * 0.3));
        break;
      default:
        _spin.identity();
    }
    _q2.copy(heading).multiply(_spin);
    // Electric sheaths flicker in size; exhaust plumes flicker in length.
    const flick = style.flicker ? 0.75 + 0.4 * Math.abs(Math.sin(d.age * 47 + d.x)) : 1;
    const scale = d.alpha > 0.05 ? style.scale * size * (style.flicker === 'all' ? flick : 1) * (0.4 + 0.6 * d.alpha) : 0;
    _m.compose(_p.set(d.x, d.y, d.z), _q2, _s.setScalar(scale));
    const i = batch.count++;
    batch.body?.setMatrixAt(i, _m);
    if (batch.glow) {
      if (style.flicker === 'glow') _m.compose(_p, _q2, _s.set(scale, scale, scale * flick));
      batch.glow.setMatrixAt(i, _m);
    }
  }

  end(time: number): void {
    for (const b of this.batches.values()) {
      for (const mesh of [b.body, b.glow]) {
        if (!mesh) continue;
        mesh.count = b.count;
        mesh.visible = b.count > 0;
        if (b.count > 0) mesh.instanceMatrix.needsUpdate = true;
      }
    }
    const n = this.count;
    this.cores.count = n;
    this.cores.instanceMatrix.needsUpdate = true;
    this.coreColor.needsUpdate = true;
    const g = this.trails.geometry;
    g.setDrawRange(0, n * (TRAIL_POINTS - 1) * 6);
    if (n > 0) {
      const used = n * VERTS_PER_TRAIL;
      this.center.clearUpdateRanges();
      this.center.addUpdateRange(0, used * 3);
      this.center.needsUpdate = true;
      this.tangent.clearUpdateRanges();
      this.tangent.addUpdateRange(0, used * 3);
      this.tangent.needsUpdate = true;
      this.infoBuffer.clearUpdateRanges();
      this.infoBuffer.addUpdateRange(0, used * INFO_STRIDE);
      this.infoBuffer.needsUpdate = true;
    }
    this.trails.visible = n > 0;
    this.smoke.visible = n > 0 && this.anySmoke;
    this.heat.visible = n > 0;
    this.heatTime.value = time;
    this.smokeTime.value = time;
  }
}
