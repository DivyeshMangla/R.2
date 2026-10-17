import * as THREE from 'three';

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

/** Deterministic value noise so textures are identical between sessions. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speckle(ctx: CanvasRenderingContext2D, size: number, count: number, rng: () => number, light: number, dark: number): void {
  for (let i = 0; i < count; i++) {
    const v = rng() < 0.5 ? light : dark;
    ctx.fillStyle = `rgba(${v},${v},${v},${0.04 + rng() * 0.08})`;
    const r = 0.5 + rng() * 2.5;
    ctx.fillRect(rng() * size, rng() * size, r, r);
  }
}

function toTexture(c: HTMLCanvasElement, srgb: boolean, anisotropy: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export interface SurfaceTextures {
  map: THREE.Texture;
  roughnessMap: THREE.Texture;
  emissiveMap?: THREE.Texture;
  normalMap?: THREE.Texture;
}

/** Converts a grayscale height canvas into a tangent-space normal map. */
function heightToNormal(height: CanvasRenderingContext2D, size: number, strength: number, anisotropy: number): THREE.Texture {
  const src = height.getImageData(0, 0, size, size).data;
  const [c, ctx] = canvas(size);
  const out = ctx.createImageData(size, size);
  const h = (x: number, y: number): number => src[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
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
  return toTexture(c, false, anisotropy);
}

/** Dark sci-fi floor tiles with panel seams, glowing grid inlays and roughness variation. */
export function floorTextures(anisotropy: number): SurfaceTextures {
  const size = 512;
  const rng = makeRng(1337);
  const [c, ctx] = canvas(size);
  const [rc, rctx] = canvas(size);
  const [ec, ectx] = canvas(size);
  const [, hctx] = canvas(size);
  const tiles = 4;
  const ts = size / tiles;
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, size, size);
  hctx.fillStyle = '#808080';
  hctx.fillRect(0, 0, size, size);
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const shade = 34 + Math.floor(rng() * 14);
      ctx.fillStyle = `rgb(${shade},${shade + 4},${shade + 10})`;
      ctx.fillRect(tx * ts, ty * ts, ts, ts);
      const rough = 120 + Math.floor(rng() * 90);
      rctx.fillStyle = `rgb(${rough},${rough},${rough})`;
      rctx.fillRect(tx * ts, ty * ts, ts, ts);
      // Inner panel bevel.
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 2;
      ctx.strokeRect(tx * ts + 6, ty * ts + 6, ts - 12, ts - 12);
      if (rng() < 0.35) {
        // Bolted access hatch.
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(tx * ts + ts * 0.3, ty * ts + ts * 0.3, ts * 0.4, ts * 0.4);
        hctx.fillStyle = '#6a6a6a';
        hctx.fillRect(tx * ts + ts * 0.3, ty * ts + ts * 0.3, ts * 0.4, ts * 0.4);
        for (const [bx, by] of [
          [0.33, 0.33],
          [0.67, 0.33],
          [0.33, 0.67],
          [0.67, 0.67],
        ]) {
          ctx.fillStyle = 'rgba(160,170,180,0.35)';
          ctx.beginPath();
          ctx.arc(tx * ts + ts * bx, ty * ts + ts * by, 3, 0, Math.PI * 2);
          ctx.fill();
          hctx.fillStyle = '#c0c0c0';
          hctx.beginPath();
          hctx.arc(tx * ts + ts * bx, ty * ts + ts * by, 3, 0, Math.PI * 2);
          hctx.fill();
        }
      }
    }
  }
  speckle(ctx, size, 9000, rng, 200, 0);
  speckle(rctx, size, 12000, rng, 255, 40);
  // Seams.
  ctx.fillStyle = '#0b0d11';
  rctx.fillStyle = '#e8e8e8';
  hctx.fillStyle = '#202020';
  for (let i = 0; i <= tiles; i++) {
    const p = i * ts;
    for (const g of [ctx, rctx, hctx]) {
      g.fillRect(p - 2, 0, 4, size);
      g.fillRect(0, p - 2, size, 4);
    }
  }
  // Emissive grid inlay along the outer tile edge only (one line per texture repeat).
  ectx.fillStyle = '#2bd6ff';
  ectx.fillRect(0, 0, size, 2);
  ectx.fillRect(0, 0, 2, size);
  ctx.fillStyle = '#123844';
  ctx.fillRect(0, 0, size, 2);
  ctx.fillRect(0, 0, 2, size);
  return {
    map: toTexture(c, true, anisotropy),
    roughnessMap: toTexture(rc, false, anisotropy),
    emissiveMap: toTexture(ec, true, anisotropy),
    normalMap: heightToNormal(hctx, size, 3, anisotropy),
  };
}

