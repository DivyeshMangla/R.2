import * as THREE from 'three';
import type { ZoneKind } from '@robot-arena/shared';

/** Per-kind ground colours: rgb base, rgb hot/bright accent. */
const PALETTE: Record<ZoneKind, { base: THREE.Color; hot: THREE.Color }> = {
  fire: { base: new THREE.Color(0.9, 0.18, 0.02), hot: new THREE.Color(1.6, 0.9, 0.25) },
  toxic: { base: new THREE.Color(0.55, 0.65, 0.02), hot: new THREE.Color(1.1, 1.4, 0.15) },
  acid: { base: new THREE.Color(0.05, 0.6, 0.12), hot: new THREE.Color(0.4, 1.5, 0.45) },
};

export interface Zone {
  zid: number;
  kind: ZoneKind;
  x: number;
  y: number;
  z: number;
  r: number;
  birth: number;
  until: number;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** Fractional particle carry so emission is frame-rate independent. */
  carry: number;
  /** Proximity bomb drawn at the centre until it detonates (deploy weapons with a trigger radius). */
  barrel: THREE.Group | null;
  /** Faint pulsing ring at the bomb's trigger radius. */
  trigger: THREE.Mesh | null;
  triggerMat: THREE.MeshBasicMaterial | null;
}

function zoneMaterial(kind: ZoneKind): THREE.ShaderMaterial {
  const p = PALETTE[kind];
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 0 },
      uBase: { value: p.base.clone() },
      uHot: { value: p.hot.clone() },
      uSeed: { value: Math.random() * 100 },
      uKind: { value: kind === 'fire' ? 0 : kind === 'toxic' ? 1 : 2 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uFade; uniform vec3 uBase; uniform vec3 uHot; uniform float uSeed; uniform float uKind;
      varying vec2 vUv;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) { return n(p) * 0.55 + n(p * 2.1) * 0.3 + n(p * 4.7) * 0.15; }
      void main() {
        float d = length(vUv);
        float edgeNoise = fbm(vUv * 3.0 + uSeed) * 0.28;
        float mask = 1.0 - smoothstep(0.62 + edgeNoise, 0.95 + edgeNoise * 0.4, d);
        if (mask < 0.01) discard;
        float speed = uKind < 0.5 ? 1.8 : uKind < 1.5 ? 0.5 : 0.35;
        float f = fbm(vUv * 5.0 + vec2(uSeed, uTime * speed));
        float g = fbm(vUv * 9.0 - vec2(uTime * speed * 0.7, uSeed));
        float hot = smoothstep(0.45, 0.85, f * 0.7 + g * 0.5);
        // Fire flickers; toxic/acid pulse slowly with bubble pops.
        float flicker = uKind < 0.5 ? 0.75 + 0.25 * sin(uTime * 17.0 + f * 9.0) : 0.85 + 0.15 * sin(uTime * 2.5 + g * 6.0);
        float pops = uKind > 0.5 ? step(0.86, n(vUv * 16.0 + floor(uTime * 3.0) * 1.7)) : 0.0;
        // Bright pulsing rim so the hazard's full (large) radius reads at a glance.
        float rim = smoothstep(0.5 + edgeNoise, 0.82 + edgeNoise * 0.5, d) * mask * (0.75 + 0.25 * sin(uTime * 4.0 + uSeed));
        vec3 col = mix(uBase, uHot, hot) * flicker + uHot * pops * 0.8 + uHot * rim * 0.9;
        float a = mask * uFade * (0.6 + hot * 0.5 + rim * 0.5);
        gl_FragColor = vec4(col * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/**
 * Lingering ground hazards (fire pools, toxic clouds, acid puddles). Each
 * zone is a noise-animated additive disc sized by its radius; the owning
 * VFXSystem emits the airborne particles for every live zone each frame.
 */
export class ZoneRenderer {
  readonly zones: Zone[] = [];
  private readonly geo = new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2);
  private readonly group = new THREE.Group();
  private readonly barrelGeo = new THREE.CylinderGeometry(0.62, 0.62, 1.5, 18);
  private readonly bandGeo = new THREE.CylinderGeometry(0.66, 0.66, 0.22, 18);
  private readonly triggerGeo = new THREE.RingGeometry(0.93, 1, 72).rotateX(-Math.PI / 2);
  private readonly barrelMat = new THREE.MeshStandardMaterial({ color: 0xe0b417, roughness: 0.55, metalness: 0.35 });

  constructor(scene: THREE.Scene) {
    this.group.name = 'zones';
    scene.add(this.group);
  }

  add(zid: number, kind: ZoneKind, x: number, y: number, z: number, r: number, dur: number, time: number): Zone {
    this.remove(zid);
    const mat = zoneMaterial(kind);
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.position.set(x, y + 0.06, z);
    mesh.scale.setScalar(r);
    mesh.renderOrder = 8;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    const zone: Zone = { zid, kind, x, y, z, r, birth: time, until: time + dur, mesh, mat, carry: 0, barrel: null, trigger: null, triggerMat: null };
    this.zones.push(zone);
    return zone;
  }

  /** Draws a live proximity bomb (barrel + glowing hazard bands) and its trigger ring on zone `zid`. */
  armBomb(zid: number, color: number, triggerRadius: number): void {
    const zone = this.zones.find((z) => z.zid === zid);
    if (!zone || zone.barrel) return;
    const barrel = new THREE.Group();
    const body = new THREE.Mesh(this.barrelGeo, this.barrelMat);
    body.position.y = 0.75;
    barrel.add(body);
    const bandMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.2), toneMapped: false });
    for (const h of [0.35, 1.15]) {
      const band = new THREE.Mesh(this.bandGeo, bandMat);
      band.position.y = h;
      barrel.add(band);
    }
    barrel.position.set(zone.x, zone.y, zone.z);
    barrel.scale.setScalar(1.25);
    this.group.add(barrel);
    zone.barrel = barrel;
    if (triggerRadius > 0) {
      const triggerMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(1.6), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      });
      const trigger = new THREE.Mesh(this.triggerGeo, triggerMat);
      trigger.position.set(zone.x, zone.y + 0.1, zone.z);
      trigger.scale.setScalar(triggerRadius);
      trigger.renderOrder = 9;
      this.group.add(trigger);
      zone.trigger = trigger;
      zone.triggerMat = triggerMat;
    }
  }

  /** The armed bomb nearest (x, z) within `maxDist` blew up: hide its barrel and trigger ring. Returns true if one was found. */
  detonateNear(x: number, z: number, maxDist: number): boolean {
    let best: Zone | null = null;
    let bestD = maxDist * maxDist;
    for (const zone of this.zones) {
      if (!zone.barrel) continue;
      const d = (zone.x - x) ** 2 + (zone.z - z) ** 2;
      if (d <= bestD) { bestD = d; best = zone; }
    }
    if (!best) return false;
    this.disarm(best);
    return true;
  }

  private disarm(zone: Zone): void {
    if (zone.barrel) {
      this.group.remove(zone.barrel);
      const disposed = new Set<THREE.Material>();
      zone.barrel.traverse((obj) => {
        const mat = (obj as THREE.Mesh).material as THREE.Material | undefined;
        if (mat && mat !== this.barrelMat && !disposed.has(mat)) { disposed.add(mat); mat.dispose(); }
      });
      zone.barrel = null;
    }
    if (zone.trigger) {
      this.group.remove(zone.trigger);
      zone.triggerMat?.dispose();
      zone.trigger = null;
      zone.triggerMat = null;
    }
  }

  remove(zid: number): void {
    const i = this.zones.findIndex((zone) => zone.zid === zid);
    if (i < 0) return;
    this.dispose(this.zones[i]);
    this.zones.splice(i, 1);
  }

  private dispose(zone: Zone): void {
    this.disarm(zone);
    this.group.remove(zone.mesh);
    zone.mat.dispose();
  }

  update(time: number): void {
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const zone = this.zones[i];
      if (time >= zone.until) {
        this.dispose(zone);
        this.zones.splice(i, 1);
        continue;
      }
      const grow = Math.min(1, (time - zone.birth) / 0.35);
      const fade = Math.min(1, (zone.until - time) / 0.8);
      zone.mat.uniforms.uTime.value = time;
      zone.mat.uniforms.uFade.value = grow * fade;
      zone.mesh.scale.setScalar(zone.r * (0.4 + 0.6 * (1 - (1 - grow) ** 3)));
      if (zone.barrel) zone.barrel.rotation.y = Math.sin(time * 9) * 0.04;
      if (zone.triggerMat) zone.triggerMat.opacity = (0.22 + 0.18 * Math.sin(time * 5 + zone.zid)) * fade;
    }
  }

  clear(): void {
    for (const zone of this.zones) this.dispose(zone);
    this.zones.length = 0;
  }
}
