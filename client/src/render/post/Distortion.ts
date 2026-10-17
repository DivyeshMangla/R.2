import * as THREE from 'three';
import { Effect } from 'postprocessing';

const FRAG = /* glsl */ `
  uniform sampler2D uDistortion;
  uniform float uStrength;
  void mainUv(inout vec2 uv) {
    uv += texture2D(uDistortion, uv).xy * uStrength;
  }
`;

/**
 * Screen-space refraction for shockwaves, fireball heat and shell trails.
 * Distortion meshes live in their own scene and write signed UV offsets into a
 * half-resolution float target in `update`; the effect then bends the UVs of
 * every effect in its pass (bloom, grading, ...) through mainUv.
 */
export class DistortionEffect extends Effect {
  readonly distortionScene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly clearColor = new THREE.Color(0, 0, 0);
  private readonly prevClear = new THREE.Color();

  constructor(distortionScene: THREE.Scene, camera: THREE.Camera) {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    super('DistortionEffect', FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ['uDistortion', new THREE.Uniform(target.texture)],
        ['uStrength', new THREE.Uniform(1)],
      ]),
    });
    this.distortionScene = distortionScene;
    this.camera = camera;
    this.target = target;
  }

  set strength(v: number) {
    (this.uniforms.get('uStrength') as THREE.Uniform<number>).value = v;
  }

  override update(renderer: THREE.WebGLRenderer): void {
    const prevTarget = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.prevClear);
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(this.clearColor, 0);
    renderer.clear(true, false, false);
    renderer.render(this.distortionScene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(this.prevClear, prevAlpha);
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, Math.floor(width / 2)), Math.max(1, Math.floor(height / 2)));
  }

  override dispose(): void {
    this.target.dispose();
    super.dispose();
  }
}
