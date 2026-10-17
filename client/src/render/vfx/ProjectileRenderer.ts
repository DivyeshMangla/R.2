import * as THREE from 'three';

export const MAX_PROJECTILES = 128;
/** Points per trail (history ring length). */
export const TRAIL_POINTS = 10;

const VERTS_PER_TRAIL = TRAIL_POINTS * 2;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

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
}

/**
 * All shells in two draw calls: instanced glowing cores (elongated along
 * travel) and one ribbon geometry holding every trail. Ribbons are expanded
 * camera-facing in the vertex shader from centre + tangent, so the CPU only
 * copies points. The same ribbon geometry is drawn into the distortion scene
 * with a heat-haze material.
 */
export class ProjectileRenderer {
  readonly cores: THREE.InstancedMesh;
  readonly trails: THREE.Mesh;
  readonly heat: THREE.Mesh;
  private readonly coreColor: THREE.InstancedBufferAttribute;
  private readonly center: THREE.BufferAttribute;
  private readonly tangent: THREE.BufferAttribute;
  private readonly infoBuffer: THREE.InterleavedBuffer;
  private readonly heatTime: { value: number };
  private count = 0;

  constructor(scene: THREE.Scene, distortionScene: THREE.Scene) {
    // Core: a capsule-ish stretched sphere, coloured per instance (HDR).
    const coreGeo = new THREE.SphereGeometry(0.11, 10, 8).scale(1, 1, 4.5);
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
    // Per vertex: side (±1), along (0 head .. 1 tail), alpha, r | g, b.
    this.infoBuffer = new THREE.InterleavedBuffer(new Float32Array(n * 6), 6);
    this.infoBuffer.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aInfo0', new THREE.InterleavedBufferAttribute(this.infoBuffer, 4, 0));
    g.setAttribute('aInfo1', new THREE.InterleavedBufferAttribute(this.infoBuffer, 2, 4));
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
    const vert = /* glsl */ `
      attribute vec3 aTangent;
      attribute vec4 aInfo0;
      varying float vAlong;
      varying float vSide;
      varying float vAlpha;
      varying vec3 vCol;
      uniform float uWidth;
      vec3 ribbon(vec3 c) {
        vec3 toCam = normalize(cameraPosition - c);
        vec3 side = cross(normalize(aTangent + vec3(1e-5)), toCam);
        float w = uWidth * (1.0 - aInfo0.y * 0.8);
        return c + normalize(side + vec3(1e-6)) * aInfo0.x * w;
      }
    `;
    const vertBody = /* glsl */ `
      vAlong = aInfo0.y;
      vSide = aInfo0.x;
      vAlpha = aInfo0.z;
      vec3 wp = ribbon(position);
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    `;
    const trailMat = new THREE.ShaderMaterial({
      uniforms: { uWidth: { value: 0.16 } },
      vertexShader: `${vert}
        attribute vec2 aInfo1;
        void main() { vCol = vec3(aInfo0.w, aInfo1); ${vertBody} }`,
      fragmentShader: /* glsl */ `
        varying float vAlong; varying float vSide; varying float vAlpha; varying vec3 vCol;
        void main() {
          float across = 1.0 - abs(vSide);
          float a = (1.0 - vAlong) * (1.0 - vAlong) * vAlpha;
          vec3 c = mix(vCol, vec3(1.0) * length(vCol), pow(1.0 - vAlong, 6.0) * 0.5);
          gl_FragColor = vec4(c * a * (0.4 + across * 0.6), 1.0);
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

    const heatMat = new THREE.ShaderMaterial({
      uniforms: { uWidth: { value: 0.35 }, uTime: { value: 0 } },
      vertexShader: `${vert}
        attribute vec2 aInfo1;
        void main() { vCol = vec3(0.0); ${vertBody} }`,
      fragmentShader: /* glsl */ `
        varying float vAlong; varying float vSide; varying float vAlpha; varying vec3 vCol;
        uniform float uTime;
        void main() {
          float a = (1.0 - vAlong) * vAlpha * (1.0 - abs(vSide));
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
  }

  push(d: ProjectileDrawData): void {
    if (this.count >= MAX_PROJECTILES) return;
    const i = this.count++;
    // Core.
    _d.set(d.dx, d.dy, d.dz);
    if (_d.lengthSq() < 1e-8) _d.set(0, 0, 1);
    _q.setFromUnitVectors(Z, _d.normalize());
    _m.compose(_p.set(d.x, d.y, d.z), _q, _s.setScalar(d.alpha > 0.05 ? 1 : 0));
    this.cores.setMatrixAt(i, _m);
    this.coreColor.setXYZ(i, d.r * 1.6 * d.alpha, d.g * 1.6 * d.alpha, d.b * 1.6 * d.alpha);

    // Ribbon: newest point first; pad missing history with the oldest point.
    const c = this.center.array as Float32Array;
    const t = this.tangent.array as Float32Array;
    const info = this.infoBuffer.array as Float32Array;
    const base = i * VERTS_PER_TRAIL;
    const pts = Math.max(1, d.trailCount);
    for (let k = 0; k < TRAIL_POINTS; k++) {
      const src = Math.min(k, pts - 1) * 3;
      const nxt = Math.min(k + 1, pts - 1) * 3;
      const px = k === 0 ? d.x : d.trail[src], py = k === 0 ? d.y : d.trail[src + 1], pz = k === 0 ? d.z : d.trail[src + 2];
      let tx = px - d.trail[nxt], ty = py - d.trail[nxt + 1], tz = pz - d.trail[nxt + 2];
      if (tx * tx + ty * ty + tz * tz < 1e-8) { tx = d.dx; ty = d.dy; tz = d.dz; }
      const along = k / (TRAIL_POINTS - 1);
      for (let side = 0; side < 2; side++) {
        const v = base + k * 2 + side;
        c[v * 3] = px; c[v * 3 + 1] = py; c[v * 3 + 2] = pz;
        t[v * 3] = tx; t[v * 3 + 1] = ty; t[v * 3 + 2] = tz;
        const o = v * 6;
        info[o] = side === 0 ? -1 : 1;
        info[o + 1] = along;
        info[o + 2] = d.alpha;
        info[o + 3] = d.r;
        info[o + 4] = d.g;
        info[o + 5] = d.b;
      }
    }
  }

  end(time: number): void {
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
      this.infoBuffer.addUpdateRange(0, used * 6);
      this.infoBuffer.needsUpdate = true;
    }
    this.trails.visible = n > 0;
    this.heat.visible = n > 0;
    this.heatTime.value = time;
  }
}
