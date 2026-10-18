/**
 * Every tunable physics / combat constant lives here. The object is mutable so
 * lil-gui can edit it live; the client forwards edits to the server so the
 * authoritative simulation and client prediction stay in agreement.
 */
export interface PhysicsConfig {
  gravity: number;

  // Chassis
  chassisMass: number;
  centerOfMassY: number;
  linearDamping: number;
  angularDamping: number;
  chassisFriction: number;
  chassisRestitution: number;

  // Drivetrain
  engineForce: number;
  reverseFactor: number;
  maxSpeed: number;
  brakeForce: number;
  rollingBrake: number;
  maxSteerAngle: number;
  steerSpeedFalloff: number;
  /** Steering response rate (1/s), shared by simulation and prediction. */
  steerResponse: number;
  /** Return-to-centre rate (1/s), faster than steering into a corner. */
  steerReturnResponse: number;
  /** Propulsion spool rate (1/s). Brakes bypass this filter. */
  throttleResponse: number;
  /** Comfortable full-lock lateral acceleration at speed (m/s²). */
  maxLateralAcceleration: number;
  /** Gentle grounded lateral-velocity damping (1/s), never a heading servo. */
  lateralDamping: number;
  downforce: number;

  // Suspension & tyres
  suspensionRestLength: number;
  suspensionStiffness: number;
  suspensionCompression: number;
  suspensionRelaxation: number;
  maxSuspensionTravel: number;
  maxSuspensionForce: number;
  wheelRadius: number;
  frictionSlip: number;
  sideFrictionStiffness: number;

  // Boost & dash
  boostForceMul: number;
  boostMaxSpeedMul: number;
  boostDrainPerSec: number;
  boostRegenPerSec: number;
  dashImpulse: number;
  dashCooldown: number;

  // Anti-flip
  antiFlipDelay: number;
  antiFlipTorque: number;
  antiFlipLift: number;

  // Weapons
  projectileSpeed: number;
  projectileLifetime: number;
  projectileImpulse: number;
  projectileDamage: number;
  fireInterval: number;
  twinSpread: number;
  /** Swept-sphere radius of a shell against robot hitboxes (m). */
  projectileRadius: number;
  /** Shell drop (m/s²). 0 = straight flight; the aim solver ignores drop. */
  projectileGravity: number;

  // Aim & hit registration
  aimPitchMinDeg: number;
  aimPitchMaxDeg: number;
  /** Aim distance used when the camera ray hits nothing (m). */
  aimMaxRange: number;
  /** Random cone half-angle per shot (deg), seeded so client and server agree. */
  aimSpreadDeg: number;
  /** A camera ray landing on the floor this close to an enemy retargets to that enemy (m). */
  floorAimRadius: number;
  /** Crosshair ray passing this close to an enemy aims at that enemy's depth (keeps lead, fixes parallax) (m). */
  aimDepthRadius: number;
  lagCompEnabled: number;
  lagCompMaxMs: number;
  /** Server fast-forwards the first part of each human shot by up to this many ms. */
  hitscanAssistMs: number;
  /** A shell cannot hit its own shooter for this long (s). */
  selfHitGraceS: number;
  aimAssistEnabled: number;
  /** Extra hitbox padding for human shots, horizontal / vertical (m). */
  aimAssistRadiusH: number;
  aimAssistRadiusV: number;
  aimAssistMaxRange: number;

  // Ramming
  ramMinSpeed: number;
  ramDamagePerMps: number;
  ramSelfDamageFraction: number;
  ramCooldown: number;
  ramImpulse: number;

  // Abilities / power-ups
  empRadius: number;
  empStunDuration: number;
  empCooldown: number;
  mineDamage: number;
  mineBlastRadius: number;
  mineTriggerRadius: number;
  mineSeekRadius: number;
  mineSpeed: number;
  mineLifetime: number;
  mineArmDelay: number;
  mineImpulse: number;

  // Death debris
  debrisImpulse: number;
  debrisLifetime: number;
}

