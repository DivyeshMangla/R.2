import * as THREE from 'three';
import { ARENA_BLOCKS, ARENA_HALF_SIZE, BARRIER_HEIGHT, PLATFORM_HALF, PLATFORM_HEIGHT, type ArenaBlock, type ArenaBlockKind } from '@robot-arena/shared';
import { mergeStaticChildren } from './mergeStatic';
import { concreteTextures, floorTextures, hazardTextures, metalPanelTextures, treadPlateTextures, type SurfaceTextures } from './ProceduralTextures';

/** Rewrites box UVs in world units so textures tile uniformly regardless of block size. */
function applyWorldUVs(geo: THREE.BufferGeometry, tile: number): void {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i));
    let u: number, v: number;
    if (ny > 0.5) {
      u = x;
      v = z;
    } else if (nx > 0.5) {
      u = z;
      v = y;
    } else {
      u = x;
      v = y;
    }
    uv.setXY(i, u / tile, v / tile);
  }
  uv.needsUpdate = true;
}

function material(tex: SurfaceTextures, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: tex.map,
    roughnessMap: tex.roughnessMap,
    normalMap: tex.normalMap ?? null,
    emissiveMap: tex.emissiveMap ?? null,
    ...params,
  });
}

export interface ArenaVisuals {
  group: THREE.Group;
  update(time: number): void;
}

