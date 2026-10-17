import * as THREE from 'three';

interface VirtualLight {
  active: boolean;
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  peak: number;
  distance: number;
  age: number;
  life: number;
  flicker: boolean;
  /** Current intensity after decay/flicker. */
  intensity: number;
  score: number;
}

const MAX_VIRTUAL = 48;

/**
 * A fixed set of real point lights shared by every flash in the game. Lights
 * are always in the scene (intensity 0 when idle) so the light count never
 * changes and shaders never recompile. Each frame the strongest flashes as
 * seen from the camera (intensity / distance²) claim the real lights.
 */
export class LightPool {
  readonly lights: THREE.PointLight[] = [];
  private readonly virtual: VirtualLight[] = [];
  private readonly order: number[] = [];
  private readonly scene: THREE.Scene;
  activeCount = 0;

  constructor(scene: THREE.Scene, size: number) {
    this.scene = scene;
    for (let i = 0; i < MAX_VIRTUAL; i++) {
      this.virtual.push({ active: false, x: 0, y: 0, z: 0, r: 1, g: 1, b: 1, peak: 0, distance: 10, age: 0, life: 1, flicker: false, intensity: 0, score: 0 });
      this.order.push(i);
    }
    this.resize(size);
  }

  /** Changes the number of real lights (one shader recompile; only from the settings menu). */
  resize(size: number): void {
    while (this.lights.length > size) {
      const l = this.lights.pop();
      if (l) this.scene.remove(l);
    }
    while (this.lights.length < size) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = false;
      this.lights.push(l);
      this.scene.add(l);
    }
  }

  /** Requests a decaying flash. Overwrites the weakest flash when all slots are busy. */
  flash(x: number, y: number, z: number, color: THREE.Color, peak: number, life: number, distance: number, flicker = false): void {
    let slot: VirtualLight | null = null;
    let weakest: VirtualLight | null = null;
    for (const v of this.virtual) {
      if (!v.active) {
        slot = v;
        break;
      }
      if (!weakest || v.intensity < weakest.intensity) weakest = v;
    }
    const v = slot ?? weakest;
    if (!v) return;
    v.active = true;
    v.x = x; v.y = y; v.z = z;
    v.r = color.r; v.g = color.g; v.b = color.b;
    v.peak = peak;
    v.intensity = peak;
    v.distance = distance;
    v.age = 0;
    v.life = life;
    v.flicker = flicker;
  }

  update(dt: number, camera: THREE.Vector3): void {
    for (const v of this.virtual) {
      if (!v.active) continue;
      v.age += dt;
      if (v.age >= v.life) {
        v.active = false;
        v.intensity = 0;
        v.score = -1;
        continue;
      }
      const k = 1 - v.age / v.life;
      v.intensity = v.peak * k * k * (v.flicker ? 0.65 + Math.random() * 0.35 : 1);
      const dx = v.x - camera.x, dy = v.y - camera.y, dz = v.z - camera.z;
      v.score = v.intensity / (1 + dx * dx + dy * dy + dz * dz);
    }
    // Insertion sort of indices by score (48 entries, no allocation).
    const o = this.order;
    for (let i = 1; i < o.length; i++) {
      const cur = o[i];
      const s = this.scoreOf(cur);
      let j = i - 1;
      while (j >= 0 && this.scoreOf(o[j]) < s) {
        o[j + 1] = o[j];
        j--;
      }
      o[j + 1] = cur;
    }
    this.activeCount = 0;
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const v = this.virtual[o[i]];
      if (!v.active) {
        l.intensity = 0;
        continue;
      }
      this.activeCount++;
      l.position.set(v.x, v.y, v.z);
      l.color.setRGB(v.r, v.g, v.b);
      l.intensity = v.intensity;
      l.distance = v.distance;
    }
  }

  private scoreOf(i: number): number {
    const v = this.virtual[i];
    return v.active ? v.score : -1;
  }

  clear(): void {
    for (const v of this.virtual) v.active = false;
    for (const l of this.lights) l.intensity = 0;
  }
}
