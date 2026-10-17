import type { Quat, Vec3 } from './math';

/**
 * Projectile hitbox for a robot, in chassis space (+Z forward, origin = rigid
 * body origin). The physics collider is only the chassis slab; the visible
 * robot also has a turret on top and wheels below, so hit tests use this
 * compound of boxes instead. On flat ground the chassis origin rests ~0.644 m
 * above the floor, so the hitbox spans roughly 0.0 .. 1.6 m in world height.
 */
export interface HitboxPart {
  name: 'chassis' | 'turret' | 'wheels';
  center: Readonly<Vec3>;
  half: Readonly<Vec3>;
}

export const ROBOT_HITBOX: readonly HitboxPart[] = [
  { name: 'chassis', center: { x: 0, y: 0, z: 0 }, half: { x: 0.85, y: 0.3, z: 1.15 } },
  // Turret ring (0.5) up to the top of the turret head (0.96).
  { name: 'turret', center: { x: 0, y: 0.73, z: 0 }, half: { x: 0.45, y: 0.23, z: 0.5 } },
  // Wheel skirt: tyres stick out to x = 1.15 and reach down to the floor.
  { name: 'wheels', center: { x: 0, y: -0.375, z: 0 }, half: { x: 1.15, y: 0.27, z: 1.15 } },
];

/** Aim point used by bots and the test harness: the middle of the hitbox, chassis space. */
export const ROBOT_HITBOX_CENTER: Readonly<Vec3> = { x: 0, y: 0.16, z: 0 };

/** A robot pose that can be hit. Pools of these are reused; never hold references across ticks. */
export interface HitTarget {
  id: number;
  p: Vec3;
  q: Quat;
}

export function makeHitTarget(): HitTarget {
  return { id: -1, p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } };
}

export function copyHitTarget(src: HitTarget, dst: HitTarget): HitTarget {
  dst.id = src.id;
  dst.p.x = src.p.x; dst.p.y = src.p.y; dst.p.z = src.p.z;
  dst.q.x = src.q.x; dst.q.y = src.q.y; dst.q.z = src.q.z; dst.q.w = src.q.w;
  return dst;
}

export interface HitboxRayHit {
  /** Distance along the ray. */
  t: number;
  point: Vec3;
  normal: Vec3;
  part: number;
  /** True when only the aim-assist padding was touched, not the real hitbox. */
  assisted: boolean;
}

export function makeHitboxRayHit(): HitboxRayHit {
  return { t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, part: 0, assisted: false };
}

/** out = q * v (allocation-free). `out` may alias `v`. */
export function rotateInto(q: Quat, v: Vec3, out: Vec3): Vec3 {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  out.x = ix * q.w - iw * q.x - iy * q.z + iz * q.y;
  out.y = iy * q.w - iw * q.y - iz * q.x + ix * q.z;
  out.z = iz * q.w - iw * q.z - ix * q.y + iy * q.x;
  return out;
}

/** out = q^-1 * v (allocation-free). `out` may alias `v`. */
export function invRotateInto(q: Quat, v: Vec3, out: Vec3): Vec3 {
  _qi.x = -q.x; _qi.y = -q.y; _qi.z = -q.z; _qi.w = q.w;
  return rotateInto(_qi, v, out);
}

/** World-space point of a chassis-space offset on `target`. */
export function hitboxPointWorld(target: HitTarget, local: Readonly<Vec3>, out: Vec3): Vec3 {
  rotateInto(target.q, local, out);
  out.x += target.p.x; out.y += target.p.y; out.z += target.p.z;
  return out;
}

export function hitboxCenter(target: HitTarget, out: Vec3): Vec3 {
  return hitboxPointWorld(target, ROBOT_HITBOX_CENTER, out);
}

/** World-space [minY, maxY] covered by the hitbox (conservative for tilted robots). */
export function hitboxVerticalRange(target: HitTarget, out: { min: number; max: number }): { min: number; max: number } {
  let lo = Infinity, hi = -Infinity;
  for (const part of ROBOT_HITBOX) {
    for (let i = 0; i < 8; i++) {
      _c.x = part.center.x + (i & 1 ? part.half.x : -part.half.x);
      _c.y = part.center.y + (i & 2 ? part.half.y : -part.half.y);
      _c.z = part.center.z + (i & 4 ? part.half.z : -part.half.z);
      hitboxPointWorld(target, _c, _c);
      if (_c.y < lo) lo = _c.y;
      if (_c.y > hi) hi = _c.y;
    }
  }
  out.min = lo;
  out.max = hi;
  return out;
}

