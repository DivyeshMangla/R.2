import type { PhysicsConfig } from './physicsConfig';
import type { PowerUpId, PowerUpStacks } from './powerups';
import type { Quat, Vec3 } from './math';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const Buttons = {
  FIRE: 1,
  BOOST: 2,
  ABILITY: 4,
} as const;

export interface InputFrame {
  seq: number;
  /** -1..1 */
  throttle: number;
  /** -1..1, positive = turn right */
  steer: number;
  /** World yaw of the turret, radians. */
  aimYaw: number;
  buttons: number;
}

/** Compact wire form: [seq, throttle*127, steer*127, aimYaw*1000, buttons]. */
export type InputWire = [number, number, number, number, number];

export function encodeInput(f: InputFrame): InputWire {
  return [f.seq, Math.round(f.throttle * 127), Math.round(f.steer * 127), Math.round(f.aimYaw * 1000), f.buttons];
}

export function decodeInput(w: unknown): InputFrame | null {
  if (!Array.isArray(w) || w.length !== 5) return null;
  for (const n of w) if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const [seq, t, s, a, b] = w as InputWire;
  return {
    seq: Math.floor(seq),
    throttle: Math.max(-1, Math.min(1, t / 127)),
    steer: Math.max(-1, Math.min(1, s / 127)),
    aimYaw: a / 1000,
    buttons: b & 7,
  };
}