/** Brushed metal panels with rivet lines (platform, pillars). */
export function metalPanelTextures(anisotropy: number, tint: [number, number, number]): SurfaceTextures {
  const size = 256;
  const rng = makeRng(42);
  const [c, ctx] = canvas(size);
  const [rc, rctx] = canvas(size);
  const [, hctx] = canvas(size);
  ctx.fillStyle = `rgb(${tint[0]},${tint[1]},${tint[2]})`;
  ctx.fillRect(0, 0, size, size);
  rctx.fillStyle = 'rgb(110,110,110)';
  rctx.fillRect(0, 0, size, size);
  hctx.fillStyle = '#808080';
  hctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    const v = Math.floor(rng() * 30);
    ctx.fillStyle = `rgba(255,255,255,${v / 900})`;
    ctx.fillRect(0, y, size, 1);
    rctx.fillStyle = `rgba(${150 + v * 2},${150 + v * 2},${150 + v * 2},0.25)`;
    rctx.fillRect(0, y, size, 1);
  }
  speckle(ctx, size, 2500, rng, 220, 0);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  hctx.fillStyle = '#303030';
  ctx.fillRect(0, size / 2 - 1, size, 3);
  ctx.fillRect(size / 2 - 1, 0, 3, size);
  hctx.fillRect(0, size / 2 - 1, size, 3);
  hctx.fillRect(size / 2 - 1, 0, 3, size);
  for (let i = 0; i < 8; i++) {
    for (const [x, y] of [
      [8 + i * 32, 8],
      [8, 8 + i * 32],
    ]) {
      ctx.fillStyle = 'rgba(200,210,220,0.4)';
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
      hctx.fillStyle = '#e0e0e0';
      hctx.beginPath();
      hctx.arc(x, y, 2.2, 0, Math.PI * 2);
      hctx.fill();
    }
  }
  return {
    map: toTexture(c, true, anisotropy),
    roughnessMap: toTexture(rc, false, anisotropy),
    normalMap: heightToNormal(hctx, size, 2.5, anisotropy),
  };
}

