import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getArenaDefinition, getWeapon, type MapId, type Vec3, type WeaponId, type WeaponPickupState } from '@robot-arena/shared';

interface PickupVisual {
  root: THREE.Group;
  weaponId: WeaponId;
  weapon: THREE.Group;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  beacon: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  label: THREE.Sprite;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  lastLabel: string;
}

/** Passable weapon pads: a floating weapon, its role, and an authoritative respawn countdown. */
export class WeaponPickupRenderer {
  private readonly group = new THREE.Group();
  private readonly pads = new Map<number, PickupVisual>();

  constructor(scene: THREE.Scene, mapId: MapId) {
    this.group.name = 'weaponPickups';
    scene.add(this.group);
    for (const pad of getArenaDefinition(mapId).pickups) {
      this.create(pad.id, pad.weaponId, pad.position);
    }
  }

  update(time: number, dt: number, states: readonly WeaponPickupState[]): void {
    void dt;
    for (const state of states) {
      let pad = this.pads.get(state.id);
      if (!pad) pad = this.create(state.id, state.weaponId, state.position);
      if (pad.weaponId !== state.weaponId) {
        pad.root.remove(pad.weapon);
        disposeObject(pad.weapon);
        pad.weaponId = state.weaponId;
        pad.weapon = weaponModel(state.weaponId);
        pad.root.add(pad.weapon);
        pad.lastLabel = '';
      }
      pad.root.position.set(state.position.x, state.position.y, state.position.z);
      const color = getWeapon(state.weaponId).color;
      pad.ring.material.color.setHex(color);
      pad.beacon.material.color.setHex(color);
      pad.weapon.visible = state.available;
      pad.weapon.position.y = 1.15 + Math.sin(time * 2.1 + state.id) * 0.14;
      pad.weapon.rotation.y = time * 0.65 + state.id;
      pad.beacon.visible = state.available;
      pad.beacon.material.opacity = 0.07 + Math.sin(time * 2.6 + state.id) * 0.025;
      pad.ring.material.opacity = state.available ? 0.75 + Math.sin(time * 3) * 0.2 : 0.4;
      if (state.available) {
        pad.ring.geometry.setDrawRange(0, Infinity);
      } else {
        const progress = THREE.MathUtils.clamp(1 - state.respawnIn / 12, 0, 1);
        pad.ring.geometry.setDrawRange(0, Math.floor(progress * 64) * 6);
      }
      const label = state.available ? 'PRESS E TO EQUIP' : `RESPAWNS IN ${Math.max(1, Math.ceil(state.respawnIn))}s`;
      if (label !== pad.lastLabel) {
        this.drawLabel(pad, label, state.available);
        pad.lastLabel = label;
      }
      pad.label.material.opacity = state.available ? 1 : 0.66;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    disposeObject(this.group);
    this.group.clear();
    this.pads.clear();
  }

  private create(id: number, weaponId: WeaponId, position: Vec3): PickupVisual {
    const root = new THREE.Group();
    root.name = `weaponPad:${id}:${weaponId}`;
    root.position.set(position.x, position.y, position.z);
    const color = getWeapon(weaponId).color;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.42, 0.1, 6), new THREE.MeshStandardMaterial({ color: 0x17222c, roughness: 0.6, metalness: 0.7 }));
    base.position.y = 0.05;
    base.receiveShadow = true;
    root.add(base);
    const outline = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.17, 64), new THREE.MeshBasicMaterial({ color: 0x35414b, transparent: true, opacity: 0.75, depthWrite: false }));
    outline.rotation.x = -Math.PI / 2;
    outline.position.y = 0.112;
    root.add(outline);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.17, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.rotation.z = Math.PI / 2;
    ring.position.y = 0.116;
    root.add(ring);
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.98, 1.9, 24, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beacon.position.y = 1.05;
    root.add(beacon);
    const weapon = weaponModel(weaponId);
    weapon.position.y = 1.15;
    root.add(weapon);

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 224;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
    label.scale.set(4.1, 1.435, 1);
    label.position.y = 2.65;
    root.add(label);
    const visual: PickupVisual = { root, weaponId, weapon, ring, beacon, label, texture, canvas, ctx, lastLabel: '' };
    this.drawLabel(visual, 'PRESS E TO EQUIP', true);
    this.pads.set(id, visual);
    this.group.add(root);
    return visual;
  }

  private drawLabel(pad: PickupVisual, status: string, available: boolean): void {
    const weapon = getWeapon(pad.weaponId);
    const c = pad.ctx;
    const w = pad.canvas.width, h = pad.canvas.height;
    const color = `#${weapon.color.toString(16).padStart(6, '0')}`;
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(5, 12, 20, 0.88)';
    c.fillRect(0, 0, w, h);
    c.fillStyle = color;
    c.fillRect(0, 0, w, 7);
    c.fillRect(0, h - 4, w, 4);
    c.textAlign = 'center';
    c.fillStyle = available ? '#ffffff' : '#a3b0bd';
    c.font = 'bold 43px Rajdhani, sans-serif';
    c.fillText(weapon.name.toUpperCase(), w / 2, 65, w - 40);
    c.fillStyle = color;
    c.font = '600 28px Rajdhani, sans-serif';
    c.fillText(weapon.role.toUpperCase(), w / 2, 112);
    c.fillStyle = available ? '#b9c9d8' : '#92a0ae';
    c.font = 'bold 23px Rajdhani, sans-serif';
    c.fillText(status, w / 2, 178);
    pad.texture.needsUpdate = true;
  }
}

