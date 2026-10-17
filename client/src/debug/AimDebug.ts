import * as THREE from 'three';
import { hitboxPointWorld, ROBOT_HITBOX, type AimSolution, type HitTarget, type ShotResultMsg, type Vec3 } from '@robot-arena/shared';

const MAX_VERTS = 8192;
const LOG_ROWS = 12;
const PATH_TTL_S = 3;

const C_ENEMY = new THREE.Color(0x3dff6a);
const C_CLAMPED = new THREE.Color(0xff3b3b);
const C_BACKGROUND = new THREE.Color(0xffd23d);
const C_HITBOX = new THREE.Color(0x19d3ff);
const C_CLIENT = new THREE.Color(0x00ffff);
const C_SERVER_HIT = new THREE.Color(0xff3bff);
const C_SERVER_MISS = new THREE.Color(0xff8a3b);

interface TimedPath {
  points: Vec3[];
  color: THREE.Color;
  ttl: number;
}

export interface AimDebugFrame {
  camOrigin: Vec3;
  aim: AimSolution;
  pivot: Vec3;
  /** Robot hitboxes to outline (interpolated remotes + local). */
  targets: readonly HitTarget[];
  targetCount: number;
}

/**
 * F4: aim rays (camera -> aim point and hinge -> aim point; green = on an
 * enemy, red = pitch-clamped, yellow = background), hitbox wireframes,
 * client-predicted vs server-resolved shell paths and a hit log.
 * F5: side-view orthographic picture-in-picture along the aim with a 1 m grid.
 */
export class AimDebug {
  enabled = false;
  pip = false;
  private readonly positions = new Float32Array(MAX_VERTS * 3);
  private readonly colors = new Float32Array(MAX_VERTS * 3);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly lines: THREE.LineSegments;
  private count = 0;
  private readonly paths: TimedPath[] = [];
  private readonly log: HTMLDivElement;
  private readonly rows: string[] = [];
  private readonly ortho = new THREE.OrthographicCamera(-10, 10, 5, -5, 0.1, 400);
  private readonly grid: THREE.GridHelper;
  private readonly corner: Vec3 = { x: 0, y: 0, z: 0 };
  private lastFrame: AimDebugFrame | null = null;

  constructor(scene: THREE.Scene) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(this.geometry, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
    this.lines.renderOrder = 999;
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    scene.add(this.lines);

    // 1 m grid in a vertical plane, re-oriented to face the PiP camera each frame.
    this.grid = new THREE.GridHelper(60, 60, 0x88ccff, 0x2a4460);
    this.grid.visible = false;
    (this.grid.material as THREE.Material).depthTest = false;
    this.grid.renderOrder = 998;
    scene.add(this.grid);

    this.log = document.createElement('div');
    this.log.style.cssText =
      'position:fixed;left:12px;top:120px;z-index:40;font:11px/1.35 ui-monospace,monospace;color:#d8f4ff;' +
      'background:rgba(4,12,20,0.78);padding:6px 8px;border:1px solid rgba(25,211,255,0.35);border-radius:4px;' +
      'white-space:pre;pointer-events:none;display:none;max-width:560px;';
    document.body.appendChild(this.log);
  }

  toggle(): void {
    this.enabled = !this.enabled;
    this.lines.visible = this.enabled;
    this.log.style.display = this.enabled ? 'block' : 'none';
    this.renderLog();
  }

  togglePip(): void {
    this.pip = !this.pip;
  }

  /** Path the local prediction flew for one of our shells. */
  onClientPath(path: Vec3[]): void {
    if (!this.enabled || path.length < 2) return;
    this.paths.push({ points: path, color: C_CLIENT, ttl: PATH_TTL_S });
  }

  onShotResult(r: ShotResultMsg, targetName: string): void {
    this.paths.push({ points: [{ ...r.muzzle }, { ...r.point }], color: r.hit ? C_SERVER_HIT : C_SERVER_MISS, ttl: PATH_TTL_S });
    const deg = (v: number): string => ((v * 180) / Math.PI).toFixed(1).padStart(6);
    this.rows.unshift(
      `#${String(r.seq).padStart(6)}/${r.b} ${(r.hit ? 'HIT ' : 'MISS').padEnd(4)} ${r.reason.padEnd(14)} ` +
        `${(r.target >= 0 ? targetName : '-').padEnd(10)} dmg ${String(r.dmg).padStart(3)}  rewind ${String(r.rewindMs).padStart(3)}ms  ` +
        `yaw ${deg(r.aimYaw)} pitch ${deg(r.aimPitch)}${r.assisted ? '  assist' : ''}${!r.hit && r.closest >= 0 ? `  closest ${r.closest.toFixed(2)}m` : ''}`,
    );
    if (this.rows.length > LOG_ROWS) this.rows.length = LOG_ROWS;
    if (this.enabled) this.renderLog();
  }

  private renderLog(): void {
    this.log.textContent = `AIM DEBUG (F4)  F5 side view\ncyan = client path  magenta = server hit  orange = server miss\n\n${this.rows.join('\n') || 'no shots yet'}`;
  }

