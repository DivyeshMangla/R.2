import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BARREL_LENGTH, CHASSIS_HALF, TURRET_HEIGHT, TWIN_BARREL_OFFSET, WHEEL_ANCHORS, physicsConfig, type PowerUpStacks, type Vec3 } from '@robot-arena/shared';
import { mergeStaticChildren } from './mergeStatic';
import { tireTextures } from './ProceduralTextures';

/**
 * Each slot is an independent Object3D so it can later be replaced by a GLTF
 * part (e.g. `model.slots.turretHead.clear(); model.slots.turretHead.add(gltf)`)
 * without touching gameplay or animation code.
 */
export interface RobotSlots {
  chassis: THREE.Group;
  turret: THREE.Group;
  turretHead: THREE.Group;
  barrels: THREE.Group[];
  wheels: WheelRig[];
  armorPlates: THREE.Object3D[];
  boosters: THREE.Group;
  empCoil: THREE.Group;
  mineRack: THREE.Group;
  repairBeacon: THREE.Object3D;
  leechCore: THREE.Object3D;
  exhaust: THREE.Group;
  shield: THREE.Mesh;
}

export interface WheelRig {
  /** Positioned at the wheel hub; rotates around Y for steering. */
  pivot: THREE.Group;
  /** Child of pivot; rotates around X for rolling. */
  spin: THREE.Group;
  anchor: Vec3;
  side: 1 | -1;
}

export interface RobotModel {
  root: THREE.Group;
  slots: RobotSlots;
  paint: THREE.MeshPhysicalMaterial;
  accent: THREE.MeshStandardMaterial;
  accentBase: THREE.Color;
  /** Muzzle tip positions in turret space, one per barrel. */
  muzzleLocal: THREE.Vector3[];
  /** World-space offsets of booster nozzles in chassis space (for exhaust particles). */
  nozzleLocal: THREE.Vector3[];
  dispose(): void;
}

export interface DebrisPiece {
  object: THREE.Object3D;
  /** Collision half extents of the chunk. */
  half: Vec3;
  /** Chunk center in chassis space. */
  offset: THREE.Vector3;
}

interface SharedAssets {
  tire: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
  darkSteel: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  headlight: THREE.MeshStandardMaterial;
  taillight: THREE.MeshStandardMaterial;
  repair: THREE.MeshStandardMaterial;
  leech: THREE.MeshStandardMaterial;
  emp: THREE.MeshStandardMaterial;
  nozzle: THREE.MeshStandardMaterial;
  shield: THREE.MeshBasicMaterial;
  geo: {
    chassis: THREE.BufferGeometry;
    deck: THREE.BufferGeometry;
    tire: THREE.BufferGeometry;
    rim: THREE.BufferGeometry;
    hub: THREE.BufferGeometry;
    turretBase: THREE.BufferGeometry;
    turretHead: THREE.BufferGeometry;
    barrel: THREE.BufferGeometry;
    muzzle: THREE.BufferGeometry;
    plate: THREE.BufferGeometry;
    strip: THREE.BufferGeometry;
    stripFront: THREE.BufferGeometry;
    shield: THREE.BufferGeometry;
  };
}

let shared: SharedAssets | null = null;

