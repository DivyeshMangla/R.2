import * as THREE from 'three';

const NOISE = /* glsl */ `
  float tm_hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float tm_noise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(tm_hash(i), tm_hash(i + vec3(1,0,0)), f.x), mix(tm_hash(i + vec3(0,1,0)), tm_hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(tm_hash(i + vec3(0,0,1)), tm_hash(i + vec3(1,0,1)), f.x), mix(tm_hash(i + vec3(0,1,1)), tm_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float tm_fbm(vec3 p) { return tm_noise(p) * 0.55 + tm_noise(p * 2.1) * 0.3 + tm_noise(p * 4.3) * 0.15; }
`;

/** Shared vertex prologue: per-instance birth/life/scale animation. */
const ANIM_VERT = /* glsl */ `
  attribute vec4 aAnim; // birth, life, scale0, scale1
  attribute vec4 aTint; // rgb, intensity
  uniform float uTime;
  varying float vT;
  varying vec4 vTint;
  varying vec3 vObj;
  varying vec3 vN;
  varying vec3 vV;
  float tm_scale(out float t) {
    float age = uTime - aAnim.x;
    t = clamp(age / max(aAnim.y, 0.001), 0.0, 1.0);
    if (age < 0.0 || age > aAnim.y) return 0.0;
    return mix(aAnim.z, aAnim.w, 1.0 - pow(1.0 - t, 3.0));
  }
`;

type Kind = 'fireball' | 'ring' | 'pillar' | 'dome';

