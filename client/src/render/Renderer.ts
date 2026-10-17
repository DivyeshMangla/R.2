import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { QUALITY_PRESETS, type QualityName, type QualitySettings } from './QualityLegacy';

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
  hemiIntensity: number;
  shadowRadius: number;
  fogDensity: number;
}

const SHADOW_EXTENT = 26;

/** WebGL2 renderer, lighting rig, environment map and the post-processing chain. */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  quality: QualitySettings = QUALITY_PRESETS.High;
  readonly tuning: GraphicsTuning = {
    exposure: 1.0,
    bloomIntensity: 1.35,
    bloomThreshold: 0.92,
    bloomSmoothing: 0.25,
    bloomRadius: 0.72,
    aoIntensity: 2.6,
    aoRadius: 1.6,
    vignetteDarkness: 0.55,
    envIntensity: 0.55,
    sunIntensity: 3.2,
    hemiIntensity: 0.55,
    shadowRadius: 3,
    fogDensity: 0.0065,
  };

  private composer: EffectComposer | null = null;
  private bloom: BloomEffect | null = null;
  private ao: N8AOPostPass | null = null;
  private vignette: VignetteEffect | null = null;
  private chromatic: ChromaticAberrationEffect | null = null;
  private chromaticAmount = 0;
  private readonly sunOffset = new THREE.Vector3(-22, 38, 16);
  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    if (!this.renderer.capabilities.isWebGL2) throw new Error('WebGL2 is required');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    // three r18x folds soft PCF into PCFShadowMap (PCFSoftShadowMap was removed); softness comes from shadow.radius.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    // Multiple post passes render per frame; the game resets stats once per frame instead.
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(70, container.clientWidth / container.clientHeight, 0.1, 400);
    this.camera.position.set(0, 12, -20);

    // Environment for reflections.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    envScene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    pmrem.dispose();
    this.scene.environmentIntensity = this.tuning.envIntensity;

    this.scene.background = new THREE.Color(0x060a12);
    this.scene.fog = new THREE.FogExp2(0x0a1220, this.tuning.fogDensity);
    this.scene.add(this.createSky());

    this.hemi = new THREE.HemisphereLight(0x9cc8ff, 0x1a1410, this.tuning.hemiIntensity);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff1dd, this.tuning.sunIntensity);
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

    window.addEventListener('resize', () => this.resize());
    this.applyQuality('High');
  }

  get maxAnisotropy(): number {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  private createSky(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(300, 48, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x02040a) },
        uHorizon: { value: new THREE.Color(0x0e2a44) },
        uGlow: { value: new THREE.Color(0x19d3ff) },
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
          col += uGlow * 0.18 * exp(-abs(h) * 18.0);
          vec3 cell = floor(vDir * 220.0);
          float star = step(0.9985, hash(cell)) * smoothstep(0.05, 0.4, h);
          col += vec3(star) * 1.4;
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

  applyQuality(name: QualityName): void {
    const q = QUALITY_PRESETS[name];
    this.quality = q;
    const ratio = Math.min(window.devicePixelRatio, q.pixelRatioCap) * (name === 'Low' ? 0.85 : 1);
    this.renderer.setPixelRatio(ratio);
    this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      (this.sun.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
    }
    this.rebuildComposer();
    this.resize();
  }

  private rebuildComposer(): void {
    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    this.ao = null;
    this.vignette = null;
    this.chromatic = null;
    const q = this.quality;
    const t = this.tuning;

    if (!q.postProcessing) {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = t.exposure;
      return;
    }
    // Tone mapping happens inside the post chain (ACES filmic) so bloom operates on HDR values.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = t.exposure;
    const composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    composer.addPass(new RenderPass(this.scene, this.camera));

    if (q.ao) {
      const size = this.drawingSize();
      const ao = new N8AOPostPass(this.scene, this.camera, size.x, size.y);
      ao.setQualityMode(q.aoQuality);
      ao.configuration.aoRadius = t.aoRadius;
      ao.configuration.distanceFalloff = 1.0;
      ao.configuration.intensity = t.aoIntensity;
      ao.configuration.color = new THREE.Color(0, 0, 0);
      composer.addPass(ao);
      this.ao = ao;
    }

    const effects = [];
    if (q.bloom) {
      // HDR luminance threshold ≈ 1 means only emissive surfaces (and VFX) bloom.
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
    const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    effects.push(toneMapping);
    if (q.vignette) {
      this.vignette = new VignetteEffect({ darkness: t.vignetteDarkness, offset: 0.32 });
      effects.push(this.vignette);
    }
    composer.addPass(new EffectPass(this.camera, ...effects));

    if (q.chromaticAberration) {
      this.chromatic = new ChromaticAberrationEffect({
        blendFunction: BlendFunction.NORMAL,
        offset: new THREE.Vector2(0, 0),
        radialModulation: true,
        modulationOffset: 0.15,
      });
      composer.addPass(new EffectPass(this.camera, this.chromatic));
    }
    if (q.smaa) composer.addPass(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));

    this.composer = composer;
    this.applyTuning();
  }

  /** Pushes `tuning` values to the live effects (called from lil-gui). */
  applyTuning(): void {
    const t = this.tuning;
    this.renderer.toneMappingExposure = t.exposure;
    this.scene.environmentIntensity = t.envIntensity;
    this.sun.intensity = t.sunIntensity;
    this.hemi.intensity = t.hemiIntensity;
    this.sun.shadow.radius = t.shadowRadius;
    if (this.scene.fog instanceof THREE.FogExp2) this.scene.fog.density = t.fogDensity;
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
  }

  /** Kicks chromatic aberration (decays automatically). */
  pulseChromatic(amount: number): void {
    this.chromaticAmount = Math.min(1, this.chromaticAmount + amount);
  }

  /** Keeps a tight shadow frustum centered on the local player, snapped to shadow texels. */
  followShadow(target: THREE.Vector3): void {
    const texel = (SHADOW_EXTENT * 2) / this.quality.shadowMapSize;
    const center = new THREE.Vector3(Math.round(target.x / texel) * texel, 0, Math.round(target.z / texel) * texel);
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).add(this.sunOffset);
    this.sun.target.updateMatrixWorld();
  }

  private drawingSize(): THREE.Vector2 {
    return this.renderer.getDrawingBufferSize(new THREE.Vector2());
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
    this.chromaticAmount = Math.max(0, this.chromaticAmount - dt * 2.2);
    if (this.chromatic) {
      const a = this.chromaticAmount * this.chromaticAmount * 0.012;
      this.chromatic.offset.set(a, a * 0.6);
    }
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  get info(): THREE.WebGLInfo {
    return this.renderer.info;
  }
}