function assets(): SharedAssets {
  if (shared) return shared;
  const tireTex = tireTextures(8);
  tireTex.map.repeat.set(2, 1);
  const r = physicsConfig.wheelRadius;
  shared = {
    tire: new THREE.MeshStandardMaterial({ color: 0x2a2a2c, map: tireTex.map, roughnessMap: tireTex.roughnessMap, roughness: 0.92, metalness: 0.0 }),
    rim: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.28, metalness: 1.0 }),
    darkSteel: new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.45, metalness: 0.85 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.12, metalness: 1.0 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0a1018, roughness: 0.05, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03 }),
    headlight: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xeaf6ff, emissiveIntensity: 6 }),
    taillight: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff2a2a, emissiveIntensity: 4 }),
    repair: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x4dff88, emissiveIntensity: 5 }),
    leech: new THREE.MeshStandardMaterial({ color: 0x200006, emissive: 0xff1844, emissiveIntensity: 5, roughness: 0.2 }),
    emp: new THREE.MeshStandardMaterial({ color: 0x0b1530, emissive: 0x4aa8ff, emissiveIntensity: 5, roughness: 0.3, metalness: 0.6 }),
    nozzle: new THREE.MeshStandardMaterial({ color: 0x110500, emissive: 0xff7a1a, emissiveIntensity: 3, roughness: 0.4 }),
    shield: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.7, 1.4), transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    geo: {
      chassis: new RoundedBoxGeometry(CHASSIS_HALF.x * 2, CHASSIS_HALF.y * 2 + 0.05, CHASSIS_HALF.z * 2, 3, 0.12),
      deck: new RoundedBoxGeometry(CHASSIS_HALF.x * 1.55, 0.1, CHASSIS_HALF.z * 1.35, 2, 0.04),
      tire: new THREE.CylinderGeometry(r, r, 0.36, 28, 1).rotateZ(Math.PI / 2),
      rim: new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.38, 20).rotateZ(Math.PI / 2),
      hub: new THREE.CylinderGeometry(r * 0.22, r * 0.22, 0.42, 6).rotateZ(Math.PI / 2),
      turretBase: new THREE.CylinderGeometry(0.5, 0.58, 0.2, 28),
      turretHead: new RoundedBoxGeometry(0.86, 0.38, 0.95, 3, 0.1),
      barrel: new THREE.CylinderGeometry(0.085, 0.1, BARREL_LENGTH - 0.25, 16).rotateX(Math.PI / 2),
      muzzle: new THREE.CylinderGeometry(0.13, 0.13, 0.2, 12).rotateX(Math.PI / 2),
      plate: new RoundedBoxGeometry(0.08, 0.42, 0.7, 2, 0.02),
      strip: new THREE.BoxGeometry(0.04, 0.05, CHASSIS_HALF.z * 1.7),
      stripFront: new THREE.BoxGeometry(CHASSIS_HALF.x * 1.5, 0.05, 0.04),
      shield: new THREE.IcosahedronGeometry(1.9, 3),
    },
  };
  for (const g of Object.values(shared.geo)) g.userData.shared = true;
  return shared;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, castShadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  return m;
}

