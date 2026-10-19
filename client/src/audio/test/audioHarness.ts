import * as THREE from 'three';
import { AudioVoiceBudget, VehicleAudioModel, type VehicleAudioInput } from '../VehicleAudioModel';
import { AudioSystem } from '../AudioSystem';

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
const base: VehicleAudioInput = {
  forwardSpeed: 0, lateralSpeed: 0, throttle: 0, grounded: true,
  boosting: false, alive: true, maxSpeed: 12, surface: 'urban', dt: 1 / 60, active: true,
};
const run = (model: VehicleAudioModel, input: Partial<VehicleAudioInput>, seconds: number, hz = 60) => {
  let frame = model.update({ ...base, ...input, dt: 0 });
  for (let i = 0; i < seconds * hz; i++) frame = model.update({ ...base, ...input, dt: 1 / hz });
  return { ...frame };
};

const idle = run(new VehicleAudioModel(), { forwardSpeed: 0.01, lateralSpeed: 0.03 }, 4);
check(idle.road === 0 && idle.slip === 0 && idle.wind === 0, 'Rest jitter must be silent in road, tire, and wind layers');
check(Math.abs(idle.rpm - 870) < 15, 'Idle must settle near quiet combustion speed');
const brake = run(new VehicleAudioModel(), { forwardSpeed: 7, throttle: -1 }, 3);
check(brake.load < 0.001, 'Braking must not sound like full-throttle acceleration');
const backwards = run(new VehicleAudioModel(), { forwardSpeed: -3, throttle: -1 }, 3);
check(backwards.gear === -1 && backwards.load > 0.99 && backwards.rpm > 2300, 'Reverse must retain genuine propulsion load');
const coast = run(new VehicleAudioModel(), { forwardSpeed: 7, throttle: 0 }, 3);
check(coast.load < 0.001 && coast.road > 0.4 && coast.rpm > idle.rpm * 2, 'Coasting must retain rolling speed independently of engine load');
const air = run(new VehicleAudioModel(), { forwardSpeed: 10, lateralSpeed: 8, throttle: 1, grounded: false }, 3);
check(air.road < 0.001 && air.slip < 0.001 && air.rpm > 3900, 'Airborne engine may rev, but tires must not scrub or roll on air');
const slip = run(new VehicleAudioModel(), { forwardSpeed: 6, lateralSpeed: 4 }, 2);
check(slip.slip > 0.65, 'A true grounded slide must create tire feedback');
const silence = run(new VehicleAudioModel(), { forwardSpeed: 10, throttle: 1, active: false }, 3);
check(silence.activity < 0.001 && silence.load < 0.001 && silence.road < 0.001, 'Inactive state must fade every continuous bed');
const dead = run(new VehicleAudioModel(), { forwardSpeed: 9, lateralSpeed: 4, throttle: 1, alive: false }, 3);
check(dead.activity < 0.001 && dead.load < 0.001 && dead.slip < 0.001, 'Dead vehicles must not keep the engine or tires alive');

const transmission = new VehicleAudioModel();
let shifts = 0;
let maxRpm = 0;
let previousRpm = 0;
let largestDrop = 0;
for (let i = 0; i < 720; i++) {
  const frame = transmission.update({ ...base, forwardSpeed: Math.min(15, i / 40), throttle: 1, boosting: i > 480 });
  if (frame.changedGear) shifts++;
  largestDrop = Math.max(largestDrop, previousRpm - frame.rpm);
  maxRpm = Math.max(maxRpm, frame.rpm);
  previousRpm = frame.rpm;
}
check(shifts === 3 && maxRpm > 4900 && maxRpm < 5700 && largestDrop < 280, 'Acceleration must progress through three bounded, smoothed shifts');
const threshold = new VehicleAudioModel();
let thresholdShifts = 0;
for (let i = 0; i < 900; i++) {
  const frame = threshold.update({ ...base, forwardSpeed: (0.31 + Math.sin(i * 0.6) * 0.025) * 12, throttle: 0.5 });
  if (frame.changedGear) thresholdShifts++;
}
check(thresholdShifts === 1, 'Gear hysteresis must reject speed jitter at the upshift threshold');
const lowRate = run(new VehicleAudioModel(), { forwardSpeed: 3, throttle: 0.7, lateralSpeed: 2 }, 1, 30);
const highRate = run(new VehicleAudioModel(), { forwardSpeed: 3, throttle: 0.7, lateralSpeed: 2 }, 1, 144);
check(Math.abs(lowRate.rpm - highRate.rpm) < 0.01 && Math.abs(lowRate.load - highRate.load) < 0.001, 'Engine envelopes must be frame-rate independent');
const invalid = run(new VehicleAudioModel(), { forwardSpeed: NaN, lateralSpeed: Infinity, throttle: NaN, maxSpeed: 0 }, 1);
check(Object.values(invalid).every((value) => typeof value !== 'number' || Number.isFinite(value)), 'Bad telemetry must never poison AudioParams');