export const DEFAULT_PHYSICS_CONFIG: Readonly<PhysicsConfig> = Object.freeze({
  gravity: 9.81 * 1.6,

  chassisMass: 360,
  centerOfMassY: -0.38,
  linearDamping: 0.035,
  angularDamping: 0.65,
  chassisFriction: 0.4,
  chassisRestitution: 0.15,

  engineForce: 1850,
  reverseFactor: 0.6,
  maxSpeed: 16,
  brakeForce: 17.5,
  rollingBrake: 2.4,
  maxSteerAngle: 0.60,
  steerSpeedFalloff: 0.025,
  steerResponse: 15,
  steerReturnResponse: 25,
  throttleResponse: 7,
  maxLateralAcceleration: 8,
  lateralDamping: 0.35,
  downforce: 0.2,

  suspensionRestLength: 0.32,
  suspensionStiffness: 34,
  suspensionCompression: 3.2,
  suspensionRelaxation: 3.8,
  maxSuspensionTravel: 0.3,
  maxSuspensionForce: 60000,
  wheelRadius: 0.38,
  frictionSlip: 2.6,
  sideFrictionStiffness: 1.0,

  boostForceMul: 1.4,
  boostMaxSpeedMul: 1.25,
  boostDrainPerSec: 38,
  boostRegenPerSec: 16,
  dashImpulse: 7,
  dashCooldown: 6,

  antiFlipDelay: 1.5,
  antiFlipTorque: 14,
  antiFlipLift: 19,

  projectileSpeed: 62,
  projectileLifetime: 1.6,
  projectileImpulse: 1050,
  projectileDamage: 17,
  fireInterval: 0.42,
  twinSpread: 0.07,
  projectileRadius: 0.15,
  projectileGravity: 0,

  aimPitchMinDeg: -15,
  aimPitchMaxDeg: 35,
  aimMaxRange: 120,
  aimSpreadDeg: 0,
  floorAimRadius: 1.5,
  aimDepthRadius: 8,
  lagCompEnabled: 1,
  lagCompMaxMs: 250,
  hitscanAssistMs: 100,
  selfHitGraceS: 0.1,
  aimAssistEnabled: 1,
  aimAssistRadiusH: 0.4,
  aimAssistRadiusV: 0.6,
  aimAssistMaxRange: 40,

  ramMinSpeed: 7,
  ramDamagePerMps: 2.6,
  ramSelfDamageFraction: 0.25,
  ramCooldown: 0.6,
  ramImpulse: 900,

  empRadius: 11,
  empStunDuration: 1.5,
  empCooldown: 15,
  mineDamage: 34,
  mineBlastRadius: 4.2,
  mineTriggerRadius: 2.3,
  mineSeekRadius: 15,
  mineSpeed: 6.5,
  mineLifetime: 12,
  mineArmDelay: 0.8,
  mineImpulse: 1800,

  debrisImpulse: 9,
  debrisLifetime: 5,
});

export const physicsConfig: PhysicsConfig = { ...DEFAULT_PHYSICS_CONFIG };

export type PhysicsConfigKey = keyof PhysicsConfig;

