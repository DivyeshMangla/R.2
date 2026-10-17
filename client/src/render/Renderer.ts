import * as THREE from 'three';
import {
  BloomEffect,
  BlendFunction,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  type Effect,
  type LUT3DEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { bakeEnvironment } from './env/EnvironmentBake';
import { HeightFog, installHeightFogChunks } from './env/HeightFog';
import { DistortionEffect } from './post/Distortion';
import { buildGradingLut, createGradingEffect } from './post/Grading';
import { LensEffect } from './post/LensEffect';
import type { GraphicsSettings } from './Quality';
import { settingsForPreset } from './Quality';
import { ParticlePass } from './vfx/ParticlePass';
import type { ParticleSystem } from './vfx/Particles';

export interface GraphicsTuning {
  exposure: number;
  bloomIntensity: number;
  bloomThreshold: number;
  bloomSmoothing: number;
  bloomRadius: number;
  aoIntensity: number;
  aoRadius: number;
  vignetteDarkness: number;
  envIntensity: number;
  sunIntensity: number;
  rimIntensity: number;
  hemiIntensity: number;
  shadowRadius: number;
  fogDensity: number;
  fogFalloff: number;
  gradeShadowTint: number;
  gradeHighlightTint: number;
  gradeSaturation: number;
  gradeContrast: number;
  grainOpacity: number;
  distortionStrength: number;
  particleSoftness: number;
}

export interface DrawStats {
  /** Scene draws (main view + shadow map) recorded around the scene render. */
  scene: number;
  /** Every draw this frame, post passes included. */
  total: number;
  triangles: number;
}

const SHADOW_EXTENT = 26;

/** Scene render pass that records how many draw calls the scene itself (and its shadows) cost. */
class CountingRenderPass extends RenderPass {
  calls = 0;

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget, deltaTime?: number, stencilTest?: boolean): void {
    const before = renderer.info.render.calls;
    super.render(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest);
    this.calls = renderer.info.render.calls - before;
  }
}

