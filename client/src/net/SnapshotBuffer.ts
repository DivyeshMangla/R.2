import * as THREE from 'three';
import { decodeRobot, lerpAngle, type MineWire, type RobotNetState, type SnapshotMsg } from '@robot-arena/shared';

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

  /** Finds the snapshot pair bracketing `t`. */
  private bracket(t: number): [StoredSnapshot, StoredSnapshot, number] | null {
    const s = this.snaps;
    if (s.length === 0) return null;
    if (s.length === 1 || t <= s[0].t) return [s[0], s[0], 0];
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1];
      const b = s[i];
      if (t >= a.t) {
        const span = b.t - a.t;
        return [a, b, span > 0 ? (t - a.t) / span : 1];
      }
    }
    return [s[0], s[0], 0];
  }

  sample(id: number, renderT: number, out: InterpolatedRobot | null): InterpolatedRobot | null {
    const br = this.bracket(renderT);
    if (!br) return null;
    const [a, b, alpha] = br;
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
    res.steer = sa.steer + (sb.steer - sa.steer) * t;
    res.throttle = sb.throttle;
    return res;
  }

  /** Mines interpolated by id between the bracketing snapshots. */
  sampleMines(renderT: number): { id: number; owner: number; p: THREE.Vector3 }[] {
    const br = this.bracket(renderT);
    if (!br) return [];
    const [a, b, alpha] = br;
    const prev = new Map<number, MineWire>(a.mines.map((m) => [m[0], m]));
    const t = Math.min(1, Math.max(0, alpha));
    return b.mines.map((m) => {
      const pm = prev.get(m[0]) ?? m;
      return {
        id: m[0],
        owner: m[4],
        p: new THREE.Vector3((pm[1] + (m[1] - pm[1]) * t) / 100, (pm[2] + (m[2] - pm[2]) * t) / 100, (pm[3] + (m[3] - pm[3]) * t) / 100),
      };
    });
  }

  clear(): void {
    this.snaps.length = 0;
  }
}

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
