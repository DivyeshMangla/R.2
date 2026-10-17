import * as THREE from 'three';
import { NUMBER_ATLAS_CELLS, type NumberAtlas, type RobotSurfaceMaps } from './RobotTextures';

export const MAX_FLEET = 8;

/**
 * Per-robot shader inputs, one column per fleet slot:
 *  row 0: paint rgb (linear), hit flash
 *  row 1: accent rgb (linear), accent intensity
 *  row 2: damage 0..1 (scorch), wear seed, regen glow, aura strength
 *  row 3: barrel heat 0..1, booster glow, stun, alive
 *  row 4: weapon rgb (linear), weapon glow intensity
 */
export class RobotDataTexture {
  readonly texture: THREE.DataTexture;
  private readonly data: Float32Array;

  constructor() {
    this.data = new Float32Array(MAX_FLEET * 5 * 4);
    this.texture = new THREE.DataTexture(this.data, MAX_FLEET, 5, THREE.RGBAFormat, THREE.FloatType);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  set(slot: number, row: number, x: number, y: number, z: number, w: number): void {
    const i = (row * MAX_FLEET + slot) * 4;
    const d = this.data;
    d[i] = x;
    d[i + 1] = y;
    d[i + 2] = z;
    d[i + 3] = w;
  }

  commit(): void {
    this.texture.needsUpdate = true;
  }
}

export type RobotMaterialKind = 'paint' | 'canvas' | 'steel' | 'barrel' | 'accent' | 'weapon' | 'number';

interface PatchOptions {
  kind: RobotMaterialKind;
  instancesPerRobot: number;
  /** Fixed fleet slot for non-instanced meshes (debris); -1 means "derive from gl_InstanceID". */
  robotIndex: number;
}

const NOISE_GLSL = /* glsl */ `
  float ra_hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float ra_noise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(ra_hash(i), ra_hash(i + vec3(1,0,0)), f.x), mix(ra_hash(i + vec3(0,1,0)), ra_hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(ra_hash(i + vec3(0,0,1)), ra_hash(i + vec3(1,0,1)), f.x), mix(ra_hash(i + vec3(0,1,1)), ra_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
`;

/**
 * Injects the robot-data fetch + worn-paint / scorch / heat / accent logic into a
 * standard material. Edge wear uses a screen-space curvature estimate
 * (|d normal| / |d position|), so bevels and rims wear through to bare metal
 * without any baked curvature map.
 */
function patch(material: THREE.MeshStandardMaterial, data: RobotDataTexture, opts: PatchOptions): void {
  const uniforms = {
    uRobotData: { value: data.texture },
    uInstPerRobot: { value: opts.instancesPerRobot },
    uRobotIndex: { value: opts.robotIndex },
    uWornColor: { value: new THREE.Color(0.62, 0.6, 0.57) },
    uWearAmount: { value: opts.kind === 'canvas' ? 0.12 : 1.0 },
    uWearScale: { value: 1.2 },
  };
  material.userData.robotUniforms = uniforms;
  const defines: Record<string, string> = { ROBOT_DATA: '' };
  if (opts.kind === 'paint' || opts.kind === 'canvas') defines.ROBOT_PAINT = '';
  if (opts.kind === 'paint' || opts.kind === 'canvas' || opts.kind === 'steel' || opts.kind === 'barrel') defines.ROBOT_SCORCH = '';
  if (opts.kind === 'barrel') defines.ROBOT_HEAT = '';
  if (opts.kind === 'accent') defines.ROBOT_ACCENT = '';
  if (opts.kind === 'weapon') defines.ROBOT_WEAPON = '';
  if (opts.kind === 'number') defines.ROBOT_NUMBER = '';
  material.defines = { ...(material.defines ?? {}), ...defines };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform sampler2D uRobotData;
        uniform float uInstPerRobot;
        uniform float uRobotIndex;
        flat varying vec4 vR0;
        flat varying vec4 vR1;
        flat varying vec4 vR2;
        flat varying vec4 vR3;
        flat varying vec4 vR4;
        varying vec3 vObjPos;`,
      )
      .replace(
        '#include <uv_vertex>',
        /* glsl */ `
        float robotIdx = uRobotIndex >= 0.0 ? uRobotIndex : floor(float(gl_InstanceID) / uInstPerRobot);
        ivec2 rc = ivec2(int(robotIdx), 0);
        vR0 = texelFetch(uRobotData, rc, 0);
        vR1 = texelFetch(uRobotData, ivec2(rc.x, 1), 0);
        vR2 = texelFetch(uRobotData, ivec2(rc.x, 2), 0);
        vR3 = texelFetch(uRobotData, ivec2(rc.x, 3), 0);
        vR4 = texelFetch(uRobotData, ivec2(rc.x, 4), 0);
        vObjPos = position;
        #include <uv_vertex>
        #ifdef ROBOT_NUMBER
          vMapUv.x = (vMapUv.x + robotIdx) / ${NUMBER_ATLAS_CELLS.toFixed(1)};
        #endif`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        flat varying vec4 vR0;
        flat varying vec4 vR1;
        flat varying vec4 vR2;
        flat varying vec4 vR3;
        flat varying vec4 vR4;
        varying vec3 vObjPos;
        uniform vec3 uWornColor;
        uniform float uWearAmount;
        uniform float uWearScale;
        ${NOISE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        float wear = 0.0;
        float scorch = 0.0;
        float n1 = ra_noise(vObjPos * 5.0 + vR2.y * 17.0);
        #ifdef ROBOT_PAINT
          diffuseColor.rgb *= vR0.rgb;
          #ifdef FLAT_SHADED
            vec3 gN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
          #else
            vec3 gN = normalize(vNormal);
          #endif
          float curv = length(fwidth(gN)) / max(length(fwidth(vViewPosition)), 1e-4);
          float n2 = ra_noise(vObjPos * 23.0 + 3.1);
          wear = smoothstep(0.62, 1.0, clamp(curv * uWearScale * 0.08, 0.0, 1.4) + (n1 - 0.5) * 0.65 + (n2 - 0.5) * 0.3) * uWearAmount;
          diffuseColor.rgb = mix(diffuseColor.rgb, uWornColor, wear);
        #endif
        #ifdef ROBOT_SCORCH
          scorch = smoothstep(0.28, 0.85, vR2.x * 1.15 + (n1 - 0.5) * 0.9);
          diffuseColor.rgb *= 1.0 - scorch * 0.86;
        #endif
        #ifdef ROBOT_ACCENT
          diffuseColor.rgb *= 0.05;
        #endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.78, wear);
        roughnessFactor = mix(roughnessFactor, 0.95, scorch);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.15, wear);
        metalnessFactor = mix(metalnessFactor, 0.15, scorch);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        #ifdef ROBOT_PAINT
          totalEmissiveRadiance += vec3(1.0, 0.92, 0.85) * vR0.a * 1.6;
          totalEmissiveRadiance += vec3(0.25, 1.0, 0.45) * vR2.z * 0.35 * (0.5 + 0.5 * sin(vObjPos.y * 40.0));
        #endif
        #ifdef ROBOT_ACCENT
          totalEmissiveRadiance = vR1.rgb * vR1.a;
        #endif
        #ifdef ROBOT_WEAPON
          totalEmissiveRadiance = vR4.rgb * vR4.a;
        #endif
        #ifdef ROBOT_HEAT
          float heatMask = smoothstep(0.15, 1.25, vObjPos.z);
          totalEmissiveRadiance += vec3(1.0, 0.32, 0.06) * pow(vR3.x, 1.6) * heatMask * 5.0;
        #endif`,
      )
      .replace('#include <opaque_fragment>', `
        // Deliberate ink-and-paint bands replace polished continuous highlights.
        outgoingLight = floor(max(outgoingLight, vec3(0.0)) * 6.0 + 0.5) / 6.0;
        #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => `robot-${opts.kind}-${opts.robotIndex >= 0 ? 'fixed' : 'inst'}`;
}

export interface RobotMaterialSet {
  data: RobotDataTexture;
  maps: RobotSurfaceMaps;
  numbers: NumberAtlas;
  /** Returns (and caches) the material for a kind + instance stride. */
  get(kind: RobotMaterialKind, instancesPerRobot: number): THREE.MeshStandardMaterial;
  /** Fresh, fade-able material bound to one fleet slot (for death debris). */
  createDebris(kind: 'paint' | 'steel', slot: number): THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  lamps: THREE.MeshBasicMaterial;
  emp: THREE.MeshBasicMaterial;
  leech: THREE.MeshBasicMaterial;
  repair: THREE.MeshBasicMaterial;
  nozzle: THREE.MeshBasicMaterial;
}

function baseMaterial(kind: RobotMaterialKind, maps: RobotSurfaceMaps, numbers: NumberAtlas): THREE.MeshStandardMaterial {
  switch (kind) {
    case 'canvas':
      return new THREE.MeshStandardMaterial({ color: 0xffffff, map: maps.detail, roughness: 1, metalness: 0, flatShading: true });
    case 'paint':
      return new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: maps.detail,
        roughnessMap: maps.roughness,
        flatShading: true,
        roughness: 1.0,
        metalness: 0.03,
      });
    case 'steel':
      return new THREE.MeshStandardMaterial({
        color: 0x3a3f47,
        map: maps.steelDetail,
        roughnessMap: maps.steelRoughness,
        flatShading: true,
        roughness: 0.95,
        metalness: 0.08,
      });
    case 'barrel':
      return new THREE.MeshStandardMaterial({
        color: 0x2c3036,
        map: maps.steelDetail,
        roughnessMap: maps.steelRoughness,
        flatShading: true,
        roughness: 0.9,
        metalness: 0.06,
      });
    case 'accent':
      return new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, roughness: 1, metalness: 0 });
    case 'weapon':
      return new THREE.MeshStandardMaterial({ color: 0x10151a, emissive: 0xffffff, roughness: 1, metalness: 0 });
    case 'number':
      return new THREE.MeshStandardMaterial({
        map: numbers.texture,
        transparent: false,
        alphaTest: 0.5,
        roughness: 0.6,
        metalness: 0.2,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
  }
}

export function createRobotMaterials(data: RobotDataTexture, maps: RobotSurfaceMaps, numbers: NumberAtlas): RobotMaterialSet {
  const cache = new Map<string, THREE.MeshStandardMaterial>();
  const hdr = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);
  return {
    data,
    maps,
    numbers,
    get(kind, instancesPerRobot) {
      const key = `${kind}:${instancesPerRobot}`;
      let m = cache.get(key);
      if (!m) {
        m = baseMaterial(kind, maps, numbers);
        patch(m, data, { kind, instancesPerRobot, robotIndex: -1 });
        cache.set(key, m);
      }
      return m;
    },
    createDebris(kind, slot) {
      const m = baseMaterial(kind, maps, numbers);
      patch(m, data, { kind, instancesPerRobot: 1, robotIndex: slot });
      m.transparent = true;
      return m;
    },
    chrome: new THREE.MeshStandardMaterial({ color: 0xb8c3c5, roughness: 0.85, metalness: 0.12, flatShading: true }),
    rubber: new THREE.MeshStandardMaterial({ color: 0xffffff, map: maps.rubber, normalMap: maps.rubberNormal, roughness: 0.93, metalness: 0.0 }),
    rim: new THREE.MeshStandardMaterial({ color: 0x8c949e, map: maps.steelDetail, roughness: 0.9, metalness: 0.1, flatShading: true }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x223d48, roughness: 0.8, metalness: 0, clearcoat: 0 }),
    lamps: new THREE.MeshBasicMaterial({ vertexColors: true, color: hdr(5, 5, 5), toneMapped: true }),
    emp: new THREE.MeshBasicMaterial({ color: hdr(0.6, 1.8, 6) }),
    leech: new THREE.MeshBasicMaterial({ color: hdr(6, 0.3, 0.8) }),
    repair: new THREE.MeshBasicMaterial({ color: hdr(0.6, 5, 1.4) }),
    nozzle: new THREE.MeshBasicMaterial({ color: hdr(5, 1.8, 0.4) }),
  };
}
