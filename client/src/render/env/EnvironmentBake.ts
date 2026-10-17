import * as THREE from 'three';

/**
 * Bakes the built arena (floodlights, emissive trims, sky) into a prefiltered
 * environment map, replacing the generic RoomEnvironment so reflections show
 * this arena. Runs once after the arena is built (and again when the preset's
 * envMapSize changes).
 */
export function bakeEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene, size: number): THREE.WebGLRenderTarget {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const prevEnv = scene.environment;
  const prevFog = scene.fog;
  scene.environment = null;
  // Fog would wash the cubemap out; reflections get the clear arena.
  scene.fog = null;
  const rt = pmrem.fromScene(scene, 0.03, 0.1, 300, { size, position: new THREE.Vector3(0, 5, 0) });
  scene.fog = prevFog;
  scene.environment = prevEnv;
  pmrem.dispose();
  return rt;
}
