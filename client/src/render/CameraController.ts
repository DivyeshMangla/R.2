import * as THREE from 'three';

export interface CameraTuning {
  distance: number;
  height: number;
  /** Spring stiffness (1/s²) of the follow spring. */
  stiffness: number;
  /** Damping ratio of the follow spring (1 = critical). */
  damping: number;
  lookAhead: number;
  lookHeight: number;
  fov: number;
  boostFov: number;
  fovLerp: number;
  shakeMaxOffset: number;
  shakeMaxAngle: number;
  shakeDecay: number;
  shakeFrequency: number;
}

/** Third-person chase camera: damped spring follow, velocity look-ahead, FOV boost, trauma shake. */
export class CameraController {
  readonly tuning: CameraTuning = {
    distance: 8.2,
    height: 3.2,
    stiffness: 70,
    damping: 1.0,
    lookAhead: 0.28,
    lookHeight: 1.3,
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
  private readonly look = new THREE.Vector3();
  private readonly lookVel = new THREE.Vector3();
  private initialized = false;
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

  update(target: THREE.Vector3, velocity: THREE.Vector3, aimYaw: number, pitch: number, boosting: boolean, dt: number): void {
    const t = this.tuning;
    this.time += dt;
    const back = new THREE.Vector3(-Math.sin(aimYaw), 0, -Math.cos(aimYaw));
    const dist = t.distance * (boosting ? 1.08 : 1);
    const height = t.height + pitch * 6;
    const desired = target.clone().addScaledVector(back, dist * Math.cos(pitch * 0.6)).add(new THREE.Vector3(0, height, 0));
    const ahead = velocity.clone().setY(0);
    if (ahead.length() > 30) ahead.setLength(30);
    const lookTarget = target.clone().addScaledVector(ahead, t.lookAhead).add(new THREE.Vector3(0, t.lookHeight, 0));
    lookTarget.addScaledVector(back, -4);

    if (!this.initialized) {
      this.pos.copy(desired);
      this.look.copy(lookTarget);
      this.vel.set(0, 0, 0);
      this.lookVel.set(0, 0, 0);
      this.initialized = true;
    }
    this.spring(this.pos, this.vel, desired, dt, t.stiffness);
    this.spring(this.look, this.lookVel, lookTarget, dt, t.stiffness * 2.2);
    // Never drop below the floor.
    this.pos.y = Math.max(this.pos.y, 0.6);

    const cam = this.camera;
    cam.position.copy(this.pos);
    cam.lookAt(this.look);

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
