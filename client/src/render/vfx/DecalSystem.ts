import * as THREE from 'three';

export const DecalKind = {
  /** Shell impact: soot ring with a small glowing core that cools. */
  SCORCH: 0,
  /** Ricochet / grazing hit: a hot streak that cools quickly. */
  SPARK: 1,
  /** Explosion: large ragged burn. */
  BLAST: 2,
} as const;
export type DecalKindValue = (typeof DecalKind)[keyof typeof DecalKind];

const MAX_DECALS = 160;
const Z = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Every scorch and spark mark is one instance of a single quad (one draw
 * call). The look is fully procedural: noise-edged soot, a hot core that cools
 * from white through orange to black, faded out at the end of its life.
 */
export class DecalSystem {
  readonly mesh: THREE.InstancedMesh;
  private readonly aDecal: THREE.InstancedBufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private head = 0;
  private limit: number;

  constructor(scene: THREE.Scene, limit: number) {
    this.limit = Math.min(MAX_DECALS, limit);
    const geo = new THREE.PlaneGeometry(1, 1);
    this.aDecal = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DECALS * 4), 4);
    this.aDecal.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aDecal', this.aDecal);
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
      vertexShader: /* glsl */ `
        attribute vec4 aDecal; // birth, life, kind, seed
        uniform float uTime;
        varying vec2 vUv;
        varying vec4 vD;
        varying float vAge;
        #include <fog_pars_vertex>
        void main() {
          vUv = uv;
          vD = aDecal;
          vAge = uTime - aDecal.x;
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec4 vD;
        varying float vAge;
        #include <fog_pars_fragment>
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
        }
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float kind = vD.z;
          float seed = vD.w * 37.0;
          float ang = atan(p.y, p.x);
          float r = length(p);
          float edge = 0.62 + 0.28 * n(vec2(ang * 2.5 + seed, seed)) + 0.12 * n(p * 6.0 + seed);
          if (kind > 0.5 && kind < 1.5) { r = length(p * vec2(0.45, 1.6)); edge = 0.7 + 0.2 * n(p * 5.0 + seed); }
          float soot = smoothstep(edge, edge * 0.35, r) * (0.55 + 0.45 * n(p * 9.0 + seed));
          float life = max(vD.y, 0.001);
          float fade = 1.0 - smoothstep(0.75, 1.0, vAge / life);
          // Hot core cools over ~1.5 s (spark marks faster).
          float cool = kind > 0.5 && kind < 1.5 ? 0.5 : 1.6;
          float heat = exp(-vAge / cool) * smoothstep(0.5, 0.0, r) * (0.6 + 0.4 * n(p * 12.0 + seed + vAge));
          vec3 hot = mix(vec3(0.9, 0.12, 0.01), vec3(1.0, 0.75, 0.35), clamp(heat * 1.5, 0.0, 1.0)) * heat * 6.0;
          float alpha = clamp(soot * 0.88 + heat, 0.0, 1.0) * fade;
          if (alpha < 0.01 || vAge < 0.0) discard;
          gl_FragColor = vec4(vec3(0.015, 0.013, 0.012) + hot, alpha);
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, MAX_DECALS);
    this.mesh.name = 'decals';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    for (let i = 0; i < MAX_DECALS; i++) this.mesh.setMatrixAt(i, ZERO);
    this.mesh.count = this.limit;
    scene.add(this.mesh);
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.min(MAX_DECALS, limit));
    this.mesh.count = this.limit;
    this.head %= this.limit;
  }

  add(pos: THREE.Vector3, normal: THREE.Vector3, size: number, kind: DecalKindValue, time: number, life: number): void {
    const i = this.head;
    this.head = (i + 1) % this.limit;
    _n.copy(normal).normalize();
    _q.setFromUnitVectors(Z, _n);
    _q2.setFromAxisAngle(Z, Math.random() * Math.PI * 2);
    _q.multiply(_q2);
    _p.copy(pos).addScaledVector(_n, 0.015);
    const stretch = kind === DecalKind.SPARK ? 1.6 : 1;
    _m.compose(_p, _q, _s.set(size, size * stretch, 1));
    this.mesh.setMatrixAt(i, _m);
    this.aDecal.setXYZW(i, time, life, kind, Math.random());
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aDecal.needsUpdate = true;
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
  }

  clear(): void {
    for (let i = 0; i < MAX_DECALS; i++) this.mesh.setMatrixAt(i, ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
