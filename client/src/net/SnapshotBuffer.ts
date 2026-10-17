import * as THREE from 'three';
import { decodeRobot, lerpAngle, type MineWire, type RobotNetState, type SnapshotMsg } from '@robot-arena/shared';
import type { MineSample } from '../render/vfx/MineRenderer';

export interface StoredSnapshot {
  t: number;
  phase: number;
  left: number;
  robots: Map<number, RobotNetState>;
  mines: MineWire[];
}

export interface InterpolatedRobot {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  aimYaw: number;
  aimPitch: number;
  steer: number;
  throttle: number;
  /** Latest authoritative state for non-pose fields (hp, flags...). */
  latest: RobotNetState;
}

const KEEP_MS = 1500;
const MAX_EXTRAPOLATE_MS = 120;

/** Time-ordered snapshot history used to render remote entities ~100 ms in the past. */
export class SnapshotBuffer {
  private readonly snaps: StoredSnapshot[] = [];

  push(msg: SnapshotMsg): StoredSnapshot {
    const robots = new Map<number, RobotNetState>();
    for (const w of msg.r) {
      const s = decodeRobot(w);
      robots.set(s.id, s);
    }
    const snap: StoredSnapshot = { t: msg.t, phase: msg.phase, left: msg.left, robots, mines: msg.m };
    const last = this.snaps[this.snaps.length - 1];
    if (last && snap.t <= last.t) return last;
    this.snaps.push(snap);
    const cutoff = snap.t - KEEP_MS;
    while (this.snaps.length > 2 && this.snaps[0].t < cutoff) this.snaps.shift();
    return snap;
  }

  latest(): StoredSnapshot | undefined {
    return this.snaps[this.snaps.length - 1];
  }

  // Result of the last bracket() call (fields, so sampling never allocates).
  private brA: StoredSnapshot | null = null;
  private brB: StoredSnapshot | null = null;
  private brAlpha = 0;

  /** Finds the snapshot pair bracketing `t` into brA / brB / brAlpha. */
  private bracket(t: number): boolean {
    const s = this.snaps;
    if (s.length === 0) return false;
    if (s.length === 1 || t <= s[0].t) {
      this.brA = this.brB = s[0];
      this.brAlpha = 0;
      return true;
    }
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1];
      const b = s[i];
      if (t >= a.t) {
        const span = b.t - a.t;
        this.brA = a;
        this.brB = b;
        this.brAlpha = span > 0 ? (t - a.t) / span : 1;
        return true;
      }
    }
    this.brA = this.brB = s[0];
    this.brAlpha = 0;
    return true;
  }

  sample(id: number, renderT: number, out: InterpolatedRobot | null): InterpolatedRobot | null {
    if (!this.bracket(renderT) || !this.brA || !this.brB) return null;
    const a = this.brA, b = this.brB, alpha = this.brAlpha;
    const latestSnap = this.latest();
    const latest = latestSnap?.robots.get(id);
    if (!latest) return null;
    let sa = a.robots.get(id);
    let sb = b.robots.get(id);
    if (!sa && !sb) sa = sb = latest;
    if (!sa) sa = sb;
    if (!sb) sb = sa;
    if (!sa || !sb) return null;
    // Never interpolate across a respawn/teleport.
    if (sa.spawnCount !== sb.spawnCount) sa = sb;
    if (sb.spawnCount !== latest.spawnCount) sa = sb = latest;

    const res =
      out ??
      {
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        velocity: new THREE.Vector3(),
        aimYaw: 0,
        aimPitch: 0,
        steer: 0,
        throttle: 0,
        latest,
      };
    res.latest = latest;

    let t = Math.min(1, Math.max(0, alpha));
    let extrapolateS = 0;
    if (b === latestSnap && renderT > b.t) {
      t = 1;
      extrapolateS = Math.min(renderT - b.t, MAX_EXTRAPOLATE_MS) / 1000;
    }

    res.position.set(sa.p.x + (sb.p.x - sa.p.x) * t, sa.p.y + (sb.p.y - sa.p.y) * t, sa.p.z + (sb.p.z - sa.p.z) * t);
    res.velocity.set(sa.v.x + (sb.v.x - sa.v.x) * t, sa.v.y + (sb.v.y - sa.v.y) * t, sa.v.z + (sb.v.z - sa.v.z) * t);
    if (extrapolateS > 0) res.position.addScaledVector(res.velocity, extrapolateS);
    qa.set(sa.q.x, sa.q.y, sa.q.z, sa.q.w);
    qb.set(sb.q.x, sb.q.y, sb.q.z, sb.q.w);
    res.quaternion.slerpQuaternions(qa, qb, t);
    res.aimYaw = lerpAngle(sa.aimYaw, sb.aimYaw, t);
    res.aimPitch = sa.aimPitch + (sb.aimPitch - sa.aimPitch) * t;
    res.steer = sa.steer + (sb.steer - sa.steer) * t;
    res.throttle = sb.throttle;
    return res;
  }

  /**
   * Mines interpolated by id between the bracketing snapshots, written into
   * `out` (grown on demand, reused every frame). Returns the count.
   */
  sampleMines(renderT: number, out: MineSample[]): number {
    if (!this.bracket(renderT) || !this.brA || !this.brB) return 0;
    const a = this.brA, b = this.brB, alpha = this.brAlpha;
    const t = Math.min(1, Math.max(0, alpha));
    let n = 0;
    for (const m of b.mines) {
      let pm = m;
      for (const o of a.mines) {
        if (o[0] === m[0]) {
          pm = o;
          break;
        }
      }
      if (n >= out.length) out.push({ id: 0, owner: 0, x: 0, y: 0, z: 0 });
      const s = out[n++];
      s.id = m[0];
      s.owner = m[4];
      s.x = (pm[1] + (m[1] - pm[1]) * t) / 100;
      s.y = (pm[2] + (m[2] - pm[2]) * t) / 100;
      s.z = (pm[3] + (m[3] - pm[3]) * t) / 100;
    }
    return n;
  }

  clear(): void {
    this.snaps.length = 0;
  }
}

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
