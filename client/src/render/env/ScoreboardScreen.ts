import * as THREE from 'three';
import { getMap, type MapDef, type MapId } from '@robot-arena/shared';

/**
 * Four-sided arena banner (one draw call). Only the harbor uses a hologram;
 * the other worlds use a framed parchment sign. Text changes redraw the canvas.
 */
export class ScoreboardScreen {
  readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.ShaderMaterial;
  private readonly theme: Readonly<MapDef>;
  private readonly hologram: boolean;
  private lastKey = '';

  constructor(height: number, size: number, mapId: MapId = 'foundry') {
    this.theme = getMap(mapId);
    this.hologram = this.theme.biome === 'urban';
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 256;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.texture }, uTime: { value: 0 }, uHologram: { value: this.hologram ? 1 : 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uTime;
        uniform float uHologram;
        varying vec2 vUv;
        void main() {
          float jitter = step(0.985, fract(sin(floor(uTime * 12.0) * 91.7) * 4375.85)) * 0.01 * uHologram;
          vec4 c = texture2D(uMap, vUv + vec2(jitter, 0.0));
          float scan = 0.75 + 0.25 * sin(vUv.y * 420.0 - uTime * 6.0);
          float flicker = 0.92 + 0.08 * sin(uTime * 37.0);
          vec3 col = c.rgb * mix(1.0, scan * flicker * 2.4, uHologram);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
      blending: this.hologram ? THREE.AdditiveBlending : THREE.NormalBlending,
      transparent: this.hologram,
      depthWrite: !this.hologram,
      side: THREE.DoubleSide,
    });
    // Four outward-facing panels merged into one geometry.
    const panels: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const p = new THREE.PlaneGeometry(size, size / 2);
      p.translate(0, 0, size / 2);
      p.rotateY((i * Math.PI) / 2);
      panels.push(p);
    }
    const merged = mergePlanes(panels);
    this.mesh = new THREE.Mesh(merged, this.material);
    this.mesh.position.set(0, height, 0);
    this.mesh.name = 'scoreboard';
    this.mesh.renderOrder = 6;
    this.draw('—', 0, 300);
  }

  /** Redraws when the text changes; cheap to call every frame. */
  set(leaderName: string, leaderKills: number, secondsLeft: number): void {
    const secs = Math.max(0, Math.floor(secondsLeft));
    const key = `${leaderName}|${leaderKills}|${secs}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.draw(leaderName, leaderKills, secs);
  }

  private draw(leader: string, kills: number, secs: number): void {
    const c = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    const accent = new THREE.Color(this.theme.palette.accent).getStyle();
    c.clearRect(0, 0, w, h);
    if (!this.hologram) {
      const frame = new THREE.Color(this.theme.palette.stone).lerp(new THREE.Color(0x694c31), 0.4).getStyle();
      const paper = new THREE.Color(this.theme.palette.ground).lerp(new THREE.Color(this.theme.biome === 'arctic' ? 0xf0f7f4 : 0xf8e8bf), 0.88).getStyle();
      const ink = new THREE.Color(this.theme.palette.stone).multiplyScalar(0.23).getStyle();
      c.fillStyle = frame; c.fillRect(0, 0, w, h);
      c.fillStyle = paper; c.fillRect(11, 11, w - 22, h - 22);
      // Fine wood grain on the frame and bronze corners make it a physical sign.
      c.strokeStyle = 'rgba(25,19,12,0.22)'; c.lineWidth = 1;
      for (const y of [3, 7, h - 7, h - 3]) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y + 1); c.stroke(); }
      c.strokeStyle = new THREE.Color(this.theme.palette.accent).multiplyScalar(0.65).getStyle();
      c.lineWidth = 2; c.strokeRect(19, 19, w - 38, h - 38);
      c.fillStyle = accent;
      for (const x of [9, w - 9]) for (const y of [9, h - 9]) c.fillRect(x - 4, y - 4, 8, 8);
      c.fillStyle = ink; c.textAlign = 'center';
      c.font = 'bold 23px Georgia, serif'; c.fillText(this.theme.name.toUpperCase(), w / 2, 47, w - 60);
      c.font = '14px Georgia, serif'; c.fillText('ARENA CHAMPION', w / 2, 72);
      c.font = 'bold 35px Georgia, serif'; c.fillText(`${leader.slice(0, 12)}  ·  ${kills}`, w / 2, 122, w - 65);
      c.fillStyle = secs <= 30 ? '#a94631' : ink;
      c.font = 'bold 57px Georgia, serif'; c.fillText(`${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`, w / 2, 189);
      c.font = '13px Georgia, serif'; c.fillText('KILLS  ·  TIME REMAINING', w / 2, 220);
      this.texture.needsUpdate = true;
      return;
    }
    c.fillStyle = 'rgba(4, 18, 28, 0.85)';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = accent;
    c.lineWidth = 6;
    c.strokeRect(6, 6, w - 12, h - 12);
    c.fillStyle = accent;
    c.font = 'bold 24px monospace';
    c.textAlign = 'center';
    c.fillText(`${this.theme.name.toUpperCase()} / LEADER`, w / 2, 52, w - 35);
    c.fillStyle = '#ffffff';
    c.font = 'bold 52px monospace';
    c.fillText(`${leader.slice(0, 12)}  ${kills}`, w / 2, 120);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    c.fillStyle = secs <= 30 ? '#ff3b6b' : '#ffb020';
    c.font = 'bold 64px monospace';
    c.fillText(`${m}:${s.toString().padStart(2, '0')}`, w / 2, 210);
    this.texture.needsUpdate = true;
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
  }
}

function mergePlanes(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  let base = 0;
  for (const g of geos) {
    const p = g.getAttribute('position');
    const u = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      uv.push(u.getX(i), u.getY(i));
    }
    const idx = g.getIndex();
    if (idx) for (let i = 0; i < idx.count; i++) index.push(idx.getX(i) + base);
    base += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(index);
  return out;
}