/** Yellow/black hazard stripes for the outer barriers. */
export function hazardTextures(anisotropy: number): SurfaceTextures {
  const size = 256;
  const rng = makeRng(7);
  const [c, ctx] = canvas(size);
  const [rc, rctx] = canvas(size);
  ctx.fillStyle = '#16181c';
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, size * 0.62, size, size * 0.3);
  ctx.clip();
  ctx.fillStyle = '#d9a514';
  for (let i = -2; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 64, size);
    ctx.lineTo(i * 64 + 32, size);
    ctx.lineTo(i * 64 + 32 + 128, size * 0.5);
    ctx.lineTo(i * 64 + 128, size * 0.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  speckle(ctx, size, 4000, rng, 255, 0);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.1 + rng() * 0.3})`;
    ctx.fillRect(rng() * size, rng() * size, 2 + rng() * 18, 1 + rng() * 3);
  }
  rctx.fillStyle = 'rgb(170,170,170)';
  rctx.fillRect(0, 0, size, size);
  speckle(rctx, size, 6000, rng, 255, 60);
  return { map: toTexture(c, true, anisotropy), roughnessMap: toTexture(rc, false, anisotropy) };
}

/** Diamond tread plate for ramps. */
export function treadPlateTextures(anisotropy: number): SurfaceTextures {
  const size = 256;
  const rng = makeRng(99);
  const [c, ctx] = canvas(size);
  const [rc, rctx] = canvas(size);
  const [, hctx] = canvas(size);
  ctx.fillStyle = '#4a5058';
  ctx.fillRect(0, 0, size, size);
  rctx.fillStyle = 'rgb(90,90,90)';
  rctx.fillRect(0, 0, size, size);
  hctx.fillStyle = '#606060';
  hctx.fillRect(0, 0, size, size);
  const step = 32;
  for (let y = 0; y < size / step; y++) {
    for (let x = 0; x < size / step; x++) {
      const cx = x * step + (y % 2 ? step / 2 : 0) + step / 4;
      const cy = y * step + step / 2;
      const angle = (x + y) % 2 ? Math.PI / 4 : -Math.PI / 4;
      for (const [g, col] of [
        [ctx, '#6c737c'],
        [hctx, '#e0e0e0'],
        [rctx, '#404040'],
      ] as const) {
        g.save();
        g.translate(cx, cy);
        g.rotate(angle);
        g.fillStyle = col;
        g.fillRect(-11, -2.5, 22, 5);
        g.restore();
      }
    }
  }
  speckle(ctx, size, 3000, rng, 230, 10);
  speckle(rctx, size, 5000, rng, 220, 40);
  return {
    map: toTexture(c, true, anisotropy),
    roughnessMap: toTexture(rc, false, anisotropy),
    normalMap: heightToNormal(hctx, size, 4, anisotropy),
  };
}

/** Rough concrete blocks with an emissive warning strip (cover walls). */
export function concreteTextures(anisotropy: number): SurfaceTextures {
  const size = 256;
  const rng = makeRng(2024);
  const [c, ctx] = canvas(size);
  const [rc, rctx] = canvas(size);
  const [ec, ectx] = canvas(size);
  ctx.fillStyle = '#5b5f66';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 300; i++) {
    const v = 70 + Math.floor(rng() * 40);
    ctx.fillStyle = `rgba(${v},${v},${v + 4},0.25)`;
    ctx.beginPath();
    ctx.arc(rng() * size, rng() * size, 2 + rng() * 14, 0, Math.PI * 2);
    ctx.fill();
  }
  speckle(ctx, size, 8000, rng, 200, 10);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, size / 2 - 1, size, 2);
  ctx.fillRect(size / 2 - 1, 0, 2, size / 2);
  ctx.fillRect(0, size / 2, 2, size / 2);
  rctx.fillStyle = 'rgb(225,225,225)';
  rctx.fillRect(0, 0, size, size);
  speckle(rctx, size, 6000, rng, 255, 150);
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, size, size);
  ectx.fillStyle = '#ff7a1a';
  ectx.fillRect(0, 10, size, 6);
  ctx.fillStyle = '#5a3010';
  ctx.fillRect(0, 10, size, 6);
  return { map: toTexture(c, true, anisotropy), roughnessMap: toTexture(rc, false, anisotropy), emissiveMap: toTexture(ec, true, anisotropy) };
}

/** Soft radial scorch mark (alpha in the texture). */
export function scorchTexture(): THREE.Texture {
  const size = 128;
  const rng = makeRng(5);
  const [c, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.95)');
  g.addColorStop(0.35, 'rgba(10,8,6,0.75)');
  g.addColorStop(0.7, 'rgba(20,16,12,0.3)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2;
    const r = size * (0.2 + rng() * 0.28);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(size / 2 + Math.cos(a) * r * 0.6, size / 2 + Math.sin(a) * r * 0.6, 2 + rng() * 6, 1 + rng() * 3, a, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Four-point star used for muzzle flashes. */
export function flashTexture(): THREE.Texture {
  const size = 128;
  const [c, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,220,150,0.9)');
  g.addColorStop(1, 'rgba(255,120,20,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'lighter';
  for (const a of [0, Math.PI / 2]) {
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(a);
    const lg = ctx.createLinearGradient(-size / 2, 0, size / 2, 0);
    lg.addColorStop(0, 'rgba(255,200,120,0)');
    lg.addColorStop(0.5, 'rgba(255,240,200,0.9)');
    lg.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = lg;
    ctx.fillRect(-size / 2, -3, size, 6);
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Rubber tread for tyres (repeats around the circumference). */
export function tireTextures(anisotropy: number): SurfaceTextures {
  const w = 256;
  const h = 64;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const rcCanvas = document.createElement('canvas');
  rcCanvas.width = w;
  rcCanvas.height = h;
  const rctx = rcCanvas.getContext('2d');
  if (!ctx || !rctx) throw new Error('2D canvas unavailable');
  ctx.fillStyle = '#121214';
  ctx.fillRect(0, 0, w, h);
  rctx.fillStyle = 'rgb(235,235,235)';
  rctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 24; i++) {
    const x = (i / 24) * w;
    ctx.fillStyle = '#060607';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x + 14, h / 2);
    ctx.lineTo(x + 6, h);
    ctx.lineTo(x, h);
    ctx.lineTo(x + 8, h / 2);
    ctx.closePath();
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  const r = new THREE.CanvasTexture(rcCanvas);
  r.anisotropy = anisotropy;
  return { map: t, roughnessMap: r };
}
