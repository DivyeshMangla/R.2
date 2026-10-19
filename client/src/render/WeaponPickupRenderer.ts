import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getArenaDefinition, getWeapon, type MapId, type Vec3, type WeaponId, type WeaponPickupState } from '@robot-arena/shared';
import { buildWeaponModel, disposeWeaponModel, padWeaponScale, weaponSizeMul } from './WeaponModels';

const LABEL_AVAILABLE = 'DRIVE OVER TO GRAB · 1 USE';
/** Height of the light column rising from each pad. */
const BEAM_HEIGHT = 9;
/** Label canvas (pixels) and its world size: readable from 20–30 m. */
const LABEL_PX_W = 1024;
const LABEL_PX_H = 360;
const LABEL_W = 6.6;
const LABEL_H = (LABEL_W * LABEL_PX_H) / LABEL_PX_W;
/** Seconds per outward ring pulse. */
const PULSE_PERIOD = 1.6;

interface PickupVisual {
  root: THREE.Group;
  weaponId: WeaponId;
  weapon: THREE.Group;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  pulse: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  beam: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  glow: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  label: THREE.Sprite;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  lastLabel: string;
  /** Largest respawn countdown seen since the pad emptied (drives the refill ring). */
  respawnSpan: number;
  /** Display scale + hover height of the current weapon. */
  scale: number;
  hover: number;
}

const BEAM_VERT = /* glsl */ `
  varying float vY;
  varying float vEdge;
  varying float vAngle;
  void main() {
    vY = uv.y;
    vAngle = uv.x;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vEdge = 1.0 - abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`;
const BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  varying float vY;
  varying float vEdge;
  varying float vAngle;
  void main() {
    float fade = pow(1.0 - vY, 1.7) * smoothstep(0.0, 0.04, vY);
    float streak = 0.7 + 0.3 * sin(vY * 26.0 - uTime * 5.0 + vAngle * 37.7);
    float a = fade * (0.18 + 0.82 * vEdge * vEdge) * streak * uOpacity;
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`;
const GLOW_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = pow(max(0.0, 1.0 - d), 2.2) * (0.85 + 0.15 * sin(uTime * 3.0)) * uOpacity;
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`;
const GLOW_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

function additive(vertexShader: string, fragmentShader: string, color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: hdr(color, new THREE.Color()) }, uTime: { value: 0 }, uOpacity: { value: 1 } },
    vertexShader,
    fragmentShader,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

/** Weapon colour pushed into HDR so bloom picks the column up from across the map. */
function hdr(color: number, out: THREE.Color): THREE.Color {
  return out.setHex(color).multiplyScalar(1.6);
}

/**
 * Passable weapon pads: a large floating weapon (scaled by its sizeMul) inside a
 * light column in its colour, its name + power, and an authoritative respawn countdown.
 */
export class WeaponPickupRenderer {
  private readonly group = new THREE.Group();
  private readonly pads = new Map<number, PickupVisual>();

  constructor(scene: THREE.Scene, mapId: MapId) {
    this.group.name = 'weaponPickups';
    scene.add(this.group);
    for (const pad of getArenaDefinition(mapId).pickups) {
      this.create(pad.id, pad.weaponId, pad.position);
    }
    this.batchPlatforms();
  }