export class RobotModelFactory {
  create(color: number): RobotModel {
    const a = assets();
    const team = new THREE.Color(color);
    const paint = new THREE.MeshPhysicalMaterial({
      color: team.clone().lerp(new THREE.Color(0x30343c), 0.45),
      roughness: 0.32,
      metalness: 0.55,
      clearcoat: 0.8,
      clearcoatRoughness: 0.18,
    });
    const accent = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: team.clone(), emissiveIntensity: 3, roughness: 0.4 });

    const root = new THREE.Group();
    root.name = 'Robot';
    const chassis = new THREE.Group();
    chassis.name = 'slot:chassis';
    root.add(chassis);

    // Body shell.
    const body = mesh(a.geo.chassis, paint);
    body.position.y = 0.02;
    chassis.add(body);
    const deck = mesh(a.geo.deck, a.darkSteel);
    deck.position.set(0, CHASSIS_HALF.y + 0.08, -0.05);
    chassis.add(deck);

    // Wedge ram plow.
    const plow = mesh(new THREE.BoxGeometry(CHASSIS_HALF.x * 2.1, 0.36, 0.14), a.darkSteel);
    plow.position.set(0, -0.08, CHASSIS_HALF.z + 0.1);
    plow.rotation.x = -0.55;
    chassis.add(plow);
    const plowEdge = mesh(new THREE.BoxGeometry(CHASSIS_HALF.x * 2.12, 0.04, 0.05), a.chrome);
    plowEdge.position.set(0, -0.23, CHASSIS_HALF.z + 0.2);
    chassis.add(plowEdge);

    // Side skirts.
    for (const s of [-1, 1]) {
      const skirt = mesh(new RoundedBoxGeometry(0.12, 0.26, CHASSIS_HALF.z * 1.2, 2, 0.03), a.darkSteel);
      skirt.position.set(s * (CHASSIS_HALF.x + 0.02), -0.12, 0);
      chassis.add(skirt);
      const strip = mesh(a.geo.strip, accent, false);
      strip.position.set(s * (CHASSIS_HALF.x + 0.01), 0.12, 0);
      chassis.add(strip);
    }
    const frontStrip = mesh(a.geo.stripFront, accent, false);
    frontStrip.position.set(0, 0.2, CHASSIS_HALF.z + 0.005);
    chassis.add(frontStrip);
    const rearStrip = mesh(a.geo.stripFront, accent, false);
    rearStrip.position.set(0, 0.2, -CHASSIS_HALF.z - 0.005);
    chassis.add(rearStrip);

    // Lights.
    for (const s of [-1, 1]) {
      const head = mesh(new THREE.BoxGeometry(0.26, 0.08, 0.03), a.headlight, false);
      head.position.set(s * 0.5, 0.06, CHASSIS_HALF.z + 0.01);
      chassis.add(head);
      const tail = mesh(new THREE.BoxGeometry(0.22, 0.08, 0.03), a.taillight, false);
      tail.position.set(s * 0.55, 0.06, -CHASSIS_HALF.z - 0.01);
      chassis.add(tail);
    }

    // Cockpit glass + vents.
    const canopy = mesh(new RoundedBoxGeometry(0.62, 0.16, 0.42, 2, 0.06), a.glass);
    canopy.position.set(0, CHASSIS_HALF.y + 0.13, 0.62);
    chassis.add(canopy);
    for (let i = 0; i < 4; i++) {
      const vent = mesh(new THREE.BoxGeometry(0.5, 0.03, 0.05), a.darkSteel, false);
      vent.position.set(0, CHASSIS_HALF.y + 0.15, -0.55 - i * 0.1);
      chassis.add(vent);
    }

    // Antenna.
    const antenna = mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.7, 6), a.chrome, false);
    antenna.position.set(-0.6, CHASSIS_HALF.y + 0.45, -0.9);
    chassis.add(antenna);
    const antennaTip = mesh(new THREE.SphereGeometry(0.04, 8, 8), accent, false);
    antennaTip.position.set(-0.6, CHASSIS_HALF.y + 0.82, -0.9);
    chassis.add(antennaTip);

    // Wheels.
    const wheels: WheelRig[] = WHEEL_ANCHORS.map((anchor) => {
      const pivot = new THREE.Group();
      const spin = new THREE.Group();
      pivot.add(spin);
      const side: 1 | -1 = anchor.x > 0 ? 1 : -1;
      spin.add(mesh(a.geo.tire, a.tire));
      const rim = mesh(a.geo.rim, a.rim);
      spin.add(rim);
      const hub = mesh(a.geo.hub, a.darkSteel, false);
      spin.add(hub);
      for (let i = 0; i < 5; i++) {
        const bolt = mesh(new THREE.BoxGeometry(0.03, 0.05, 0.05), accent, false);
        const ang = (i / 5) * Math.PI * 2;
        bolt.position.set(side * 0.2, Math.sin(ang) * 0.14, Math.cos(ang) * 0.14);
        spin.add(bolt);
      }
      pivot.position.set(anchor.x, anchor.y - physicsConfig.suspensionRestLength, anchor.z);
      chassis.add(pivot);
      // Suspension arm (static, visual only).
      const arm = mesh(new THREE.BoxGeometry(0.22, 0.06, 0.12), a.darkSteel, false);
      arm.position.set(anchor.x * 0.88, anchor.y - 0.05, anchor.z);
      chassis.add(arm);
      return { pivot, spin, anchor, side };
    });

    // Turret.
    const turret = new THREE.Group();
    turret.name = 'slot:turret';
    turret.position.y = TURRET_HEIGHT - 0.12;
    chassis.add(turret);
    const tBase = mesh(a.geo.turretBase, a.darkSteel);
    turret.add(tBase);
    const turretHead = new THREE.Group();
    turretHead.name = 'slot:turretHead';
    turretHead.position.y = 0.26;
    turret.add(turretHead);
    const head = mesh(a.geo.turretHead, paint);
    turretHead.add(head);
    const visor = mesh(new THREE.BoxGeometry(0.5, 0.07, 0.03), accent, false);
    visor.position.set(0, 0.06, 0.48);
    turretHead.add(visor);
    const ring = mesh(new THREE.TorusGeometry(0.52, 0.025, 8, 40), accent, false);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.11;
    turret.add(ring);

    const makeBarrel = (x: number): THREE.Group => {
      const g = new THREE.Group();
      g.position.set(x, 0.0, 0.25);
      const b = mesh(a.geo.barrel, a.darkSteel);
      b.position.z = (BARREL_LENGTH - 0.25) / 2;
      g.add(b);
      const m = mesh(a.geo.muzzle, a.chrome);
      m.position.z = BARREL_LENGTH - 0.2;
      g.add(m);
      const band = mesh(new THREE.TorusGeometry(0.1, 0.015, 6, 20), accent, false);
      band.position.z = BARREL_LENGTH - 0.42;
      g.add(band);
      turretHead.add(g);
      return g;
    };
    const barrelSingle = makeBarrel(0);
    const barrelL = makeBarrel(-TWIN_BARREL_OFFSET);
    const barrelR = makeBarrel(TWIN_BARREL_OFFSET);
    barrelL.visible = barrelR.visible = false;

    // Add-on: armor plates (Reinforced Plating stacks).
    const armorPlates: THREE.Object3D[] = [];
    const platePositions: [number, number, number, number][] = [
      [CHASSIS_HALF.x + 0.12, 0.0, 0.35, 0],
      [-CHASSIS_HALF.x - 0.12, 0.0, 0.35, 0],
      [CHASSIS_HALF.x + 0.12, 0.0, -0.45, 0],
      [-CHASSIS_HALF.x - 0.12, 0.0, -0.45, 0],
      [0, 0.12, CHASSIS_HALF.z + 0.02, Math.PI / 2],
    ];
    for (const [x, y, z, ry] of platePositions) {
      const plate = new THREE.Group();
      const p = mesh(a.geo.plate, paint);
      plate.add(p);
      for (const by of [-0.15, 0.15]) {
        const bolt = mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.1, 6).rotateZ(Math.PI / 2), a.chrome, false);
        bolt.position.set(0, by, 0.25);
        plate.add(bolt);
      }
      plate.position.set(x, y, z);
      plate.rotation.y = ry;
      if (ry !== 0) plate.scale.set(1, 0.7, 2.1);
      plate.visible = false;
      chassis.add(plate);
      armorPlates.push(plate);
    }

    // Add-on: rocket boosters (Rocket Dash).
    const boosters = new THREE.Group();
    const nozzleLocal: THREE.Vector3[] = [];
    for (const s of [-1, 1]) {
      const tube = mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.75, 16).rotateX(Math.PI / 2), a.darkSteel);
      tube.position.set(s * 0.42, CHASSIS_HALF.y + 0.18, -CHASSIS_HALF.z + 0.05);
      boosters.add(tube);
      const nozzle = mesh(new THREE.CylinderGeometry(0.15, 0.1, 0.12, 16).rotateX(Math.PI / 2), a.nozzle, false);
      nozzle.position.set(s * 0.42, CHASSIS_HALF.y + 0.18, -CHASSIS_HALF.z - 0.36);
      boosters.add(nozzle);
      nozzleLocal.push(new THREE.Vector3(s * 0.42, CHASSIS_HALF.y + 0.18, -CHASSIS_HALF.z - 0.45));
    }
    boosters.visible = false;
    chassis.add(boosters);

    // Exhaust pipes used for the normal boost flame.
    const exhaust = new THREE.Group();
    for (const s of [-1, 1]) {
      const pipe = mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.25, 10).rotateX(Math.PI / 2), a.chrome, false);
      pipe.position.set(s * 0.25, -0.05, -CHASSIS_HALF.z - 0.08);
      exhaust.add(pipe);
    }
    chassis.add(exhaust);

    // Add-on: EMP coil on the turret.
    const empCoil = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const coil = mesh(new THREE.TorusGeometry(0.22 - i * 0.04, 0.03, 8, 24), a.emp, false);
      coil.rotation.x = Math.PI / 2;
      coil.position.y = 0.26 + i * 0.07;
      empCoil.add(coil);
    }
    const spike = mesh(new THREE.ConeGeometry(0.05, 0.3, 8), a.emp, false);
    spike.position.y = 0.55;
    empCoil.add(spike);
    empCoil.position.set(-0.18, 0.2, -0.2);
    empCoil.visible = false;
    turretHead.add(empCoil);

    // Add-on: mine rack (Magnet Mines).
    const mineRack = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const disc = mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 16), a.darkSteel, false);
      disc.rotation.x = Math.PI / 2;
      disc.position.set((i - 1) * 0.36, CHASSIS_HALF.y + 0.08, -CHASSIS_HALF.z + 0.25);
      mineRack.add(disc);
      const light = mesh(new THREE.SphereGeometry(0.035, 8, 8), a.taillight, false);
      light.position.set((i - 1) * 0.36, CHASSIS_HALF.y + 0.08, -CHASSIS_HALF.z + 0.2);
      mineRack.add(light);
    }
    mineRack.visible = false;
    chassis.add(mineRack);

    // Add-on: repair beacon (Field Repair) and leech core.
    const repairBeacon = new THREE.Group();
    const crossA = mesh(new THREE.BoxGeometry(0.2, 0.05, 0.06), a.repair, false);
    const crossB = mesh(new THREE.BoxGeometry(0.06, 0.05, 0.2), a.repair, false);
    repairBeacon.add(crossA, crossB);
    repairBeacon.position.set(0.5, CHASSIS_HALF.y + 0.16, -0.8);
    repairBeacon.visible = false;
    chassis.add(repairBeacon);

    const leechCore = mesh(new THREE.IcosahedronGeometry(0.12, 1), a.leech, false);
    leechCore.position.set(0, 0.3, -0.3);
    leechCore.visible = false;
    turretHead.add(leechCore);

    const shield = new THREE.Mesh(a.geo.shield, a.shield);
    shield.scale.set(1.0, 0.65, 1.25);
    shield.visible = false;
    root.add(shield);

    for (const container of [chassis, turretHead, turret, boosters, exhaust, empCoil, mineRack, repairBeacon, ...wheels.map((w) => w.spin), ...armorPlates, barrelSingle, barrelL, barrelR]) {
      mergeStaticChildren(container);
    }

    return {
      root,
      paint,
      accent,
      accentBase: team,
      muzzleLocal: [new THREE.Vector3(0, 0.26, 0.25 + BARREL_LENGTH)],
      nozzleLocal,
      slots: {
        chassis,
        turret,
        turretHead,
        barrels: [barrelSingle, barrelL, barrelR],
        wheels,
        armorPlates,
        boosters,
        empCoil,
        mineRack,
        repairBeacon,
        leechCore,
        exhaust,
        shield,
      },
      dispose: () => {
        paint.dispose();
        accent.dispose();
        root.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            if (!o.geometry.userData.shared) o.geometry.dispose();
          }
        });
      },
    };
  }

  /** Applies visible add-ons for the current power-up stacks. */
  applyPowerUps(model: RobotModel, stacks: PowerUpStacks): void {
    const s = model.slots;
    const plates = stacks.reinforced_plating ?? 0;
    s.armorPlates.forEach((p, i) => (p.visible = i < plates));
    const twin = (stacks.twin_barrel ?? 0) > 0;
    s.barrels[0].visible = !twin;
    s.barrels[1].visible = twin;
    s.barrels[2].visible = twin;
    const heavy = stacks.heavy_rounds ?? 0;
    for (const b of s.barrels) b.scale.set(1 + heavy * 0.18, 1 + heavy * 0.18, 1 + heavy * 0.04);
    s.boosters.visible = (stacks.rocket_dash ?? 0) > 0;
    s.empCoil.visible = (stacks.emp_burst ?? 0) > 0;
    s.mineRack.visible = (stacks.magnet_mines ?? 0) > 0;
    s.repairBeacon.visible = (stacks.field_repair ?? 0) > 0;
    s.leechCore.visible = (stacks.leech_core ?? 0) > 0;
    const grip = stacks.grip_tires ?? 0;
    for (const w of s.wheels) w.spin.scale.set(1 + grip * 0.15, 1, 1);
  }

  /** Splits a robot into 6–10 physical chunks for the death explosion. */
  createDebris(model: RobotModel): DebrisPiece[] {
    const a = assets();
    const paint = model.paint.clone();
    const dark = a.darkSteel.clone();
    const tire = a.tire.clone();
    const accent = model.accent.clone();
    const pieces: DebrisPiece[] = [];
    const H = CHASSIS_HALF;

    const plate = (w: number, h: number, d: number, mat: THREE.Material, offset: THREE.Vector3): void => {
      const m = mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.2), mat);
      pieces.push({ object: m, half: { x: w / 2, y: h / 2, z: d / 2 }, offset });
    };
    // Chassis split into front/rear halves + deck.
    plate(H.x * 2, H.y * 2, H.z, paint, new THREE.Vector3(0, 0, H.z / 2));
    plate(H.x * 2, H.y * 2, H.z, paint, new THREE.Vector3(0, 0, -H.z / 2));
    plate(H.x * 1.5, 0.1, H.z * 1.3, dark, new THREE.Vector3(0, H.y + 0.1, 0));
    // Wheels.
    for (const anchor of WHEEL_ANCHORS) {
      const g = new THREE.Group();
      g.add(mesh(a.geo.tire, tire));
      g.add(mesh(a.geo.rim, a.rim));
      const r = physicsConfig.wheelRadius;
      pieces.push({ object: g, half: { x: 0.18, y: r, z: r }, offset: new THREE.Vector3(anchor.x, anchor.y - physicsConfig.suspensionRestLength, anchor.z) });
    }
    // Turret head + barrel.
    const t = new THREE.Group();
    t.add(mesh(a.geo.turretHead, paint));
    pieces.push({ object: t, half: { x: 0.43, y: 0.19, z: 0.47 }, offset: new THREE.Vector3(0, TURRET_HEIGHT + 0.15, 0) });
    const barrel = mesh(a.geo.barrel, dark);
    pieces.push({ object: barrel, half: { x: 0.1, y: 0.1, z: (BARREL_LENGTH - 0.25) / 2 }, offset: new THREE.Vector3(0, TURRET_HEIGHT + 0.15, 0.9) });
    // Glowing strip shard.
    const shard = mesh(new THREE.BoxGeometry(0.08, 0.08, 1.2), accent, false);
    pieces.push({ object: shard, half: { x: 0.04, y: 0.04, z: 0.6 }, offset: new THREE.Vector3(H.x, 0.12, 0) });
    return pieces;
  }
}
