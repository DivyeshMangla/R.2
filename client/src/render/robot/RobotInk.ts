import * as THREE from 'three';

export interface InkPart {
  geometry: THREE.BufferGeometry;
  perRobot: number;
  /** Crease threshold in degrees (default 26). */
  inkAngle?: number;
}

/** One instanced line draw outlines the whole fleet, using the same part transforms as its meshes. */
export class RobotInk {
  readonly lines: THREE.LineSegments<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly offsets: number[] = [];
  private readonly data: Float32Array;
  private readonly texture: THREE.DataTexture;
  private readonly stride: number;

  constructor(parts: readonly InkPart[], capacity: number) {
    const positions: number[] = [], transforms: number[] = [];
    let stride = 0;
    for (const part of parts) {
      this.offsets.push(stride);
      const edges = new THREE.EdgesGeometry(part.geometry, part.inkAngle ?? 26);
      const p = edges.getAttribute('position');
      for (let k = 0; k < part.perRobot; k++) {
        for (let i = 0; i < p.count; i++) {
          positions.push(p.getX(i), p.getY(i), p.getZ(i));
          transforms.push(stride + k);
        }
      }
      stride += part.perRobot;
      edges.dispose();
    }
    this.stride = stride;
    this.data = new Float32Array(capacity * stride * 16);
    this.texture = new THREE.DataTexture(this.data, 4, capacity * stride, THREE.RGBAFormat, THREE.FloatType);
    this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aTransform', new THREE.Float32BufferAttribute(transforms, 1));
    geometry.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: { uTransforms: { value: this.texture }, uStride: { value: stride }, uInk: { value: new THREE.Color(0x272323) } },
      vertexShader: `uniform sampler2D uTransforms;uniform int uStride;attribute float aTransform;
        void main(){int row=gl_InstanceID*uStride+int(aTransform+.5);mat4 m=mat4(texelFetch(uTransforms,ivec2(0,row),0),texelFetch(uTransforms,ivec2(1,row),0),texelFetch(uTransforms,ivec2(2,row),0),texelFetch(uTransforms,ivec2(3,row),0));
          vec4 p=projectionMatrix*viewMatrix*modelMatrix*m*vec4(position,1.);p.z-=.00015*p.w;gl_Position=p;}`,
      fragmentShader: `uniform vec3 uInk;void main(){gl_FragColor=vec4(uInk,1.);
        #include <colorspace_fragment>
      }`,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(geometry, material);
    this.lines.name = 'robot.ink';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 1;
  }

  set(slot: number, transform: number, matrix: THREE.Matrix4): void {
    this.data.set(matrix.elements, (slot * this.stride + transform) * 16);
  }

  commit(count: number): void {
    this.lines.geometry.instanceCount = count;
    this.texture.needsUpdate = true;
  }
}
