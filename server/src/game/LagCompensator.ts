import { MAX_PLAYERS, TICK_RATE, type HitTarget } from '@robot-arena/shared';

const FRAMES = TICK_RATE + 4;
const SLOTS = MAX_PLAYERS + 2;
/** id, alive, px, py, pz, qx, qy, qz, qw */
const STRIDE = 9;

export interface PoseSource {
  id: number;
  alive: boolean;
  p: { x: number; y: number; z: number };
  q: { x: number; y: number; z: number; w: number };
}

/**
 * Pose history of every robot for the last ~1 s of ticks, in a preallocated
 * ring. `sample` reconstructs the hitboxes as they were at an arbitrary past
 * server time (linear position, normalised-lerp rotation between ticks).
 */
export class LagCompensator {
  private readonly times = new Float64Array(FRAMES);
  private readonly counts = new Int32Array(FRAMES);
  private readonly data = new Float64Array(FRAMES * SLOTS * STRIDE);
  private head = -1;
  private size = 0;

  /** Records the post-step pose of every robot at server time `timeMs`. */
  record(timeMs: number, robots: Iterable<PoseSource>): void {
    this.head = (this.head + 1) % FRAMES;
    this.size = Math.min(FRAMES, this.size + 1);
    this.times[this.head] = timeMs;
    let n = 0;
    const base = this.head * SLOTS * STRIDE;
    for (const r of robots) {
      if (n >= SLOTS) break;
      const o = base + n * STRIDE;
      const d = this.data;
      d[o] = r.id;
      d[o + 1] = r.alive ? 1 : 0;
      d[o + 2] = r.p.x; d[o + 3] = r.p.y; d[o + 4] = r.p.z;
      d[o + 5] = r.q.x; d[o + 6] = r.q.y; d[o + 7] = r.q.z; d[o + 8] = r.q.w;
      n++;
    }
    this.counts[this.head] = n;
  }

  latestTime(): number {
    return this.size > 0 ? this.times[this.head] : 0;
  }

  oldestTime(): number {
    return this.size > 0 ? this.times[(this.head - this.size + 1 + FRAMES) % FRAMES] : 0;
  }

  /**
   * Fills `pool` with the living robots' poses at `timeMs` (clamped to the
   * recorded window) and returns how many entries were written.
   */
  sample(timeMs: number, pool: HitTarget[]): number {
    if (this.size === 0) return 0;
    // Find frames a (older) and b (newer) bracketing timeMs.
    let b = this.head;
    let a = b;
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - i + FRAMES) % FRAMES;
      a = idx;
      if (this.times[idx] <= timeMs) break;
      b = idx;
    }
    const ta = this.times[a], tb = this.times[b];
    const alpha = tb > ta ? Math.min(1, Math.max(0, (timeMs - ta) / (tb - ta))) : 0;
    const d = this.data;
    const baseA = a * SLOTS * STRIDE, baseB = b * SLOTS * STRIDE;
    const nA = this.counts[a], nB = this.counts[b];
    let out = 0;
    for (let i = 0; i < nB && out < pool.length; i++) {
      const ob = baseB + i * STRIDE;
      const id = d[ob];
      let oa = -1;
      for (let j = 0; j < nA; j++) {
        if (d[baseA + j * STRIDE] === id) {
          oa = baseA + j * STRIDE;
          break;
        }
      }
      // Alive in both frames (or only in the newer one when nothing older exists).
      if (oa < 0) oa = ob;
      if (d[oa + 1] === 0 || d[ob + 1] === 0) continue;
      const t = pool[out++];
      t.id = id;
      t.p.x = d[oa + 2] + (d[ob + 2] - d[oa + 2]) * alpha;
      t.p.y = d[oa + 3] + (d[ob + 3] - d[oa + 3]) * alpha;
      t.p.z = d[oa + 4] + (d[ob + 4] - d[oa + 4]) * alpha;
      // Teleports (respawn) never get interpolated across.
      const jump = Math.hypot(d[ob + 2] - d[oa + 2], d[ob + 3] - d[oa + 3], d[ob + 4] - d[oa + 4]);
      const s = jump > 4 ? 1 : alpha;
      if (s === 1) { t.p.x = d[ob + 2]; t.p.y = d[ob + 3]; t.p.z = d[ob + 4]; }
      let qx = d[ob + 5], qy = d[ob + 6], qz = d[ob + 7], qw = d[ob + 8];
      let ax = d[oa + 5], ay = d[oa + 6], az = d[oa + 7], aw = d[oa + 8];
      if (ax * qx + ay * qy + az * qz + aw * qw < 0) { ax = -ax; ay = -ay; az = -az; aw = -aw; }
      qx = ax + (qx - ax) * s; qy = ay + (qy - ay) * s; qz = az + (qz - az) * s; qw = aw + (qw - aw) * s;
      const ql = Math.hypot(qx, qy, qz, qw) || 1;
      t.q.x = qx / ql; t.q.y = qy / ql; t.q.z = qz / ql; t.q.w = qw / ql;
    }
    return out;
  }

  clear(): void {
    this.head = -1;
    this.size = 0;
  }
}
