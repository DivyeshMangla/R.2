import RAPIER from '@dimforge/rapier3d-compat';
import type { World } from '@dimforge/rapier3d-compat';
import { CollisionGroups } from './collisionGroups';
import { makeHitboxRayHit, raycastHitbox, type HitboxRayHit, type HitTarget } from './hitbox';
import type { Vec3 } from './math';
import { physicsConfig } from './physicsConfig';

export interface ProjectileState {
  id: number;
  owner: number;
  pos: Vec3;
  vel: Vec3;
  bouncesLeft: number;
  age: number;
  lifetime: number;
  damage: number;
  knockback: number;
  /** Swept-sphere radius against robot hitboxes. */
  radius: number;
  /** Aim-assist padding applies to this shell (human shots only). */
  assist: boolean;
  /** Distance travelled so far (m). */
  dist: number;
}

export interface EnvHit {
  t: number;
  point: Vec3;
  normal: Vec3;
  /** Rapier collider handle (map to the arena block kind for surface effects). */
  handle: number;
}

export interface RobotHit extends HitboxRayHit {
  targetId: number;
}

export function makeEnvHit(): EnvHit {
  return { t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, handle: -1 };
}

export function makeRobotHit(): RobotHit {
  return { ...makeHitboxRayHit(), targetId: -1 };
}

/**
 * What a projectile can collide with. The environment is the static Rapier
 * world; robots are analytic hitboxes so the server can test them at rewound
 * (lag-compensated) poses without touching the physics world.
 */
export interface ProjectileWorld {
  castEnv(origin: Vec3, dir: Vec3, maxDist: number, out: EnvHit): boolean;
  /** Nearest robot hit along the ray, skipping `ignoreId`. Pads are 0 when assist is off. */
  castRobots(origin: Vec3, dir: Vec3, maxDist: number, radius: number, padH: number, padV: number, ignoreId: number, out: RobotHit): boolean;
}

export const StepKind = {
  FLY: 0,
  EXPIRE: 1,
  BOUNCE: 2,
  HIT_ENV: 3,
  HIT_ROBOT: 4,
} as const;
export type StepKindValue = (typeof StepKind)[keyof typeof StepKind];

export interface StepResult {
  kind: StepKindValue;
  point: Vec3;
  normal: Vec3;
  targetId: number;
  assisted: boolean;
  /** Environment collider handle for BOUNCE / HIT_ENV (-1 otherwise). */
  envHandle: number;
}

export function makeStepResult(): StepResult {
  return { kind: StepKind.FLY, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, targetId: -1, assisted: false, envHandle: -1 };
}

const _dir: Vec3 = { x: 0, y: 0, z: 0 };
const _env = makeEnvHit();
const _robot = makeRobotHit();

/**
 * Advances one projectile by `dt`: gravity, then a swept segment against the
 * environment (bouncing while it has bounces left) and robot hitboxes.
 * Mutates `p` and writes the outcome into `out` (allocation-free).
 */
