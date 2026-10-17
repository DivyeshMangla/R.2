import * as THREE from 'three';
import { LookupTexture, LUT3DEffect } from 'postprocessing';

export interface GradingParams {
  /** Teal push into the shadows. */
  shadowTint: number;
  /** Warm push into the highlights. */
  highlightTint: number;
  saturation: number;
  contrast: number;
}

/**
 * Builds the colour-grading LUT procedurally from a neutral 32³ cube: teal
 * shadows, warm highlights, a gentle S-curve and saturation. Applied after
 * tone mapping (display-referred), like a film LUT.
 */
export function buildGradingLut(p: GradingParams): LookupTexture {
  const size = 32;
  const lut = LookupTexture.createNeutral(size);
  const data = lut.image.data as Float32Array;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const shadow = Math.pow(1 - lum, 2.2);
    const high = Math.pow(lum, 2.0);
    // Teal shadows, warm highlights.
    r += -0.04 * shadow * p.shadowTint + 0.05 * high * p.highlightTint;
    g += 0.015 * shadow * p.shadowTint + 0.02 * high * p.highlightTint;
    b += 0.05 * shadow * p.shadowTint - 0.04 * high * p.highlightTint;
    // Saturation around luminance.
    const l2 = r * 0.2126 + g * 0.7152 + b * 0.0722;
    r = l2 + (r - l2) * p.saturation;
    g = l2 + (g - l2) * p.saturation;
    b = l2 + (b - l2) * p.saturation;
    // S-curve contrast.
    const s = (x: number): number => {
      const c = THREE.MathUtils.clamp(x, 0, 1);
      const curve = c * c * (3 - 2 * c);
      return c + (curve - c) * p.contrast;
    };
    data[i] = s(r);
    data[i + 1] = s(g);
    data[i + 2] = s(b);
  }
  lut.needsUpdate = true;
  return lut;
}

export function createGradingEffect(p: GradingParams): LUT3DEffect {
  return new LUT3DEffect(buildGradingLut(p), { tetrahedralInterpolation: true });
}
