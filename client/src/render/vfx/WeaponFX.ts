import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);

interface Beam {
  core: THREE.Mesh;
  glow: THREE.Mesh;
  coreMat: THREE.MeshBasicMaterial;
  glowMat: THREE.MeshBasicMaterial;
  birth: number;
  life: number;
  width: number;
}

interface Slash {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  arc: number;
  birth: number;
  life: number;
  radius: number;
}

interface Bubble {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  seen: boolean;
}

const BEAMS = 16;
const SLASHES = 16;

function additive(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
}

function bubbleMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0.35, 0.9, 1.4) }, uAlpha: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vObj;
      void main() {
        vObj = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform float uAlpha;
      varying vec3 vN; varying vec3 vV; varying vec3 vObj;
      void main() {
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4);
        // Hex-ish scan bands crawling over the bubble.
        float bands = 0.5 + 0.5 * sin(vObj.y * 14.0 - uTime * 5.0);
        float cells = abs(sin(vObj.x * 9.0 + uTime) * sin(vObj.z * 9.0 - uTime * 0.7));
        float a = (fres * 1.3 + bands * 0.08 + step(0.92, cells) * 0.25) * uAlpha;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * Pooled weapon meshes that particles can't sell on their own: thick fading
 * hitscan beams, melee swing arcs, and persistent per-robot shield bubbles.
 */
export class WeaponFX {
  private readonly beams: Beam[] = [];
  private readonly slashes: Slash[] = [];
  private readonly bubbles = new Map<number, Bubble>();
  private readonly bubbleGeo = new THREE.SphereGeometry(1, 28, 16);
  private readonly group = new THREE.Group();
  private beamHead = 0;
  private slashHead = 0;
  private time = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'weaponFX';
    scene.add(this.group);
    // Unit cylinder along +Y from 0..1 so scale.y = length.
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    beamGeo.translate(0, 0.5, 0);
    for (let i = 0; i < BEAMS; i++) {
      const coreMat = additive(0xffffff, 0);
      const glowMat = additive(0xffffff, 0);
      const core = new THREE.Mesh(beamGeo, coreMat);
      const glow = new THREE.Mesh(beamGeo, glowMat);
      core.visible = glow.visible = false;
      core.frustumCulled = glow.frustumCulled = false;
      core.renderOrder = glow.renderOrder = 11;
      this.group.add(core, glow);
      this.beams.push({ core, glow, coreMat, glowMat, birth: -1e6, life: 0.2, width: 0.1 });
    }
    for (let i = 0; i < SLASHES; i++) {
      const mat = additive(0xffffff, 0);
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 11;
      this.group.add(mesh);
      this.slashes.push({ mesh, mat, arc: -1, birth: -1e6, life: 0.22, radius: 1 });
    }
  }

  /** Bright beam from `from` to `to` that thins and fades over `life` seconds. */
  beam(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, width: number, life: number): void {
    const b = this.beams[this.beamHead];
    this.beamHead = (this.beamHead + 1) % BEAMS;
    _a.subVectors(to, from);
    const len = Math.max(0.01, _a.length());
    _q.setFromUnitVectors(Y, _a.multiplyScalar(1 / len));
    for (const m of [b.core, b.glow]) {
      m.position.copy(from);
      m.quaternion.copy(_q);
      m.visible = true;
    }
    b.core.scale.set(width * 0.35, len, width * 0.35);
    b.glow.scale.set(width, len, width);
    b.coreMat.color.setRGB(1, 1, 1);
    b.glowMat.color.copy(color);
    b.birth = this.time;
    b.life = life;
    b.width = width;
  }

  /** Horizontal swing arc of `arc` radians centred on `yaw`, sweeping out to `radius`. */
  slash(pos: THREE.Vector3, yaw: number, arc: number, radius: number, color: THREE.Color, life = 0.22, tilt = 0): void {
    const s = this.slashes[this.slashHead];
    this.slashHead = (this.slashHead + 1) % SLASHES;
    const a = Math.max(0.3, Math.min(Math.PI * 1.9, arc));
    if (Math.abs(a - s.arc) > 1e-3) {
      s.mesh.geometry.dispose();
      // Ring in XY rotated flat; theta measured from +X, centred on +Z after rotation.
      // Fat crescent: the inner edge sits well inside the reach so the swing reads as a heavy blade sweep.
      const geo = new THREE.RingGeometry(0.38, 1, 36, 1, Math.PI / 2 - a / 2, a);
      geo.rotateX(-Math.PI / 2);
      geo.scale(1, 1, -1);
      s.mesh.geometry = geo;
      s.arc = a;
    }
    s.mesh.position.set(pos.x, pos.y + 0.7, pos.z);
    s.mesh.rotation.set(tilt, yaw, 0, 'YXZ');
    s.mesh.visible = true;
    s.mat.color.copy(color);
    s.birth = this.time;
    s.life = life;
    s.radius = radius;
    s.mesh.scale.setScalar(radius * 0.6);
  }

  /** Call once per frame per shielded robot; bubbles not refreshed this frame are hidden in `update`. */
  shield(id: number, pos: THREE.Vector3, color: THREE.Color, size = 1.3): void {
    let b = this.bubbles.get(id);
    if (!b) {
      const mat = bubbleMaterial();
      const mesh = new THREE.Mesh(this.bubbleGeo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 10;
      this.group.add(mesh);
      b = { mesh, mat, seen: false };
      this.bubbles.set(id, b);
    }
    b.seen = true;
    b.mesh.visible = true;
    b.mesh.position.set(pos.x, pos.y + 0.45, pos.z);
    const pulse = 1 + Math.sin(this.time * 6 + id) * 0.025;
    b.mesh.scale.set(2.1 * size * pulse, 1.55 * size * pulse, 2.4 * size * pulse);
    (b.mat.uniforms.uColor.value as THREE.Color).copy(color);
  }

  update(time: number): void {
    this.time = time;
    for (const b of this.beams) {
      if (!b.core.visible) continue;
      const t = (time - b.birth) / b.life;
      if (t >= 1 || t < 0) {
        b.core.visible = b.glow.visible = false;
        continue;
      }
      // Hold full brightness for the first fifth, then thin out: a heavy beam lingers before fading.
      const hold = t < 0.2 ? 1 : 1 - (t - 0.2) / 0.8;
      b.coreMat.opacity = Math.min(1, hold * hold * 1.2);
      b.glowMat.opacity = 0.7 * hold;
      const w = b.width * (0.45 + 0.55 * hold);
      b.core.scale.x = b.core.scale.z = w * 0.4;
      b.glow.scale.x = b.glow.scale.z = w * (1 + t * 1.1);
    }
    for (const s of this.slashes) {
      if (!s.mesh.visible) continue;
      const t = (time - s.birth) / s.life;
      if (t >= 1 || t < 0) {
        s.mesh.visible = false;
        continue;
      }
      s.mat.opacity = Math.min(1, (1 - t) * 1.8);
      s.mesh.scale.setScalar(s.radius * (0.6 + 0.5 * (1 - (1 - t) ** 3)));
    }
    for (const b of this.bubbles.values()) {
      if (!b.seen) b.mesh.visible = false;
      b.seen = false;
      b.mat.uniforms.uTime.value = time;
    }
  }

  clear(): void {
    for (const b of this.beams) b.core.visible = b.glow.visible = false;
    for (const s of this.slashes) s.mesh.visible = false;
    for (const b of this.bubbles.values()) b.mesh.visible = false;
  }

  /** Drop the shield bubble of a robot that left the match. */
  remove(id: number): void {
    const b = this.bubbles.get(id);
    if (!b) return;
    this.group.remove(b.mesh);
    b.mat.dispose();
    this.bubbles.delete(id);
  }

  /** Midpoint helper used by callers for lights along a beam. */
  static mid(a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(a).add(_b.copy(b)).multiplyScalar(0.5);
  }
}