export function emptyInput(seq = 0): InputFrame {
  return { seq, throttle: 0, steer: 0, aimYaw: 0, buttons: 0 };
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export const RobotFlags = {
  ALIVE: 1,
  STUNNED: 2,
  BOOSTING: 4,
  PROTECTED: 8,
  BOT: 16,
} as const;

export interface RobotNetState {
  id: number;
  p: Vec3;
  q: Quat;
  v: Vec3;
  w: Vec3;
  hp: number;
  maxHp: number;
  flags: number;
  aimYaw: number;
  steer: number;
  throttle: number;
  lastSeq: number;
  boostEnergy: number;
  dashCooldown: number;
  empCooldown: number;
  flipTimer: number;
  spawnCount: number;
  fireCooldown: number;
}

export type RobotWire = number[];

const POS_Q = 1000;
const ROT_Q = 10000;
const VEL_Q = 100;

export function encodeRobot(s: RobotNetState): RobotWire {
  return [
    s.id,
    Math.round(s.p.x * POS_Q), Math.round(s.p.y * POS_Q), Math.round(s.p.z * POS_Q),
    Math.round(s.q.x * ROT_Q), Math.round(s.q.y * ROT_Q), Math.round(s.q.z * ROT_Q), Math.round(s.q.w * ROT_Q),
    Math.round(s.v.x * VEL_Q), Math.round(s.v.y * VEL_Q), Math.round(s.v.z * VEL_Q),
    Math.round(s.w.x * VEL_Q), Math.round(s.w.y * VEL_Q), Math.round(s.w.z * VEL_Q),
    Math.round(s.hp * 10), Math.round(s.maxHp),
    s.flags,
    Math.round(s.aimYaw * 1000),
    Math.round(s.steer * 100),
    Math.round(s.throttle * 100),
    s.lastSeq,
    Math.round(s.boostEnergy * 10),
    Math.round(s.dashCooldown * 100),
    Math.round(s.empCooldown * 100),
    Math.round(s.flipTimer * 100),
    s.spawnCount,
    Math.round(s.fireCooldown * 1000),
  ];
}

export function decodeRobot(w: RobotWire): RobotNetState {
  const qx = w[4] / ROT_Q, qy = w[5] / ROT_Q, qz = w[6] / ROT_Q, qw = w[7] / ROT_Q;
  const ql = Math.hypot(qx, qy, qz, qw) || 1;
  return {
    id: w[0],
    p: { x: w[1] / POS_Q, y: w[2] / POS_Q, z: w[3] / POS_Q },
    q: { x: qx / ql, y: qy / ql, z: qz / ql, w: qw / ql },
    v: { x: w[8] / VEL_Q, y: w[9] / VEL_Q, z: w[10] / VEL_Q },
    w: { x: w[11] / VEL_Q, y: w[12] / VEL_Q, z: w[13] / VEL_Q },
    hp: w[14] / 10,
    maxHp: w[15],
    flags: w[16],
    aimYaw: w[17] / 1000,
    steer: w[18] / 100,
    throttle: w[19] / 100,
    lastSeq: w[20],
    boostEnergy: w[21] / 10,
    dashCooldown: w[22] / 100,
    empCooldown: w[23] / 100,
    flipTimer: w[24] / 100,
    spawnCount: w[25],
    fireCooldown: w[26] / 1000,
  };
}

/** [id, x*100, y*100, z*100, ownerId] */
export type MineWire = [number, number, number, number, number];

export const MatchPhase = {
  PLAYING: 0,
  RESULTS: 1,
} as const;
export type MatchPhaseValue = (typeof MatchPhase)[keyof typeof MatchPhase];

export interface SnapshotMsg {
  /** Server time in ms. */
  t: number;
  tick: number;
  phase: MatchPhaseValue;
  /** Seconds left in the current phase. */
  left: number;
  r: RobotWire[];
  m: MineWire[];
}

// ---------------------------------------------------------------------------
// Roster / progression
// ---------------------------------------------------------------------------

export interface PlayerInfo {
  id: number;
  name: string;
  color: number;
  isBot: boolean;
  kills: number;
  deaths: number;
  level: number;
  xp: number;
  xpToNext: number;
  stacks: PowerUpStacks;
}

export interface RosterMsg {
  players: PlayerInfo[];
}

export interface WelcomeMsg {
  yourId: number;
  serverTime: number;
  tuning: PhysicsConfig;
}

export interface CardOfferMsg {
  offerId: number;
  cards: PowerUpId[];
  /** Seconds until the server auto-picks. */
  expiresIn: number;
  /** Additional offers queued after this one. */
  queued: number;
}

export interface CardResolvedMsg {
  offerId: number;
  picked: PowerUpId;
  auto: boolean;
}

export interface PickMsg {
  offerId: number;
  index: number;
}

export interface TuneMsg {
  key: string;
  value: number;
}

export interface PingMsg {
  c: number;
}

export interface PongMsg {
  c: number;
  s: number;
}

export interface ResultsEntry {
  id: number;
  name: string;
  color: number;
  kills: number;
  deaths: number;
  level: number;
}

export interface ResultsMsg {
  standings: ResultsEntry[];
  duration: number;
}

// ---------------------------------------------------------------------------
// Events (batched once per server tick)
// ---------------------------------------------------------------------------

export type GameEvent =
  | { k: 'shot'; pid: number; owner: number; p: Vec3; v: Vec3; bounces: number }
  | { k: 'impact'; pid: number; p: Vec3; n: Vec3; target: number; dmg: number; owner: number }
  | { k: 'bounce'; pid: number; p: Vec3; v: Vec3 }
  | { k: 'dmg'; target: number; source: number; amount: number; p: Vec3; cause: 'ram' | 'mine' }
  | { k: 'heal'; target: number; amount: number; from?: number }
  | { k: 'death'; id: number; p: Vec3; q: Quat; v: Vec3; killer: number }
  | { k: 'kill'; killer: number; victim: number; assists: number[] }
  | { k: 'respawn'; id: number; p: Vec3; yaw: number }
  | { k: 'levelup'; id: number; level: number }
  | { k: 'powerup'; id: number; powerup: PowerUpId }
  | { k: 'emp'; id: number; p: Vec3; r: number; hits: number[] }
  | { k: 'dash'; id: number }
  | { k: 'mineBoom'; mid: number; p: Vec3; owner: number }
  | { k: 'ram'; a: number; b: number; p: Vec3; speed: number }
  | { k: 'tune'; key: string; value: number }
  | { k: 'matchStart' };

export interface EventsMsg {
  t: number;
  e: GameEvent[];
}

export const Msg = {
  // client -> server
  INPUT: 'in',
  PICK: 'pick',
  TUNE: 'tune',
  PING: 'ping',
  // server -> client
  WELCOME: 'welcome',
  SNAPSHOT: 'snap',
  ROSTER: 'roster',
  EVENTS: 'ev',
  CARDS: 'cards',
  CARDS_RESOLVED: 'cardsDone',
  RESULTS: 'results',
  PONG: 'pong',
} as const;