const budget = new AudioVoiceBudget(28);
let peakVoices = 0;
for (let i = 0; i < 20000; i++) {
  budget.acquire(i * 0.0005, 1.2, i % 5, `voice-${i}`, 0);
  peakVoices = Math.max(peakVoices, budget.activeCount);
}
check(peakVoices === 28, 'Dense combat must obey the hard 28-voice ceiling');
budget.expire(30);
check(budget.activeCount === 0, 'Expired voices must free all voice budget');
const cooldown = new AudioVoiceBudget();
check(!!cooldown.acquire(0, 1, 1, 'debris', 0.09) && !cooldown.acquire(0.02, 1, 1, 'debris', 0.09), 'Low-priority debris must obey its cooldown');

// Exercise actual AudioSystem topology and lifecycle without browser output or perceptual claims.
class Param {
  value = 0;
  setTargetAtTime(value: number): this { check(Number.isFinite(value), 'Non-finite AudioParam'); this.value = value; return this; }
  setValueAtTime(value: number): this { return this.setTargetAtTime(value); }
  exponentialRampToValueAtTime(value: number): this { check(value > 0, 'Exponential ramps must stay positive'); return this.setTargetAtTime(value); }
}
class Node {
  readonly gain = new Param(); readonly frequency = new Param(); readonly Q = new Param();
  readonly playbackRate = new Param(); readonly pan = new Param();
  readonly threshold = new Param(); readonly ratio = new Param(); readonly attack = new Param();
  readonly release = new Param(); readonly knee = new Param();
  readonly connected = new Set<Node>();
  type = ''; loop = false; buffer: unknown = null; started = false; stopped = false;
  constructor(readonly kind: string) { graph.push(this); }
  connect(node: Node): Node { this.connected.add(node); return node; }
  disconnect(): void { this.connected.clear(); }
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
}
const graph: Node[] = [];
let rejectDecode = false;
class Context {
  readonly sampleRate = 8000; currentTime = 0; state = 'running';
  readonly destination = new Node('destination');
  createGain(): Node { return new Node('gain'); }
  createBiquadFilter(): Node { return new Node('filter'); }
  createDynamicsCompressor(): Node { return new Node('compressor'); }
  createBufferSource(): Node { return new Node('buffer-source'); }
  createOscillator(): Node { return new Node('oscillator'); }
  createStereoPanner(): Node { return new Node('panner'); }
  createBuffer(_channels: number, length: number): { getChannelData: () => Float32Array } {
    const data = new Float32Array(length); return { getChannelData: () => data };
  }
  resume(): Promise<void> { return Promise.resolve(); }
  decodeAudioData(): Promise<ReturnType<Context['createBuffer']>> {
    return rejectDecode ? Promise.reject(new Error('test decode failure')) : Promise.resolve(this.createBuffer(1, 32000));
  }
}
let context: Context;
const originalContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class extends Context { constructor() { super(); context = this; } } });
const goodFetch = (async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })) as unknown as typeof fetch;
globalThis.fetch = goodFetch;
const system = new AudioSystem();
try {
  system.unlock();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  check(!graph.some((node) => node.kind === 'oscillator'), 'Continuous vehicle engine must contain no oscillator nodes');
  const exhaust = graph.find((node) => node.loop)!.buffer as { getChannelData: (channel: number) => Float32Array };
  const pulse = exhaust.getChannelData(0);
  const seam = Math.abs(pulse[0] - pulse[pulse.length - 1]);
  const pulseRms = Math.sqrt(pulse.reduce((sum, value) => sum + value * value, 0) / pulse.length);
  check(seam < 0.000001 && pulseRms > 0.05, 'Procedural exhaust must have a continuous, non-silent loop seam');
  const connected = (): number => graph.filter((node) => node.connected.size > 0).length;
  const baseline = connected();
  system.setActive(true);
  let peakGraph = baseline;
  let peakConnectedVoices = 0;
  const position = new THREE.Vector3(); const camera = new THREE.PerspectiveCamera();
  const weapons = ['pistol', 'shotgun', 'compound_bow', 'revolver', 'rpg', 'tesla_gun', 'flintlock', 'darts', 'twin_cannon', 'syringe'] as const;
  for (let i = 0; i < 600; i++) {
    context!.currentTime = i * 0.04;
    system.updateVehicle({ ...base, forwardSpeed: 8, throttle: 1, lateralSpeed: i % 4, surface: 'desert' });
    system.cannon(null, null, true, weapons[i % weapons.length]);
    system.cannon(position, camera, false, 'revolver');
    system.impact(position, camera, true); system.debrisClank(position, camera, 8);
    if (i % 8 === 0) { system.explosion(position, camera, i % 16 === 0 ? 2 : 0.5); system.hurt(); system.hitMarker(); system.killConfirm(); system.landing(5); }
    if (i % 6 === 0) { system.beam(position, camera, false, 1.8); system.swing(position, camera, true, 1.6); system.meleeHit(position, camera, i % 12 === 0 ? 150 : 30); system.zap(position, camera, true, 1.5); }
    if (i % 10 === 0) { system.heal(position, camera); system.shield(position, camera, i % 20 === 0); system.teleport(position, camera); system.flame(position, camera, 2); system.chainsaw(position, camera, 3); system.deploy(position, camera); system.ignite(position, camera, true); }
    peakGraph = Math.max(peakGraph, connected());
    const connectedVoices = graph.filter((node) => node.kind === 'panner' && node.connected.size > 0).length;
    peakConnectedVoices = Math.max(peakConnectedVoices, connectedVoices);
    check(connectedVoices <= 28, 'Connected one-shot graphs must obey the same hard 28-voice ceiling');
    check(connected() <= baseline + 28 * 15, 'Dense combat graph must remain bounded');
  }
  system.setActive(false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(connected() === baseline, 'Deactivation must disconnect every one-shot graph');
  const sourcesAtPause = graph.filter((node) => node.kind === 'buffer-source' || node.kind === 'oscillator').length;
  system.cannon(null, null, true); system.impact(position, camera, true); system.hurt();
  check(graph.filter((node) => node.kind === 'buffer-source' || node.kind === 'oscillator').length === sourcesAtPause, 'Inactive gameplay must reject combat sounds');
  system.pick();
  const uiPanner = graph.filter((node) => node.kind === 'panner' && node.connected.size > 0).at(-1);
  const uiDestination = uiPanner?.connected.values().next().value;
  check(!!uiPanner && uiDestination?.gain.value === 0.75, 'UI pickup must remain audible on its own bus while gameplay is inactive');
  await new Promise((resolve) => setTimeout(resolve, 550));
  check(connected() === baseline, 'UI event graphs must also release after their tails');
  const unusedSources = graph.filter((node) => !node.loop && node.started && !node.stopped);
  check(unusedSources.length === 0, 'Released event sources must all stop');
  check(graph.filter((node) => node.kind === 'filter').every((node) => node.Q.value <= 0.8), 'No continuous or combat layer may reintroduce a narrow resonant whistle');
  for (const failure of ['fetch', 'decode'] as const) {
    const from = graph.length;
    rejectDecode = failure === 'decode';
    globalThis.fetch = failure === 'fetch' ? (async () => { throw new Error('test fetch failure'); }) : goodFetch;
    const fallback = new AudioSystem();
    fallback.unlock();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const loops = graph.slice(from).filter((node) => node.loop);
    check(loops.length === 6, `A ${failure} failure must retain every procedural/physical layer`);
    fallback.setActive(true);
    fallback.updateVehicle({ ...base, forwardSpeed: 5, throttle: 1 });
    const engineFilter = loops[0].connected.values().next().value;
    const engineGain = engineFilter?.connected.values().next().value;
    check((engineGain?.gain.value ?? 0) > 0, `The fallback engine must remain audible after ${failure} failure`);
    fallback.setActive(false);
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
  console.log(`Audio harness passed: 14 telemetry scenarios, 3 smooth shifts, ${thresholdShifts} jitter-threshold shift, 30/144 Hz envelope parity, 20,000-event cap=${peakVoices}, 24s combat connected voices=${peakConnectedVoices}, graph peak=${peakGraph}, baseline=${baseline}; event graphs released after 80ms fade grace; UI bus and fetch/decode fallback pass; exhaust seam=${seam.toExponential(2)}, RMS=${pulseRms.toFixed(3)}.`);
} finally {
  system.setActive(false);
  globalThis.fetch = originalFetch;
  if (originalContext) Object.defineProperty(globalThis, 'AudioContext', originalContext);
  else Reflect.deleteProperty(globalThis, 'AudioContext');
}
