import type { MapBiome } from '@robot-arena/shared';

export interface VehicleAudioInput {
  /** Chassis-space horizontal speeds, metres per second. */
  forwardSpeed: number;
  lateralSpeed: number;
  throttle: number;
  /** Optional actual smoothed propulsion demand; braking should report zero. */
  driveDemand?: number;
  /** Smoothed physical drift state; does not create tire noise without real slip. */
  driftAmount?: number;
  grounded: boolean;
  boosting: boolean;
  alive: boolean;
  maxSpeed: number;
  surface: MapBiome;
  dt: number;
  active?: boolean;
}

export interface VehicleAudioFrame {
  rpm: number;
  gear: number;
  load: number;
  slip: number;
  road: number;
  wind: number;
  boost: number;
  activity: number;
  changedGear: boolean;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const finite = (n: number): number => Number.isFinite(n) ? n : 0;
const approach = (value: number, target: number, dt: number, seconds: number): number =>
  target + (value - target) * Math.exp(-dt / seconds);
const GEAR_UP = [0.31, 0.58, 0.86] as const;
const GEAR_DOWN = [0, 0.19, 0.44, 0.7] as const;
const GEAR_RATIO = [940, 550, 360, 270] as const;

/** Presentation only: virtual four-speed transmission, independent of physics. */
export class VehicleAudioModel {
  private gear = 1;
  private shiftDwell = 0;
  private shiftCut = 0;
  private readonly frame: VehicleAudioFrame = {
    rpm: 860, gear: 1, load: 0, slip: 0, road: 0, wind: 0, boost: 0, activity: 0, changedGear: false,
  };

  update(input: VehicleAudioInput, active = input.active !== false): Readonly<VehicleAudioFrame> {
    const dt = clamp(finite(input.dt), 0, 0.1);
    const speed = Math.abs(finite(input.forwardSpeed));
    const maxSpeed = Math.max(3, finite(input.maxSpeed));
    const normalized = speed / maxSpeed;
    const throttle = clamp(finite(input.throttle), -1, 1);
    const braking = speed > 0.6 && throttle * input.forwardSpeed < -0.08;
    const demand = clamp(Math.abs(finite(input.driveDemand ?? (braking ? 0 : throttle))), 0, 1);
    const running = input.alive && active;
    const reverse = input.forwardSpeed < -0.65 || (speed < 0.65 && throttle < -0.08);
    this.shiftDwell = Math.max(0, this.shiftDwell - dt);
    this.shiftCut = Math.max(0, this.shiftCut - dt);
    this.frame.changedGear = false;

    // Separate up/down boundaries and a minimum dwell prevent chatter near a threshold.
    if (!reverse && input.grounded && this.shiftDwell <= 0) {
      let next = this.gear;
      if (this.gear < 4 && normalized > GEAR_UP[this.gear - 1]) next++;
      else if (this.gear > 1 && normalized < GEAR_DOWN[this.gear - 1]) next--;
      if (next !== this.gear) {
        this.gear = next;
        // A full arcade launch now lasts 1.5 s. Let its transmission keep up,
        // while hysteresis still prevents chatter around each shift boundary.
        this.shiftDwell = 0.34;
        this.shiftCut = 0.16;
        this.frame.changedGear = running && speed > 1;
      }
    }
    if (speed < 0.3) this.gear = 1;

    const ratio = reverse ? 560 : GEAR_RATIO[this.gear - 1];
    const wheelRpm = 860 + speed * ratio * (12 / maxSpeed);
    // Free revs in the air never feed the road or tire layers.
    const rpmTarget = clamp(input.grounded
      ? wheelRpm + demand * 280 + (input.boosting ? 240 : 0)
      : 1000 + demand * 3100, 820, 5700);
    this.frame.rpm = approach(this.frame.rpm, rpmTarget, dt, rpmTarget > this.frame.rpm ? 0.19 : 0.13);
    const loadTarget = running ? demand * (this.shiftCut > 0 ? 0.34 : 1) : 0;
    this.frame.load = approach(this.frame.load, loadTarget, dt, loadTarget > this.frame.load ? 0.09 : 0.16);
    // Deadbands reject resting contact jitter; scrub is broadband, never a sine squeal.
    const horizontal = Math.hypot(speed, finite(input.lateralSpeed));
    const sideSpeed = Math.abs(finite(input.lateralSpeed));
    const naturalScrub = clamp((sideSpeed - 0.75) / 4.5, 0, 1);
    const driftScrub = clamp(finite(input.driftAmount ?? 0), 0, 1)
      * clamp((sideSpeed - 0.35) / 2.8, 0, 1) * 0.55;
    const slipTarget = running && input.grounded && horizontal > 1.2
      ? Math.max(naturalScrub, driftScrub) : 0;
    this.frame.slip = approach(this.frame.slip, slipTarget, dt, slipTarget > this.frame.slip ? 0.1 : 0.22);
    const roadTarget = running && input.grounded ? clamp((horizontal - 0.65) / maxSpeed, 0, 1.25) : 0;
    this.frame.road = approach(this.frame.road, roadTarget, dt, 0.12);
    this.frame.wind = approach(this.frame.wind, running ? clamp((horizontal / maxSpeed - 0.28) / 1.1, 0, 1) ** 2 : 0, dt, 0.3);
    this.frame.boost = approach(this.frame.boost, running && input.boosting ? 1 : 0, dt, 0.12);
    this.frame.activity = approach(this.frame.activity, running ? 1 : 0, dt, running ? 0.2 : 0.09);
    this.frame.gear = reverse ? -1 : this.gear;
    return this.frame;
  }
}

/** Bounded one-shot allocator; pure so dense-combat behavior can be tested. */
export class AudioVoiceBudget {
  private readonly voices: { id: number; until: number; priority: number }[] = [];
  private readonly lastEvent = new Map<string, number>();
  private sequence = 0;
  constructor(readonly capacity = 28) {}

  acquire(now: number, duration: number, priority: number, event: string, interval: number): { id: number; stolen?: number } | null {
    this.expire(now);
    if (now - (this.lastEvent.get(event) ?? -Infinity) < interval) return null;
    let stolen: number | undefined;
    if (this.voices.length >= this.capacity) {
      let lowest = 0;
      for (let i = 1; i < this.voices.length; i++) {
        if (this.voices[i].priority < this.voices[lowest].priority) lowest = i;
      }
      if (this.voices[lowest].priority > priority) return null;
      stolen = this.voices[lowest].id;
      this.voices.splice(lowest, 1);
    }
    const id = ++this.sequence;
    this.voices.push({ id, until: now + duration, priority });
    this.lastEvent.set(event, now);
    return { id, stolen };
  }

  expire(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i].until <= now) this.voices.splice(i, 1);
    }
  }

  release(id: number): void {
    const at = this.voices.findIndex((voice) => voice.id === id);
    if (at !== -1) this.voices.splice(at, 1);
  }

  get activeCount(): number { return this.voices.length; }
}
