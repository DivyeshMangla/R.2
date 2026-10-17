export type QualityName = 'Low' | 'Medium' | 'High' | 'Ultra';

export interface QualitySettings {
  name: QualityName;
  pixelRatioCap: number;
  shadowMapSize: number;
  postProcessing: boolean;
  bloom: boolean;
  ao: boolean;
  aoQuality: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra';
  smaa: boolean;
  vignette: boolean;
  chromaticAberration: boolean;
  particleMultiplier: number;
  maxDecals: number;
}

export const QUALITY_PRESETS: Readonly<Record<QualityName, QualitySettings>> = {
  Low: {
    name: 'Low',
    pixelRatioCap: 1,
    shadowMapSize: 512,
    postProcessing: false,
    bloom: false,
    ao: false,
    aoQuality: 'Performance',
    smaa: false,
    vignette: false,
    chromaticAberration: false,
    particleMultiplier: 0.35,
    maxDecals: 16,
  },
  Medium: {
    name: 'Medium',
    pixelRatioCap: 1.25,
    shadowMapSize: 1024,
    postProcessing: true,
    bloom: true,
    ao: false,
    aoQuality: 'Low',
    smaa: true,
    vignette: true,
    chromaticAberration: true,
    particleMultiplier: 0.6,
    maxDecals: 32,
  },
  High: {
    name: 'High',
    pixelRatioCap: 1.5,
    shadowMapSize: 2048,
    postProcessing: true,
    bloom: true,
    ao: true,
    aoQuality: 'Medium',
    smaa: true,
    vignette: true,
    chromaticAberration: true,
    particleMultiplier: 1,
    maxDecals: 64,
  },
  Ultra: {
    name: 'Ultra',
    pixelRatioCap: 2,
    shadowMapSize: 4096,
    postProcessing: true,
    bloom: true,
    ao: true,
    aoQuality: 'High',
    smaa: true,
    vignette: true,
    chromaticAberration: true,
    particleMultiplier: 1.4,
    maxDecals: 96,
  },
};

export const QUALITY_ORDER: readonly QualityName[] = ['Low', 'Medium', 'High', 'Ultra'];

const STORAGE_KEY = 'robot-arena.quality';

export function loadSavedQuality(): QualityName | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v && (QUALITY_ORDER as readonly string[]).includes(v) ? (v as QualityName) : null;
  } catch {
    return null;
  }
}

export function saveQuality(name: QualityName): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Storage unavailable (private mode); the preset simply won't persist.
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
