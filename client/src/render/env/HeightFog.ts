import * as THREE from 'three';

let patched = false;

/**
 * Swaps three's linear-fog shader chunks for exponential *height* fog (the
 * exp2 path is left intact). Must run before any material compiles. World
 * height is reconstructed in the vertex shader from the view matrix:
 * world = camera + transpose(mat3(view)) * viewPos.
 */
export function installHeightFogChunks(): void {
  if (patched) return;
  patched = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = /* glsl */ `
    #ifdef USE_FOG
      varying float vFogDepth;
      varying vec3 vFogWorld;
    #endif`;
  C.fog_vertex = /* glsl */ `
    #ifdef USE_FOG
      vFogDepth = - mvPosition.z;
      vFogWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;
    #endif`;
  C.fog_pars_fragment = /* glsl */ `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      varying float vFogDepth;
      varying vec3 vFogWorld;
      #ifdef FOG_EXP2
        uniform float fogDensity;
      #else
        uniform float fogNear;
        uniform float fogFar;
      #endif
    #endif`;
  C.fog_fragment = /* glsl */ `
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
      #else
        // HeightFog: fogNear = density, fogFar = height falloff. Density decays with
        // the mean height of the view ray, so low ground haze thins out overhead.
        float fogDist = length(vFogWorld - cameraPosition);
        float fogY = max(0.5 * (cameraPosition.y + vFogWorld.y), 0.0);
        float fogFactor = 1.0 - exp( - fogNear * fogDist * exp( - fogFar * fogY ) );
      #endif
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
    #endif`;
}

/** Exponential height fog. Reuses Fog.near as density and Fog.far as height falloff (see the chunks above). */
export class HeightFog extends THREE.Fog {
  constructor(color: THREE.ColorRepresentation, density: number, falloff: number) {
    super(color, density, falloff);
    this.name = 'HeightFog';
  }

  get density(): number {
    return this.near;
  }

  set density(v: number) {
    this.near = v;
  }

  get falloff(): number {
    return this.far;
  }

  set falloff(v: number) {
    this.far = v;
  }
}
