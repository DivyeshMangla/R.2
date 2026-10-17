import * as THREE from 'three';
import { CURVE_RES, TYPE_COUNT, TYPE_DEFS, type Blend, type PType } from './ParticleAtlas';

/**
 * Parameters of one particle. Callers keep a single scratch instance and
 * overwrite its fields before every `emit`, so spawning never allocates.
 */
export interface ParticleSpec {
  type: PType;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  size: number;
  /** Downward acceleration (m/s²); negative floats up. */
  gravity: number;
  /** Exponential velocity damping (1/s). */
  drag: number;
  /** Velocity-aligned stretch (seconds of travel the sprite spans; 0 = round). */
  stretch: number;
  rot: number;
  rotSpeed: number;
  r: number; g: number; b: number;
  /** HDR multiplier on the type's colour curve (bloom-friendly). */
  intensity: number;
}

export function makeParticleSpec(): ParticleSpec {
  return {
    type: 0 as PType, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1, gravity: 0, drag: 0, stretch: 0,
    rot: 0, rotSpeed: 0, r: 1, g: 1, b: 1, intensity: 1,
  };
}

const VERT = /* glsl */ `
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute vec4 aTime;   // birth, life, gravity, drag
  attribute vec4 aSize;   // size, stretch, rot, rotSpeed
  attribute vec4 aTint;   // rgb, intensity
  attribute vec4 aType;   // curve row, frame0, frames (negative = flipbook), seed

  uniform float uTime;
  uniform sampler2D uCurves;
  uniform float uCurveRows;
  uniform float uSizeScale;

  varying vec2 vUv;
  varying vec4 vColor;
  varying float vViewZ;

  #include <fog_pars_vertex>

  void main() {
    float age = uTime - aTime.x;
    float life = aTime.y;
    if (age < 0.0 || age > life || life <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float t = age / life;
    float drag = aTime.w;
    // Closed-form motion: exponential drag on the launch velocity plus constant gravity.
    float k = drag > 1e-4 ? (1.0 - exp(-drag * age)) / drag : age;
    vec3 wp = aPos + aVel * k;
    wp.y -= 0.5 * aTime.z * age * age;
    vec3 vel = aVel * exp(-drag * age) - vec3(0.0, aTime.z * age, 0.0);

    float row = aType.x;
    vec2 cuv = vec2((t * (${CURVE_RES - 1}.0) + 0.5) / ${CURVE_RES}.0, 0.0);
    vColor = texture2D(uCurves, vec2(cuv.x, (row * 2.0 + 0.5) / uCurveRows));
    float sizeMul = texture2D(uCurves, vec2(cuv.x, (row * 2.0 + 1.5) / uCurveRows)).r * 2.0;
    vColor.rgb *= aTint.rgb * aTint.w;

    // Atlas cell: flipbook over life, or a per-particle variant.
    float frames = abs(aType.z);
    float cell = aType.y + (aType.z < 0.0 ? min(floor(t * frames), frames - 1.0) : floor(aType.w * frames * 0.999));
    vec2 cellOrigin = vec2(mod(cell, 4.0), 3.0 - floor(cell / 4.0)) * 0.25;

    vec4 mv = viewMatrix * vec4(wp, 1.0);
    float size = aSize.x * sizeMul * uSizeScale;
    float rot = aSize.z + aSize.w * age;
    vec2 corner = position.xy;
    vec2 axisX = vec2(cos(rot), sin(rot));
    vec2 axisY = vec2(-axisX.y, axisX.x);
    vec2 offset = (corner.x * axisX + corner.y * axisY) * size;

    // Velocity-aligned stretch: orient the quad along the view-space velocity.
    if (aSize.y > 0.0) {
      vec3 vv = mat3(viewMatrix) * vel;
      float sp = length(vv.xy);
      if (sp > 1e-3) {
        vec2 dir = vv.xy / sp;
        vec2 nrm = vec2(-dir.y, dir.x);
        offset = dir * corner.y * (size + sp * aSize.y) + nrm * corner.x * size;
      }
    }
    mv.xy += offset;
    vViewZ = mv.z;
    vUv = cellOrigin + (corner + 0.5) * 0.25;
    gl_Position = projectionMatrix * mv;
    vec4 mvPosition = mv;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  #include <packing>
  uniform sampler2D uAtlas;
  uniform sampler2D uDepth;
  uniform float uUseDepth;
  uniform float uSoft;
  uniform vec2 uResolution;
  uniform float uNear;
  uniform float uFar;
  uniform float uAdditive;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vViewZ;

  #include <fog_pars_fragment>

  void main() {
    vec4 tex = texture2D(uAtlas, vUv);
    float a = tex.a * vColor.a;
    if (uUseDepth > 0.5) {
      // Manual occlusion + soft edge against the composer's stable scene depth.
      float d = texture2D(uDepth, gl_FragCoord.xy / uResolution).r;
      float sceneZ = perspectiveDepthToViewZ(d, uNear, uFar);
      float gap = vViewZ - sceneZ;
      a *= uSoft > 0.0 ? clamp(gap / uSoft, 0.0, 1.0) : step(0.0, gap);
    }
    if (a < 0.003) discard;
    vec3 col = vColor.rgb * tex.rgb;
    gl_FragColor = uAdditive > 0.5 ? vec4(col * a, 1.0) : vec4(col, a);
    #include <fog_fragment>
  }
`;

/**
 * One instanced billboard system (one draw call). Motion is evaluated in the
 * vertex shader from birth state, so the CPU only writes a particle once, into
 * a ring buffer, and uploads just the dirty range each frame.
 */
