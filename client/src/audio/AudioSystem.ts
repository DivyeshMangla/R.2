import * as THREE from 'three';
import type { WeaponId } from '@robot-arena/shared';
import { AudioVoiceBudget, VehicleAudioModel, type VehicleAudioInput } from './VehicleAudioModel';

interface LoopLayer { source: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode }
interface Voice {
  id: number; until: number; ui: boolean; input: GainNode; nodes: AudioNode[]; sources: AudioScheduledSourceNode[];
  timer: ReturnType<typeof setTimeout>;
}

/** Recorded engine texture, physical vehicle layers, and bounded spatial combat Foley. */
export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private vehicleBus: GainNode | null = null;
  private vehicleDuck: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engine: LoopLayer | null = null;
  private recorded: LoopLayer | null = null;
  private intake: LoopLayer | null = null;
  private road: LoopLayer | null = null;
  private tires: LoopLayer | null = null;
  private wind: LoopLayer | null = null;
  private boost: LoopLayer | null = null;
  private active = false;
  private duckUntil = 0;
  private readonly model = new VehicleAudioModel();
  private readonly budget = new AudioVoiceBudget(28);
  private readonly voices = new Map<number, Voice>();
  private readonly destinationVoices = new Map<AudioNode, Voice>();
  private readonly fadingVoices = new Set<number>();
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listenerPos = new THREE.Vector3();
  private readonly spatialPoint = new THREE.Vector3();
  volume = 0.6;
  muted = false;

  /** Must be called from a user gesture. Engine remains quiet until driving is active. */
  unlock(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass'; highpass.frequency.value = 28; highpass.Q.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -15; comp.knee.value = 16; comp.ratio.value = 3;
    comp.attack.value = 0.008; comp.release.value = 0.2;
    this.master.connect(highpass).connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.gain.value = this.active ? 0.75 : 0; this.sfx.connect(this.master);
    this.uiBus = ctx.createGain(); this.uiBus.gain.value = 0.75; this.uiBus.connect(this.master);
    this.vehicleBus = ctx.createGain(); this.vehicleBus.gain.value = this.active ? 1 : 0;
    this.vehicleDuck = ctx.createGain(); this.vehicleBus.connect(this.vehicleDuck).connect(this.master);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + white * 0.04) / 1.02;
      data[i] = white * 0.6 + brown * 1.3;
    }
    this.engine = this.loop(this.exhaustBuffer(ctx), 'lowpass', 240, 0.55);
    this.intake = this.loop(this.noise, 'bandpass', 350, 0.55);
    this.road = this.loop(this.noise, 'bandpass', 420, 0.5);
    this.tires = this.loop(this.noise, 'bandpass', 1100, 0.55);
    this.wind = this.loop(this.noise, 'lowpass', 650, 0.55);
    this.boost = this.loop(this.noise, 'bandpass', 850, 0.5);
    void this.loadRecordedEngine(ctx);
  }

  private loop(buffer: AudioBuffer, type: BiquadFilterType, frequency: number, q: number): LoopLayer {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource(); source.buffer = buffer; source.loop = true;
    const filter = ctx.createBiquadFilter(); filter.type = type;
    filter.frequency.value = frequency; filter.Q.value = q;
    const gain = ctx.createGain(); gain.gain.value = 0;
    source.connect(filter).connect(gain).connect(this.vehicleBus!); source.start();
    return { source, filter, gain };
  }

  /** Four-cylinder exhaust at a 1200 RPM reference: weak harmonics, noisy firing pulses. */
  private exhaustBuffer(ctx: AudioContext): AudioBuffer {
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let mean = 0;
    for (let i = 0; i < data.length; i++) {
      const phase = i / ctx.sampleRate * 40;
      const p = phase % 1;
      data[i] = Math.exp(-p * 13) * (0.55 * Math.sin(p * 9) + (Math.random() * 2 - 1) * 0.2)
        + Math.sin(phase * Math.PI * 2) * 0.15 + Math.sin(phase * Math.PI * 4) * 0.035;
      mean += data[i];
    }
    mean /= data.length;
    for (let i = 0; i < data.length; i++) data[i] -= mean;
    // A short cosine correction joins the loop endpoints without a periodic DC click.
    const delta = (data[0] - data[data.length - 1]) * 0.5;
    const edge = Math.round(ctx.sampleRate * 0.006);
    for (let i = 0; i < edge; i++) {
      const weight = (1 + Math.cos(Math.PI * i / edge)) * 0.5;
      data[i] -= delta * weight;
      data[data.length - 1 - i] += delta * weight;
    }
    return buffer;
  }

  private async loadRecordedEngine(ctx: AudioContext): Promise<void> {
    try {
      const response = await fetch('/assets/audio/engine-load.wav');
      if (!response.ok) return;
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      if (ctx.state === 'closed') return;
      this.recorded = this.loop(buffer, 'lowpass', 2100, 0.55);
    } catch { /* Combustion and all physical feedback remain available on decode failure. */ }
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (this.fadeTimer !== null) { clearTimeout(this.fadeTimer); this.fadeTimer = null; }
    for (const id of this.fadingVoices) this.releaseVoice(id);
    this.fadingVoices.clear();
    if (this.ctx) {
      this.vehicleBus?.gain.setTargetAtTime(active ? 1 : 0, this.ctx.currentTime, active ? 0.12 : 0.045);
      // Approximately 40 ms to silence; UI remains on its independent bus.
      this.sfx?.gain.setTargetAtTime(active ? 0.75 : 0, this.ctx.currentTime, 0.009);
    }
    if (!active) {
      for (const voice of this.voices.values()) if (!voice.ui) this.fadingVoices.add(voice.id);
      this.fadeTimer = setTimeout(() => {
        for (const id of this.fadingVoices) this.releaseVoice(id);
        this.fadingVoices.clear(); this.fadeTimer = null;
      }, 80);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master && this.ctx && !this.muted) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
  }

  setListener(pos: THREE.Vector3): void { this.listenerPos.copy(pos); }

  private spatial(pos: THREE.Vector3 | null, camera: THREE.Camera | null): { gain: number; pan: number } {
    if (!pos) return { gain: 1, pan: 0 };
    const gain = 1 / (1 + (pos.distanceTo(this.listenerPos) / 20) ** 2);
    let pan = 0;
    if (camera) {
      const local = this.spatialPoint.copy(pos).applyMatrix4(camera.matrixWorldInverse);
      pan = THREE.MathUtils.clamp(local.x / (Math.abs(local.z) + 5), -0.85, 0.85);
    }
    return { gain, pan };
  }

  private out(gain: number, pan: number, event: string, duration: number, priority = 1, interval = 0, ui = false): GainNode | null {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || (!this.active && !ui) || this.muted || gain < 0.008
      || (typeof document !== 'undefined' && document.hidden)) return null;
    // Audio time is authoritative even if browser timer callbacks are throttled.
    for (const voice of this.voices.values()) if (voice.until <= ctx.currentTime) this.releaseVoice(voice.id);
    const allocation = this.budget.acquire(ctx.currentTime, duration, priority, event, interval);
    if (!allocation) return null;
    if (allocation.stolen !== undefined) this.releaseVoice(allocation.stolen);
    const input = ctx.createGain(); input.gain.value = gain;
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = 0.55;
    filter.frequency.value = 2200 + 6500 * Math.sqrt(Math.min(1, gain));
    const panner = ctx.createStereoPanner(); panner.pan.value = pan;
    input.connect(filter).connect(panner).connect(ui ? this.uiBus! : this.sfx);
    const voice: Voice = {
      id: allocation.id, until: ctx.currentTime + duration, ui, input, nodes: [input, filter, panner], sources: [],
      timer: setTimeout(() => this.releaseVoice(allocation.id), (duration + 0.1) * 1000),
    };
    this.voices.set(voice.id, voice); this.destinationVoices.set(input, voice);
    return input;
  }

  private track(dest: AudioNode, source: AudioScheduledSourceNode, ...nodes: AudioNode[]): void {
    const voice = this.destinationVoices.get(dest);
    if (voice) { voice.sources.push(source); voice.nodes.push(source, ...nodes); }
  }

  private releaseVoice(id: number): void {
    const voice = this.voices.get(id);
    if (!voice) return;
    clearTimeout(voice.timer);
    for (const source of voice.sources) { try { source.stop(); } catch { /* Already stopped. */ } }
    for (const node of voice.nodes) node.disconnect();
    this.destinationVoices.delete(voice.input); this.voices.delete(id); this.budget.release(id);
    this.fadingVoices.delete(id);
  }

  private duck(amount = 0.72): void {
    if (!this.ctx || !this.vehicleDuck) return;
    const t = this.ctx.currentTime;
    this.duckUntil = Math.max(this.duckUntil, t + 0.16);
    this.vehicleDuck.gain.setTargetAtTime(amount, t, 0.012);
  }

  private noiseBurst(dest: AudioNode, t: number, dur: number, filter: BiquadFilterType, f0: number, f1: number, q: number, volume: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const source = ctx.createBufferSource(); source.buffer = this.noise;
    source.playbackRate.value = 0.9 + Math.random() * 0.2;
    const f = ctx.createBiquadFilter(); f.type = filter; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const gain = ctx.createGain(); gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.003); gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    source.connect(f).connect(gain).connect(dest); this.track(dest, source, f, gain);
    source.start(t, Math.random() * Math.max(0, 1.5 - dur)); source.stop(t + dur + 0.025);
  }

  private tone(dest: AudioNode, t: number, f0: number, f1: number, dur: number, volume: number, type: OscillatorType = 'sine'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const source = ctx.createOscillator(); source.type = type;
    source.frequency.setValueAtTime(f0, t); source.frequency.exponentialRampToValueAtTime(Math.max(25, f1), t + dur);
    const gain = ctx.createGain(); gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.003); gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    source.connect(gain).connect(dest); this.track(dest, source, gain);
    source.start(t); source.stop(t + dur + 0.025);
  }

  cannon(pos: THREE.Vector3 | null, camera: THREE.Camera | null, local: boolean, weaponId: WeaponId = 'pulse'): void {
    const { gain, pan } = this.spatial(pos, camera);
    const volume = weaponId === 'repeater' ? 0.3 : weaponId === 'scatter' ? 0.6 : 0.48;
    const dest = this.out(gain * volume * (local ? 1 : 0.6), pan, local ? 'local-shot' : 'remote-shot', 0.5, local ? 4 : 2, local ? 0.035 : 0.025);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    const variation = 0.94 + Math.random() * 0.12;
    if (weaponId === 'repeater') {
      this.tone(dest, t, 145 * variation, 58, 0.085, 0.7);
      this.noiseBurst(dest, t, 0.07, 'bandpass', 2100, 650, 0.6, 0.8);
      this.noiseBurst(dest, t + 0.04, 0.065, 'bandpass', 670, 280, 0.7, 0.22);
    } else if (weaponId === 'rail') {
      this.noiseBurst(dest, t, 0.055, 'highpass', 2900, 1200, 0.55, 0.7);
      this.tone(dest, t, 105 * variation, 31, 0.26, 0.95);
      this.noiseBurst(dest, t + 0.025, 0.3, 'bandpass', 1200, 180, 0.7, 0.7);
      this.tone(dest, t + 0.008, 520 * variation, 220, 0.12, 0.12, 'triangle');
    } else if (weaponId === 'scatter') {
      this.tone(dest, t, 100 * variation, 35, 0.24, 1);
      this.noiseBurst(dest, t, 0.21, 'lowpass', 3200, 300, 0.55, 1.05);
      this.noiseBurst(dest, t + 0.12, 0.12, 'bandpass', 1200, 450, 0.6, 0.18);
    } else {
      this.tone(dest, t, 145 * variation, 42, 0.2, 0.95);
      this.noiseBurst(dest, t, 0.14, 'lowpass', 3100, 380, 0.6, 0.85);
      this.noiseBurst(dest, t + 0.09, 0.08, 'bandpass', 800, 280, 0.6, 0.15);
    }
    if (local) this.duck(weaponId === 'repeater' ? 0.8 : 0.68);
  }

  impact(pos: THREE.Vector3 | null, camera: THREE.Camera | null, metal: boolean): void {
    const { gain, pan } = this.spatial(pos, camera);
    const dest = this.out(gain * 0.28, pan, 'impact', 0.32, 1, 0.025);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(dest, t, 0.085, 'bandpass', metal ? 2600 : 1100, 400, 0.8, 0.75);
    if (metal) {
      const f = 530 + Math.random() * 350;
      this.tone(dest, t, f, f * 0.94, 0.16, 0.18);
      this.tone(dest, t, f * 1.48, f * 1.4, 0.1, 0.065);
    } else this.tone(dest, t, 110, 48, 0.1, 0.3);
  }

  debrisClank(pos: THREE.Vector3, camera: THREE.Camera, strength: number): void {
    const { gain, pan } = this.spatial(pos, camera);
    const dest = this.out(Math.min(0.17, gain * 0.065 * Math.min(2, strength / 4)), pan, 'debris', 0.22, 0, 0.09);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime; const f = 320 + Math.random() * 300;
    this.tone(dest, t, f, f * 0.86, 0.12, 0.45, 'triangle');
    this.noiseBurst(dest, t, 0.045, 'bandpass', 1800, 550, 0.8, 0.4);
  }

  killConfirm(): void {
    const dest = this.out(0.23, 0, 'kill', 0.4, 5, 0.08);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(dest, t, 350, 320, 0.09, 0.3, 'triangle'); this.tone(dest, t + 0.065, 700, 660, 0.14, 0.25);
    this.noiseBurst(dest, t, 0.05, 'bandpass', 1700, 750, 0.7, 0.3);
  }

  hitMarker(): void {
    const dest = this.out(0.2, 0, 'hit', 0.15, 3, 0.055);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(dest, t, 0.034, 'bandpass', 1800, 900, 0.75, 0.6);
    this.tone(dest, t, 720, 620, 0.04, 0.13, 'triangle');
  }

  explosion(pos: THREE.Vector3 | null, camera: THREE.Camera | null, scale = 1): void {
    const { gain, pan } = this.spatial(pos, camera);
    const dest = this.out(Math.min(0.95, gain * 0.85 * scale), pan, 'explosion', 1.65, 4, 0.045);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(dest, t, 83, 29, 0.6, 0.9);
    this.noiseBurst(dest, t, 1.2, 'lowpass', 2100, 100, 0.6, 0.95);
    this.noiseBurst(dest, t, 0.15, 'highpass', 3200, 900, 0.55, 0.42);
    this.noiseBurst(dest, t + 0.17, 0.65, 'bandpass', 700, 200, 0.55, 0.26);
    if (!pos || gain > 0.4) this.duck(0.6);
  }

  ram(pos: THREE.Vector3 | null, camera: THREE.Camera | null, strength: number): void {
    const { gain, pan } = this.spatial(pos, camera);
    const dest = this.out(gain * Math.min(0.7, 0.2 + strength * 0.025), pan, 'ram', 0.55, 3, 0.1);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(dest, t, 115, 44, 0.23, 0.85); this.noiseBurst(dest, t, 0.18, 'bandpass', 980, 250, 0.7, 0.8);
    this.tone(dest, t, 430 + Math.random() * 90, 370, 0.22, 0.12, 'triangle');
    if (gain > 0.5) this.duck(0.7);
  }

  landing(strength: number): void {
    if (strength < 2) return;
    const dest = this.out(Math.min(0.38, (strength - 1) * 0.032), 0, 'landing', 0.38, 2, 0.16);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(dest, t, 92, 43, 0.2, 0.65); this.noiseBurst(dest, t, 0.16, 'lowpass', 900, 180, 0.6, 0.8);
    this.noiseBurst(dest, t + 0.045, 0.08, 'bandpass', 1500, 600, 0.6, 0.12);
  }

  private shift(): void {
    const dest = this.out(0.085, 0, 'shift', 0.15, 1, 0.5);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(dest, t, 0.055, 'bandpass', 720, 320, 0.7, 0.65); this.tone(dest, t, 150, 82, 0.065, 0.32);
  }

  levelUp(): void {
    const dest = this.out(0.23, 0, 'level', 0.7, 4, 0.2, true);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    [392, 494, 587].forEach((f, i) => this.tone(dest, t + i * 0.09, f, f, 0.28, 0.28, 'triangle'));
  }

  pick(): void {
    const dest = this.out(0.22, 0, 'pick', 0.4, 3, 0.08, true);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(dest, t, 0.04, 'bandpass', 1200, 600, 0.6, 0.25);
    this.tone(dest, t, 580, 700, 0.1, 0.32); this.tone(dest, t + 0.07, 870, 1000, 0.15, 0.24);
  }

  emp(pos: THREE.Vector3 | null, camera: THREE.Camera | null): void {
    const { gain, pan } = this.spatial(pos, camera);
    const dest = this.out(gain * 0.55, pan, 'emp', 1.1, 4, 0.1);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(dest, t, 150, 35, 0.65, 0.8); this.noiseBurst(dest, t, 0.65, 'bandpass', 2200, 180, 0.65, 0.8);
    this.tone(dest, t, 620, 100, 0.3, 0.1, 'triangle'); if (gain > 0.4) this.duck(0.7);
  }

  dash(pos: THREE.Vector3 | null, camera: THREE.Camera | null): void {
    const { gain, pan } = this.spatial(pos, camera);
    const dest = this.out(gain * 0.4, pan, 'dash', 0.7, 3, 0.1);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(dest, t, 0.42, 'bandpass', 300, 1300, 0.55, 0.9); this.tone(dest, t, 65, 135, 0.22, 0.35);
  }

  hurt(): void {
    const dest = this.out(0.22, 0, 'hurt', 0.22, 4, 0.14);
    if (!dest || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(dest, t, 135, 65, 0.12, 0.5); this.noiseBurst(dest, t, 0.07, 'lowpass', 900, 250, 0.55, 0.4); this.duck(0.68);
  }

  updateVehicle(input: VehicleAudioInput): void {
    if (input.active !== undefined) this.setActive(input.active);
    const frame = this.model.update(input, this.active && input.active !== false);
    const ctx = this.ctx;
    if (!ctx || !this.engine || !this.intake || !this.road || !this.tires || !this.wind || !this.boost) return;
    const t = ctx.currentTime;
    const a = frame.activity;
    const sampleWeight = this.recorded ? Math.min(1, Math.max(0, (frame.rpm - 1400) / 1300)) * Math.min(1, frame.load / 0.55) : 0;
    const wet = Math.sqrt(sampleWeight);
    const dry = Math.sqrt(1 - sampleWeight);
    this.engine.source.playbackRate.setTargetAtTime(frame.rpm / 1200, t, 0.045);
    this.engine.filter.frequency.setTargetAtTime(160 + frame.rpm * 0.08 + frame.load * 220, t, 0.09);
    this.engine.gain.gain.setTargetAtTime(a * (0.035 + (0.04 + frame.load * 0.18) * dry), t, 0.07);
    if (this.recorded) {
      this.recorded.source.playbackRate.setTargetAtTime(Math.max(0.7, Math.min(1.5, frame.rpm / 3000)), t, 0.09);
      this.recorded.gain.gain.setTargetAtTime(a * wet * (0.055 + frame.load * 0.095), t, 0.09);
      this.recorded.filter.frequency.setTargetAtTime(950 + frame.load * 1500, t, 0.1);
    }
    this.intake.filter.frequency.setTargetAtTime(210 + frame.rpm * 0.095, t, 0.12);
    this.intake.gain.gain.setTargetAtTime(a * frame.load * 0.052, t, 0.08);
    const rough = input.surface === 'desert' || input.surface === 'forest' ? 1.35 : input.surface === 'arctic' ? 0.7 : 1;
    const roadHz = input.surface === 'desert' ? 520 : input.surface === 'arctic' ? 780 : input.surface === 'forest' ? 340 : 420;
    this.road.filter.frequency.setTargetAtTime(roadHz + frame.road * 120, t, 0.2);
    this.road.gain.gain.setTargetAtTime(a * frame.road * 0.043 * rough, t, 0.1);
    this.tires.filter.frequency.setTargetAtTime(input.surface === 'arctic' ? 1400 : input.surface === 'desert' ? 650 : 1050, t, 0.16);
    this.tires.gain.gain.setTargetAtTime(a * frame.slip * 0.105, t, 0.065);
    this.wind.gain.gain.setTargetAtTime(a * frame.wind * 0.04, t, 0.22);
    this.boost.gain.gain.setTargetAtTime(a * frame.boost * 0.06, t, 0.09);
    if (this.vehicleDuck && t > this.duckUntil) this.vehicleDuck.gain.setTargetAtTime(1, t, 0.16);
    if (frame.changedGear && a > 0.7 && frame.load > 0.15) this.shift();
  }
}