  /** Rebuilds the overlay lines for this frame. */
  update(frame: AimDebugFrame | null, dt: number): void {
    for (let i = this.paths.length - 1; i >= 0; i--) {
      this.paths[i].ttl -= dt;
      if (this.paths[i].ttl <= 0) this.paths.splice(i, 1);
    }
    this.lastFrame = frame;
    if (!this.enabled && !this.pip) return;
    this.count = 0;
    if (frame) {
      const a = frame.aim;
      const c = a.clamped ? C_CLAMPED : a.kind === 'robot' ? C_ENEMY : C_BACKGROUND;
      this.segment(frame.camOrigin, a.point, c);
      this.segment(frame.pivot, a.point, c);
      this.cross(a.point, 0.25, c);
      for (let i = 0; i < frame.targetCount; i++) this.hitbox(frame.targets[i]);
    }
    for (const p of this.paths) {
      for (let i = 1; i < p.points.length; i++) this.segment(p.points[i - 1], p.points[i], p.color);
      this.cross(p.points[p.points.length - 1], 0.15, p.color);
    }
    this.geometry.setDrawRange(0, this.count);
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  private vertex(p: Vec3, c: THREE.Color): void {
    if (this.count >= MAX_VERTS) return;
    const i = this.count * 3;
    this.positions[i] = p.x; this.positions[i + 1] = p.y; this.positions[i + 2] = p.z;
    this.colors[i] = c.r; this.colors[i + 1] = c.g; this.colors[i + 2] = c.b;
    this.count++;
  }

  private segment(a: Vec3, b: Vec3, c: THREE.Color): void {
    this.vertex(a, c);
    this.vertex(b, c);
  }

  private cross(p: Vec3, s: number, c: THREE.Color): void {
    this.segment({ x: p.x - s, y: p.y, z: p.z }, { x: p.x + s, y: p.y, z: p.z }, c);
    this.segment({ x: p.x, y: p.y - s, z: p.z }, { x: p.x, y: p.y + s, z: p.z }, c);
    this.segment({ x: p.x, y: p.y, z: p.z - s }, { x: p.x, y: p.y, z: p.z + s }, c);
  }

  private hitbox(t: HitTarget): void {
    const corners: Vec3[] = Array.from({ length: 8 }, () => ({ x: 0, y: 0, z: 0 }));
    for (const part of ROBOT_HITBOX) {
      for (let i = 0; i < 8; i++) {
        this.corner.x = part.center.x + (i & 1 ? part.half.x : -part.half.x);
        this.corner.y = part.center.y + (i & 2 ? part.half.y : -part.half.y);
        this.corner.z = part.center.z + (i & 4 ? part.half.z : -part.half.z);
        hitboxPointWorld(t, this.corner, corners[i]);
      }
      for (let i = 0; i < 8; i++) {
        for (const bit of [1, 2, 4]) if (!(i & bit)) this.segment(corners[i], corners[i | bit], C_HITBOX);
      }
    }
  }

  /**
   * Side view along the current aim, drawn into the bottom-right corner after
   * the main frame. Looks perpendicular to the hinge -> aim point line.
   */
  renderPip(gl: THREE.WebGLRenderer, scene: THREE.Scene): void {
    const f = this.lastFrame;
    if (!this.pip || !f) return;
    const a = f.aim;
    const mid = new THREE.Vector3((f.pivot.x + a.point.x) / 2, (f.pivot.y + a.point.y) / 2, (f.pivot.z + a.point.z) / 2);
    const along = new THREE.Vector3(a.point.x - f.pivot.x, 0, a.point.z - f.pivot.z);
    const span = Math.max(8, along.length() + 4);
    if (along.lengthSq() < 1e-6) along.set(0, 0, 1);
    along.normalize();
    const side = new THREE.Vector3(-along.z, 0, along.x);
    const size = gl.getSize(new THREE.Vector2());
    const w = Math.round(size.x * 0.34), h = Math.round(size.y * 0.3);
    const aspect = w / h;
    const halfW = span / 2;
    const halfH = halfW / aspect;
    const o = this.ortho;
    o.left = -halfW; o.right = halfW; o.top = halfH; o.bottom = -halfH;
    o.position.copy(mid).addScaledVector(side, 60);
    o.up.set(0, 1, 0);
    o.lookAt(mid);
    o.updateProjectionMatrix();

    // Grid in the vertical plane through the aim line, snapped to whole metres.
    this.grid.position.set(Math.round(mid.x), Math.round(mid.y), Math.round(mid.z));
    this.grid.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), side);
    const wasLines = this.lines.visible;
    this.lines.visible = true;
    this.grid.visible = true;

    const x = size.x - w - 12, y = 12;
    const prevAuto = gl.autoClear;
    gl.autoClear = false;
    gl.setScissorTest(true);
    gl.setScissor(x, y, w, h);
    gl.setViewport(x, y, w, h);
    gl.clearDepth();
    gl.render(scene, o);
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.x, size.y);
    gl.autoClear = prevAuto;

    this.grid.visible = false;
    this.lines.visible = wasLines;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.lines, this.grid);
    this.geometry.dispose();
    this.log.remove();
  }
}
