import * as THREE from 'three';

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function heightToNormal(src: CanvasRenderingContext2D, size: number, strength: number): HTMLCanvasElement {
  const data = src.getImageData(0, 0, size, size).data;
  const [c, ctx] = makeCanvas(size, size);
  const out = ctx.createImageData(size, size);
  const h = (x: number, y: number): number => data[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      out.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

function tex(c: HTMLCanvasElement, srgb: boolean, anisotropy: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

export interface RobotSurfaceMaps {
  /** Near-white albedo multiplier: grime, seams, stencils. Tinted per robot in the shader. */
  detail: THREE.Texture;
  roughness: THREE.Texture;
  normal: THREE.Texture;
  /** Darker, coarser maps for bare steel parts. */
  steelDetail: THREE.Texture;
  steelRoughness: THREE.Texture;
  steelNormal: THREE.Texture;
  rubber: THREE.Texture;
  rubberNormal: THREE.Texture;
}

/**
 * Painted-metal detail maps. Panel seams, rivet lines, scratches and grime are
 * drawn into a height field, which also generates the matching normal map.
 */
export function createRobotSurfaceMaps(anisotropy: number): RobotSurfaceMaps {
  const size = 512;
  const r = rng(77);
  const [dc, d] = makeCanvas(size, size);
  const [rc, rough] = makeCanvas(size, size);
  const [, h] = makeCanvas(size, size);

  d.fillStyle = 'rgb(236,236,236)';
  d.fillRect(0, 0, size, size);
  rough.fillStyle = 'rgb(92,92,92)';
  rough.fillRect(0, 0, size, size);
  h.fillStyle = 'rgb(140,140,140)';
  h.fillRect(0, 0, size, size);

  // Large-scale grime blotches.
  for (let i = 0; i < 70; i++) {
    const x = r() * size, y = r() * size, rad = 20 + r() * 80;
    const g = d.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(60,55,50,${0.05 + r() * 0.1})`);
    g.addColorStop(1, 'rgba(60,55,50,0)');
    d.fillStyle = g;
    d.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    const gr = rough.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `rgba(200,200,200,${0.1 + r() * 0.2})`);
    gr.addColorStop(1, 'rgba(200,200,200,0)');
    rough.fillStyle = gr;
    rough.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }

  // Panel seams on a 256px grid with offset rows and rivet lines along them.
  const seam = (x0: number, y0: number, x1: number, y1: number): void => {
    d.strokeStyle = 'rgba(30,30,32,0.75)';
    d.lineWidth = 2.5;
    d.beginPath();
    d.moveTo(x0, y0);
    d.lineTo(x1, y1);
    d.stroke();
    h.strokeStyle = 'rgb(40,40,40)';
    h.lineWidth = 3;
    h.beginPath();
    h.moveTo(x0, y0);
    h.lineTo(x1, y1);
    h.stroke();
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.floor(len / 22);
    const nx = (y1 - y0) / len, ny = -(x1 - x0) / len;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const px = x0 + (x1 - x0) * t + nx * 7;
      const py = y0 + (y1 - y0) * t + ny * 7;
      h.fillStyle = 'rgb(230,230,230)';
      h.beginPath();
      h.arc(px, py, 2.6, 0, Math.PI * 2);
      h.fill();
      d.fillStyle = 'rgba(255,255,255,0.35)';
      d.beginPath();
      d.arc(px - 0.6, py - 0.6, 1.4, 0, Math.PI * 2);
      d.fill();
    }
  };
  seam(0, 2, size, 2);
  seam(0, 256, size, 256);
  seam(2, 0, 2, 256);
  seam(170, 256, 170, size);
  seam(256, 0, 256, 256);
  seam(400, 256, 400, size);

  // Access hatch and stencils.
  d.strokeStyle = 'rgba(30,30,32,0.6)';
  d.lineWidth = 2;
  d.strokeRect(60, 60, 120, 80);
  h.strokeStyle = 'rgb(70,70,70)';
  h.lineWidth = 3;
  h.strokeRect(60, 60, 120, 80);
  d.fillStyle = 'rgba(25,25,25,0.55)';
  d.font = 'bold 22px monospace';
  d.fillText('ARX-7', 300, 120);
  d.font = 'bold 14px monospace';
  d.fillText('DANGER  HIGH VOLTAGE', 290, 450);
  for (let i = 0; i < 6; i++) {
    d.fillStyle = i % 2 ? 'rgba(20,20,20,0.5)' : 'rgba(255,190,40,0.6)';
    d.fillRect(300 + i * 14, 140, 14, 8);
  }

  // Scratches: bright in albedo, rough, slightly indented.
  for (let i = 0; i < 160; i++) {
    const x = r() * size, y = r() * size;
    const a = r() * Math.PI;
    const len = 6 + r() * 40;
    const x1 = x + Math.cos(a) * len, y1 = y + Math.sin(a) * len;
    d.strokeStyle = `rgba(255,255,255,${0.15 + r() * 0.3})`;
    d.lineWidth = 0.6 + r();
    d.beginPath();
    d.moveTo(x, y);
    d.lineTo(x1, y1);
    d.stroke();
    rough.strokeStyle = `rgba(30,30,30,${0.4 + r() * 0.4})`;
    rough.lineWidth = 1;
    rough.beginPath();
    rough.moveTo(x, y);
    rough.lineTo(x1, y1);
    rough.stroke();
    h.strokeStyle = 'rgba(100,100,100,0.6)';
    h.lineWidth = 1;
    h.beginPath();
    h.moveTo(x, y);
    h.lineTo(x1, y1);
    h.stroke();
  }
  // Fine speckle.
  for (let i = 0; i < 14000; i++) {
    const v = r() < 0.5 ? 255 : 0;
    d.fillStyle = `rgba(${v},${v},${v},${0.02 + r() * 0.05})`;
    d.fillRect(r() * size, r() * size, 1.5, 1.5);
    rough.fillStyle = `rgba(${v},${v},${v},${0.05 + r() * 0.08})`;
    rough.fillRect(r() * size, r() * size, 2, 2);
  }

  // Steel variant: darker base, heavier grime, crosshatch brushing.
  const [sdc, sd] = makeCanvas(256, 256);
  const [src, sr] = makeCanvas(256, 256);
  const [, sh] = makeCanvas(256, 256);
  sd.fillStyle = 'rgb(200,200,204)';
  sd.fillRect(0, 0, 256, 256);
  sr.fillStyle = 'rgb(120,120,120)';
  sr.fillRect(0, 0, 256, 256);
  sh.fillStyle = 'rgb(128,128,128)';
  sh.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y++) {
    const v = Math.floor(r() * 40);
    sd.fillStyle = `rgba(0,0,0,${v / 600})`;
    sd.fillRect(0, y, 256, 1);
    sr.fillStyle = `rgba(255,255,255,${v / 400})`;
    sr.fillRect(0, y, 256, 1);
  }
  for (let i = 0; i < 40; i++) {
    const x = r() * 256, y = r() * 256, rad = 10 + r() * 40;
    const g = sd.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(40,30,20,${0.1 + r() * 0.2})`);
    g.addColorStop(1, 'rgba(40,30,20,0)');
    sd.fillStyle = g;
    sd.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  for (let i = 0; i < 4; i++) {
    sh.fillStyle = 'rgb(60,60,60)';
    sh.fillRect(0, i * 64, 256, 2);
    sd.fillStyle = 'rgba(0,0,0,0.5)';
    sd.fillRect(0, i * 64, 256, 2);
  }

  // Rubber: sidewall lettering ring + fine grain.
  const [rbc, rb] = makeCanvas(256, 256);
  const [, rbh] = makeCanvas(256, 256);
  rb.fillStyle = 'rgb(40,40,42)';
  rb.fillRect(0, 0, 256, 256);
  rbh.fillStyle = 'rgb(128,128,128)';
  rbh.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) {
    const v = 30 + Math.floor(r() * 30);
    rb.fillStyle = `rgba(${v},${v},${v},0.5)`;
    rb.fillRect(r() * 256, r() * 256, 1.5, 1.5);
    rbh.fillStyle = `rgba(${v * 4},${v * 4},${v * 4},0.3)`;
    rbh.fillRect(r() * 256, r() * 256, 2, 2);
  }
  rb.fillStyle = 'rgba(120,120,120,0.35)';
  rb.font = 'bold 18px sans-serif';
  rb.fillText('GRIPMASTER 380', 40, 128);

  // Uneven pen hatching and broken construction strokes make the paint read as a drawing.
  for (const [context, dimension] of [[d, size], [sd, 256]] as const) {
    context.strokeStyle = 'rgba(38,31,29,0.19)';
    context.lineWidth = 1.2;
    for (let i = 0; i < 95; i++) {
      const x = r() * dimension, y = r() * dimension, length = 6 + r() * 19;
      context.beginPath(); context.moveTo(x, y); context.lineTo(x + length, y - length * 0.55 + r() * 2); context.stroke();
      if (i % 4 === 0) { context.beginPath(); context.moveTo(x + 2, y + 4); context.lineTo(x + length + 2, y - length * 0.55 + 4); context.stroke(); }
    }
  }

  return {
    detail: tex(dc, true, anisotropy),
    roughness: tex(rc, false, anisotropy),
    normal: tex(heightToNormal(h, size, 2.2), false, anisotropy),
    steelDetail: tex(sdc, true, anisotropy),
    steelRoughness: tex(src, false, anisotropy),
    steelNormal: tex(heightToNormal(sh, 256, 2), false, anisotropy),
    rubber: tex(rbc, true, anisotropy),
    rubberNormal: tex(heightToNormal(rbh, 256, 3), false, anisotropy),
  };
}

export const NUMBER_ATLAS_CELLS = 8;

/** One cell per fleet slot holding the robot's stencilled number (decal style, alpha-tested). */
export class NumberAtlas {
  readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cell = 128;

  constructor() {
    const [c, ctx] = makeCanvas(this.cell * NUMBER_ATLAS_CELLS, this.cell);
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(c);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
  }

  setNumber(slot: number, value: number): void {
    const ctx = this.ctx;
    const s = this.cell;
    const x = slot * s;
    ctx.clearRect(x, 0, s, s);
    const r = rng(value * 31 + 7);
    ctx.save();
    ctx.translate(x, 0);
    // Stencil plate frame.
    ctx.strokeStyle = 'rgba(240,240,232,0.9)';
    ctx.lineWidth = 5;
    ctx.strokeRect(8, 18, s - 16, s - 36);
    ctx.fillStyle = 'rgba(240,240,232,0.95)';
    ctx.font = `900 ${Math.round(s * 0.55)}px Rajdhani, Impact, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(value).padStart(2, '0'), s / 2, s / 2 + 4);
    // Wear: chip away random flecks so it reads as painted-on.
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.4 + r() * 0.6})`;
      ctx.beginPath();
      ctx.arc(r() * s, r() * s, 0.8 + r() * 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    this.texture.needsUpdate = true;
  }
}
