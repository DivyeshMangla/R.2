import * as THREE from 'three';

const MAX_QUADS = 2400;
const LIFE_S = 14;
const MIN_STEP = 0.18;
const MAX_GAP = 1.4;

interface TrackState {
  has: boolean;
  /** Left / right edge of the last emitted cross-section. */
  lx: number; ly: number; lz: number;
  rx: number; ry: number; rz: number;
  cx: number; cz: number;
  time: number;
}

/**
 * Tyre marks as one dynamic triangle ribbon (one draw call). Each wheel keeps
 * its last cross-section; a new quad joins it to the current one. Quads live
 * in a ring buffer and fade by birth time in the shader.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly pos: THREE.BufferAttribute;
  private readonly data: THREE.BufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private readonly tracks = new Map<number, TrackState>();
  private readonly attrs: THREE.BufferAttribute[];
  private head = 0;
  private dirtyFrom = -1;
  private dirtyTo = -1;
  private wrapped = false;
  enabled = true;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(MAX_QUADS * 6 * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    // birth, strength, across (0..1)
    this.data = new THREE.BufferAttribute(new Float32Array(MAX_QUADS * 6 * 3).fill(-1e6), 3);
    this.data.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aSkid', this.data);
    this.attrs = [this.pos, this.data];
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uLife: { value: LIFE_S } }]),
      vertexShader: /* glsl */ `
        attribute vec3 aSkid;
        uniform float uTime;
        uniform float uLife;
        varying float vAlpha;
        varying float vAcross;
        #include <fog_pars_vertex>
        void main() {
          float age = uTime - aSkid.x;
          vAlpha = aSkid.y * (1.0 - smoothstep(uLife * 0.6, uLife, age)) * step(0.0, age);
          vAcross = aSkid.z;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying float vAcross;
        #include <fog_pars_fragment>
        void main() {
          // Tread ribs across the mark.
          float ribs = 0.75 + 0.25 * step(0.5, fract(vAcross * 5.0));
          float edge = smoothstep(0.0, 0.18, vAcross) * smoothstep(1.0, 0.82, vAcross);
          float a = vAlpha * edge * ribs * 0.7;
          if (a < 0.01) discard;
          gl_FragColor = vec4(0.012, 0.012, 0.014, a);
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'skidMarks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  /**
   * Feeds one wheel's contact patch. `key` identifies the wheel (robot*4+i).
   * `rx/rz` is the robot's right axis; `strength` 0 ends the current streak.
   */
  feed(key: number, x: number, y: number, z: number, rx: number, rz: number, width: number, strength: number, time: number): void {
    let t = this.tracks.get(key);
    if (!t) {
      t = { has: false, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0, cx: 0, cz: 0, time: 0 };
      this.tracks.set(key, t);
    }
    if (!this.enabled || strength <= 0.02) {
      t.has = false;
      return;
    }
    const h = width / 2;
    const lx = x - rx * h, lz = z - rz * h;
    const rX = x + rx * h, rZ = z + rz * h;
    const yy = y + 0.02;
    if (t.has) {
      const d = Math.hypot(x - t.cx, z - t.cz);
      if (d < MIN_STEP) return;
      if (d < MAX_GAP && time - t.time < 0.3) this.quad(t, lx, yy, lz, rX, yy, rZ, strength, time);
    }
    t.has = true;
    t.lx = lx; t.ly = yy; t.lz = lz;
    t.rx = rX; t.ry = yy; t.rz = rZ;
    t.cx = x; t.cz = z;
    t.time = time;
  }

  private quad(t: TrackState, lx: number, ly: number, lz: number, rx: number, ry: number, rz: number, s: number, time: number): void {
    const q = this.head;
    this.head = (q + 1) % MAX_QUADS;
    if (this.head === 0) this.wrapped = true;
    const o = q * 18;
    // Two triangles: prevL, prevR, curR / prevL, curR, curL.
    this.vert(o, 0, t.lx, t.ly, t.lz, 0, s, time);
    this.vert(o, 1, t.rx, t.ry, t.rz, 1, s, time);
    this.vert(o, 2, rx, ry, rz, 1, s, time);
    this.vert(o, 3, t.lx, t.ly, t.lz, 0, s, time);
    this.vert(o, 4, rx, ry, rz, 1, s, time);
    this.vert(o, 5, lx, ly, lz, 0, s, time);
    if (this.dirtyFrom < 0) this.dirtyFrom = q;
    this.dirtyTo = q;
  }

  private vert(o: number, v: number, x: number, y: number, z: number, across: number, s: number, time: number): void {
    const p = this.pos.array as Float32Array;
    const d = this.data.array as Float32Array;
    const i = o + v * 3;
    p[i] = x; p[i + 1] = y; p[i + 2] = z;
    d[i] = time; d[i + 1] = s; d[i + 2] = across;
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
    if (this.dirtyFrom < 0) return;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      if (this.wrapped || this.dirtyTo < this.dirtyFrom) a.addUpdateRange(0, a.array.length);
      else a.addUpdateRange(this.dirtyFrom * 18, (this.dirtyTo - this.dirtyFrom + 1) * 18);
      a.needsUpdate = true;
    }
    this.dirtyFrom = this.dirtyTo = -1;
    this.wrapped = false;
  }

  clear(): void {
    (this.data.array as Float32Array).fill(-1e6);
    this.data.clearUpdateRanges();
    this.data.needsUpdate = true;
    for (const t of this.tracks.values()) t.has = false;
  }
}