/**
 * WebGL2 renderer: lighting rig (shadowed key, cool rim, low hemisphere),
 * baked arena environment, exponential height fog, and the post chain built
 * from GraphicsSettings.
 */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly distortionScene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly rim: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fog: HeightFog;
  readonly lens = new LensEffect();
  readonly draws: DrawStats = { scene: 0, total: 0, triangles: 0 };
  settings: GraphicsSettings = settingsForPreset('High');
  readonly tuning: GraphicsTuning = {
    exposure: 1.0,
    bloomIntensity: 1.25,
    bloomThreshold: 0.95,
    bloomSmoothing: 0.25,
    bloomRadius: 0.7,
    aoIntensity: 2.4,
    aoRadius: 1.6,
    vignetteDarkness: 0.5,
    envIntensity: 0.7,
    sunIntensity: 3.0,
    rimIntensity: 1.6,
    hemiIntensity: 0.35,
    shadowRadius: 3,
    fogDensity: 0.016,
    fogFalloff: 0.16,
    gradeShadowTint: 1,
    gradeHighlightTint: 1,
    gradeSaturation: 1.08,
    gradeContrast: 0.25,
    grainOpacity: 0.12,
    distortionStrength: 1,
    particleSoftness: 0.6,
  };

  private composer: EffectComposer | null = null;
  private renderPass: CountingRenderPass | null = null;
  private bloom: BloomEffect | null = null;
  private ao: N8AOPostPass | null = null;
  private vignette: VignetteEffect | null = null;
  private noise: NoiseEffect | null = null;
  private lut: LUT3DEffect | null = null;
  private distortion: DistortionEffect | null = null;
  private particlePass: ParticlePass | null = null;
  private particleScene: THREE.Scene | null = null;
  private particleSystems: ParticleSystem[] = [];
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private readonly sunOffset = new THREE.Vector3(-22, 38, 16);
  private readonly rimOffset = new THREE.Vector3(26, 14, -30);
  private readonly shadowCenter = new THREE.Vector3();
  private readonly size = new THREE.Vector2();
  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    // Height fog replaces three's linear-fog chunks; must happen before any shader compiles.
    installHeightFogChunks();
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    if (!this.renderer.capabilities.isWebGL2) throw new Error('WebGL2 is required');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    // Several passes render per frame; the game resets stats once per frame.
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(70, container.clientWidth / container.clientHeight, 0.1, 400);
    this.camera.position.set(0, 12, -20);

    this.scene.background = new THREE.Color(0x060a12);
    this.fog = new HeightFog(0x0b1422, this.tuning.fogDensity, this.tuning.fogFalloff);
    this.scene.fog = this.fog;
    this.scene.add(this.createSky());

    this.hemi = new THREE.HemisphereLight(0x8fb8ff, 0x16110c, this.tuning.hemiIntensity);
    this.scene.add(this.hemi);

    // Key light: warm floodlight, the only shadow caster.
    this.sun = new THREE.DirectionalLight(0xfff0d8, this.tuning.sunIntensity);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_EXTENT;
    sc.right = SHADOW_EXTENT;
    sc.top = SHADOW_EXTENT;
    sc.bottom = -SHADOW_EXTENT;
    sc.near = 1;
    sc.far = 110;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = this.tuning.shadowRadius;
    this.scene.add(this.sun, this.sun.target);

    // Rim light: cool, from behind the key, carves silhouettes out of the haze.
    this.rim = new THREE.DirectionalLight(0x7fb6ff, this.tuning.rimIntensity);
    this.rim.castShadow = false;
    this.scene.add(this.rim, this.rim.target);

    window.addEventListener('resize', () => this.resize());
    this.applySettings(this.settings);
  }

  get maxAnisotropy(): number {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  /** Particles render inside the composer (after AO, before bloom). */
  setParticles(scene: THREE.Scene, systems: ParticleSystem[]): void {
    this.particleScene = scene;
    this.particleSystems = systems;
    this.rebuildComposer();
  }

  /** Bakes the current scene (arena, floodlights, sky) into the reflection environment. */
  bakeEnvironment(): void {
    this.envTarget?.dispose();
    this.envTarget = bakeEnvironment(this.renderer, this.scene, this.settings.envMapSize);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = this.tuning.envIntensity;
  }

  private createSky(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(300, 48, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x02040a) },
        uHorizon: { value: new THREE.Color(0x10263a) },
        uGlow: { value: new THREE.Color(0xff8a3b) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGlow;
        varying vec3 vDir;
        float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
        void main() {
          float h = clamp(vDir.y, -0.2, 1.0);
          vec3 col = mix(uHorizon, uTop, pow(max(h, 0.0), 0.45));
          // Sodium-orange industrial light pollution on the horizon.
          col += uGlow * 0.12 * exp(-abs(h) * 14.0);
          vec3 cell = floor(vDir * 220.0);
          float star = step(0.9988, hash(cell)) * smoothstep(0.1, 0.45, h);
          col += vec3(star) * 1.2;
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.name = 'Sky';
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    return sky;
  }

  applySettings(s: GraphicsSettings): void {
    const prevEnv = this.settings.envMapSize;
    this.settings = { ...s };
    const ratio = Math.min(window.devicePixelRatio, s.pixelRatioCap) * s.pixelRatioScale;
    this.renderer.setPixelRatio(ratio);
    this.renderer.shadowMap.enabled = s.shadows;
    this.sun.castShadow = s.shadows;
    this.sun.shadow.mapSize.set(s.shadowMapSize, s.shadowMapSize);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      (this.sun.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
    }
    // Shadow on/off changes material programs.
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.needsUpdate = true;
      }
    });
    this.rebuildComposer();
    this.resize();
    if (this.envTarget && prevEnv !== s.envMapSize) this.bakeEnvironment();
  }

  private rebuildComposer(): void {
    this.composer?.dispose();
    this.composer = null;
    this.renderPass = null;
    this.bloom = null;
    this.ao = null;
    this.vignette = null;
    this.noise = null;
    this.lut = null;
    this.distortion = null;
    this.particlePass = null;
    const s = this.settings;
    const t = this.tuning;
    for (const p of this.particleSystems) p.setDepth(null, this.camera.near, this.camera.far, 1, 1, 0);

    if (!s.postProcessing) {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = t.exposure;
      return;
    }
    // Tone mapping happens in the chain (ACES) so bloom and particles stay HDR until then.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = t.exposure;
    const composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.renderPass = new CountingRenderPass(this.scene, this.camera);
    composer.addPass(this.renderPass);

    if (s.ao) {
      const size = this.renderer.getDrawingBufferSize(this.size);
      const ao = new N8AOPostPass(this.scene, this.camera, size.x, size.y);
      ao.setQualityMode(s.aoQuality);
      ao.configuration.aoRadius = t.aoRadius;
      ao.configuration.distanceFalloff = 1.0;
      ao.configuration.intensity = t.aoIntensity;
      ao.configuration.color = new THREE.Color(0, 0, 0);
      // N8AO auto-enables transparency awareness when the scene has any transparent
      // material, which re-renders the whole scene twice per frame. Our transparent
      // objects never write depth, so AO already ignores them: keep it off.
      (ao as unknown as { autoDetectTransparency: boolean }).autoDetectTransparency = false;
      ao.configuration.transparencyAware = false;
      composer.addPass(ao);
      this.ao = ao;
    }

    if (this.particleScene) {
      this.particlePass = new ParticlePass(this.particleScene, this.camera, this.particleSystems);
      this.particlePass.softness = s.softParticles ? t.particleSoftness : 0;
      composer.addPass(this.particlePass);
    }

    const effects: Effect[] = [];
    if (s.distortion) {
      this.distortion = new DistortionEffect(this.distortionScene, this.camera);
      effects.push(this.distortion);
    }
    if (s.bloom) {
      this.bloom = new BloomEffect({
        mipmapBlur: true,
        intensity: t.bloomIntensity,
        luminanceThreshold: t.bloomThreshold,
        luminanceSmoothing: t.bloomSmoothing,
        radius: t.bloomRadius,
        levels: 8,
      });
      effects.push(this.bloom);
    }
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    if (s.grading) {
      this.lut = createGradingEffect(this.gradingParams());
      effects.push(this.lut);
    }
    if (s.vignette) {
      this.vignette = new VignetteEffect({ darkness: t.vignetteDarkness, offset: 0.32 });
      effects.push(this.vignette);
    }
    if (s.filmGrain) {
      this.noise = new NoiseEffect({ premultiply: true, blendFunction: BlendFunction.SCREEN });
      this.noise.blendMode.opacity.value = t.grainOpacity;
      effects.push(this.noise);
    }
    composer.addPass(new EffectPass(this.camera, ...effects));
    if (s.lensEffects || s.motionBlur) composer.addPass(new EffectPass(this.camera, this.lens));
    if (s.smaa) composer.addPass(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));

    this.composer = composer;
    this.applyTuning();
  }

  private gradingParams(): { shadowTint: number; highlightTint: number; saturation: number; contrast: number } {
    const t = this.tuning;
    return { shadowTint: t.gradeShadowTint, highlightTint: t.gradeHighlightTint, saturation: t.gradeSaturation, contrast: t.gradeContrast };
  }

  /** Rebuilds the grading LUT (lil-gui). */
  applyGrading(): void {
    if (!this.lut) return;
    const old = this.lut.lut;
    this.lut.lut = buildGradingLut(this.gradingParams());
    old.dispose();
  }

  /** Pushes `tuning` values to the live lights and effects (lil-gui). */
  applyTuning(): void {
    const t = this.tuning;
    this.renderer.toneMappingExposure = t.exposure;
    this.scene.environmentIntensity = t.envIntensity;
    this.sun.intensity = t.sunIntensity;
    this.rim.intensity = t.rimIntensity;
    this.hemi.intensity = t.hemiIntensity;
    this.sun.shadow.radius = t.shadowRadius;
    this.fog.density = t.fogDensity;
    this.fog.falloff = t.fogFalloff;
    if (this.bloom) {
      this.bloom.intensity = t.bloomIntensity;
      this.bloom.luminanceMaterial.threshold = t.bloomThreshold;
      this.bloom.luminanceMaterial.smoothing = t.bloomSmoothing;
      this.bloom.mipmapBlurPass.radius = t.bloomRadius;
    }
    if (this.ao) {
      this.ao.configuration.intensity = t.aoIntensity;
      this.ao.configuration.aoRadius = t.aoRadius;
    }
    if (this.vignette) this.vignette.darkness = t.vignetteDarkness;
    if (this.noise) this.noise.blendMode.opacity.value = t.grainOpacity;
    if (this.distortion) this.distortion.strength = t.distortionStrength;
    if (this.particlePass) this.particlePass.softness = this.settings.softParticles ? t.particleSoftness : 0;
  }

  /** Kicks chromatic aberration (decays automatically). */
  pulseChromatic(amount: number): void {
    this.lens.pulseChroma(amount);
  }

  /** Radial dash blur (decays automatically). */
  dashBlur(amount: number): void {
    this.lens.kickBlur(amount);
  }

  /** Keeps a tight shadow frustum centred on the local player, snapped to shadow texels. */
  followShadow(target: THREE.Vector3): void {
    const texel = (SHADOW_EXTENT * 2) / this.settings.shadowMapSize;
    const c = this.shadowCenter.set(Math.round(target.x / texel) * texel, 0, Math.round(target.z / texel) * texel);
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).add(this.sunOffset);
    this.sun.target.updateMatrixWorld();
    this.rim.target.position.copy(c);
    this.rim.position.copy(c).add(this.rimOffset);
    this.rim.target.updateMatrixWorld();
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
  }

  render(dt: number): void {
    this.lens.tick(dt, this.settings.lensEffects, this.settings.motionBlur);
    const info = this.renderer.info;
    if (this.composer) {
      this.composer.render(dt);
      this.draws.scene = this.renderPass?.calls ?? 0;
    } else {
      const before = info.render.calls;
      this.renderer.render(this.scene, this.camera);
      this.draws.scene = info.render.calls - before;
      if (this.particleScene) {
        const auto = this.renderer.autoClear;
        this.renderer.autoClear = false;
        this.renderer.render(this.particleScene, this.camera);
        this.renderer.autoClear = auto;
      }
    }
    this.draws.total = info.render.calls;
    this.draws.triangles = info.render.triangles;
  }

  get info(): THREE.WebGLInfo {
    return this.renderer.info;
  }
}
