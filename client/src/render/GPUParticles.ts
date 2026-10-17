import * as THREE from 'three';

export interface ParticleSpawn {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  sizeStart: number;
  sizeEnd: number;
  /** Linear RGB; values above 1 feed the bloom pass. */
  r: number;
  g: number;
  b: number;
  alpha: number;
  gravity: number;
  drag: number;
  /** Velocity-aligned stretch factor (sparks). */
  stretch: number;
}

const vertexShader = /* glsl */ `
  uniform float uTime;
  attribute vec3 aStart;
  attribute vec3 aVel;
  attribute vec4 aParams;   // birth, life, gravity, drag
  attribute vec4 aColor;    // rgb, alpha
  attribute vec3 aSize;     // start, end, stretch
  varying vec4 vColor;
  varying vec2 vUv;
  varying float vT;
  void main() {
    float age = uTime - aParams.x;
    float t = age / aParams.y;
    if (t < 0.0 || t > 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float drag = aParams.w;
    float k = drag > 0.001 ? (1.0 - exp(-drag * age)) / drag : age;
    vec3 pos = aStart + aVel * k + vec3(0.0, -0.5 * aParams.z * age * age, 0.0);
    vec3 vel = aVel * exp(-drag * age) + vec3(0.0, -aParams.z * age, 0.0);
    float size = mix(aSize.x, aSize.y, t);
    vec4 mv = viewMatrix * vec4(pos, 1.0);
    vec3 mvVel = (viewMatrix * vec4(vel, 0.0)).xyz;
    float sp = length(mvVel.xy);
    vec2 ay = sp > 1e-3 ? mvVel.xy / sp : vec2(0.0, 1.0);
    vec2 ax = vec2(ay.y, -ay.x);
    float stretch = 1.0 + aSize.z * sp;
    mv.xy += (ax * position.x + ay * position.y * stretch) * size;
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    vUv = uv;
    vT = t;
  }
`;

const fragmentAdditive = /* glsl */ `
  varying vec4 vColor;
  varying vec2 vUv;
  varying float vT;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.0, d);
    a *= a;
    float fade = pow(1.0 - vT, 1.4);
    gl_FragColor = vec4(vColor.rgb * a * fade * vColor.a, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const fragmentSmoke = /* glsl */ `
  varying vec4 vColor;
  varying vec2 vUv;
  varying float vT;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec2 c = vUv - 0.5;
    float d = length(c) * 2.0;
    float n = hash(floor(vUv * 8.0)) * 0.25;
    float a = smoothstep(1.0, 0.1, d + n * 0.6);
    float fade = smoothstep(0.0, 0.12, vT) * (1.0 - vT);
    gl_FragColor = vec4(vColor.rgb, a * fade * vColor.a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Fully GPU-animated particles: the CPU only writes spawn parameters into a
 * ring buffer; position, size and fade are evaluated in the vertex shader.
 */
export class GPUParticles {
  readonly mesh: THREE.Mesh;
  private readonly capacity: number;
  private cursor = 0;
  private readonly start: THREE.InstancedBufferAttribute;
  private readonly vel: THREE.InstancedBufferAttribute;
  private readonly params: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly size: THREE.InstancedBufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private dirtyFrom = -1;
  private dirtyCount = 0;
  private wrapped = false;
  time = 0;

  constructor(capacity: number, mode: 'additive' | 'smoke') {
    this.capacity = capacity;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    const mk = (n: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.start = mk(3);
    this.vel = mk(3);
    this.params = mk(4);
    this.color = mk(4);
    this.size = mk(3);
    // Park all particles as already dead.
    for (let i = 0; i < capacity; i++) {
      this.params.setXYZW(i, -1000, 1, 0, 0);
    }
    geo.setAttribute('aStart', this.start);
    geo.setAttribute('aVel', this.vel);
    geo.setAttribute('aParams', this.params);
    geo.setAttribute('aColor', this.color);
    geo.setAttribute('aSize', this.size);
    geo.instanceCount = capacity;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader,
      fragmentShader: mode === 'additive' ? fragmentAdditive : fragmentSmoke,
      transparent: true,
      depthWrite: false,
      blending: mode === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = mode === 'additive' ? 10 : 9;
  }

  emit(p: ParticleSpawn): void {
    const i = this.cursor;
    this.start.setXYZ(i, p.x, p.y, p.z);
    this.vel.setXYZ(i, p.vx, p.vy, p.vz);
    this.params.setXYZW(i, this.time, p.life, p.gravity, p.drag);
    this.color.setXYZW(i, p.r, p.g, p.b, p.alpha);
    this.size.setXYZ(i, p.sizeStart, p.sizeEnd, p.stretch);
    if (this.dirtyFrom < 0) this.dirtyFrom = i;
    this.dirtyCount += 1;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.cursor === 0) this.wrapped = true;
  }

  update(time: number): void {
    this.time = time;
    this.material.uniforms.uTime.value = time;
    if (this.dirtyCount === 0) return;
    const attrs = [this.start, this.vel, this.params, this.color, this.size];
    for (const a of attrs) {
      a.clearUpdateRanges();
      if (this.wrapped || this.dirtyCount >= this.capacity) {
        a.addUpdateRange(0, this.capacity * a.itemSize);
      } else {
        a.addUpdateRange(this.dirtyFrom * a.itemSize, this.dirtyCount * a.itemSize);
      }
      a.needsUpdate = true;
    }
    this.dirtyFrom = -1;
    this.dirtyCount = 0;
    this.wrapped = false;
  }
}