/** [min, max, step] ranges for live tuning; also used to validate remote edits. */
export const PHYSICS_CONFIG_RANGES: Readonly<Record<PhysicsConfigKey, readonly [number, number, number]>> = {
  gravity: [2, 40, 0.1],
  chassisMass: [80, 1500, 10],
  centerOfMassY: [-1, 0.4, 0.01],
  linearDamping: [0, 2, 0.01],
  angularDamping: [0, 6, 0.05],
  chassisFriction: [0, 2, 0.01],
  chassisRestitution: [0, 1, 0.01],
  engineForce: [500, 20000, 50],
  reverseFactor: [0.1, 1.5, 0.01],
  maxSpeed: [5, 60, 0.5],
  brakeForce: [0, 120, 1],
  rollingBrake: [0, 20, 0.1],
  maxSteerAngle: [0.1, 1.0, 0.01],
  steerSpeedFalloff: [0, 0.3, 0.005],
  steerResponse: [2, 30, 0.5],
  steerReturnResponse: [2, 40, 0.5],
  throttleResponse: [1, 30, 0.5],
  maxLateralAcceleration: [3, 20, 0.25],
  lateralDamping: [0, 3, 0.05],
  downforce: [0, 3, 0.01],
  suspensionRestLength: [0.05, 0.8, 0.01],
  suspensionStiffness: [5, 120, 0.5],
  suspensionCompression: [0.1, 15, 0.05],
  suspensionRelaxation: [0.1, 15, 0.05],
  maxSuspensionTravel: [0.05, 1, 0.01],
  maxSuspensionForce: [1000, 200000, 500],
  wheelRadius: [0.2, 0.7, 0.01],
  frictionSlip: [0.2, 12, 0.05],
  sideFrictionStiffness: [0.1, 4, 0.05],
  boostForceMul: [1, 4, 0.05],
  boostMaxSpeedMul: [1, 3, 0.05],
  boostDrainPerSec: [1, 200, 1],
  boostRegenPerSec: [1, 200, 1],
  dashImpulse: [0, 40, 0.5],
  dashCooldown: [0.5, 30, 0.5],
  antiFlipDelay: [0.1, 5, 0.05],
  antiFlipTorque: [0, 60, 0.5],
  antiFlipLift: [0, 60, 0.5],
  projectileSpeed: [10, 200, 1],
  projectileLifetime: [0.2, 5, 0.05],
  projectileImpulse: [0, 6000, 25],
  projectileDamage: [1, 100, 1],
  fireInterval: [0.05, 2, 0.01],
  twinSpread: [0, 0.4, 0.005],
  projectileRadius: [0, 0.6, 0.01],
  projectileGravity: [0, 30, 0.1],
  aimPitchMinDeg: [-45, 0, 1],
  aimPitchMaxDeg: [0, 80, 1],
  aimMaxRange: [20, 300, 1],
  aimSpreadDeg: [0, 5, 0.05],
  floorAimRadius: [0, 4, 0.05],
  aimDepthRadius: [0, 20, 0.25],
  lagCompEnabled: [0, 1, 1],
  lagCompMaxMs: [0, 500, 5],
  hitscanAssistMs: [0, 250, 5],
  selfHitGraceS: [0, 0.5, 0.01],
  aimAssistEnabled: [0, 1, 1],
  aimAssistRadiusH: [0, 1.5, 0.01],
  aimAssistRadiusV: [0, 1.5, 0.01],
  aimAssistMaxRange: [0, 120, 1],
  ramMinSpeed: [0, 30, 0.5],
  ramDamagePerMps: [0, 20, 0.1],
  ramSelfDamageFraction: [0, 1, 0.01],
  ramCooldown: [0.05, 3, 0.05],
  ramImpulse: [0, 5000, 25],
  empRadius: [1, 40, 0.5],
  empStunDuration: [0.1, 5, 0.05],
  empCooldown: [1, 60, 0.5],
  mineDamage: [1, 150, 1],
  mineBlastRadius: [0.5, 15, 0.1],
  mineTriggerRadius: [0.5, 10, 0.1],
  mineSeekRadius: [1, 50, 0.5],
  mineSpeed: [0, 30, 0.5],
  mineLifetime: [1, 60, 0.5],
  mineArmDelay: [0, 5, 0.05],
  mineImpulse: [0, 8000, 50],
  debrisImpulse: [0, 40, 0.5],
  debrisLifetime: [0.5, 20, 0.5],
};

export function isPhysicsConfigKey(key: string): key is PhysicsConfigKey {
  return Object.prototype.hasOwnProperty.call(DEFAULT_PHYSICS_CONFIG, key);
}

/** Validates and applies a tuning edit. Returns the clamped applied value, or null if rejected. */
export function applyPhysicsTuning(key: string, value: unknown): number | null {
  if (!isPhysicsConfigKey(key) || typeof value !== 'number' || !Number.isFinite(value)) return null;
  const [min, max] = PHYSICS_CONFIG_RANGES[key];
  const v = Math.min(max, Math.max(min, value));
  physicsConfig[key] = v;
  return v;
}

export function replacePhysicsConfig(values: Partial<Record<string, unknown>>): void {
  for (const [k, v] of Object.entries(values)) applyPhysicsTuning(k, v);
}