/** Compact display models use the same silhouette cues as the equipped barrels. */
function weaponModel(id: WeaponId): THREE.Group {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x546375, roughness: 0.3, metalness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x16212e, roughness: 0.5, metalness: 0.65 });
  const glow = new THREE.MeshStandardMaterial({ color: 0x101820, emissive: getWeapon(id).color, emissiveIntensity: 2.3, roughness: 0.3 });
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): void => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    group.add(mesh);
  };
  add(new THREE.BoxGeometry(0.42, 0.32, 0.55), dark, 0, 0, -0.33);
  const barrel = (x: number, y: number, length: number, radius: number): void => {
    add(new THREE.CylinderGeometry(radius, radius, length, 12).rotateX(Math.PI / 2), metal, x, y, length / 2 - 0.15);
  };
  if (id === 'scatter') {
    add(new THREE.BoxGeometry(0.6, 0.4, 0.75), metal, 0, 0, 0.3);
    for (const x of [-0.19, 0, 0.19]) add(new THREE.CylinderGeometry(0.07, 0.07, 0.07, 10).rotateX(Math.PI / 2), glow, x, 0, 0.72);
  } else if (id === 'rail') {
    for (const x of [-0.19, 0.19]) {
      add(new THREE.BoxGeometry(0.1, 0.26, 1.5), metal, x, 0, 0.5);
      add(new THREE.BoxGeometry(0.04, 0.06, 1.32), glow, x * 0.7, 0.07, 0.5);
    }
    add(new THREE.BoxGeometry(0.19, 0.14, 0.28), glow, 0, 0.26, -0.24);
  } else if (id === 'repeater') {
    add(new THREE.CylinderGeometry(0.32, 0.32, 0.45, 12).rotateX(Math.PI / 2), dark, 0, 0, -0.1);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      barrel(Math.cos(a) * 0.16, Math.sin(a) * 0.16, 0.95, 0.065);
    }
    add(new THREE.TorusGeometry(0.23, 0.04, 6, 20), glow, 0, 0, 0.8);
  } else {
    barrel(0, 0, 1.1, 0.12);
    for (const z of [0.15, 0.45, 0.75]) add(new THREE.TorusGeometry(0.17, 0.035, 6, 20), glow, 0, 0, z);
  }
  // Every display part rotates together, so combine them into one draw per material.
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const child of [...group.children]) {
    if (!(child instanceof THREE.Mesh) || Array.isArray(child.material)) continue;
    child.updateMatrix();
    const geometry = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone();
    geometry.applyMatrix4(child.matrix);
    const batch = batches.get(child.material) ?? [];
    batch.push(geometry);
    batches.set(child.material, batch);
    child.geometry.dispose();
    group.remove(child);
  }
  for (const [material, geometries] of batches) {
    const merged = mergeGeometries(geometries, false);
    if (merged) group.add(new THREE.Mesh(merged, material));
    for (const geometry of geometries) geometry.dispose();
  }
  group.rotation.z = -0.08;
  return group;
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