export function stepProjectile(world: ProjectileWorld, p: ProjectileState, dt: number, out: StepResult): StepKindValue {
  const cfg = physicsConfig;
  out.targetId = -1;
  out.assisted = false;
  out.envHandle = -1;
  p.age += dt;
  if (p.age > p.lifetime) return (out.kind = StepKind.EXPIRE);
  p.vel.y -= cfg.projectileGravity * dt;
  const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
  if (speed < 1e-4) return (out.kind = StepKind.EXPIRE);
  _dir.x = p.vel.x / speed;
  _dir.y = p.vel.y / speed;
  _dir.z = p.vel.z / speed;
  const travel = speed * dt;

  const envHit = world.castEnv(p.pos, _dir, travel, _env);
  const reach = envHit ? _env.t : travel;
  const assistOn = p.assist && cfg.aimAssistEnabled > 0 && p.dist < cfg.aimAssistMaxRange;
  const padH = assistOn ? cfg.aimAssistRadiusH : 0;
  const padV = assistOn ? cfg.aimAssistRadiusV : 0;
  const ignore = p.age < cfg.selfHitGraceS ? p.owner : -1;
  if (world.castRobots(p.pos, _dir, reach, p.radius, padH, padV, ignore, _robot)) {
    p.pos.x += _dir.x * _robot.t;
    p.pos.y += _dir.y * _robot.t;
    p.pos.z += _dir.z * _robot.t;
    p.dist += _robot.t;
    copy(_robot.point, out.point);
    copy(_robot.normal, out.normal);
    out.targetId = _robot.targetId;
    out.assisted = _robot.assisted;
    return (out.kind = StepKind.HIT_ROBOT);
  }
  if (!envHit) {
    p.pos.x += _dir.x * travel;
    p.pos.y += _dir.y * travel;
    p.pos.z += _dir.z * travel;
    p.dist += travel;
    return (out.kind = StepKind.FLY);
  }

  let nx = _env.normal.x, ny = _env.normal.y, nz = _env.normal.z;
  if (nx * _dir.x + ny * _dir.y + nz * _dir.z > 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  out.normal.x = nx; out.normal.y = ny; out.normal.z = nz;
  copy(_env.point, out.point);
  out.envHandle = _env.handle;
  p.dist += _env.t;
  if (p.bouncesLeft > 0) {
    p.bouncesLeft -= 1;
    const d = 2 * (p.vel.x * nx + p.vel.y * ny + p.vel.z * nz);
    p.vel.x -= d * nx;
    p.vel.y -= d * ny;
    p.vel.z -= d * nz;
    p.pos.x = _env.point.x + nx * 0.05;
    p.pos.y = _env.point.y + ny * 0.05;
    p.pos.z = _env.point.z + nz * 0.05;
    return (out.kind = StepKind.BOUNCE);
  }
  copy(_env.point, p.pos);
  return (out.kind = StepKind.HIT_ENV);
}

function copy(a: Vec3, b: Vec3): void {
  b.x = a.x; b.y = a.y; b.z = a.z;
}

/** Allocation-free environment-only ray caster over a Rapier world. */
export function createEnvCaster(world: World): ProjectileWorld['castEnv'] {
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  return (origin, dir, maxDist, out) => {
    ray.origin = origin;
    ray.dir = dir;
    const hit = world.castRayAndGetNormal(ray, maxDist, true, undefined, CollisionGroups.ENV_QUERY);
    if (!hit) return false;
    out.t = hit.timeOfImpact;
    out.point.x = origin.x + dir.x * out.t;
    out.point.y = origin.y + dir.y * out.t;
    out.point.z = origin.z + dir.z * out.t;
    out.normal.x = hit.normal.x;
    out.normal.y = hit.normal.y;
    out.normal.z = hit.normal.z;
    out.handle = hit.collider.handle;
    return true;
  };
}

const _probe = makeHitboxRayHit();

/** castRobots over a list of hit targets (the first `count` entries). */
export function castHitTargets(
  targets: readonly HitTarget[],
  count: number,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  radius: number,
  padH: number,
  padV: number,
  ignoreId: number,
  out: RobotHit,
): boolean {
  let found = false;
  for (let i = 0; i < count; i++) {
    const t = targets[i];
    if (t.id === ignoreId) continue;
    if (!raycastHitbox(t, origin, dir, maxDist, radius, padH, padV, _probe)) continue;
    // A real hit beats any assisted one; otherwise the nearest wins.
    if (found) {
      if (_probe.assisted && !out.assisted) continue;
      if (_probe.assisted === out.assisted && _probe.t >= out.t) continue;
    }
    found = true;
    out.t = _probe.t;
    out.part = _probe.part;
    out.assisted = _probe.assisted;
    out.targetId = t.id;
    copy(_probe.point, out.point);
    copy(_probe.normal, out.normal);
  }
  return found;
}
