import * as THREE from 'three';

const MAX_SEGMENTS = 1600;
/** Per-vertex data: r, g, b, birth, life. */
const STRIDE = 5;

/**
 * Jagged lightning bolts as one LineSegments ring buffer. Each bolt is a
 * random displaced polyline written once; the shader flickers and fades it by
 * birth time.
 */
export class ElectricArcs {
  readonly lines: THREE.LineSegments;
  private readonly pos: THREE.BufferAttribute;
  private readonly data: THREE.InterleavedBuffer;
  private readonly material: THREE.ShaderMaterial;
  private head = 0;
  private dirty = false;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(MAX_SEGMENTS * 2 * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.data = new THREE.InterleavedBuffer(new Float32Array(MAX_SEGMENTS * 2 * STRIDE).fill(-1e6), STRIDE);
    this.data.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aArc', new THREE.InterleavedBufferAttribute(this.data, 4, 0));
    geo.setAttribute('aLife', new THREE.InterleavedBufferAttribute(this.data, 1, 4));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec4 aArc; // rgb (HDR), birth
        attribute float aLife;
        uniform float uTime;
        varying vec3 vCol;
        varying float vA;
        void main() {
          float age = uTime - aArc.w;
          float t = age / max(aLife, 0.001);
          float flicker = step(0.35, fract(sin(floor(uTime * 30.0) * 12.9898 + aArc.w * 78.233) * 43758.5453));
          vA = (age < 0.0 || t > 1.0) ? 0.0 : (1.0 - t) * (0.4 + 0.6 * flicker);
          vCol = aArc.rgb;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        varying float vA;
        void main() {
          if (vA < 0.01) discard;
          gl_FragColor = vec4(vCol * vA, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(geo, this.material);
    this.lines.name = 'electricArcs';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 12;
    scene.add(this.lines);
  }

  /** A bolt from a to b with `segments` kinks displaced up to `jitter` metres. Colour is HDR. */
  bolt(ax: number, ay: number, az: number, bx: number, by: number, bz: number, segments: number, jitter: number, color: THREE.Color, intensity: number, time: number, life: number): void {
    let px = ax, py = ay, pz = az;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      // Displacement tapers to zero at both ends.
      const amp = i === segments ? 0 : jitter * Math.sin(t * Math.PI);
      const nx = ax + (bx - ax) * t + (Math.random() - 0.5) * 2 * amp;
      const ny = ay + (by - ay) * t + (Math.random() - 0.5) * 2 * amp;
      const nz = az + (bz - az) * t + (Math.random() - 0.5) * 2 * amp;
      this.segment(px, py, pz, nx, ny, nz, color, intensity, time, life);
      px = nx; py = ny; pz = nz;
    }
  }

  private segment(ax: number, ay: number, az: number, bx: number, by: number, bz: number, c: THREE.Color, k: number, time: number, life: number): void {
    const s = this.head;
    this.head = (s + 1) % MAX_SEGMENTS;
    const p = this.pos.array as Float32Array;
    const d = this.data.array as Float32Array;
    const o = s * 6;
    p[o] = ax; p[o + 1] = ay; p[o + 2] = az;
    p[o + 3] = bx; p[o + 4] = by; p[o + 5] = bz;
    for (let v = 0; v < 2; v++) {
      const i = (s * 2 + v) * STRIDE;
      d[i] = c.r * k; d[i + 1] = c.g * k; d[i + 2] = c.b * k; d[i + 3] = time; d[i + 4] = life;
    }
    this.dirty = true;
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
    if (!this.dirty) return;
    this.pos.needsUpdate = true;
    this.data.needsUpdate = true;
    this.dirty = false;
  }

  clear(): void {
    (this.data.array as Float32Array).fill(-1e6);
    this.data.needsUpdate = true;
  }
}
