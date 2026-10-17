import * as THREE from 'three';
import { GPUParticles, type ParticleSpawn } from './GPUParticles';
import { flashTexture, scorchTexture } from './ProceduralTextures';

interface TimedLight {
  light: THREE.PointLight;
  life: number;
  age: number;
  peak: number;
  flicker: boolean;
}

interface Expanding {
  mesh: THREE.Mesh;
  age: number;
  life: number;
  from: number;
  to: number;
  opacity: number;
}

interface Decal {
  mesh: THREE.Mesh;
  age: number;
  life: number;
}

interface MineVisual {
  group: THREE.Group;
  light: THREE.Mesh;
  seen: boolean;
}

const LIGHT_POOL = 6;
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const Z = new THREE.Vector3(0, 0, 1);

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function randomUnit(out: THREE.Vector3): THREE.Vector3 {
  const u = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return out.set(s * Math.cos(t), u, s * Math.sin(t));
}

/** All transient visual effects: particles, flashes, shockwaves, decals and mines. */
export class VFXSystem {
  readonly additive = new GPUParticles(9000, 'additive');
  readonly smokeParticles = new GPUParticles(4000, 'smoke');
  particleMultiplier = 1;
  maxDecals = 64;

  private readonly scene: THREE.Scene;
  private readonly lights: TimedLight[] = [];
  private readonly expanding: Expanding[] = [];
  private readonly decals: Decal[] = [];
  private readonly flashes: { mesh: THREE.Mesh; age: number; life: number }[] = [];
  private readonly mines = new Map<number, MineVisual>();
  private readonly flashMat: THREE.MeshBasicMaterial;
  private readonly flashGeo = new THREE.PlaneGeometry(1, 1);
  private readonly ringGeo = new THREE.RingGeometry(0.85, 1, 72);
  private readonly sphereGeo = new THREE.SphereGeometry(1, 24, 16);
  private readonly decalGeo = new THREE.PlaneGeometry(1, 1);
  private readonly decalMat: THREE.MeshBasicMaterial;
  private readonly mineBodyMat = new THREE.MeshStandardMaterial({ color: 0x23272e, metalness: 0.9, roughness: 0.35 });
  private readonly mineGeo = new THREE.CylinderGeometry(0.32, 0.38, 0.18, 18);
  private readonly mineLightGeo = new THREE.SphereGeometry(0.08, 10, 10);
  private readonly spawn: ParticleSpawn = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, sizeStart: 1, sizeEnd: 1, r: 1, g: 1, b: 1, alpha: 1, gravity: 0, drag: 0, stretch: 0,
  };

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    scene.add(this.additive.mesh, this.smokeParticles.mesh);
    for (let i = 0; i < LIGHT_POOL; i++) {
      const light = new THREE.PointLight(0xffaa55, 0, 18, 2);
      light.castShadow = false;
      scene.add(light);
      this.lights.push({ light, life: 0, age: 1, peak: 0, flicker: false });
    }
    this.flashMat = new THREE.MeshBasicMaterial({
      map: flashTexture(),
      color: new THREE.Color(4, 3, 1.6),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.decalMat = new THREE.MeshBasicMaterial({
      map: scorchTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
  }

  private count(n: number): number {
    const scaled = n * this.particleMultiplier;
    return Math.floor(scaled) + (Math.random() < scaled % 1 ? 1 : 0);
  }

  private emit(fill: (p: ParticleSpawn) => void, smoke = false): void {
    const p = this.spawn;
    p.gravity = 0;
    p.drag = 0;
    p.stretch = 0;
    p.alpha = 1;
    fill(p);
    (smoke ? this.smokeParticles : this.additive).emit(p);
  }

  flashLight(pos: THREE.Vector3, color: THREE.ColorRepresentation, intensity: number, life: number, distance = 18, flicker = false): void {
    let slot = this.lights[0];
    for (const l of this.lights) if (l.age / l.life > slot.age / slot.life || l.life === 0) slot = l;
    slot.light.position.copy(pos);
    slot.light.color.set(color);
    slot.light.distance = distance;
    slot.age = 0;
    slot.life = life;
    slot.peak = intensity;
    slot.flicker = flicker;
  }

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3): void {
    for (let k = 0; k < 2; k++) {
      const m = new THREE.Mesh(this.flashGeo, this.flashMat);
      m.position.copy(pos);
      tmpQ.setFromUnitVectors(Z, dir);
      m.quaternion.copy(tmpQ);
      if (k === 1) m.rotateZ(Math.PI / 2);
      m.rotateX(Math.PI / 2);
      m.scale.set(rand(0.5, 0.8), rand(1.1, 1.6), 1);
      this.scene.add(m);
      this.flashes.push({ mesh: m, age: 0, life: 0.06 });
    }
    this.flashLight(pos, 0xffb060, 40, 0.08, 10, true);
    const n = this.count(10);
    for (let i = 0; i < n; i++) {
      randomUnit(tmpV).multiplyScalar(2).addScaledVector(dir, rand(6, 14));
      this.emit((p) => {
        p.x = pos.x; p.y = pos.y; p.z = pos.z;
        p.vx = tmpV.x; p.vy = tmpV.y; p.vz = tmpV.z;
        p.life = rand(0.08, 0.18);
        p.sizeStart = rand(0.08, 0.16); p.sizeEnd = 0.02;
        p.r = 5; p.g = 3; p.b = 1.2;
        p.drag = 6; p.stretch = 0.06;
      });
    }
    const s = this.count(3);
    for (let i = 0; i < s; i++) {
      this.emit((p) => {
        p.x = pos.x + dir.x * 0.2; p.y = pos.y; p.z = pos.z + dir.z * 0.2;
        p.vx = dir.x * rand(1, 3) + rand(-0.4, 0.4); p.vy = rand(0.3, 1.0); p.vz = dir.z * rand(1, 3) + rand(-0.4, 0.4);
        p.life = rand(0.5, 0.9); p.sizeStart = 0.25; p.sizeEnd = 0.9;
        p.r = 0.55; p.g = 0.55; p.b = 0.58; p.alpha = 0.35; p.drag = 2.5;
      }, true);
    }
  }

  trail(pos: THREE.Vector3, vel: THREE.Vector3, color: THREE.Color): void {
    if (Math.random() > this.particleMultiplier) return;
    this.emit((p) => {
      p.x = pos.x; p.y = pos.y; p.z = pos.z;
      p.vx = -vel.x * 0.02 + rand(-0.2, 0.2); p.vy = rand(-0.1, 0.25); p.vz = -vel.z * 0.02 + rand(-0.2, 0.2);
      p.life = rand(0.16, 0.3); p.sizeStart = 0.2; p.sizeEnd = 0.04;
      p.r = color.r * 3; p.g = color.g * 3; p.b = color.b * 3;
    });
  }

  impactSparks(pos: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, strength = 1): void {
    const n = this.count(18 * strength);
    for (let i = 0; i < n; i++) {
      randomUnit(tmpV);
      if (tmpV.dot(normal) < 0) tmpV.reflect(normal);
      tmpV.addScaledVector(normal, 0.6).normalize().multiplyScalar(rand(4, 13) * Math.sqrt(strength));
      this.emit((p) => {
        p.x = pos.x; p.y = pos.y; p.z = pos.z;
        p.vx = tmpV.x; p.vy = tmpV.y; p.vz = tmpV.z;
        p.life = rand(0.2, 0.55); p.sizeStart = rand(0.05, 0.09); p.sizeEnd = 0.01;
        p.r = 6; p.g = 3.2 + color.g; p.b = 1 + color.b;
        p.gravity = 16; p.drag = 1.5; p.stretch = 0.05;
      });
    }
    this.emit((p) => {
      p.x = pos.x + normal.x * 0.1; p.y = pos.y + normal.y * 0.1; p.z = pos.z + normal.z * 0.1;
      p.vx = 0; p.vy = 0; p.vz = 0;
      p.life = 0.12; p.sizeStart = 1.1 * strength; p.sizeEnd = 0.4;
      p.r = color.r * 4 + 2; p.g = color.g * 4 + 1.5; p.b = color.b * 4 + 1;
    });
    const s = this.count(4 * strength);
    for (let i = 0; i < s; i++) {
      this.emit((p) => {
        p.x = pos.x; p.y = pos.y; p.z = pos.z;
        p.vx = normal.x * rand(0.5, 1.5) + rand(-0.4, 0.4); p.vy = normal.y * rand(0.5, 1.5) + rand(0.2, 0.8); p.vz = normal.z * rand(0.5, 1.5) + rand(-0.4, 0.4);
        p.life = rand(0.8, 1.4); p.sizeStart = 0.3; p.sizeEnd = 1.3;
        p.r = 0.32; p.g = 0.31; p.b = 0.3; p.alpha = 0.45; p.drag = 1.8;
      }, true);
    }
    this.flashLight(pos.clone().addScaledVector(normal, 0.3), color.clone().lerp(new THREE.Color(1, 0.7, 0.3), 0.5), 14 * strength, 0.12, 8);
  }

  explosion(pos: THREE.Vector3, scale: number, color: THREE.Color): void {
    // Fireball core.
    const fireMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 2.6, 0.7), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const fire = new THREE.Mesh(this.sphereGeo, fireMat);
    fire.position.copy(pos);
    this.scene.add(fire);
    this.expanding.push({ mesh: fire, age: 0, life: 0.45, from: 0.4 * scale, to: 2.8 * scale, opacity: 1 });
    this.shockwave(pos, 9 * scale, new THREE.Color(3, 1.8, 0.9), 0.55);
    this.flashLight(pos.clone().setY(pos.y + 1), 0xff8a3a, 90 * scale, 0.5, 30);

    const sparks = this.count(80 * scale);
    for (let i = 0; i < sparks; i++) {
      randomUnit(tmpV);
      tmpV.y = Math.abs(tmpV.y) * 0.8 + 0.2;
      tmpV.normalize().multiplyScalar(rand(6, 22) * scale);
      this.emit((p) => {
        p.x = pos.x; p.y = pos.y; p.z = pos.z;
        p.vx = tmpV.x; p.vy = tmpV.y; p.vz = tmpV.z;
        p.life = rand(0.4, 1.1); p.sizeStart = rand(0.07, 0.14); p.sizeEnd = 0.02;
        p.r = 7; p.g = 3.5; p.b = 1.1;
        p.gravity = 14; p.drag = 1.2; p.stretch = 0.04;
      });
    }
    const embers = this.count(30 * scale);
    for (let i = 0; i < embers; i++) {
      randomUnit(tmpV).multiplyScalar(rand(1, 5) * scale);
      this.emit((p) => {
        p.x = pos.x + tmpV.x * 0.2; p.y = pos.y + Math.abs(tmpV.y) * 0.2; p.z = pos.z + tmpV.z * 0.2;
        p.vx = tmpV.x; p.vy = Math.abs(tmpV.y) + 2; p.vz = tmpV.z;
        p.life = rand(0.3, 0.7); p.sizeStart = rand(0.8, 1.6) * scale; p.sizeEnd = 0.2;
        p.r = 4 + color.r; p.g = 1.6 + color.g * 0.5; p.b = 0.3; p.drag = 3;
      });
    }
    const smoke = this.count(26 * scale);
    for (let i = 0; i < smoke; i++) {
      randomUnit(tmpV).multiplyScalar(rand(1, 4) * scale);
      this.emit((p) => {
        p.x = pos.x + tmpV.x * 0.3; p.y = pos.y + 0.3; p.z = pos.z + tmpV.z * 0.3;
        p.vx = tmpV.x; p.vy = Math.abs(tmpV.y) * 0.6 + rand(1.5, 3); p.vz = tmpV.z;
        p.life = rand(1.8, 3.2); p.sizeStart = rand(0.8, 1.4) * scale; p.sizeEnd = rand(3, 4.5) * scale;
        const g = rand(0.06, 0.14);
        p.r = g; p.g = g; p.b = g * 1.05; p.alpha = 0.75; p.drag = 1.4; p.gravity = -0.6;
      }, true);
    }
    this.decal(pos.clone().setY(pos.y - 0.4), new THREE.Vector3(0, 1, 0), 4.2 * scale, true);
  }

  shockwave(pos: THREE.Vector3, radius: number, color: THREE.Color, life: number): void {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(this.ringGeo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos).setY(Math.max(0.08, pos.y - 0.3));
    this.scene.add(ring);
    this.expanding.push({ mesh: ring, age: 0, life, from: 0.3, to: radius, opacity: 1 });
  }

  empBurst(pos: THREE.Vector3, radius: number): void {
    const color = new THREE.Color(0.6, 1.6, 4);
    this.shockwave(pos, radius, color, 0.6);
    this.shockwave(pos, radius * 0.7, color.clone().multiplyScalar(0.6), 0.45);
    const domeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.9, 2.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const dome = new THREE.Mesh(this.sphereGeo, domeMat);
    dome.position.copy(pos);
    this.scene.add(dome);
    this.expanding.push({ mesh: dome, age: 0, life: 0.5, from: 0.5, to: radius, opacity: 0.35 });
    this.flashLight(pos, 0x4aa8ff, 70, 0.4, radius * 2);
    const n = this.count(70);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(10, 22);
      this.emit((p) => {
        p.x = pos.x; p.y = pos.y + 0.3; p.z = pos.z;
        p.vx = Math.cos(a) * sp; p.vy = rand(-0.5, 2); p.vz = Math.sin(a) * sp;
        p.life = rand(0.3, 0.6); p.sizeStart = 0.14; p.sizeEnd = 0.03;
        p.r = 1; p.g = 2.6; p.b = 6; p.drag = 2.5; p.stretch = 0.05;
      });
    }
  }

  stunSparks(pos: THREE.Vector3): void {
    if (Math.random() > 0.5 * this.particleMultiplier) return;
    randomUnit(tmpV);
    this.emit((p) => {
      p.x = pos.x + tmpV.x * 0.9; p.y = pos.y + 0.4 + Math.abs(tmpV.y) * 0.5; p.z = pos.z + tmpV.z * 0.9;
      p.vx = tmpV.x * 2; p.vy = rand(0, 2); p.vz = tmpV.z * 2;
      p.life = 0.15; p.sizeStart = 0.1; p.sizeEnd = 0.02;
      p.r = 1; p.g = 2.5; p.b = 6; p.stretch = 0.08;
    });
  }

  dust(pos: THREE.Vector3, vel: THREE.Vector3, amount: number): void {
    const n = this.count(amount);
    for (let i = 0; i < n; i++) {
      this.emit((p) => {
        p.x = pos.x + rand(-0.15, 0.15); p.y = pos.y + 0.05; p.z = pos.z + rand(-0.15, 0.15);
        p.vx = -vel.x * 0.15 + rand(-0.6, 0.6); p.vy = rand(0.3, 1.2); p.vz = -vel.z * 0.15 + rand(-0.6, 0.6);
        p.life = rand(0.6, 1.2); p.sizeStart = rand(0.25, 0.4); p.sizeEnd = rand(1.0, 1.8);
        p.r = 0.36; p.g = 0.33; p.b = 0.3; p.alpha = 0.32; p.drag = 2.2; p.gravity = -0.2;
      }, true);
    }
  }

  exhaust(pos: THREE.Vector3, back: THREE.Vector3, hot: boolean): void {
    if (Math.random() > this.particleMultiplier) return;
    this.emit((p) => {
      p.x = pos.x; p.y = pos.y; p.z = pos.z;
      p.vx = back.x * rand(4, 8) + rand(-0.3, 0.3); p.vy = back.y * 4 + rand(-0.2, 0.4); p.vz = back.z * rand(4, 8) + rand(-0.3, 0.3);
      p.life = rand(0.08, 0.2); p.sizeStart = hot ? 0.35 : 0.22; p.sizeEnd = 0.05;
      p.r = hot ? 2 : 6; p.g = hot ? 3 : 2.6; p.b = hot ? 7 : 0.8; p.drag = 3;
    });
  }

  debrisSmoke(pos: THREE.Vector3): void {
    if (Math.random() > 0.6 * this.particleMultiplier) return;
    this.emit((p) => {
      p.x = pos.x; p.y = pos.y; p.z = pos.z;
      p.vx = rand(-0.3, 0.3); p.vy = rand(0.8, 1.6); p.vz = rand(-0.3, 0.3);
      p.life = rand(1.2, 2.2); p.sizeStart = 0.25; p.sizeEnd = rand(1.2, 1.8);
      const g = rand(0.08, 0.16);
      p.r = g; p.g = g; p.b = g; p.alpha = 0.5; p.drag = 1; p.gravity = -0.4;
    }, true);
  }

  decal(pos: THREE.Vector3, normal: THREE.Vector3, size: number, big = false): void {
    while (this.decals.length >= this.maxDecals) {
      const old = this.decals.shift();
      if (old) {
        this.scene.remove(old.mesh);
        (old.mesh.material as THREE.Material).dispose();
      }
    }
    const mat = this.decalMat.clone();
    const m = new THREE.Mesh(this.decalGeo, mat);
    m.position.copy(pos).addScaledVector(normal, 0.015);
    tmpQ.setFromUnitVectors(Z, normal);
    m.quaternion.copy(tmpQ);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(size);
    m.renderOrder = 1;
    this.scene.add(m);
    this.decals.push({ mesh: m, age: 0, life: big ? 30 : 18 });
  }

  /** Synchronises mine meshes with the interpolated server list. */
  updateMines(list: { id: number; owner: number; p: THREE.Vector3 }[], colorOf: (owner: number) => number, time: number): void {
    for (const v of this.mines.values()) v.seen = false;
    for (const m of list) {
      let v = this.mines.get(m.id);
      if (!v) {
        const group = new THREE.Group();
        const body = new THREE.Mesh(this.mineGeo, this.mineBodyMat);
        body.castShadow = true;
        group.add(body);
        const lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(colorOf(m.owner)).multiplyScalar(5) });
        const light = new THREE.Mesh(this.mineLightGeo, lightMat);
        light.position.y = 0.12;
        group.add(light);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.03, 6, 24), lightMat);
        ring.rotation.x = Math.PI / 2;
        group.add(ring);
        this.scene.add(group);
        v = { group, light, seen: true };
        this.mines.set(m.id, v);
      }
      v.seen = true;
      v.group.position.copy(m.p);
      v.group.rotation.y = time * 4 + m.id;
      v.light.visible = Math.sin(time * 14 + m.id) > -0.2;
    }
    for (const [id, v] of this.mines) {
      if (!v.seen) {
        this.scene.remove(v.group);
        this.mines.delete(id);
      }
    }
  }

  update(dt: number, time: number): void {
    this.additive.update(time);
    this.smokeParticles.update(time);

    for (const l of this.lights) {
      if (l.life <= 0) continue;
      l.age += dt;
      const t = Math.min(1, l.age / l.life);
      let k = (1 - t) * (1 - t);
      if (l.flicker) k *= 0.7 + Math.random() * 0.6;
      l.light.intensity = t >= 1 ? 0 : l.peak * k;
      if (t >= 1) l.life = 0;
    }

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.age += dt;
      if (f.age >= f.life) {
        this.scene.remove(f.mesh);
        this.flashes.splice(i, 1);
      }
    }

    for (let i = this.expanding.length - 1; i >= 0; i--) {
      const e = this.expanding[i];
      e.age += dt;
      const t = Math.min(1, e.age / e.life);
      const ease = 1 - Math.pow(1 - t, 3);
      e.mesh.scale.setScalar(e.from + (e.to - e.from) * ease);
      const mat = e.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = e.opacity * (1 - t) * (1 - t);
      if (t >= 1) {
        this.scene.remove(e.mesh);
        mat.dispose();
        this.expanding.splice(i, 1);
      }
    }

    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.age += dt;
      const mat = d.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.min(1, (d.life - d.age) / 4);
      if (d.age >= d.life) {
        this.scene.remove(d.mesh);
        mat.dispose();
        this.decals.splice(i, 1);
      }
    }
  }

  clearTransient(): void {
    for (const d of this.decals) {
      this.scene.remove(d.mesh);
      (d.mesh.material as THREE.Material).dispose();
    }
    this.decals.length = 0;
  }
}
