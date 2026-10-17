import * as THREE from 'three';
import { Pass } from 'postprocessing';
import type { ParticleSystem } from './Particles';

/**
 * Draws the particle scene on top of the lit frame inside the composer, after
 * AO and before bloom/tone mapping, so sparks and fire bloom in HDR while AO
 * never darkens them.
 *
 * Occlusion and soft edges come from the composer's *stable* depth texture:
 * it is a blit target that is never bound as a render output, so sampling it
 * while drawing into the current buffer cannot form a feedback loop.
 */
export class ParticlePass extends Pass {
  private readonly particleScene: THREE.Scene;
  private readonly particleCamera: THREE.PerspectiveCamera;
  private readonly systems: ParticleSystem[];
  private depth: THREE.Texture | null = null;
  private width = 1;
  private height = 1;
  /** Soft-particle fade distance in metres (0 = hard occlusion). */
  softness = 0.6;
  /** Extra scenes rendered with the particles (distortion-free transients). */
  readonly overlays: THREE.Scene[] = [];

  constructor(particleScene: THREE.Scene, camera: THREE.PerspectiveCamera, systems: ParticleSystem[]) {
    super('ParticlePass');
    this.particleScene = particleScene;
    this.particleCamera = camera;
    this.systems = systems;
    this.needsSwap = false;
    this.needsDepthTexture = true;
  }

  override setDepthTexture(depthTexture: THREE.Texture): void {
    this.depth = depthTexture;
  }

  override setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget | null): void {
    const cam = this.particleCamera;
    for (const s of this.systems) s.setDepth(this.depth, cam.near, cam.far, this.width, this.height, this.softness);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
    for (const o of this.overlays) renderer.render(o, cam);
    renderer.render(this.particleScene, cam);
    renderer.autoClear = autoClear;
  }
}
