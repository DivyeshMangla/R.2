export interface PerfSample {
  frameMs: number;
  sceneDraws: number;
  totalDraws: number;
  triangles: number;
  particles: number;
  lights: number;
  preset: string;
}

/**
 * F3 performance overlay: FPS, frame time, scene / total draw calls,
 * triangles, live particles and active dynamic lights. Text refreshes 4x per
 * second; between refreshes it only accumulates numbers.
 */
export class DebugOverlay {
  private readonly node: HTMLDivElement;
  private visible = false;
  private acc = 0;
  private frames = 0;
  private worstMs = 0;
  private maxDraws = 0;

  constructor() {
    this.node = document.createElement('div');
    this.node.className = 'perf-overlay panel';
    this.node.style.display = 'none';
    document.body.appendChild(this.node);
  }

  get enabled(): boolean {
    return this.visible;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.node.style.display = this.visible ? 'block' : 'none';
  }

  /** Call once per frame; `sample` is only read when the overlay is visible. */
  update(dt: number, sample: PerfSample): void {
    if (!this.visible) return;
    this.acc += dt;
    this.frames++;
    this.worstMs = Math.max(this.worstMs, sample.frameMs);
    this.maxDraws = Math.max(this.maxDraws, sample.totalDraws);
    if (this.acc < 0.25) return;
    const fps = this.frames / this.acc;
    this.node.textContent =
      `${sample.preset.toUpperCase()}  ${fps.toFixed(0)} fps  ${(1000 / fps).toFixed(1)} ms (worst ${this.worstMs.toFixed(1)})\n` +
      `draws scene ${sample.sceneDraws}  total ${sample.totalDraws} (peak ${this.maxDraws})  tris ${(sample.triangles / 1000).toFixed(0)}k\n` +
      `particles ${sample.particles}  lights ${sample.lights}`;
    this.acc = 0;
    this.frames = 0;
    this.worstMs = 0;
  }
}
