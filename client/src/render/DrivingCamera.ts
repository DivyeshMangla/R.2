import { angleDiff, clamp } from '@robot-arena/shared';

/** Driver intent is presentation only; steering and turret authority stay separate. */
export interface DrivingViewIntent {
  active: boolean;
  mouseIdleSeconds: number;
  mouseSerial: number;
  firing: boolean;
  steady: boolean;
  recenter: boolean;
  /** Physical slide blend: keep automatic follow abreast of sustained drift yaw. */
  driftAmount?: number;
}

const AUTO_DELAY = 0.65;
const AUTO_BLEND_SECONDS = 0.3;
const LOOK_BACK_LIMIT = 100 * Math.PI / 180;
const AUTO_RATE = 120 * Math.PI / 180;
const MANUAL_RATE = 160 * Math.PI / 180;

function wrapYaw(yaw: number): number {
  return Math.atan2(Math.sin(yaw), Math.cos(yaw));
}

/**
 * Delayed chase yaw with explicit aim ownership. New mouse motion cancels C;
 * looking back intentionally latches free aim until C or a fresh mouse move.
 */
export class DrivingCamera {
  private manual = false;
  private manualMouseSerial = 0;
  private lookBack = false;
  private lastMouseSerial = -1;
  private driftBlend = 0;

  reset(): void {
    this.manual = false;
    this.lookBack = false;
    this.lastMouseSerial = -1;
    this.driftBlend = 0;
  }

  update(viewYaw: number, chassisYaw: number, forwardSpeed: number, dt: number, intent: DrivingViewIntent): number {
    if (!Number.isFinite(viewYaw) || !Number.isFinite(chassisYaw)) return 0;
    const h = clamp(dt, 0, 0.1);
    const drift = Number.isFinite(intent.driftAmount) ? clamp(intent.driftAmount ?? 0, 0, 1) : 0;
    this.driftBlend += (drift - this.driftBlend) * (1 - Math.exp(-h / 0.22));
    const delta = angleDiff(viewYaw, chassisYaw);
    const newMouse = intent.mouseSerial !== this.lastMouseSerial;
    this.lastMouseSerial = intent.mouseSerial;
    if (!intent.active) {
      this.manual = false;
      this.lookBack = false;
      this.driftBlend = 0;
      return wrapYaw(viewYaw);
    }
    if (newMouse) this.lookBack = Math.abs(delta) > LOOK_BACK_LIMIT;
    if (this.manual && intent.mouseSerial !== this.manualMouseSerial) this.manual = false;
    if (intent.recenter) {
      this.manual = true;
      this.manualMouseSerial = intent.mouseSerial;
      this.lookBack = false;
    }
    if (intent.firing || intent.steady) {
      this.manual = false;
      return wrapYaw(viewYaw);
    }
    if (!this.manual && (forwardSpeed <= 2 || this.lookBack || intent.mouseIdleSeconds <= AUTO_DELAY)) return wrapYaw(viewYaw);
    const blend = this.manual ? 1 : clamp((intent.mouseIdleSeconds - AUTO_DELAY) / AUTO_BLEND_SECONDS, 0, 1);
    // Both a tight ordinary corner and a held drift can exceed 90 degrees/s.
    // The chase limit must clear that physical turn rate, or the view falls
    // half a turn behind and reverses at the yaw wrap. Drift gets a slightly
    // firmer response through a smooth blend, retaining a readable view offset.
    // Explicit C recenter remains full strength; mouse/fire/RMB still own aim.
    const response = this.manual ? 6.5 : (4.5 + this.driftBlend * 0.3) * blend;
    const rate = this.manual ? MANUAL_RATE : AUTO_RATE * blend;
    const move = clamp(delta * (1 - Math.exp(-response * h)), -rate * h, rate * h);
    const yaw = wrapYaw(viewYaw + move);
    if (this.manual && Math.abs(delta) < 0.006) this.manual = false;
    return yaw;
  }
}

/** Exponential time constants keep camera framing stable across render rates. */
export function cameraBlend(dt: number, response: number): number {
  return 1 - Math.exp(-Math.max(0, Math.min(dt, 0.1)) * response);
}

/** Exported for telemetry/tests: maximum follow motion in radians per second. */
export const DRIVING_CAMERA_AUTO_RATE = AUTO_RATE;

