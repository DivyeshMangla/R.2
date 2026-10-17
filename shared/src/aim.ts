import { clamp, type Quat, type Vec3 } from './math';
import { hitboxCenter, hitboxPointWorld, ROBOT_HITBOX_CENTER, rotateInto, type HitTarget } from './hitbox';
import { physicsConfig } from './physicsConfig';
import { castHitTargets, makeEnvHit, makeRobotHit, type ProjectileWorld } from './projectile';
import { TWIN_BARREL_OFFSET } from './robotController';

/**
 * Turret geometry shared by the server (where shots spawn), the client (where
 * the barrel is drawn and the aim is solved) and the test harness.
 *
 * The turret ring sits on the chassis at TURRET_RING_Y (chassis space). The
 * head stays level in world space, so the barrel hinge is TURRET_HEAD_Y
 * straight up from the ring. Shells leave MUZZLE_DISTANCE along the aim
 * direction from that hinge, i.e. the muzzle always lies on the line from the
 * hinge to the aim point, so a shell passes exactly through the crosshair.
 */
export const TURRET_RING_Y = 0.5;
export const TURRET_HEAD_Y = 0.26;
export const MUZZLE_DISTANCE = 1.7;

const DEG = Math.PI / 180;

/** World-space barrel hinge for a chassis pose. */
export function getTurretPivot(p: Vec3, q: Quat, out: Vec3): Vec3 {
  _l.x = 0; _l.y = TURRET_RING_Y; _l.z = 0;
  rotateInto(q, _l, out);
  out.x += p.x;
  out.y += p.y + TURRET_HEAD_Y;
  out.z += p.z;
  return out;
}

/** Unit direction for a world yaw (0 = +Z, positive toward +X) and pitch (positive = up). */
export function aimDirection(yaw: number, pitch: number, out: Vec3): Vec3 {
  const c = Math.cos(pitch);
  out.x = Math.sin(yaw) * c;
  out.y = Math.sin(pitch);
  out.z = Math.cos(yaw) * c;
  return out;
}

export function clampAimPitch(pitch: number): number {
  return clamp(pitch, physicsConfig.aimPitchMinDeg * DEG, physicsConfig.aimPitchMaxDeg * DEG);
}

/** Lateral barrel offset for barrel `index` of `count`. */
function barrelLateral(index: number, count: number): number {
  if (count <= 1) return 0;
  return (index / (count - 1) - 0.5) * 2 * TWIN_BARREL_OFFSET;
}

/** World-space muzzle of barrel `index` (of `count`). */
export function getMuzzlePosition(p: Vec3, q: Quat, yaw: number, pitch: number, index: number, count: number, out: Vec3): Vec3 {
  getTurretPivot(p, q, out);
  aimDirection(yaw, pitch, _d);
  const lat = barrelLateral(index, count);
  // Right of the aim yaw is -X at yaw 0 (see shared/math.ts).
  out.x += _d.x * MUZZLE_DISTANCE - Math.cos(yaw) * lat;
  out.y += _d.y * MUZZLE_DISTANCE;
  out.z += _d.z * MUZZLE_DISTANCE + Math.sin(yaw) * lat;
  return out;
}

export interface ShotSpec {
  barrel: number;
  origin: Vec3;
  dir: Vec3;
}

