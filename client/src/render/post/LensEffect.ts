import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

const FRAG = /* glsl */ `
  uniform float uChroma;
  uniform float uBlur;
  uniform vec2 uCenter;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 d = uv - uCenter;
    float r2 = dot(d, d);
    vec3 col;
    if (uChroma > 1e-5) {
      // Radial chromatic aberration, stronger toward the edges.
      vec2 off = d * uChroma * (0.4 + r2 * 2.0);
      col.r = texture2D(inputBuffer, uv + off).r;
      col.g = inputColor.g;
      col.b = texture2D(inputBuffer, uv - off).b;
    } else {
      col = inputColor.rgb;
    }
    if (uBlur > 1e-4) {
      // Radial (zoom) blur toward the centre: dash speed lines.
      vec3 acc = col;
      float wsum = 1.0;
      for (int i = 1; i <= 8; i++) {
        float t = float(i) / 8.0;
        float w = 1.0 - t * 0.6;
        acc += texture2D(inputBuffer, uv - d * t * uBlur * 0.08 * (0.3 + r2 * 3.0)).rgb * w;
        wsum += w;
      }
      col = acc / wsum;
    }
    outputColor = vec4(col, inputColor.a);
  }
`;

/**
 * One convolution effect for two lens kicks: chromatic aberration pulses
 * (damage, EMP) and the radial dash motion blur. Both decay to zero, at which
 * point the shader takes the cheap path.
 */
export class LensEffect extends Effect {
  private chroma = 0;
  private blur = 0;

  constructor() {
    super('LensEffect', FRAG, {
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uChroma', new THREE.Uniform(0)],
        ['uBlur', new THREE.Uniform(0)],
        ['uCenter', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
      ]),
    });
  }

  pulseChroma(amount: number): void {
    this.chroma = Math.min(1, this.chroma + amount);
  }

  /** Sets the dash blur target (0..1); it decays on its own. */
  kickBlur(amount: number): void {
    this.blur = Math.max(this.blur, Math.min(1, amount));
  }

  get active(): boolean {
    return this.chroma > 1e-3 || this.blur > 1e-3;
  }

  tick(dt: number, chromaEnabled: boolean, blurEnabled: boolean): void {
    this.chroma = Math.max(0, this.chroma - dt * 2.2);
    this.blur = Math.max(0, this.blur - dt * 2.6);
    const u = this.uniforms;
    (u.get('uChroma') as THREE.Uniform<number>).value = chromaEnabled ? this.chroma * this.chroma * 0.008 : 0;
    (u.get('uBlur') as THREE.Uniform<number>).value = blurEnabled ? this.blur : 0;
  }
}
