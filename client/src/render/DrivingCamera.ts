import { angleDiff, clamp } from '@robot-arena/shared';

/** Driver intent is presentation only; steering and turret authority stay separate. */
export interface DrivingViewIntent {
  active: boolean;
  mouseIdleSeconds: number;
  mouseSerial: number;
  firing: boolean;
  steady: boolean;
  recenter: boolean;
}

const AUTO_DELAY = 1.2;
const AUTO_BLEND_SECONDS = 0.65;
const LOOK_BACK_LIMIT = 100 * Math.PI / 180;
const AUTO_RATE = 75 * Math.PI / 180;
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

  reset(): void {
    this.manual = false;
    this.lookBack = false;
    this.lastMouseSerial = -1;
  }

  update(viewYaw: number, chassisYaw: number, forwardSpeed: number, dt: number, intent: DrivingViewIntent): number {
    if (!Number.isFinite(viewYaw) || !Number.isFinite(chassisYaw)) return 0;
    const h = clamp(dt, 0, 0.1);
    const delta = angleDiff(viewYaw, chassisYaw);
    const newMouse = intent.mouseSerial !== this.lastMouseSerial;
    this.lastMouseSerial = intent.mouseSerial;
    if (!intent.active) {
      this.manual = false;
      this.lookBack = false;
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
    const response = this.manual ? 6.5 : 3.2 * blend;
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

