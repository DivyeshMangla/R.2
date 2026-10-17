import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CHASSIS_HALF, getCharacter, getMap, getWeapon, physicsConfig, RobotFlags, TWIN_BARREL_OFFSET, WHEEL_ANCHORS, type MapId, type PowerUpStacks, type Vec3 } from '@robot-arena/shared';
import {
  BARREL_MOUNT,
  BARREL_TIP_Z,
  buildRobotParts,
  suspensionMounts,
  TURRET_MOUNT,
  type AddonKey,
  type PartDef,
  type PartMaterial,
} from './RobotGeometry';
import { createRobotMaterials, MAX_FLEET, RobotDataTexture, type RobotMaterialSet } from './RobotMaterials';
import { createRobotSurfaceMaps, NumberAtlas } from './RobotTextures';
import { RobotVisual } from './RobotVisual';
import { RobotInk } from './RobotInk';

export interface DebrisPiece {
  object: THREE.Object3D;
  /** Collision half extents of the chunk. */
  half: Vec3;
  /** Chunk centre in chassis space. */
  offset: THREE.Vector3;
}

interface PartMesh {
  def: PartDef;
  mesh: THREE.InstancedMesh;
  perRobot: number;
}

/** Per-robot slot transforms, recomputed every frame. */
interface SlotMatrices {
  root: THREE.Matrix4;
  chassis: THREE.Matrix4;
  chassisLocal: THREE.Matrix4;
  turret: THREE.Matrix4;
  barrel: THREE.Matrix4;
  wheels: THREE.Matrix4[];
  arms: THREE.Matrix4[];
  shocks: THREE.Matrix4[];
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const LEAN_PIVOT = new THREE.Vector3(0, -0.25, 0);
const WHITE = new THREE.Color(1, 1, 1);
const STUN = new THREE.Color(0.35, 0.75, 1.8);

const MOUNTS = WHEEL_ANCHORS.map((a) => suspensionMounts(a));
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

function addonVisible(addon: AddonKey | undefined, stacks: PowerUpStacks): boolean {
  switch (addon) {
    case undefined:
      return true;
    case 'plates':
      return (stacks.reinforced_plating ?? 0) > 0;
    case 'boosters':
      return (stacks.rocket_dash ?? 0) > 0;
    case 'mines':
      return (stacks.magnet_mines ?? 0) > 0;
    case 'repair':
      return (stacks.field_repair ?? 0) > 0;
    case 'emp':
      return (stacks.emp_burst ?? 0) > 0;
    case 'leech':
      return (stacks.leech_core ?? 0) > 0;
  }
}

/**
 * Renders every robot through shared InstancedMeshes: one draw call per part
 * type for the whole fleet. Per-robot shader inputs live in RobotDataTexture.
 */
export class RobotFleet {
  readonly materials: RobotMaterialSet;
  readonly visuals = new Map<number, RobotVisual>();
  leanStrength = 1;
  private readonly parts: PartMesh[] = [];
  private readonly partByName = new Map<string, PartDef>();
  private readonly slots: (RobotVisual | null)[] = new Array<RobotVisual | null>(MAX_FLEET).fill(null);
  private readonly matrices: SlotMatrices[] = [];
  private readonly blobs: THREE.InstancedMesh;
  private readonly aura: THREE.InstancedMesh;
  private readonly auraMaterial: THREE.ShaderMaterial;
  private readonly group = new THREE.Group();
  private readonly ink: RobotInk;
  private mapTheme = getMap('foundry');

