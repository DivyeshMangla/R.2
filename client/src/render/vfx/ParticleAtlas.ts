import * as THREE from 'three';

/** Particle look presets. Each owns a colour/alpha curve and a size curve over normalised lifetime. */
export enum PType {
  SPARK = 0,
  EMBER = 1,
  FLASH = 2,
  FIRE = 3,
  SMOKE = 4,
  DUST = 5,
  GLOW = 6,
  ELECTRIC = 7,
  NANO = 8,
  LEECH = 9,
  CHUNK = 10,
  STREAK = 11,
  TIRE_SMOKE = 12,
  THRUSTER = 13,
}

export type Blend = 'add' | 'alpha';

interface TypeDef {
  blend: Blend;
  /** First atlas cell and number of cells (variants or flipbook frames). */
  frame0: number;
  frames: number;
  /** true = play cells as a flipbook over life; false = pick one variant per particle. */
  flipbook: boolean;
  /** [t, r, g, b, a] keys (0..1). */
  color: [number, number, number, number, number][];
  /** [t, size multiplier] keys (0..1). */
  size: [number, number][];
}

export const TYPE_DEFS: Readonly<Record<PType, TypeDef>> = {
  [PType.SPARK]: { blend: 'add', frame0: 1, frames: 1, flipbook: false, color: [[0, 1, 1, 0.9, 1], [0.4, 1, 0.75, 0.35, 1], [1, 0.9, 0.25, 0.05, 0]], size: [[0, 1], [1, 0.4]] },
  [PType.EMBER]: { blend: 'add', frame0: 0, frames: 1, flipbook: false, color: [[0, 1, 0.85, 0.5, 1], [0.6, 1, 0.45, 0.1, 0.9], [1, 0.6, 0.12, 0.02, 0]], size: [[0, 1], [1, 0.5]] },
  [PType.FLASH]: { blend: 'add', frame0: 2, frames: 1, flipbook: false, color: [[0, 1, 1, 1, 1], [0.3, 1, 0.8, 0.5, 0.8], [1, 1, 0.5, 0.2, 0]], size: [[0, 0.6], [0.25, 1], [1, 1.2]] },
  [PType.FIRE]: { blend: 'add', frame0: 8, frames: 4, flipbook: true, color: [[0, 1, 0.95, 0.75, 1], [0.25, 1, 0.6, 0.18, 0.95], [0.7, 0.7, 0.18, 0.04, 0.5], [1, 0.2, 0.05, 0.02, 0]], size: [[0, 0.5], [0.3, 1], [1, 1.3]] },
  [PType.SMOKE]: { blend: 'alpha', frame0: 4, frames: 4, flipbook: false, color: [[0, 0.3, 0.28, 0.26, 0], [0.12, 0.22, 0.21, 0.2, 0.75], [0.6, 0.16, 0.16, 0.17, 0.45], [1, 0.14, 0.14, 0.15, 0]], size: [[0, 0.35], [0.4, 0.8], [1, 1]] },
  [PType.DUST]: { blend: 'alpha', frame0: 14, frames: 1, flipbook: false, color: [[0, 0.55, 0.5, 0.44, 0], [0.15, 0.55, 0.5, 0.44, 0.5], [1, 0.5, 0.46, 0.42, 0]], size: [[0, 0.4], [1, 1]] },
  [PType.GLOW]: { blend: 'add', frame0: 0, frames: 1, flipbook: false, color: [[0, 1, 1, 1, 1], [1, 1, 1, 1, 0]], size: [[0, 1], [1, 0.6]] },
  [PType.ELECTRIC]: { blend: 'add', frame0: 12, frames: 1, flipbook: false, color: [[0, 0.8, 0.95, 1, 1], [0.5, 0.4, 0.75, 1, 0.9], [1, 0.2, 0.4, 1, 0]], size: [[0, 1], [1, 0.7]] },
  [PType.NANO]: { blend: 'add', frame0: 15, frames: 1, flipbook: false, color: [[0, 0.5, 1, 0.6, 0], [0.2, 0.5, 1, 0.6, 1], [1, 0.3, 1, 0.5, 0]], size: [[0, 0.6], [0.5, 1], [1, 0.4]] },
  [PType.LEECH]: { blend: 'add', frame0: 0, frames: 1, flipbook: false, color: [[0, 1, 0.15, 0.25, 0], [0.2, 1, 0.1, 0.2, 1], [1, 0.6, 0.02, 0.1, 0]], size: [[0, 0.5], [0.5, 1], [1, 0.3]] },
  [PType.CHUNK]: { blend: 'alpha', frame0: 13, frames: 1, flipbook: false, color: [[0, 0.32, 0.33, 0.36, 1], [0.85, 0.28, 0.29, 0.31, 1], [1, 0.28, 0.29, 0.31, 0]], size: [[0, 1], [1, 1]] },
  [PType.STREAK]: { blend: 'add', frame0: 1, frames: 1, flipbook: false, color: [[0, 0.7, 0.85, 1, 0], [0.2, 0.7, 0.85, 1, 0.8], [1, 0.4, 0.6, 1, 0]], size: [[0, 1], [1, 1]] },
  [PType.TIRE_SMOKE]: { blend: 'alpha', frame0: 4, frames: 4, flipbook: false, color: [[0, 0.75, 0.75, 0.76, 0], [0.15, 0.7, 0.7, 0.72, 0.45], [1, 0.65, 0.65, 0.67, 0]], size: [[0, 0.3], [1, 1]] },
  [PType.THRUSTER]: { blend: 'add', frame0: 8, frames: 4, flipbook: true, color: [[0, 0.75, 0.9, 1, 1], [0.2, 1, 0.75, 0.35, 1], [1, 0.6, 0.12, 0.02, 0]], size: [[0, 0.7], [0.3, 1], [1, 0.3]] },
};

