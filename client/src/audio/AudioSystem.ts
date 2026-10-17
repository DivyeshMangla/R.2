import * as THREE from 'three';

/** Procedurally synthesised Web Audio: engine hum, cannon, impacts, explosions, UI chimes. */
export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private boostGain: GainNode | null = null;
  private readonly listenerPos = new THREE.Vector3();
  volume = 0.6;
  muted = false;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Engine: two detuned saws through a resonant low-pass.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 300;
    this.engineFilter.Q.value = 6;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc2 = ctx.createOscillator();
    this.engineOsc2.type = 'square';
    this.engineOsc.connect(this.engineFilter);
    this.engineOsc2.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.engineOsc.start();
    this.engineOsc2.start();

    // Boost hiss.
    const boostSrc = ctx.createBufferSource();
    boostSrc.buffer = this.noise;
    boostSrc.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    this.boostGain = ctx.createGain();
    this.boostGain.gain.value = 0;
    boostSrc.connect(bp).connect(this.boostGain).connect(this.master);
    boostSrc.start();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  setListener(pos: THREE.Vector3): void {
    this.listenerPos.copy(pos);
  }

  /** Distance attenuation + stereo pan relative to the listener's view. */
  private spatial(pos: THREE.Vector3 | null, camera: THREE.Camera | null): { gain: number; pan: number } {
    if (!pos) return { gain: 1, pan: 0 };
    const d = pos.distanceTo(this.listenerPos);
    const gain = 1 / (1 + (d / 12) ** 2);
    let pan = 0;
    if (camera) {
      const local = pos.clone().applyMatrix4(camera.matrixWorldInverse);
      pan = THREE.MathUtils.clamp(local.x / (Math.abs(local.z) + 4), -0.9, 0.9);
    }
    return { gain, pan };
  }

  private out(gain: number, pan: number): AudioNode | null {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return null;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(this.sfx);
    return g;
  }

  private noiseBurst(dest: AudioNode, t: number, dur: number, filter: BiquadFilterType, f0: number, f1: number, q: number, vol: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private tone(dest: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, dur: number, vol: number, attack = 0.002): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  cannon(pos: THREE.Vector3 | null, camera: THREE.Camera | null, local: boolean): void {
    const { gain, pan } = this.spatial(pos, camera);
    const dest = this.out(gain * (local ? 0.9 : 0.6), pan);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(dest, t, 'sine', 160, 38, 0.22, 0.9);
    this.tone(dest, t, 'square', 520, 90, 0.06, 0.15);
    this.noiseBurst(dest, t, 0.18, 'lowpass', 4200, 300, 0.7, 0.8);
  }

  impact(pos: THREE.Vector3 | null, camera: THREE.Camera | null, metal: boolean): void {
    const { gain, pan } = this.spatial(pos, camera);
    const dest = this.out(gain * 0.7, pan);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(dest, t, 0.09, 'bandpass', metal ? 3200 : 1400, metal ? 1800 : 500, 2.5, 0.9);
    if (metal) {
      const f = 900 + Math.random() * 600;
      this.tone(dest, t, 'triangle', f, f * 0.92, 0.25, 0.18);
      this.tone(dest, t, 'sine', f * 2.37, f * 2.2, 0.18, 0.08);
    }
  }

  hitMarker(): void {
    const dest = this.out(0.35, 0);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(dest, t, 'square', 1800, 1700, 0.04, 0.25);
    this.tone(dest, t + 0.03, 'square', 2400, 2300, 0.04, 0.2);
  }

  explosion(pos: THREE.Vector3 | null, camera: THREE.Camera | null, scale = 1): void {
    const { gain, pan } = this.spatial(pos, camera);
    const dest = this.out(Math.min(1.4, gain * 1.6 * scale), pan);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(dest, t, 'sine', 90, 25, 1.1, 1.0, 0.005);
    this.noiseBurst(dest, t, 1.3, 'lowpass', 2600, 90, 0.9, 1.0);
    this.noiseBurst(dest, t + 0.05, 0.5, 'highpass', 3000, 1200, 0.5, 0.25);
  }

  ram(pos: THREE.Vector3 | null, camera: THREE.Camera | null, strength: number): void {
    const { gain, pan } = this.spatial(pos, camera);
    const dest = this.out(gain * Math.min(1.2, 0.4 + strength * 0.05), pan);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(dest, t, 'sine', 120, 50, 0.3, 0.9);
    this.noiseBurst(dest, t, 0.25, 'bandpass', 900, 300, 1.2, 0.9);
    this.tone(dest, t, 'triangle', 640, 560, 0.4, 0.15);
  }

  levelUp(): void {
    const dest = this.out(0.5, 0);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      this.tone(dest, t + i * 0.08, 'triangle', f, f, 0.5, 0.35, 0.01);
      this.tone(dest, t + i * 0.08, 'sine', f * 2, f * 2, 0.35, 0.1, 0.01);
    });
  }

  pick(): void {
    const dest = this.out(0.4, 0);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(dest, t, 'sine', 880, 1320, 0.15, 0.4);
    this.tone(dest, t + 0.07, 'sine', 1320, 1760, 0.2, 0.3);
  }

  emp(pos: THREE.Vector3 | null, camera: THREE.Camera | null): void {
    const { gain, pan } = this.spatial(pos, camera);
    const dest = this.out(gain * 1.1, pan);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(dest, t, 'sawtooth', 2400, 60, 0.7, 0.35);
    this.tone(dest, t, 'sine', 140, 40, 0.8, 0.8);
    this.noiseBurst(dest, t, 0.6, 'bandpass', 5000, 400, 3, 0.5);
  }

  dash(pos: THREE.Vector3 | null, camera: THREE.Camera | null): void {
    const { gain, pan } = this.spatial(pos, camera);
    const dest = this.out(gain, pan);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(dest, t, 0.55, 'bandpass', 600, 4000, 1.5, 0.9);
    this.tone(dest, t, 'sawtooth', 90, 220, 0.4, 0.3);
  }

  hurt(): void {
    const dest = this.out(0.5, 0);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(dest, t, 'square', 220, 110, 0.12, 0.2);
  }

  /** Continuous engine sound for the local robot. */
  updateEngine(speed: number, throttle: number, boosting: boolean, alive: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.engineOsc || !this.engineOsc2 || !this.engineFilter || !this.engineGain || !this.boostGain) return;
    const t = ctx.currentTime;
    const s = Math.min(1.5, Math.abs(speed) / 22);
    const base = 42 + s * 95 + Math.abs(throttle) * 12;
    this.engineOsc.frequency.setTargetAtTime(base, t, 0.06);
    this.engineOsc2.frequency.setTargetAtTime(base * 0.502, t, 0.06);
    this.engineFilter.frequency.setTargetAtTime(220 + s * 1500 + Math.abs(throttle) * 400, t, 0.08);
    this.engineGain.gain.setTargetAtTime(alive ? 0.05 + s * 0.07 + Math.abs(throttle) * 0.04 : 0, t, 0.1);
    this.boostGain.gain.setTargetAtTime(alive && boosting ? 0.18 : 0, t, 0.08);
  }
}
