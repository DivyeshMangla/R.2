import { Buttons, clamp, type InputFrame } from '@robot-arena/shared';

export interface InputSettings {
  mouseSensitivity: number;
  invertY: boolean;
}

type KeyHandler = (code: string, e: KeyboardEvent) => void;

/**
 * Keyboard + pointer-lock mouse. The mouse steers the *view* (camera orbit
 * yaw/pitch); turret yaw/pitch are solved from the screen-centre ray by
 * Game (shared/aim.ts solveAim) and written into the frame before sending.
 */
export class InputManager {
  readonly settings: InputSettings = { mouseSensitivity: 0.0022, invertY: false };
  /** Camera orbit yaw (world, same convention as aim yaw). */
  viewYaw = 0;
  /** Camera orbit pitch, radians, positive = looking up. */
  viewPitch = -0.12;

  private readonly keys = new Set<string>();
  private mouseDown = false;
  /** A click that started and ended between two ticks still fires once. */
  private fireLatched = false;
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

  /** Builds the next input frame (increments the sequence number). Aim fields are filled by the caller. */
  sample(): InputFrame {
    const k = this.keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let buttons = 0;
    if (this.mouseDown || this.fireLatched) buttons |= Buttons.FIRE;
    this.fireLatched = false;
    if (k.has('ShiftLeft') || k.has('ShiftRight')) buttons |= Buttons.BOOST;
    if (k.has('Space')) buttons |= Buttons.ABILITY;
    if (k.has('KeyE')) buttons |= Buttons.INTERACT;
    this.seq += 1;
    return { seq: this.seq, throttle: fwd, steer, aimYaw: this.viewYaw, buttons, aimPitch: 0, viewT: 0 };
  }

  resetAim(yaw: number): void {
    this.viewYaw = yaw;
    this.viewPitch = -0.12;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.closest('.garage'))) return;
    if (this.locked && (e.code === 'Tab' || e.code === 'Space')) e.preventDefault();
    if (!e.repeat) for (const h of this.keyHandlers) h(e.code, e);
    this.keys.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
    this.mouseDown = false;
    this.fireLatched = false;
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0 && this.locked) {
      this.mouseDown = true;
      this.fireLatched = true;
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseDown = false;
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    const s = this.settings.mouseSensitivity;
    // Mouse right turns the view right, which is negative yaw (see shared/math.ts).
    this.viewYaw -= e.movementX * s;
    // Mouse up looks up (unless inverted).
    this.viewPitch = clamp(this.viewPitch - e.movementY * s * (this.settings.invertY ? -1 : 1), -0.75, 0.6);
    if (this.viewYaw > Math.PI) this.viewYaw -= Math.PI * 2;
    if (this.viewYaw < -Math.PI) this.viewYaw += Math.PI * 2;
  };

  private readonly onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
    if (!this.locked) this.mouseDown = false;
  };
}