/** Deterministic per-shot seed so client prediction and server pick the same spread. */
export function shotSeed(playerId: number, inputSeq: number, barrel: number): number {
  let h = (playerId * 0x9e3779b1) ^ (inputSeq * 0x85ebca6b) ^ (barrel * 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

function seededUnit(seed: number, salt: number): number {
  let h = Math.imul(seed ^ salt, 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/**
 * Every shell of one trigger pull. Twin barrels diverge by ±twinSpread in yaw;
 * aimSpreadDeg adds a seeded random cone. Allocates (once per shot, not per tick).
 */
export function computeShots(p: Vec3, q: Quat, aimYaw: number, aimPitch: number, count: number, playerId: number, inputSeq: number): ShotSpec[] {
  const cfg = physicsConfig;
  const pitch = clampAimPitch(aimPitch);
  const out: ShotSpec[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1) - 0.5;
    let yaw = aimYaw - t * cfg.twinSpread * 2;
    let pt = pitch;
    if (cfg.aimSpreadDeg > 0) {
      const seed = shotSeed(playerId, inputSeq, i);
      const r = Math.sqrt(seededUnit(seed, 1)) * cfg.aimSpreadDeg * DEG;
      const a = seededUnit(seed, 2) * Math.PI * 2;
      yaw += Math.cos(a) * r;
      pt += Math.sin(a) * r;
    }
    const origin = getMuzzlePosition(p, q, aimYaw, pitch, i, count, { x: 0, y: 0, z: 0 });
    out.push({ barrel: i, origin, dir: aimDirection(yaw, pt, { x: 0, y: 0, z: 0 }) });
  }
  return out;
}

export type AimHitKind = 'robot' | 'env' | 'sky';

export interface AimSolution {
  /** World point the camera centre ray resolved to. */
  point: Vec3;
  kind: AimHitKind;
  targetId: number;
  /** Turret yaw/pitch from the hinge to `point` (pitch clamped). */
  yaw: number;
  pitch: number;
  /** True when the pitch limit stopped the barrel reaching the point. */
  clamped: boolean;
  /** True when the aim depth came from a nearby enemy (floor retarget or depth snap). */
  retargeted: boolean;
  /** Distance from the hinge to `point`. */
  distance: number;
}

export function makeAimSolution(): AimSolution {
  return { point: { x: 0, y: 0, z: 0 }, kind: 'sky', targetId: -1, yaw: 0, pitch: 0, clamped: false, retargeted: false, distance: 0 };
}

export interface AimQuery {
  world: Pick<ProjectileWorld, 'castEnv'>;
  targets: readonly HitTarget[];
  targetCount: number;
  selfId: number;
  camOrigin: Vec3;
  camDir: Vec3;
  /** Barrel hinge of the shooter (getTurretPivot). */
  pivot: Vec3;
}

const _env = makeEnvHit();
const _robot = makeRobotHit();
const _start: Vec3 = { x: 0, y: 0, z: 0 };
const _c: Vec3 = { x: 0, y: 0, z: 0 };
const _p: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Resolves what the screen-centre ray is pointing at and the turret angles
 * needed to hit it. The ray starts at the point of the camera ray closest to
 * the hinge, so nothing between the camera and the shooter's own robot (or the
 * robot itself) can catch it. Robots are hitboxes, the arena is the Rapier
 * world; a floor hit within floorAimRadius of an enemy aims at that enemy.
 */
export function solveAim(q: AimQuery, out: AimSolution): AimSolution {
  const cfg = physicsConfig;
  const o = q.camOrigin, d = q.camDir;
  const along = Math.max(0, (q.pivot.x - o.x) * d.x + (q.pivot.y - o.y) * d.y + (q.pivot.z - o.z) * d.z);
  _start.x = o.x + d.x * along;
  _start.y = o.y + d.y * along;
  _start.z = o.z + d.z * along;
  const range = cfg.aimMaxRange;

  const envHit = q.world.castEnv(_start, d, range, _env);
  const reach = envHit ? _env.t : range;
  out.retargeted = false;
  if (castHitTargets(q.targets, q.targetCount, _start, d, reach, 0, 0, 0, q.selfId, _robot)) {
    out.kind = 'robot';
    out.targetId = _robot.targetId;
    setV(out.point, _robot.point);
  } else if (envHit) {
    out.kind = 'env';
    out.targetId = -1;
    setV(out.point, _env.point);
    if (!(_env.normal.y > 0.7 && retargetFloor(q, _env.t, out))) depthSnap(q, _env.t, out);
  } else {
    out.kind = 'sky';
    out.targetId = -1;
    out.point.x = _start.x + d.x * range;
    out.point.y = _start.y + d.y * range;
    out.point.z = _start.z + d.z * range;
    depthSnap(q, range, out);
  }
  return aimAnglesFrom(q.pivot, out.point, out);
}

/** Fills yaw/pitch/clamped/distance for the hinge -> point line. */
export function aimAnglesFrom(pivot: Vec3, point: Vec3, out: AimSolution): AimSolution {
  const dx = point.x - pivot.x, dy = point.y - pivot.y, dz = point.z - pivot.z;
  const flat = Math.hypot(dx, dz);
  out.distance = Math.hypot(flat, dy);
  out.yaw = Math.atan2(dx, dz);
  const raw = Math.atan2(dy, flat);
  out.pitch = clampAimPitch(raw);
  out.clamped = Math.abs(out.pitch - raw) > 1e-4;
  return out;
}

/** Point on the (shifted) camera ray at distance `t`. */
function rayPoint(q: AimQuery, t: number, out: Vec3): Vec3 {
  out.x = _start.x + q.camDir.x * t;
  out.y = _start.y + q.camDir.y * t;
  out.z = _start.z + q.camDir.z * t;
  return out;
}

/** Distance along the camera ray of its closest approach to `p`. */
function alongRay(q: AimQuery, p: Vec3): number {
  return (p.x - _start.x) * q.camDir.x + (p.y - _start.y) * q.camDir.y + (p.z - _start.z) * q.camDir.z;
}

/**
 * Crosshair on the floor next to an enemy: aim at that enemy instead of into
 * the floor. The aim point stays on the camera ray at the enemy's depth (so a
 * lead is kept) but is lifted to the hitbox-centre height.
 */
function retargetFloor(q: AimQuery, floorT: number, out: AimSolution): boolean {
  const r = physicsConfig.floorAimRadius;
  if (r <= 0) return false;
  let best = r;
  let bestIdx = -1;
  for (let i = 0; i < q.targetCount; i++) {
    const t = q.targets[i];
    if (t.id === q.selfId) continue;
    const dist = Math.hypot(t.p.x - out.point.x, t.p.z - out.point.z);
    // Footprint radius ~1.2 m: measure from the robot's edge, not its centre.
    const edge = Math.max(0, dist - 1.2);
    if (edge < best) {
      best = edge;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return false;
  const t = q.targets[bestIdx];
  hitboxCenter(t, _c);
  const along = Math.min(floorT, Math.max(0, alongRay(q, _c)));
  rayPoint(q, along, out.point);
  out.point.y = Math.max(out.point.y, _c.y);
  out.kind = 'robot';
  out.targetId = t.id;
  out.retargeted = true;
  return true;
}

/**
 * The crosshair is on background, but an enemy is near the ray (typically
 * because the player is leading it). Use the enemy's depth for the aim point:
 * the direction on screen is unchanged, only the camera/turret parallax is
 * resolved at the distance the player actually cares about.
 */
function depthSnap(q: AimQuery, maxT: number, out: AimSolution): void {
  const r = physicsConfig.aimDepthRadius;
  if (r <= 0) return;
  let best = r;
  let bestAlong = -1;
  let bestId = -1;
  for (let i = 0; i < q.targetCount; i++) {
    const t = q.targets[i];
    if (t.id === q.selfId) continue;
    hitboxCenter(t, _c);
    const along = alongRay(q, _c);
    // Behind the camera or behind the surface the crosshair is on: not this enemy.
    if (along <= 0 || along > maxT) continue;
    rayPoint(q, along, _p);
    const perp = Math.hypot(_p.x - _c.x, _p.y - _c.y, _p.z - _c.z);
    if (perp < best) {
      best = perp;
      bestAlong = along;
      bestId = t.id;
    }
  }
  if (bestAlong < 0) return;
  rayPoint(q, bestAlong, out.point);
  out.targetId = bestId;
  out.retargeted = true;
}

function setV(dst: Vec3, src: Vec3): void {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
}

/** Point to aim at on a target: the hitbox centre, or a chassis-space offset. */
export function targetAimPoint(t: HitTarget, out: Vec3, local: Readonly<Vec3> = ROBOT_HITBOX_CENTER): Vec3 {
  return hitboxPointWorld(t, local, out);
}

// ---------------------------------------------------------------------------
// Camera rig: the client orbit camera and the harness use the same placement
// so that "screen centre" means the same ray in both.
// ---------------------------------------------------------------------------

export interface CameraRig {
  /** Distance behind the look point along the view direction (m). */
  distance: number;
  /** Extra height of the camera above that orbit point (m). */
  height: number;
  /** Look point height above the chassis origin (m). */
  lookHeight: number;
}

export const DEFAULT_CAMERA_RIG: Readonly<CameraRig> = { distance: 7.5, height: 0.9, lookHeight: 1.5 };

/** Camera position for a robot position and view yaw/pitch; the camera looks along aimDirection(yaw, pitch). */
export function cameraOrigin(robotPos: Vec3, viewYaw: number, viewPitch: number, rig: Readonly<CameraRig>, out: Vec3): Vec3 {
  aimDirection(viewYaw, viewPitch, _d);
  out.x = robotPos.x - _d.x * rig.distance;
  out.y = robotPos.y + rig.lookHeight - _d.y * rig.distance + rig.height;
  out.z = robotPos.z - _d.z * rig.distance;
  return out;
}

const _l: Vec3 = { x: 0, y: 0, z: 0 };
const _d: Vec3 = { x: 0, y: 0, z: 0 };
