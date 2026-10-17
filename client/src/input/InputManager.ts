import { Buttons, clamp, type InputFrame } from '@robot-arena/shared';

export interface InputSettings {
  mouseSensitivity: number;
  invertY: boolean;
}

type KeyHandler = (code: string, e: KeyboardEvent) => void;

/**
 * Keyboard + pointer-lock mouse. Owns the turret aim yaw and the camera pitch,
 * and produces compact InputFrames for each fixed simulation tick.
 */
export class InputManager {
  readonly settings: InputSettings = { mouseSensitivity: 0.0022, invertY: false };
  aimYaw = 0;
  cameraPitch = 0.22;

  private readonly keys = new Set<string>();
  private mouseDown = false;
  private seq = 0;
  private locked = false;
  private readonly keyHandlers: KeyHandler[] = [];
  private readonly element: HTMLElement;

  constructor(element: HTMLElement) {
    this.element = element;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    element.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onLockChange);
    element.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get isLocked(): boolean {
    return this.locked;
  }

  requestLock(): void {
    const req = this.element.requestPointerLock() as unknown;
    if (req instanceof Promise) req.catch(() => undefined);
  }

  onKey(handler: KeyHandler): void {
    this.keyHandlers.push(handler);
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Builds the next input frame (increments the sequence number). */
  sample(): InputFrame {
    const k = this.keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let buttons = 0;
    if (this.mouseDown) buttons |= Buttons.FIRE;
    if (k.has('ShiftLeft') || k.has('ShiftRight')) buttons |= Buttons.BOOST;
    if (k.has('Space')) buttons |= Buttons.ABILITY;
    this.seq += 1;
    return { seq: this.seq, throttle: fwd, steer, aimYaw: this.aimYaw, buttons };
  }

  resetAim(yaw: number): void {
    this.aimYaw = yaw;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    if (!e.repeat) for (const h of this.keyHandlers) h(e.code, e);
    this.keys.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
    this.mouseDown = false;
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseDown = true;
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseDown = false;
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    const s = this.settings.mouseSensitivity;
    // Mouse right turns the aim right, which is negative yaw (see shared/math.ts).
    this.aimYaw -= e.movementX * s;
    this.cameraPitch = clamp(this.cameraPitch + e.movementY * s * (this.settings.invertY ? -1 : 1), -0.25, 0.85);
    if (this.aimYaw > Math.PI) this.aimYaw -= Math.PI * 2;
    if (this.aimYaw < -Math.PI) this.aimYaw += Math.PI * 2;
  };

  private readonly onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
    if (!this.locked) this.mouseDown = false;
  };
}