export const TYPE_COUNT = 14;
export const CURVE_RES = 64;

/** RGBA8 texture: row 2t = colour/alpha curve, row 2t+1 = size curve (R) for type t. */
export function createCurveTexture(): THREE.DataTexture {
  const data = new Uint8Array(CURVE_RES * TYPE_COUNT * 2 * 4);
  const sample = <T extends number[]>(keys: T[], t: number, channel: number): number => {
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      if (t >= a[0] && t <= b[0]) {
        const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
        return a[channel] + (b[channel] - a[channel]) * k;
      }
    }
    return t <= keys[0][0] ? keys[0][channel] : keys[keys.length - 1][channel];
  };
  for (let type = 0; type < TYPE_COUNT; type++) {
    const def = TYPE_DEFS[type as PType];
    for (let x = 0; x < CURVE_RES; x++) {
      const t = x / (CURVE_RES - 1);
      const ci = ((type * 2) * CURVE_RES + x) * 4;
      for (let c = 0; c < 4; c++) data[ci + c] = Math.round(THREE.MathUtils.clamp(sample(def.color, t, c + 1), 0, 1) * 255);
      const si = ((type * 2 + 1) * CURVE_RES + x) * 4;
      data[si] = Math.round(THREE.MathUtils.clamp(sample(def.size, t, 1) / 2, 0, 1) * 255);
      data[si + 1] = data[si + 2] = 0;
      data[si + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, CURVE_RES, TYPE_COUNT * 2, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** 4×4 atlas of procedurally drawn sprites (white shapes; tinted in the shader). */
export function createParticleAtlas(): THREE.CanvasTexture {
  const cell = 128;
  const c = document.createElement('canvas');
  c.width = c.height = cell * 4;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  let seed = 9;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const at = (i: number): [number, number] => [(i % 4) * cell, Math.floor(i / 4) * cell];
  const radial = (i: number, stops: [number, string][]): void => {
    const [x, y] = at(i);
    const g = ctx.createRadialGradient(x + cell / 2, y + cell / 2, 0, x + cell / 2, y + cell / 2, cell / 2);
    for (const [o, col] of stops) g.addColorStop(o, col);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, cell, cell);
  };
  const blob = (i: number, puffs: number, softness: number, alpha: number): void => {
    const [x, y] = at(i);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, cell, cell);
    ctx.clip();
    for (let k = 0; k < puffs; k++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * cell * 0.22;
      const r = cell * (0.16 + rnd() * 0.18);
      const px = x + cell / 2 + Math.cos(a) * d, py = y + cell / 2 + Math.sin(a) * d;
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(255,255,255,${alpha})`);
      g.addColorStop(softness, `rgba(255,255,255,${alpha * 0.5})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, cell, cell);
    }
    ctx.restore();
  };

  // 0 soft glow
  radial(0, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]);
  // 1 spark streak (long axis = Y)
  {
    const [x, y] = at(1);
    const g = ctx.createLinearGradient(x + cell / 2 - 10, 0, x + cell / 2 + 10, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x + cell / 2, y + cell / 2, 9, cell * 0.46, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // 2 star flash
  {
    radial(2, [[0, 'rgba(255,255,255,1)'], [0.18, 'rgba(255,255,255,0.7)'], [0.5, 'rgba(255,255,255,0.1)'], [1, 'rgba(255,255,255,0)']]);
    const [x, y] = at(2);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 4; k++) {
      ctx.save();
      ctx.translate(x + cell / 2, y + cell / 2);
      ctx.rotate((k * Math.PI) / 4);
      const g = ctx.createLinearGradient(-cell / 2, 0, cell / 2, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, `rgba(255,255,255,${k % 2 ? 0.5 : 0.9})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-cell / 2, -2, cell, 4);
      ctx.restore();
    }
    ctx.restore();
  }
  // 3 ring
  radial(3, [[0, 'rgba(255,255,255,0)'], [0.7, 'rgba(255,255,255,0)'], [0.82, 'rgba(255,255,255,1)'], [0.95, 'rgba(255,255,255,0)'], [1, 'rgba(255,255,255,0)']]);
  // 4-7 smoke variants
  for (let i = 4; i < 8; i++) blob(i, 9, 0.45, 0.55);
  // 8-11 fire flipbook: dense → wispy
  for (let i = 8; i < 12; i++) blob(i, 12 - (i - 8) * 2, 0.3 + (i - 8) * 0.1, 0.9 - (i - 8) * 0.15);
  // 12 electric squiggle
  {
    const [x, y] = at(12);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.shadowColor = 'rgba(255,255,255,1)';
    ctx.shadowBlur = 8;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + cell / 2, y + 6);
    for (let k = 1; k < 9; k++) ctx.lineTo(x + cell / 2 + (rnd() - 0.5) * 40, y + 6 + (k / 8) * (cell - 12));
    ctx.stroke();
    ctx.restore();
  }
  // 13 chunk (shaded irregular shard)
  {
    const [x, y] = at(13);
    ctx.save();
    ctx.translate(x + cell / 2, y + cell / 2);
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const r = cell * (0.25 + rnd() * 0.15);
      if (k === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    const g = ctx.createLinearGradient(-cell / 3, -cell / 3, cell / 3, cell / 3);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(110,110,110,1)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }
  // 14 dust blotch
  blob(14, 14, 0.6, 0.35);
  // 15 nano (bright dot with cross)
  {
    radial(15, [[0, 'rgba(255,255,255,1)'], [0.15, 'rgba(255,255,255,0.8)'], [0.4, 'rgba(255,255,255,0.1)'], [1, 'rgba(255,255,255,0)']]);
    const [x, y] = at(15);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(x + cell / 2 - 1.5, y + cell * 0.25, 3, cell * 0.5);
    ctx.fillRect(x + cell * 0.25, y + cell / 2 - 1.5, cell * 0.5, 3);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}