  constructor(scene: THREE.Scene, anisotropy: number) {
    this.group.name = 'RobotFleet';
    scene.add(this.group);
    const data = new RobotDataTexture();
    const numbers = new NumberAtlas();
    this.materials = createRobotMaterials(data, createRobotSurfaceMaps(anisotropy), numbers);

    for (const def of buildRobotParts()) {
      def.geometry.userData.shared = true;
      this.partByName.set(def.name, def);
      const perRobot = def.locals?.length ?? (def.slot === 'wheel' || def.slot === 'arm' || def.slot === 'shock' ? 4 : 1);
      const mesh = new THREE.InstancedMesh(def.geometry, this.materialFor(def.material, perRobot), MAX_FLEET * perRobot);
      mesh.name = def.name;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = def.castShadow;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.group.add(mesh);
      this.parts.push({ def, mesh, perRobot });
    }
    this.ink = new RobotInk(this.parts.map((part) => ({ geometry: part.def.geometry, perRobot: part.perRobot })), MAX_FLEET);
    this.group.add(this.ink.lines);

    for (let i = 0; i < MAX_FLEET; i++) {
      this.matrices.push({
        root: new THREE.Matrix4(),
        chassis: new THREE.Matrix4(),
        chassisLocal: new THREE.Matrix4(),
        turret: new THREE.Matrix4(),
        barrel: new THREE.Matrix4(),
        wheels: [0, 1, 2, 3].map(() => new THREE.Matrix4()),
        arms: [0, 1, 2, 3].map(() => new THREE.Matrix4()),
        shocks: [0, 1, 2, 3].map(() => new THREE.Matrix4()),
      });
    }

    // Contact-shadow blobs (multiply blended) ground every robot.
    const blobTex = makeBlobTexture();
    const blobMat = new THREE.MeshBasicMaterial({
      map: blobTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.MultiplyBlending,
      premultipliedAlpha: true,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.blobs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), blobMat, MAX_FLEET);
    this.blobs.name = 'robot.contactShadows';
    this.blobs.frustumCulled = false;
    this.blobs.renderOrder = 2;
    this.blobs.count = 0;
    this.group.add(this.blobs);

    // Level aura: additive fresnel shell.
    this.auraMaterial = new THREE.ShaderMaterial({
      uniforms: { uRobotData: { value: data.texture }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        uniform sampler2D uRobotData;
        flat varying vec4 vR1;
        flat varying float vAura;
        varying vec3 vN;
        varying vec3 vV;
        varying vec3 vObj;
        void main() {
          int ri = gl_InstanceID;
          vR1 = texelFetch(uRobotData, ivec2(ri, 1), 0);
          vAura = texelFetch(uRobotData, ivec2(ri, 2), 0).w;
          mat4 m = modelMatrix * instanceMatrix;
          vec4 wp = m * vec4(position, 1.0);
          vN = normalize(mat3(m) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          vObj = position;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        flat varying vec4 vR1;
        flat varying float vAura;
        varying vec3 vN;
        varying vec3 vV;
        varying vec3 vObj;
        void main() {
          float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);
          float bands = 0.55 + 0.45 * sin(vObj.y * 14.0 - uTime * 5.0 + vObj.x * 3.0);
          vec3 col = normalize(vR1.rgb + 0.001) * (1.6 + vAura * 2.4);
          gl_FragColor = vec4(col * fres * vAura * bands, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.aura = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 3), this.auraMaterial, MAX_FLEET);
    this.aura.name = 'robot.aura';
    this.aura.frustumCulled = false;
    this.aura.count = 0;
    this.group.add(this.aura);
    this.setMapTheme('foundry');
  }

  /** Shared expedition paint, fittings and metal finish for this arena. */
  setMapTheme(mapId: MapId): void {
    this.mapTheme = getMap(mapId);
    const { palette, biome } = this.mapTheme;
    for (const visual of this.visuals.values()) visual.biome = biome;
    this.materials.chrome.color.setHex(biome === 'ancient' ? 0xb38a4b : palette.stone).lerp(_c.setHex(0xe2dfd1), 0.42);
    this.materials.chrome.roughness = biome === 'desert' || biome === 'forest' ? 0.52 : 0.28;
    this.materials.rim.color.setHex(palette.robotPaint).lerp(_c.setHex(0xb4afa1), 0.52);
    this.materials.glass.color.setHex(palette.robotAccent).multiplyScalar(0.18);
    for (const part of this.parts) {
      if (part.def.material !== 'steel' && part.def.material !== 'barrel') continue;
      const material = part.mesh.material as THREE.MeshStandardMaterial;
      material.color.setHex(palette.stone).lerp(_c.setHex(0x383b3c), 0.58);
    }
  }

  private materialFor(key: PartMaterial, perRobot: number): THREE.Material {
    const m = this.materials;
    switch (key) {
      case 'paint':
      case 'canvas':
      case 'steel':
      case 'barrel':
      case 'accent':
      case 'weapon':
      case 'number':
        return m.get(key, perRobot);
      case 'chrome':
        return m.chrome;
      case 'rubber':
        return m.rubber;
      case 'rim':
        return m.rim;
      case 'glass':
        return m.glass;
      case 'lamps':
        return m.lamps;
      case 'emp':
        return m.emp;
      case 'leech':
        return m.leech;
      case 'repair':
        return m.repair;
      case 'nozzle':
        return m.nozzle;
    }
  }

  /** Looks up a part by name (for swapping in authored geometry later). */
  part(name: string): PartDef | undefined {
    return this.partByName.get(name);
  }

  add(id: number, color: number): RobotVisual {
    const existing = this.visuals.get(id);
    if (existing) return existing;
    let slot = this.slots.indexOf(null);
    if (slot < 0) slot = MAX_FLEET - 1;
    const v = new RobotVisual(id, slot, color);
    v.biome = this.mapTheme.biome;
    this.slots[slot] = v;
    this.visuals.set(id, v);
    this.materials.numbers.setNumber(slot, id);
    return v;
  }

  remove(id: number): void {
    const v = this.visuals.get(id);
    if (!v) return;
    this.slots[v.slot] = null;
    this.visuals.delete(id);
  }

  get(id: number): RobotVisual | undefined {
    return this.visuals.get(id);
  }

  setStacks(v: RobotVisual, stacks: PowerUpStacks): void {
    const key = JSON.stringify(stacks);
    if (key === v.stacksKey) return;
    v.stacksKey = key;
    v.stacks = { ...stacks };
  }

  // ------------------------------------------------------------ transforms

  private computeSlot(v: RobotVisual): SlotMatrices {
    const mats = this.matrices[v.slot];
    mats.root.compose(v.position, v.quaternion, _s.set(1, 1, 1));

    // Chassis = root · (pivot · lean · pivot⁻¹) · squash offset
    _m.makeTranslation(LEAN_PIVOT.x, LEAN_PIVOT.y + v.squash, LEAN_PIVOT.z);
    _m2.makeRotationFromQuaternion(v.leanQuat);
    _m.multiply(_m2);
    _m2.makeTranslation(-LEAN_PIVOT.x, -LEAN_PIVOT.y, -LEAN_PIVOT.z);
    mats.chassisLocal.multiplyMatrices(_m, _m2);
    mats.chassis.multiplyMatrices(mats.root, mats.chassisLocal);

    // Turret stays level in world space and points along the aim yaw.
    _v.copy(TURRET_MOUNT).applyMatrix4(mats.chassis);
    _q.setFromAxisAngle(Y_AXIS, v.aimYaw);
    mats.turret.compose(_v, _q, _s.set(1, 1, 1));

    const heavy = v.stacks.heavy_rounds ?? 0;
    const radial = 1 + heavy * 0.15;
    // Barrel hinges at BARREL_MOUNT and pitches about turret-local X (+pitch = muzzle up), as in shared/aim.ts.
    _q.setFromAxisAngle(X_AXIS, -v.barrelPitch);
    _m.compose(_v.set(BARREL_MOUNT.x, BARREL_MOUNT.y, BARREL_MOUNT.z), _q, _s.set(radial, radial, 1 + heavy * 0.03));
    _m2.makeTranslation(0, 0, v.recoil);
    _m.multiply(_m2);
    mats.barrel.multiplyMatrices(mats.turret, _m);

    const grip = v.stacks.grip_tires ?? 0;
    for (let i = 0; i < 4; i++) {
      const a = WHEEL_ANCHORS[i];
      const susp = v.wheelSuspension[i];
      _q.setFromAxisAngle(Y_AXIS, v.wheelSteer[i]);
      _q2.setFromAxisAngle(X_AXIS, v.wheelSpin[i]);
      _q.multiply(_q2);
      _v.set(a.x, a.y - susp, a.z);
      _m.compose(_v, _q, _s.set(1 + grip * 0.12, 1, 1));
      mats.wheels[i].multiplyMatrices(mats.root, _m);

      // Suspension links: chassis-side mount (moves with lean/squash) → wheel hub.
      const mounts = MOUNTS[i];
      this.link(mats.arms[i], mats, mounts.arm, _v);
      _v2.set(a.x * 0.92, a.y - susp + 0.05, a.z - 0.02);
      this.link(mats.shocks[i], mats, mounts.shock, _v2);
    }
    return mats;
  }

  private readonly _from = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();

  private link(out: THREE.Matrix4, mats: SlotMatrices, chassisMount: THREE.Vector3, rootTarget: THREE.Vector3): void {
    this._from.copy(chassisMount).applyMatrix4(mats.chassisLocal);
    this._dir.copy(rootTarget).sub(this._from);
    const len = Math.max(0.01, this._dir.length());
    this._dir.divideScalar(len);
    _q2.setFromUnitVectors(X_AXIS, this._dir);
    _m.compose(this._from, _q2, _s.set(len, 1, 1));
    out.multiplyMatrices(mats.root, _m);
  }

  private slotMatrix(def: PartDef, mats: SlotMatrices, k: number): THREE.Matrix4 {
    switch (def.slot) {
      case 'chassis':
        return mats.chassis;
      case 'turret':
        return mats.turret;
      case 'barrel':
        return mats.barrel;
      case 'wheel':
        return mats.wheels[k];
      case 'arm':
        return mats.arms[k];
      case 'shock':
        return mats.shocks[k];
    }
  }

  // ------------------------------------------------------------ per frame

  /**
   * Advances every visual and uploads instance matrices + robot data.
   * `groundHeight` returns the floor height under a point (for contact shadows).
   */
  update(dt: number, time: number, groundHeight: (x: number, y: number, z: number) => number): void {
    const data = this.materials.data;
    let maxSlot = -1;
    for (let s = 0; s < MAX_FLEET; s++) {
      const v = this.slots[s];
      if (!v) continue;
      maxSlot = s;
      v.update(dt, this.leanStrength);
    }
    const slotCount = maxSlot + 1;
    for (let s = 0; s < slotCount; s++) {
      const v = this.slots[s];
      if (v && v.visible) this.computeSlot(v);
    }

    for (const [partIndex, p] of this.parts.entries()) {
      const inkOffset = this.ink.offsets[partIndex];
      p.mesh.count = slotCount * p.perRobot;
      let any = false;
      for (let s = 0; s < slotCount; s++) {
        const v = this.slots[s];
        const show = !!v && v.visible && addonVisible(p.def.addon, v.stacks) && this.variantVisible(p.def, v);
        if (!show || !v) {
          for (let k = 0; k < p.perRobot; k++) {
            p.mesh.setMatrixAt(s * p.perRobot + k, ZERO);
            this.ink.set(s, inkOffset + k, ZERO);
          }
          continue;
        }
        any = true;
        const mats = this.matrices[s];
        const plates = v.stacks.reinforced_plating ?? 0;
        for (let k = 0; k < p.perRobot; k++) {
          const idx = s * p.perRobot + k;
          if (p.def.addon === 'plates' && k >= plates) {
            p.mesh.setMatrixAt(idx, ZERO);
            this.ink.set(s, inkOffset + k, ZERO);
            continue;
          }
          const base = this.slotMatrix(p.def, mats, k);
          if (p.def.locals) {
            _m.multiplyMatrices(base, p.def.locals[k]);
            p.mesh.setMatrixAt(idx, _m);
            this.ink.set(s, inkOffset + k, _m);
          } else {
            p.mesh.setMatrixAt(idx, base);
            this.ink.set(s, inkOffset + k, base);
          }
        }
      }
      p.mesh.visible = any;
      p.mesh.instanceMatrix.needsUpdate = true;
    }
    this.ink.commit(slotCount);

    // Robot data texture + blobs + aura.
    this.blobs.count = slotCount;
    this.aura.count = slotCount;
    let anyAura = false;
    for (let s = 0; s < slotCount; s++) {
      const v = this.slots[s];
      if (!v) {
        this.blobs.setMatrixAt(s, ZERO);
        this.aura.setMatrixAt(s, ZERO);
        data.set(s, 3, 0, 0, 0, 0);
        continue;
      }
      this.writeData(v, time);
      if (!v.visible) {
        this.blobs.setMatrixAt(s, ZERO);
        this.aura.setMatrixAt(s, ZERO);
        continue;
      }
      const g = groundHeight(v.position.x, v.position.y, v.position.z);
      const height = Math.max(0, v.position.y - g - 0.55);
      const size = 2.9 * Math.max(0.35, 1 - height * 0.25);
      _q.setFromAxisAngle(Y_AXIS, yawOf(v.quaternion));
      _m.compose(_v.set(v.position.x, g + 0.03, v.position.z), _q, _s.set(size * 0.8, 1, size));
      this.blobs.setMatrixAt(s, height > 4 ? ZERO : _m);

      if (v.aura > 0.02) {
        anyAura = true;
        _m2.compose(_v.set(0, 0.1, 0), _q.identity(), _s.set(1.25, 0.85, 1.6));
        _m.multiplyMatrices(this.matrices[s].chassis, _m2);
        this.aura.setMatrixAt(s, _m);
      } else {
        this.aura.setMatrixAt(s, ZERO);
      }
    }
    this.blobs.instanceMatrix.needsUpdate = true;
    this.aura.instanceMatrix.needsUpdate = true;
    this.aura.visible = anyAura;
    this.auraMaterial.uniforms.uTime.value = time;
    data.commit();
  }

  setContactShadows(enabled: boolean): void {
    this.blobs.visible = enabled;
  }

  private variantVisible(def: PartDef, v: RobotVisual): boolean {
    if (v.weaponId === null && (def.slot === 'barrel' || def.weapon)) return false;
    if (def.biome && def.biome !== v.biome) return false;
    if (def.character && def.character !== v.characterId) return false;
    if (def.weapon && def.weapon !== v.weaponId) return false;
    if (!def.variant) return true;
    const twin = (v.stacks.twin_barrel ?? 0) > 0;
    return def.variant === 'twin' ? twin : !twin;
  }

  private writeData(v: RobotVisual, time: number): void {
    const data = this.materials.data;
    const s = v.slot;
    _c.setHex(v.color).lerp(_c2.setHex(this.mapTheme.palette.robotPaint), 0.24);
    data.set(s, 0, _c.r, _c.g, _c.b, v.hitFlash);

    const stunned = (v.flags & RobotFlags.STUNNED) !== 0;
    const boosting = (v.flags & RobotFlags.BOOSTING) !== 0;
    // Accent hue drifts and whitens with level.
    _c2.setHex(this.mapTheme.palette.robotAccent).lerp(_c.setHex(getCharacter(v.characterId).accent), 0.3)
      .offsetHSL((v.level - 1) * 0.006, 0, 0).lerp(WHITE, (v.level - 1) * 0.025);
    let intensity = 0.5 + v.level * 0.1 + (boosting ? 0.7 : 0) + Math.sin(time * 3 + v.id) * 0.05;
    if (v.damageTier === 2) {
      // Failing power: irregular flicker.
      const f = Math.sin(time * 37 + v.flickerPhase) * Math.sin(time * 13.3 + v.flickerPhase * 2);
      if (f > 0.45) intensity *= 0.08;
    }
    if (stunned) {
      _c2.copy(STUN);
      intensity *= Math.sin(time * 60) > 0 ? 1.6 : 0.2;
    }
    data.set(s, 1, _c2.r, _c2.g, _c2.b, intensity);

    const frac = v.maxHp > 0 ? v.hp / v.maxHp : 1;
    const damage = frac < 0.66 ? THREE.MathUtils.clamp((0.66 - frac) / 0.6 + 0.25, 0, 1) : 0;
    const regen = (v.stacks.field_repair ?? 0) > 0 && v.sinceDamaged > 4 && frac < 1 ? 1 : 0;
    data.set(s, 2, damage, v.wearSeed, regen, v.aura);
    data.set(s, 3, v.heat, v.boosterGlow, stunned ? 1 : 0, v.visible ? 1 : 0);
    _c.setHex(v.weaponId === null ? 0 : getWeapon(v.weaponId).color);
    data.set(s, 4, _c.r, _c.g, _c.b, v.weaponId === null ? 0 : 1.1 + v.heat * 0.7);
  }

  // ------------------------------------------------------------ queries for VFX

  /** World-space muzzle tip for a projectile's barrel key (scatter pellets share one muzzle). */
  muzzleWorld(v: RobotVisual, index: number, out: THREE.Vector3): THREE.Vector3 {
    const twin = (v.stacks.twin_barrel ?? 0) > 0;
    if (v.weaponId === null) return out.copy(v.position);
    const barrel = Math.floor(index / getWeapon(v.weaponId).pellets);
    const x = twin ? (barrel === 0 ? -TWIN_BARREL_OFFSET : TWIN_BARREL_OFFSET) : 0;
    return out.set(x, 0, BARREL_TIP_Z).applyMatrix4(this.matrices[v.slot].barrel);
  }

  /** Transforms a chassis-space point to world space using the current visual pose. */
  chassisPoint(v: RobotVisual, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(local).applyMatrix4(this.matrices[v.slot].chassis);
  }

  chassisDirection(v: RobotVisual, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(local).transformDirection(this.matrices[v.slot].chassis);
  }

  /** World position of wheel i's contact patch. */
  wheelContact(v: RobotVisual, i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, -physicsConfig.wheelRadius, 0).applyMatrix4(this.matrices[v.slot].wheels[i]);
  }

  // ------------------------------------------------------------ debris

  /** 6–10 physical chunks using the robot's own worn materials. */
  createDebris(v: RobotVisual): DebrisPiece[] {
    const m = this.materials;
    const H = CHASSIS_HALF;
    const pieces: DebrisPiece[] = [];
    const paintMat = (): THREE.MeshStandardMaterial => m.createDebris('paint', v.slot);
    const steelMat = (): THREE.MeshStandardMaterial => m.createDebris('steel', v.slot);
    const chunk = (geo: THREE.BufferGeometry, mat: THREE.Material, half: Vec3, offset: THREE.Vector3): void => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      pieces.push({ object: mesh, half, offset });
    };
    chunk(new RoundedBoxGeometry(H.x * 1.9, 0.5, H.z * 0.95, 2, 0.08), paintMat(), { x: H.x * 0.95, y: 0.25, z: H.z * 0.47 }, new THREE.Vector3(0, 0, H.z * 0.5));
    chunk(new RoundedBoxGeometry(H.x * 1.9, 0.45, H.z * 0.9, 2, 0.08), paintMat(), { x: H.x * 0.95, y: 0.22, z: H.z * 0.45 }, new THREE.Vector3(0, 0, -H.z * 0.5));
    chunk(new RoundedBoxGeometry(1.4, 0.16, 0.62, 2, 0.05), paintMat(), { x: 0.7, y: 0.08, z: 0.31 }, new THREE.Vector3(0, 0.33, -0.72));
    chunk(new RoundedBoxGeometry(1.84, 0.38, 0.14, 2, 0.04), steelMat(), { x: 0.92, y: 0.19, z: 0.07 }, new THREE.Vector3(0, -0.08, H.z + 0.12));
    const turretPaint = this.partByName.get('turret.paint');
    if (turretPaint) chunk(turretPaint.geometry, paintMat(), { x: 0.48, y: 0.24, z: 0.48 }, new THREE.Vector3(0, TURRET_MOUNT.y, 0));
    const barrel = this.partByName.get('barrel.single.steel');
    if (barrel && v.weaponId !== null) chunk(barrel.geometry, steelMat(), { x: 0.12, y: 0.12, z: 0.65 }, new THREE.Vector3(0, TURRET_MOUNT.y + BARREL_MOUNT.y, 0.4));
    // Loose wheels: tyre only (one draw call each; the rim is hidden inside it at a distance).
    const tire = this.partByName.get('wheel.tire');
    if (tire) {
      for (const a of WHEEL_ANCHORS) {
        const t = new THREE.Mesh(tire.geometry, m.rubber.clone());
        const R = physicsConfig.wheelRadius;
        pieces.push({ object: t, half: { x: 0.17, y: R, z: R }, offset: new THREE.Vector3(a.x, a.y - physicsConfig.suspensionRestLength, a.z) });
      }
    }
    return pieces;
  }
}

function yawOf(q: THREE.Quaternion): number {
  _v2.set(0, 0, 1).applyQuaternion(q);
  return Math.atan2(_v2.x, _v2.z);
}

function makeBlobTexture(): THREE.Texture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // Multiply blending: white = no change, darker = shadow.
  g.addColorStop(0, 'rgb(70,72,78)');
  g.addColorStop(0.45, 'rgb(130,132,138)');
  g.addColorStop(1, 'rgb(255,255,255)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
