import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Merges the direct mesh children of `container` that share a material into a
 * single mesh each (nested groups are left alone so animated / swappable slots
 * keep their own transforms). Cuts per-robot draw calls by roughly 4x.
 */
export function mergeStaticChildren(container: THREE.Object3D): void {
  const buckets = new Map<THREE.Material, THREE.Mesh[]>();
  for (const child of container.children) {
    if (!(child instanceof THREE.Mesh) || Array.isArray(child.material) || !child.visible) continue;
    const list = buckets.get(child.material) ?? [];
    list.push(child);
    buckets.set(child.material, list);
  }
  for (const [material, meshes] of buckets) {
    if (meshes.length < 2) continue;
    const geos = meshes.map((m) => {
      m.updateMatrix();
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
      return g.applyMatrix4(m.matrix);
    });
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = meshes.some((m) => m.castShadow);
    mesh.receiveShadow = true;
    for (const m of meshes) {
      container.remove(m);
      if (!m.geometry.userData.shared) m.geometry.dispose();
    }
    container.add(mesh);
  }
}