/** Builds the arena meshes from the shared block layout. */
export function buildArena(anisotropy: number): ArenaVisuals {
  const group = new THREE.Group();
  group.name = 'Arena';

  const floorTex = floorTextures(anisotropy);
  const metalTex = metalPanelTextures(anisotropy, [70, 76, 86]);
  const pillarTex = metalPanelTextures(anisotropy, [52, 56, 66]);
  const hazardTex = hazardTextures(anisotropy);
  const treadTex = treadPlateTextures(anisotropy);
  const concreteTex = concreteTextures(anisotropy);

  const mats: Record<ArenaBlockKind, THREE.MeshStandardMaterial> = {
    floor: material(floorTex, { roughness: 0.85, metalness: 0.35, emissive: new THREE.Color(0x2bd6ff), emissiveIntensity: 0.9, normalScale: new THREE.Vector2(0.6, 0.6) }),
    barrier: material(hazardTex, { roughness: 0.7, metalness: 0.25 }),
    platform: material(metalTex, { roughness: 0.55, metalness: 0.75, envMapIntensity: 1.1 }),
    ramp: material(treadTex, { roughness: 0.5, metalness: 0.85, envMapIntensity: 1.2 }),
    jump: material(treadTex, { roughness: 0.45, metalness: 0.8, color: new THREE.Color(0xffd7a0) }),
    cover: material(concreteTex, { roughness: 0.95, metalness: 0.05, emissive: new THREE.Color(0xffffff), emissiveIntensity: 2.2 }),
    pillar: material(pillarTex, { roughness: 0.4, metalness: 0.9 }),
  };
  const tileSize: Record<ArenaBlockKind, number> = { floor: 8, barrier: 2.4, platform: 3.5, ramp: 2, jump: 2, cover: 1.2, pillar: 2.4 };

  for (const b of ARENA_BLOCKS) {
    const geo = new THREE.BoxGeometry(b.half.x * 2, b.half.y * 2, b.half.z * 2);
    applyWorldUVs(geo, tileSize[b.kind]);
    const mesh = new THREE.Mesh(geo, mats[b.kind]);
    mesh.position.set(b.center.x, b.center.y, b.center.z);
    mesh.quaternion.set(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w);
    mesh.receiveShadow = true;
    mesh.castShadow = b.kind !== 'floor';
    mesh.name = `arena-${b.kind}`;
    group.add(mesh);
  }

  const trimMats: THREE.MeshStandardMaterial[] = [];
  const trim = (color: number, intensity: number): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity, roughness: 0.3 });
    trimMats.push(m);
    return m;
  };

  // Emissive trims along the barrier tops.
  const barrierTrim = trim(0xffb020, 3.0);
  for (const b of ARENA_BLOCKS.filter((x) => x.kind === 'barrier')) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(b.half.x * 2 + 0.02, 0.08, b.half.z * 2 + 0.02), barrierTrim);
    strip.position.set(b.center.x, BARRIER_HEIGHT + 0.04, b.center.z);
    group.add(strip);
  }

  // Platform edge lights.
  const platformTrim = trim(0x19d3ff, 4.0);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(PLATFORM_HALF * 2, 0.06, 0.08), platformTrim);
    strip.position.set(Math.sin(a) * (PLATFORM_HALF + 0.01), PLATFORM_HEIGHT - 0.12, Math.cos(a) * (PLATFORM_HALF + 0.01));
    strip.rotation.y = a;
    group.add(strip);
  }
  // Center emblem ring on the platform.
  const emblem = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.45, 96), trim(0x19d3ff, 2.5));
  emblem.rotation.x = -Math.PI / 2;
  emblem.position.y = PLATFORM_HEIGHT + 0.012;
  group.add(emblem);
  const emblemInner = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.3, 64), trim(0xff3b6b, 3));
  emblemInner.rotation.x = -Math.PI / 2;
  emblemInner.position.y = PLATFORM_HEIGHT + 0.012;
  group.add(emblemInner);

  // Ramp side rails.
  const railTrim = trim(0x7dff4a, 2.6);
  for (const b of ARENA_BLOCKS.filter((x) => x.kind === 'ramp' || x.kind === 'jump')) addRampRails(group, b, railTrim);

  // Pillar light strips.
  const pillarTrim = trim(0xb66bff, 4);
  for (const b of ARENA_BLOCKS.filter((x) => x.kind === 'pillar')) {
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.08, b.half.y * 1.6, 0.08), pillarTrim);
      strip.position.set(b.center.x + Math.sin(a) * b.half.x * 1.41, b.center.y, b.center.z + Math.cos(a) * b.half.z * 1.41);
      group.add(strip);
    }
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 0.3, 24), pillarTrim);
    cap.position.set(b.center.x, b.center.y + b.half.y + 0.15, b.center.z);
    group.add(cap);
  }

  // Outer scenery: tiered stands outside the barriers to frame the arena.
  const standMat = new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.8, metalness: 0.4 });
  const standGlow = trim(0x19d3ff, 1.6);
  for (let side = 0; side < 4; side++) {
    const a = (side * Math.PI) / 2;
    for (let tier = 0; tier < 3; tier++) {
      const depth = 4;
      const dist = ARENA_HALF_SIZE + 3 + tier * depth;
      const h = 2.5 + tier * 2.2;
      const len = (ARENA_HALF_SIZE + 3 + tier * depth) * 2;
      const stand = new THREE.Mesh(new THREE.BoxGeometry(len, h, depth), standMat);
      stand.position.set(Math.sin(a) * dist, h / 2, Math.cos(a) * dist);
      stand.rotation.y = a;
      stand.receiveShadow = true;
      group.add(stand);
      const glow = new THREE.Mesh(new THREE.BoxGeometry(len, 0.06, 0.06), standGlow);
      glow.position.set(Math.sin(a) * (dist - depth / 2), h + 0.03, Math.cos(a) * (dist - depth / 2));
      glow.rotation.y = a;
      group.add(glow);
    }
  }

  // Floodlight towers in the corners.
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.5, metalness: 0.9 });
  const lampMat = trim(0xfff2d0, 8);
  for (const [x, z] of [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ] as const) {
    const d = ARENA_HALF_SIZE + 9;
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 24, 12), towerMat);
    tower.position.set(x * d, 12, z * d);
    group.add(tower);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(4, 1.4, 0.6), lampMat);
    lamp.position.set(x * d, 24.5, z * d);
    lamp.lookAt(0, 0, 0);
    group.add(lamp);
  }

  // Collapse the static arena into one mesh per material (keeps draw calls low).
  mergeStaticChildren(group);

  const pulseMats = [platformTrim, railTrim];
  return {
    group,
    update(time: number) {
      const pulse = 0.8 + Math.sin(time * 2.2) * 0.2;
      pulseMats[0].emissiveIntensity = 3.2 + pulse * 1.2;
      pulseMats[1].emissiveIntensity = 2.0 + Math.sin(time * 3.1) * 0.6;
      mats.floor.emissiveIntensity = 0.7 + Math.sin(time * 0.9) * 0.15;
    },
  };
}

function addRampRails(group: THREE.Group, b: ArenaBlock, mat: THREE.Material): void {
  const q = new THREE.Quaternion(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w);
  const center = new THREE.Vector3(b.center.x, b.center.y, b.center.z);
  for (const side of [-1, 1]) {
    const local = new THREE.Vector3(side * (b.half.x - 0.05), b.half.y + 0.03, 0);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, b.half.z * 2 - 0.2), mat);
    rail.position.copy(local.applyQuaternion(q).add(center));
    rail.quaternion.copy(q);
    group.add(rail);
  }
}
