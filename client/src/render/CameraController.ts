import * as THREE from 'three';
import { aimDirection, cameraOrigin, DEFAULT_CAMERA_RIG, type Vec3 } from '@robot-arena/shared';

export interface CameraTuning {
  /** Orbit rig (see shared/aim.ts cameraOrigin). */
  distance: number;
  height: number;
  lookHeight: number;
  /** Spring stiffness (1/s²) of the follow spring. */
  stiffness: number;
  /** Damping ratio of the follow spring (1 = critical). */
  damping: number;
  fov: number;
  boostFov: number;
  fovLerp: number;
  shakeMaxOffset: number;
  shakeMaxAngle: number;
  shakeDecay: number;
  shakeFrequency: number;
}

/**
 * Third-person orbit camera. The mouse sets the view yaw/pitch; the camera
 * position spring-follows the shared rig and always looks exactly along the
 * view direction, so the screen centre is a known ray (aimOrigin/aimDir,
 * captured before shake) that the aim solver can use.
 */
export class CameraController {
  readonly tuning: CameraTuning = {
    distance: DEFAULT_CAMERA_RIG.distance,
    height: DEFAULT_CAMERA_RIG.height,
    lookHeight: DEFAULT_CAMERA_RIG.lookHeight,
    stiffness: 70,
    damping: 1.0,
    fov: 70,
    boostFov: 82,
    fovLerp: 6,
    shakeMaxOffset: 0.45,
    shakeMaxAngle: 0.05,
    shakeDecay: 1.6,
    shakeFrequency: 22,
  };
  private trauma = 0;
  private readonly pos = new THREE.Vector3(0, 10, -20);
  private readonly vel = new THREE.Vector3();
  private initialized = false;
  /** Unshaken screen-centre ray of the last update (world space). */
  readonly aimOrigin: Vec3 = { x: 0, y: 0, z: 0 };
  readonly aimDir: Vec3 = { x: 0, y: 0, z: 1 };
  private readonly desired: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly desiredV = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private time = 0;
  private readonly camera: THREE.PerspectiveCamera;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  /** Adds trauma in [0,1]; shake strength scales with trauma². */
  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  snap(): void {
    this.initialized = false;
  }

  private spring(current: THREE.Vector3, velocity: THREE.Vector3, target: THREE.Vector3, dt: number, stiffness: number): void {
    const k = stiffness;
    const c = 2 * Math.sqrt(k) * this.tuning.damping;
    // Semi-implicit Euler with sub-steps for stability at low frame rates.
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const ax = (target.x - current.x) * k - velocity.x * c;
      const ay = (target.y - current.y) * k - velocity.y * c;
      const az = (target.z - current.z) * k - velocity.z * c;
      velocity.x += ax * h;
      velocity.y += ay * h;
      velocity.z += az * h;
      current.addScaledVector(velocity, h);
    }
  }

  update(target: THREE.Vector3, viewYaw: number, viewPitch: number, boosting: boolean, dt: number): void {
    const t = this.tuning;
    this.time += dt;
    const rig = { distance: t.distance * (boosting ? 1.08 : 1), height: t.height, lookHeight: t.lookHeight };
    cameraOrigin(target, viewYaw, viewPitch, rig, this.desired);
    this.desiredV.set(this.desired.x, this.desired.y, this.desired.z);

    if (!this.initialized) {
      this.pos.copy(this.desiredV);
      this.vel.set(0, 0, 0);
      this.initialized = true;
    }
    this.spring(this.pos, this.vel, this.desiredV, dt, t.stiffness);
    // Never drop below the floor.
    this.pos.y = Math.max(this.pos.y, 0.6);

    const cam = this.camera;
    aimDirection(viewYaw, viewPitch, this.aimDir);
    cam.position.copy(this.pos);
    cam.lookAt(this.lookAt.set(this.pos.x + this.aimDir.x, this.pos.y + this.aimDir.y, this.pos.z + this.aimDir.z));
    this.aimOrigin.x = this.pos.x;
    this.aimOrigin.y = this.pos.y;
    this.aimOrigin.z = this.pos.z;

    // Trauma shake (smooth pseudo-noise from layered sines).
    this.trauma = Math.max(0, this.trauma - t.shakeDecay * dt);
    const s = this.trauma * this.trauma;
    if (s > 0) {
      const f = t.shakeFrequency;
      const n = (o: number): number => Math.sin(this.time * f + o) * 0.6 + Math.sin(this.time * f * 1.73 + o * 2.1) * 0.4;
      cam.position.x += n(0) * t.shakeMaxOffset * s;
      cam.position.y += n(11) * t.shakeMaxOffset * s;
      cam.position.z += n(23) * t.shakeMaxOffset * s;
      cam.rotateZ(n(37) * t.shakeMaxAngle * s);
      cam.rotateX(n(41) * t.shakeMaxAngle * 0.5 * s);
    }

    const fovTarget = boosting ? t.boostFov : t.fov;
    cam.fov += (fovTarget - cam.fov) * Math.min(1, dt * t.fovLerp);
    cam.updateProjectionMatrix();
  }
}