  update(time: number, dt: number, states: readonly WeaponPickupState[]): void {
    void dt;
    for (const state of states) {
      let pad = this.pads.get(state.id);
      if (!pad) pad = this.create(state.id, state.weaponId, state.position);
      if (pad.weaponId !== state.weaponId) {
        disposeWeaponModel(pad.weapon);
        pad.weaponId = state.weaponId;
        pad.weapon = displayModel(state.weaponId);
        pad.root.add(pad.weapon);
        this.fit(pad);
        pad.lastLabel = '';
      }
      pad.root.position.set(state.position.x, state.position.y, state.position.z);
      const def = getWeapon(state.weaponId);
      const size = weaponSizeMul(state.weaponId);
      pad.ring.material.color.setHex(def.color);
      pad.pulse.material.color.setHex(def.color);
      hdr(def.color, pad.beam.material.uniforms.uColor.value as THREE.Color);
      hdr(def.color, pad.glow.material.uniforms.uColor.value as THREE.Color);
      pad.beam.material.uniforms.uTime.value = time + state.id;
      pad.glow.material.uniforms.uTime.value = time + state.id;

      // Heavy weapons bob slower and lower and turn ponderously; light ones bounce and spin.
      pad.weapon.visible = state.available;
      pad.weapon.position.y = pad.hover + Math.sin(time * (2.6 / size) + state.id) * (0.32 / size);
      pad.weapon.rotation.y = time * (1.1 / size) + state.id;

      pad.ring.material.opacity = state.available ? 0.85 + Math.sin(time * 3) * 0.15 : 0.45;
      pad.beam.material.uniforms.uOpacity.value = state.available ? 1 : 0.18;
      pad.glow.material.uniforms.uOpacity.value = state.available ? 1 : 0.25;
      const phase = ((time + state.id * 0.37) % PULSE_PERIOD) / PULSE_PERIOD;
      pad.pulse.visible = state.available;
      pad.pulse.scale.setScalar(1 + phase * 1.4);
      pad.pulse.material.opacity = (1 - phase) * 0.8;
      if (state.available) {
        pad.respawnSpan = 0;
        pad.ring.geometry.setDrawRange(0, Infinity);
      } else {
        pad.respawnSpan = Math.max(pad.respawnSpan, state.respawnIn);
        const progress = pad.respawnSpan > 0 ? THREE.MathUtils.clamp(1 - state.respawnIn / pad.respawnSpan, 0, 1) : 0;
        pad.ring.geometry.setDrawRange(0, Math.floor(progress * 64) * 6);
      }
      const label = state.available ? LABEL_AVAILABLE : `BACK IN ${Math.max(1, Math.ceil(state.respawnIn))}s`;
      if (label !== pad.lastLabel) {
        this.drawLabel(pad, label, state.available);
        pad.lastLabel = label;
      }
      pad.label.material.opacity = state.available ? 1 : 0.7;
    }
  }

  dispose(): void {
    // Weapon models share cached GPU resources: detach them before the deep dispose.
    for (const pad of this.pads.values()) disposeWeaponModel(pad.weapon);
    this.group.removeFromParent();
    disposeObject(this.group);
    this.group.clear();
    this.pads.clear();
  }