interface Pool {
  mesh: THREE.InstancedMesh;
  twin: THREE.InstancedMesh | null;
  anim: THREE.InstancedBufferAttribute;
  tint: THREE.InstancedBufferAttribute;
  head: number;
  capacity: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function fireballMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      ${ANIM_VERT}
      ${NOISE}
      void main() {
        float t;
        float s = tm_scale(t);
        vT = t; vTint = aTint; vObj = position;
        float n = tm_fbm(position * 2.2 + vec3(0.0, -uTime * 1.6, aAnim.x * 7.0));
        vec3 p = position * s * (0.8 + n * 0.45 * (0.5 + t));
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      varying float vT; varying vec4 vTint; varying vec3 vObj; varying vec3 vN; varying vec3 vV;
      uniform float uTime;
      ${NOISE}
      void main() {
        float core = pow(abs(dot(normalize(vN), normalize(vV))), 1.5);
        float n = tm_fbm(vObj * 3.0 + vec3(0.0, -uTime * 2.5, 0.0));
        float heat = clamp(core * (1.25 - vT * 1.4) + n * 0.35 - vT * 0.3, 0.0, 1.0);
        vec3 col = mix(vec3(0.35, 0.05, 0.01), vec3(1.0, 0.45, 0.08), smoothstep(0.1, 0.5, heat));
        col = mix(col, vec3(1.0, 0.92, 0.7), smoothstep(0.6, 0.95, heat));
        col *= vTint.rgb;
        float a = (1.0 - smoothstep(0.55, 1.0, vT)) * smoothstep(0.05, 0.3, heat + 0.2);
        gl_FragColor = vec4(col * a * vTint.a * (0.5 + heat * 1.6), 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

function ringMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      ${ANIM_VERT}
      varying vec2 vUv;
      void main() {
        float t;
        float s = tm_scale(t);
        vT = t; vTint = aTint; vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position * s, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vT; varying vec4 vTint; varying vec2 vUv;
      void main() {
        // RingGeometry uv.x runs inner (0) -> outer (1) after the radial remap below.
        float edge = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
        float a = edge * (1.0 - vT) * (1.0 - vT);
        gl_FragColor = vec4(vTint.rgb * vTint.a * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function pillarMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      ${ANIM_VERT}
      varying vec2 vUv;
      void main() {
        float t;
        float s = tm_scale(t);
        vT = t; vTint = aTint; vUv = uv;
        // scale0 = radius, scale1 = height (grows fast, then holds).
        float h = aAnim.w * smoothstep(0.0, 0.25, t);
        vec3 p = vec3(position.x * aAnim.z * (1.0 + t * 0.6), (position.y + 0.5) * h, position.z * aAnim.z * (1.0 + t * 0.6));
        if (s == 0.0) p = vec3(0.0);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vT; varying vec4 vTint; varying vec2 vUv;
      uniform float uTime;
      void main() {
        float bands = 0.6 + 0.4 * sin(vUv.y * 40.0 - uTime * 12.0);
        float a = pow(1.0 - vUv.y, 2.0) * (1.0 - smoothstep(0.35, 1.0, vT)) * bands * 0.6;
        gl_FragColor = vec4(vTint.rgb * vTint.a * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function domeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      ${ANIM_VERT}
      void main() {
        float t;
        float s = tm_scale(t);
        vT = t; vTint = aTint; vObj = position;
        vec4 wp = modelMatrix * instanceMatrix * vec4(position * s, 1.0);
        vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      varying float vT; varying vec4 vTint; varying vec3 vObj; varying vec3 vN; varying vec3 vV;
      uniform float uTime;
      ${NOISE}
      void main() {
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
        float hex = step(0.82, tm_noise(vObj * 9.0 + uTime * 3.0));
        float a = (fres * 1.4 + hex * 0.5) * (1.0 - vT) * step(0.0, vObj.y + 0.05);
        gl_FragColor = vec4(vTint.rgb * vTint.a * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Writes a screen-space offset into the distortion buffer (heat haze / shock refraction). */
function distortionMaterial(kind: 'fireball' | 'ring'): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uStrength: { value: kind === 'ring' ? 0.03 : 0.012 } },
    vertexShader: /* glsl */ `
      ${ANIM_VERT}
      varying vec2 vUv;
      varying vec4 vClip;
      varying vec4 vCenterClip;
      void main() {
        float t;
        float s = tm_scale(t);
        vT = t; vUv = uv; vObj = position;
        mat4 mm = modelMatrix * instanceMatrix;
        vClip = projectionMatrix * viewMatrix * mm * vec4(position * s, 1.0);
        vCenterClip = projectionMatrix * viewMatrix * mm * vec4(0.0, 0.0, 0.0, 1.0);
        gl_Position = vClip;
      }`,
    fragmentShader: /* glsl */ `
      varying float vT; varying vec2 vUv; varying vec4 vClip; varying vec4 vCenterClip; varying vec3 vObj;
      uniform float uStrength;
      uniform float uTime;
      ${NOISE}
      void main() {
        vec2 d = vClip.xy / vClip.w - vCenterClip.xy / vCenterClip.w;
        float len = max(length(d), 1e-4);
        float fade = (1.0 - vT);
        ${kind === 'ring'
          ? 'float mask = smoothstep(0.0, 0.4, vUv.y) * smoothstep(1.0, 0.5, vUv.y); vec2 off = d / len * mask;'
          : 'float n = tm_noise(vObj * 6.0 + uTime * 4.0) - 0.5; vec2 off = vec2(n, -n) * 2.0;'}
        gl_FragColor = vec4(off * uStrength * fade, 0.0, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
}

/**
 * Pooled one-shot meshes: fireballs, shockwave rings, level-up pillars and
 * EMP domes. One InstancedMesh per kind (4 draw calls), animated entirely in
 * the shader from birth time; rings and fireballs also write into the
 * distortion scene through twin meshes sharing their geometry.
 */
export class TransientMeshes {
  private readonly pools: Record<Kind, Pool>;
  private readonly materials: THREE.ShaderMaterial[] = [];

  constructor(scene: THREE.Scene, distortionScene: THREE.Scene) {
    // Ring: RingGeometry in XY, rotated flat; remap uv.y to the radial coordinate.
    const ringGeo = new THREE.RingGeometry(0.82, 1, 72, 1);
    const pos = ringGeo.getAttribute('position');
    const uv = ringGeo.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) uv.setY(i, (Math.hypot(pos.getX(i), pos.getY(i)) - 0.82) / 0.18);
    ringGeo.rotateX(-Math.PI / 2);
    const pillarGeo = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true);
    const fire = fireballMaterial();
    const ring = ringMaterial();
    this.pools = {
      fireball: this.pool(scene, distortionScene, new THREE.IcosahedronGeometry(1, 3), fire, 24, distortionMaterial('fireball')),
      ring: this.pool(scene, distortionScene, ringGeo, ring, 24, distortionMaterial('ring')),
      pillar: this.pool(scene, null, pillarGeo, pillarMaterial(), 8, null),
      dome: this.pool(scene, null, new THREE.SphereGeometry(1, 32, 16), domeMaterial(), 6, null),
    };
  }

  private pool(scene: THREE.Scene, distortion: THREE.Scene | null, geo: THREE.BufferGeometry, mat: THREE.ShaderMaterial, capacity: number, distMat: THREE.ShaderMaterial | null): Pool {
    const anim = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4).fill(-1e6), 4);
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    anim.setUsage(THREE.DynamicDrawUsage);
    tint.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAnim', anim);
    geo.setAttribute('aTint', tint);
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, ZERO);
    scene.add(mesh);
    this.materials.push(mat);
    let twin: THREE.InstancedMesh | null = null;
    if (distortion && distMat) {
      twin = new THREE.InstancedMesh(geo, distMat, capacity);
      twin.instanceMatrix = mesh.instanceMatrix;
      twin.frustumCulled = false;
      distortion.add(twin);
      this.materials.push(distMat);
    }
    return { mesh, twin, anim, tint, head: 0, capacity };
  }

  private spawn(kind: Kind, x: number, y: number, z: number, rot: THREE.Quaternion | null, s0: number, s1: number, life: number, color: THREE.Color, intensity: number, time: number): void {
    const p = this.pools[kind];
    const i = p.head;
    p.head = (i + 1) % p.capacity;
    _m.compose(_p.set(x, y, z), rot ?? _q.setFromEuler(_e.set(0, Math.random() * Math.PI * 2, 0)), _s);
    p.mesh.setMatrixAt(i, _m);
    p.mesh.instanceMatrix.needsUpdate = true;
    p.anim.setXYZW(i, time, life, s0, s1);
    p.tint.setXYZW(i, color.r, color.g, color.b, intensity);
    p.anim.needsUpdate = true;
    p.tint.needsUpdate = true;
  }

  fireball(x: number, y: number, z: number, radius: number, color: THREE.Color, time: number): void {
    this.spawn('fireball', x, y, z, null, radius * 0.25, radius, 0.55 + radius * 0.12, color, 1.0, time);
  }

  /** Flat shockwave ring on the ground (or tilted by `rot`). */
  ring(x: number, y: number, z: number, radius: number, color: THREE.Color, intensity: number, life: number, time: number, rot: THREE.Quaternion | null = null): void {
    this.spawn('ring', x, y, z, rot, radius * 0.08, radius, life, color, intensity, time);
  }

  pillar(x: number, y: number, z: number, radius: number, height: number, color: THREE.Color, time: number): void {
    this.spawn('pillar', x, y, z, null, radius, height, 1.2, color, 1.6, time);
  }

  dome(x: number, y: number, z: number, radius: number, color: THREE.Color, time: number): void {
    this.spawn('dome', x, y, z, null, radius * 0.15, radius, 0.7, color, 2.4, time);
  }

  update(time: number): void {
    for (const m of this.materials) m.uniforms.uTime.value = time;
  }

  clear(): void {
    for (const k of Object.keys(this.pools) as Kind[]) {
      const p = this.pools[k];
      (p.anim.array as Float32Array).fill(-1e6);
      p.anim.needsUpdate = true;
    }
  }
}