export class ParticleSystem {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly capacity: number;
  readonly blend: Blend;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aVel: THREE.InstancedBufferAttribute;
  private readonly aTime: THREE.InstancedBufferAttribute;
  private readonly aSize: THREE.InstancedBufferAttribute;
  private readonly aTint: THREE.InstancedBufferAttribute;
  private readonly aType: THREE.InstancedBufferAttribute;
  private readonly attrs: THREE.InstancedBufferAttribute[];
  private head = 0;
  private dirtyFrom = -1;
  private dirtyTo = -1;
  private wrapped = false;
  /** Particles emitted since the last `flush` (for the debug overlay). */
  emitted = 0;
  private lastBirth: Float32Array;
  private lastLife: Float32Array;
  time = 0;

  constructor(capacity: number, blend: Blend, atlas: THREE.Texture, curves: THREE.Texture) {
    this.capacity = capacity;
    this.blend = blend;
    const g = new THREE.InstancedBufferGeometry();
    const quad = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
    g.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = mk(3);
    this.aVel = mk(3);
    this.aTime = mk(4);
    this.aSize = mk(4);
    this.aTint = mk(4);
    this.aType = mk(4);
    this.attrs = [this.aPos, this.aVel, this.aTime, this.aSize, this.aTint, this.aType];
    g.setAttribute('aPos', this.aPos);
    g.setAttribute('aVel', this.aVel);
    g.setAttribute('aTime', this.aTime);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aTint', this.aTint);
    g.setAttribute('aType', this.aType);
    g.instanceCount = capacity;
    // Dead slots start "expired".
    for (let i = 0; i < capacity; i++) this.aTime.setXYZW(i, -1e6, 0, 0, 0);
    this.geometry = g;
    this.lastBirth = new Float32Array(capacity).fill(-1e6);
    this.lastLife = new Float32Array(capacity);

    const additive = blend === 'add';
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uAtlas: { value: null },
          uCurves: { value: null },
          uCurveRows: { value: TYPE_COUNT * 2 },
          uSizeScale: { value: 1 },
          uDepth: { value: null },
          uUseDepth: { value: 0 },
          uSoft: { value: 0.6 },
          uResolution: { value: new THREE.Vector2(1, 1) },
          uNear: { value: 0.1 },
          uFar: { value: 400 },
          uAdditive: { value: additive ? 1 : 0 },
        },
      ]),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // Additive light must fade to black in fog, not toward the fog colour: only the alpha system is fogged.
      fog: !additive,
      blending: additive ? THREE.CustomBlending : THREE.NormalBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
    });
    // Textures are assigned after merge (UniformsUtils.merge clones them otherwise).
    this.material.uniforms.uAtlas.value = atlas;
    this.material.uniforms.uCurves.value = curves;
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = `particles.${blend}`;
    this.mesh.renderOrder = additive ? 11 : 10;
  }

  /** Writes one particle into the ring buffer (overwrites the oldest when full). */
  emit(s: ParticleSpec): void {
    const i = this.head;
    this.head = (i + 1) % this.capacity;
    if (this.head === 0) this.wrapped = true;
    this.aPos.setXYZ(i, s.x, s.y, s.z);
    this.aVel.setXYZ(i, s.vx, s.vy, s.vz);
    this.aTime.setXYZW(i, this.time, s.life, s.gravity, s.drag);
    this.aSize.setXYZW(i, s.size, s.stretch, s.rot, s.rotSpeed);
    this.aTint.setXYZW(i, s.r, s.g, s.b, s.intensity);
    const def = TYPE_DEFS[s.type];
    this.aType.setXYZW(i, s.type, def.frame0, def.flipbook ? -def.frames : def.frames, Math.random());
    this.lastBirth[i] = this.time;
    this.lastLife[i] = s.life;
    if (this.dirtyFrom < 0) this.dirtyFrom = i;
    this.dirtyTo = i;
    this.emitted++;
  }

  /** Uploads only the ring-buffer range written this frame. */
  flush(time: number): void {
    this.time = time;
    this.material.uniforms.uTime.value = time;
    if (this.dirtyFrom < 0) return;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      if (this.wrapped || this.dirtyTo < this.dirtyFrom) {
        a.addUpdateRange(0, this.capacity * a.itemSize);
      } else {
        a.addUpdateRange(this.dirtyFrom * a.itemSize, (this.dirtyTo - this.dirtyFrom + 1) * a.itemSize);
      }
      a.needsUpdate = true;
    }
    this.dirtyFrom = this.dirtyTo = -1;
    this.wrapped = false;
  }

  /** Live particle count (approximate; scans birth times). */
  countAlive(): number {
    let n = 0;
    const t = this.time;
    for (let i = 0; i < this.capacity; i++) if (t - this.lastBirth[i] <= this.lastLife[i]) n++;
    return n;
  }

  setDepth(texture: THREE.Texture | null, near: number, far: number, width: number, height: number, soft: number): void {
    const u = this.material.uniforms;
    u.uDepth.value = texture;
    u.uUseDepth.value = texture ? 1 : 0;
    u.uNear.value = near;
    u.uFar.value = far;
    (u.uResolution.value as THREE.Vector2).set(width, height);
    u.uSoft.value = soft;
    // Without the depth texture particles fall back to the hardware depth test.
    this.material.depthTest = !texture;
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) {
      this.aTime.setX(i, -1e6);
      this.lastBirth[i] = -1e6;
    }
    this.aTime.clearUpdateRanges();
    this.aTime.needsUpdate = true;
    this.head = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
