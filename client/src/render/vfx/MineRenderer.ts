import * as THREE from 'three';

export interface MineSample {
  id: number;
  owner: number;
  x: number; y: number; z: number;
}

const MAX_MINES = 64;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();
const Y = new THREE.Vector3(0, 1, 0);

/**
 * Magnet mines in three draw calls: instanced metal bodies, blinking HDR
 * status lights (owner colour) and soft additive beacon cones.
 */
export class MineRenderer {
  private readonly body: THREE.InstancedMesh;
  private readonly light: THREE.InstancedMesh;
  private readonly beacon: THREE.InstancedMesh;

  constructor(scene: THREE.Scene) {
    const bodyGeo = new THREE.CylinderGeometry(0.32, 0.38, 0.18, 18);
    this.body = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0x23272e, metalness: 0.9, roughness: 0.35 }), MAX_MINES);
    this.body.castShadow = true;
    this.light = new THREE.InstancedMesh(new THREE.SphereGeometry(0.08, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_MINES);
    this.light.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MINES * 3), 3);
    const beaconGeo = new THREE.ConeGeometry(0.5, 2.2, 16, 1, true).translate(0, 1.1, 0).rotateX(Math.PI);
    beaconGeo.translate(0, 2.2, 0);
    this.beacon = new THREE.InstancedMesh(
      beaconGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      MAX_MINES,
    );
    this.beacon.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MINES * 3), 3);
    for (const m of [this.body, this.light, this.beacon]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }
    this.body.name = 'mines.body';
  }

  update(mines: readonly MineSample[], count: number, colorOf: (owner: number) => number, time: number): void {
    const n = Math.min(count, MAX_MINES);
    for (let i = 0; i < n; i++) {
      const s = mines[i];
      _q.setFromAxisAngle(Y, time * 1.5 + s.id);
      _m.compose(_p.set(s.x, s.y, s.z), _q, _s);
      this.body.setMatrixAt(i, _m);
      _m.compose(_p.set(s.x, s.y + 0.12, s.z), _q, _s);
      this.light.setMatrixAt(i, _m);
      _m.compose(_p.set(s.x, s.y, s.z), _q, _s);
      this.beacon.setMatrixAt(i, _m);
      const blink = Math.sin(time * 9 + s.id * 1.7) > 0 ? 6 : 0.6;
      _c.setHex(colorOf(s.owner));
      this.light.setColorAt(i, _c.multiplyScalar(blink));
      _c.setHex(colorOf(s.owner));
      this.beacon.setColorAt(i, _c.multiplyScalar(0.6 + 0.4 * Math.sin(time * 4 + s.id)));
    }
    this.body.count = this.light.count = this.beacon.count = n;
    this.body.instanceMatrix.needsUpdate = true;
    this.light.instanceMatrix.needsUpdate = true;
    this.beacon.instanceMatrix.needsUpdate = true;
    if (this.light.instanceColor) this.light.instanceColor.needsUpdate = true;
    if (this.beacon.instanceColor) this.beacon.instanceColor.needsUpdate = true;
  }
}
