export type QualityName = 'Low' | 'Medium' | 'High' | 'Ultra';

/** Every graphics feature the renderer can toggle. Presets fill these; the settings menu overrides them. */
export interface GraphicsSettings {
  preset: QualityName;
  pixelRatioCap: number;
  pixelRatioScale: number;
  shadows: boolean;
  shadowMapSize: number;
  postProcessing: boolean;
  bloom: boolean;
  ao: boolean;
  aoQuality: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra';
  smaa: boolean;
  grading: boolean;
  filmGrain: boolean;
  vignette: boolean;
  /** Chromatic aberration pulses + radial dash blur. */
  lensEffects: boolean;
  motionBlur: boolean;
  softParticles: boolean;
  distortion: boolean;
  maxDynamicLights: number;
  particleDensity: number;
  maxDecals: number;
  skidMarks: boolean;
  dustMotes: boolean;
  contactShadows: boolean;
  envMapSize: number;
}

export type ToggleKey = {
  [K in keyof GraphicsSettings]: GraphicsSettings[K] extends boolean ? K : never;
}[keyof GraphicsSettings];

export const TOGGLE_LABELS: Readonly<Record<ToggleKey, string>> = {
  shadows: 'Shadows',
  postProcessing: 'Post-processing',
  bloom: 'Bloom',
  ao: 'Ambient occlusion (N8AO)',
  smaa: 'Anti-aliasing (SMAA)',
  grading: 'Color grading (LUT)',
  filmGrain: 'Film grain',
  vignette: 'Vignette',
  lensEffects: 'Chromatic aberration',
  motionBlur: 'Dash motion blur',
  softParticles: 'Soft particles',
  distortion: 'Heat / shockwave distortion',
  skidMarks: 'Skid marks',
  dustMotes: 'Floating dust',
  contactShadows: 'Contact shadows',
};

export const QUALITY_PRESETS: Readonly<Record<QualityName, Omit<GraphicsSettings, 'preset'>>> = {
  Low: {
    pixelRatioCap: 1,
    pixelRatioScale: 0.8,
    shadows: true,
    shadowMapSize: 1024,
    postProcessing: false,
    bloom: false,
    ao: false,
    aoQuality: 'Performance',
    smaa: false,
    grading: false,
    filmGrain: false,
    vignette: false,
    lensEffects: false,
    motionBlur: false,
    softParticles: false,
    distortion: false,
    maxDynamicLights: 2,
    particleDensity: 0.4,
    maxDecals: 24,
    skidMarks: true,
    dustMotes: false,
    contactShadows: true,
    envMapSize: 64,
  },
  Medium: {
    pixelRatioCap: 1.25,
    pixelRatioScale: 1,
    shadows: true,
    shadowMapSize: 1024,
    postProcessing: true,
    bloom: true,
    ao: false,
    aoQuality: 'Performance',
    smaa: true,
    grading: true,
    filmGrain: false,
    vignette: true,
    lensEffects: true,
    motionBlur: false,
    softParticles: true,
    distortion: false,
    maxDynamicLights: 4,
    particleDensity: 0.65,
    maxDecals: 48,
    skidMarks: true,
    dustMotes: true,
    contactShadows: true,
    envMapSize: 128,
  },
  High: {
    pixelRatioCap: 1.5,
    pixelRatioScale: 1,
    shadows: true,
    shadowMapSize: 2048,
    postProcessing: true,
    bloom: true,
    ao: true,
    aoQuality: 'Medium',
    smaa: true,
    grading: true,
    filmGrain: true,
    vignette: true,
    lensEffects: true,
    motionBlur: true,
    softParticles: true,
    distortion: true,
    maxDynamicLights: 6,
    particleDensity: 1,
    maxDecals: 96,
    skidMarks: true,
    dustMotes: true,
    contactShadows: true,
    envMapSize: 256,
  },
  Ultra: {
    pixelRatioCap: 2,
    pixelRatioScale: 1,
    shadows: true,
    shadowMapSize: 4096,
    postProcessing: true,
    bloom: true,
    ao: true,
    aoQuality: 'High',
    smaa: true,
    grading: true,
    filmGrain: true,
    vignette: true,
    lensEffects: true,
    motionBlur: true,
    softParticles: true,
    distortion: true,
    maxDynamicLights: 8,
    particleDensity: 1.35,
    maxDecals: 160,
    skidMarks: true,
    dustMotes: true,
    contactShadows: true,
    envMapSize: 256,
  },
};

export const QUALITY_ORDER: readonly QualityName[] = ['Low', 'Medium', 'High', 'Ultra'];

export function settingsForPreset(name: QualityName): GraphicsSettings {
  return { preset: name, ...QUALITY_PRESETS[name] };
}

const STORAGE_KEY = 'robot-arena.graphics.v2';

/** Restores the saved preset + per-feature overrides (null if nothing valid is stored). */
export function loadSavedSettings(): GraphicsSettings | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GraphicsSettings>;
    if (!parsed.preset || !(QUALITY_ORDER as readonly string[]).includes(parsed.preset)) return null;
    const base = settingsForPreset(parsed.preset);
    for (const key of Object.keys(base) as (keyof GraphicsSettings)[]) {
      const v = parsed[key];
      if (v !== undefined && typeof v === typeof base[key]) (base as unknown as Record<string, unknown>)[key] = v;
    }
    return base;
  } catch {
    return null;
  }
}

export function saveSettings(s: GraphicsSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private mode); settings simply won't persist.
  }
}

/**
 * Averages FPS over the first 5 seconds of gameplay and recommends a preset.
 * Returns null while still measuring.
 */
export class QualityAutoDetector {
  private elapsed = 0;
  private frames = 0;
  private done = false;
  private readonly warmup = 1.0;
  private readonly window = 5.0;

  sample(dt: number): QualityName | null {
    if (this.done) return null;
    this.elapsed += dt;
    if (this.elapsed < this.warmup) return null;
    this.frames += 1;
    if (this.elapsed < this.warmup + this.window) return null;
    this.done = true;
    const fps = this.frames / this.window;
    if (fps < 28) return 'Low';
    if (fps < 45) return 'Medium';
    return 'High';
  }

  get finished(): boolean {
    return this.done;
  }
}