  /** All map pads share one platform draw and one outline draw, even on the larger arenas. */
  private batchPlatforms(): void {
    for (const name of ['pickup.base', 'pickup.outline']) {
      const geometries: THREE.BufferGeometry[] = [];
      const materials = new Set<THREE.Material>();
      this.group.updateMatrixWorld(true);
      for (const pad of this.pads.values()) {
        const mesh = pad.root.getObjectByName(name);
        if (!(mesh instanceof THREE.Mesh) || Array.isArray(mesh.material)) continue;
        geometries.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
        materials.add(mesh.material);
        mesh.geometry.dispose();
        mesh.removeFromParent();
      }
      const merged = mergeGeometries(geometries, false);
      const material = materials.values().next().value;
      if (merged && material) {
        const mesh = new THREE.Mesh(merged, material);
        mesh.name = `${name}.batch`;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
      for (const geometry of geometries) geometry.dispose();
      for (const extra of materials) if (extra !== material) extra.dispose();
    }
  }

  /** Sizes the floating weapon, its hover height and the label above it for the current weapon. */
  private fit(pad: PickupVisual): void {
    pad.scale = padWeaponScale(pad.weaponId);
    pad.hover = 0.85 + 0.42 * pad.scale;
    pad.weapon.scale.setScalar(pad.scale);
    pad.weapon.position.y = pad.hover;
    pad.label.position.y = pad.hover + 0.42 * pad.scale + LABEL_H * 0.5 + 0.35;
  }

  private create(id: number, weaponId: WeaponId, position: Vec3): PickupVisual {
    const root = new THREE.Group();
    root.name = `weaponPad:${id}:${weaponId}`;
    root.position.set(position.x, position.y, position.z);
    const color = getWeapon(weaponId).color;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.42, 0.1, 6), new THREE.MeshStandardMaterial({ color: 0x38302c, roughness: 1, metalness: 0, flatShading: true }));
    base.position.y = 0.05;
    base.name = 'pickup.base';
    base.receiveShadow = true;
    root.add(base);
    const outline = new THREE.Mesh(new THREE.RingGeometry(0.94, 1.3, 64), new THREE.MeshBasicMaterial({ color: 0x35414b, transparent: true, opacity: 0.75, depthWrite: false }));
    outline.rotation.x = -Math.PI / 2;
    outline.name = 'pickup.outline';
    outline.position.y = 0.112;
    root.add(outline);
    // Wide HDR ring (doubles as the refill progress arc) + a pulse that ripples outward.
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.98, 1.26, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.rotation.z = Math.PI / 2;
    ring.position.y = 0.116;
    root.add(ring);
    const pulse = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.12, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }));
    pulse.rotation.x = -Math.PI / 2;
    pulse.position.y = 0.12;
    root.add(pulse);
    // Soft ground glow and a light column in the weapon colour, visible across the arena.
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2), additive(GLOW_VERT, GLOW_FRAG, color));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.125;
    glow.renderOrder = 2;
    root.add(glow);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.85, 1.12, BEAM_HEIGHT, 24, 1, true).translate(0, BEAM_HEIGHT / 2, 0),
      additive(BEAM_VERT, BEAM_FRAG, color),
    );
    beam.position.y = 0.12;
    beam.renderOrder = 3;
    beam.frustumCulled = false;
    root.add(beam);

    const weapon = displayModel(weaponId);
    root.add(weapon);

    const canvas = document.createElement('canvas');
    canvas.width = LABEL_PX_W;
    canvas.height = LABEL_PX_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
    label.scale.set(LABEL_W, LABEL_H, 1);
    label.renderOrder = 4;
    root.add(label);
    const visual: PickupVisual = {
      root, weaponId, weapon, ring, pulse, beam, glow, label, texture, canvas, ctx, lastLabel: '', respawnSpan: 0, scale: 1, hover: 1.2,
    };
    this.fit(visual);
    this.drawLabel(visual, LABEL_AVAILABLE, true);
    this.pads.set(id, visual);
    this.group.add(root);
    return visual;
  }

  private drawLabel(pad: PickupVisual, status: string, available: boolean): void {
    const weapon = getWeapon(pad.weaponId);
    const c = pad.ctx;
    const w = pad.canvas.width, h = pad.canvas.height;
    const color = `#${weapon.color.toString(16).padStart(6, '0')}`;
    const ink = available ? '#302824' : '#8a8071';
    const font = (px: number): string => `bold ${px}px "Comic Sans MS", "Chalkboard SE", sans-serif`;
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#f3e5c7';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#302824'; c.lineWidth = 14; c.strokeRect(7, 7, w - 14, h - 14);
    c.lineWidth = 2.5; c.strokeRect(22, 22, w - 44, h - 44);
    c.fillStyle = color;
    c.fillRect(0, 0, w, 14);
    c.fillRect(0, h - 8, w, 8);
    c.textAlign = 'center';
    c.textBaseline = 'middle';

    // Name: big and dark.
    c.fillStyle = ink;
    c.font = font(78);
    c.fillText(weapon.name.toUpperCase(), w / 2, 92, w - 70);

    // Power chip in the weapon colour, with the role beside it.
    c.font = font(62);
    const power = weapon.power;
    const chipW = Math.min(w - 120, c.measureText(power).width + 70);
    const chipH = 86;
    const chipX = (w - chipW) / 2;
    const chipY = 150;
    c.fillStyle = available ? color : '#a99f90';
    roundRect(c, chipX, chipY, chipW, chipH, 22);
    c.fill();
    c.lineWidth = 6;
    c.strokeStyle = '#302824';
    c.stroke();
    c.fillStyle = '#fffaf0';
    c.strokeStyle = '#302824';
    c.lineWidth = 8;
    c.strokeText(power, w / 2, chipY + chipH / 2 + 3, chipW - 30);
    c.fillText(power, w / 2, chipY + chipH / 2 + 3, chipW - 30);

    c.fillStyle = '#65564b';
    c.font = font(36);
    c.fillText(`${weapon.role.toUpperCase()}  ·  ${status}`, w / 2, 290, w - 70);
    pad.texture.needsUpdate = true;
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** Pad display: the shared weapon model, tilted a touch so its silhouette reads while it spins. */
function displayModel(id: WeaponId): THREE.Group {
  const model = buildWeaponModel(id);
  // Pivot group so the tilt stays stable while the outer group spins and scales.
  const pivot = new THREE.Group();
  model.rotation.z = -0.1;
  model.rotation.x = -0.14;
  pivot.add(model);
  pivot.name = model.name;
  pivot.userData.sharedWeaponModel = true;
  return pivot;
}

function disposeObject(object: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) geometries.add(child.geometry);
    if (child instanceof THREE.Mesh || child instanceof THREE.Sprite) {
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        materials.add(material);
        const map = (material as THREE.MeshBasicMaterial | THREE.SpriteMaterial).map;
        if (map) textures.add(map);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}