/** Closest point on the hitbox surface/volume to `point` (world space). Returns the distance. */
export function closestPointOnHitbox(target: HitTarget, point: Vec3, out: Vec3): number {
  _o.x = point.x - target.p.x; _o.y = point.y - target.p.y; _o.z = point.z - target.p.z;
  invRotateInto(target.q, _o, _o);
  let best = Infinity;
  for (const part of ROBOT_HITBOX) {
    const cx = clampAbs(_o.x - part.center.x, part.half.x) + part.center.x;
    const cy = clampAbs(_o.y - part.center.y, part.half.y) + part.center.y;
    const cz = clampAbs(_o.z - part.center.z, part.half.z) + part.center.z;
    const d = Math.hypot(_o.x - cx, _o.y - cy, _o.z - cz);
    if (d < best) {
      best = d;
      _c.x = cx; _c.y = cy; _c.z = cz;
    }
  }
  hitboxPointWorld(target, _c, out);
  return best;
}

function clampAbs(v: number, h: number): number {
  return v < -h ? -h : v > h ? h : v;
}

/**
 * Ray (or swept sphere of `radius`) against the robot hitbox. The sphere sweep
 * is approximated by inflating every box by `radius` (exact on faces, slightly
 * generous on edges). When nothing is hit and `padH`/`padV` are > 0, the boxes
 * are inflated further by those amounts (horizontally / vertically) and a hit
 * on that padding is reported with `assisted = true`.
 */
export function raycastHitbox(
  target: HitTarget,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  radius: number,
  padH: number,
  padV: number,
  out: HitboxRayHit,
): boolean {
  _o.x = origin.x - target.p.x; _o.y = origin.y - target.p.y; _o.z = origin.z - target.p.z;
  invRotateInto(target.q, _o, _o);
  invRotateInto(target.q, dir, _d);
  if (castParts(radius, radius, maxDist, out)) {
    out.assisted = false;
  } else if ((padH > 0 || padV > 0) && castParts(radius + padH, radius + padV, maxDist, out)) {
    // Padding is only a near-miss rescue: if the line goes on to touch the real
    // hitbox, report nothing now and let the real contact register.
    const padT = out.t;
    if (castParts(radius, radius, padT + 2 * (Math.max(padH, padV) + radius) + 1, out)) return false;
    out.t = padT;
    castParts(radius + padH, radius + padV, maxDist, out);
    out.assisted = true;
  } else {
    return false;
  }
  out.point.x = origin.x + dir.x * out.t;
  out.point.y = origin.y + dir.y * out.t;
  out.point.z = origin.z + dir.z * out.t;
  rotateInto(target.q, out.normal, out.normal);
  return true;
}

/** Slab test of the local ray (_o, _d) against every inflated part; writes t, part and local normal. */
function castParts(inflateH: number, inflateV: number, maxDist: number, out: HitboxRayHit): boolean {
  let bestT = Infinity;
  for (let i = 0; i < ROBOT_HITBOX.length; i++) {
    const part = ROBOT_HITBOX[i];
    let tEnter = -Infinity, tExit = Infinity, axis = 0, sign = 0;
    for (let a = 0; a < 3; a++) {
      const o = a === 0 ? _o.x - part.center.x : a === 1 ? _o.y - part.center.y : _o.z - part.center.z;
      const d = a === 0 ? _d.x : a === 1 ? _d.y : _d.z;
      const h = (a === 0 ? part.half.x : a === 1 ? part.half.y : part.half.z) + (a === 1 ? inflateV : inflateH);
      if (Math.abs(d) < 1e-9) {
        if (o < -h || o > h) { tEnter = Infinity; break; }
        continue;
      }
      let t0 = (-h - o) / d, t1 = (h - o) / d, s = -1;
      if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; s = 1; }
      if (t0 > tEnter) { tEnter = t0; axis = a; sign = s; }
      if (t1 < tExit) tExit = t1;
      if (tEnter > tExit) break;
    }
    if (tEnter > tExit || tExit < 0) continue;
    // A ray starting inside a part hits it immediately.
    const t = tEnter < 0 ? 0 : tEnter;
    if (t <= maxDist && t < bestT) {
      bestT = t;
      out.part = i;
      out.normal.x = axis === 0 ? sign : 0;
      out.normal.y = axis === 1 ? sign : 0;
      out.normal.z = axis === 2 ? sign : 0;
      if (tEnter < 0) { out.normal.x = -_d.x; out.normal.y = -_d.y; out.normal.z = -_d.z; }
    }
  }
  if (bestT === Infinity) return false;
  out.t = bestT;
  return true;
}

const _o: Vec3 = { x: 0, y: 0, z: 0 };
const _d: Vec3 = { x: 0, y: 0, z: 0 };
const _c: Vec3 = { x: 0, y: 0, z: 0 };
const _qi: Quat = { x: 0, y: 0, z: 0, w: 1 };
