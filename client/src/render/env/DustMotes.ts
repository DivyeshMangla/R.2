import * as THREE from 'three';

const COUNT = 1400;
const BOX = 36;

/**
 * Floating dust caught in the floodlights: one Points draw call. Particles
 * live in a box that wraps around the camera in the shader, so the field is
 * infinite and the CPU never touches it after creation.
 */
export class DustMotes {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene) {
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = Math.random() * BOX;
      pos[i * 3 + 1] = Math.random() * 14;
      pos[i * 3 + 2] = Math.random() * BOX;
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uBox: { value: BOX }, uScale: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform float uBox;
        uniform float uScale;
        varying float vA;
        void main() {
          vec3 drift = vec3(sin(uTime * 0.13 + aSeed * 40.0) * 1.5 + uTime * 0.25, sin(uTime * 0.2 + aSeed * 17.0) * 0.6, cos(uTime * 0.11 + aSeed * 23.0) * 1.5);
          vec3 p = position + drift;
          // Wrap into a box centred on the camera.
          vec3 origin = cameraPosition - vec3(uBox * 0.5, 0.0, uBox * 0.5);
          p.xz = origin.xz + mod(p.xz - origin.xz, uBox);
          p.y = mod(p.y, 14.0) + 0.3;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          vA = smoothstep(uBox * 0.5, uBox * 0.2, d) * smoothstep(0.5, 3.0, d) * (0.4 + 0.6 * fract(aSeed * 7.3));
          gl_PointSize = uScale * (18.0 + aSeed * 22.0) / max(d, 0.5);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(c)) * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(1.0, 0.93, 0.8) * a * 0.55, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.name = 'dustMotes';
    this.points.renderOrder = 7;
    scene.add(this.points);
  }

  update(time: number, pixelRatio: number): void {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uScale.value = pixelRatio;
  }

  set visible(v: boolean) {
    this.points.visible = v;
  }
}
