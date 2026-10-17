import {
  BASE_HP,
  computeStats,
  emptyInput,
  RobotController,
  RobotFlags,
  xpToNext,
  type InputFrame,
  type PlayerInfo,
  type PowerUpId,
  type PowerUpStacks,
  type RobotNetState,
  type RobotStats,
  type Vec3,
} from '@robot-arena/shared';
import type { BotAI } from './BotAI';

export interface ActiveOffer {
  offerId: number;
  cards: PowerUpId[];
  expiresAt: number;
}

export class ServerRobot {
  readonly id: number;
  readonly name: string;
  readonly color: number;
  readonly sessionId: string | null;
  readonly controller: RobotController;
  bot: BotAI | null = null;

  hp = BASE_HP;
  stacks: PowerUpStacks = {};
  stats: RobotStats = computeStats({});
  level = 1;
  xp = 0;
  kills = 0;
  deaths = 0;

  alive = true;
  respawnTimer = 0;
  spawnCount = 0;
  stunTimer = 0;
  protectTimer = 0;
  fireCooldown = 0;
  empCooldown = 0;
  lastCombatTime = -1e9;
  /** attackerId -> last time (s) they damaged this robot; used for assists. */
  readonly damageLog = new Map<number, number>();

  readonly inputQueue: InputFrame[] = [];
  lastInput: InputFrame = emptyInput();
  lastProcessedSeq = 0;
  /** True when this tick's input was newly received (not a repeat of the last one during an input gap). */
  freshInput = false;
  aimYaw = 0;
  aimPitch = 0;

  pendingOffers = 0;
  activeOffer: ActiveOffer | null = null;

  constructor(id: number, name: string, color: number, sessionId: string | null, controller: RobotController) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.sessionId = sessionId;
    this.controller = controller;
  }

  get isBot(): boolean {
    return this.sessionId === null;
  }

  position(): Vec3 {
    const t = this.controller.body.translation();
    return { x: t.x, y: t.y, z: t.z };
  }

  velocity(): Vec3 {
    const v = this.controller.body.linvel();
    return { x: v.x, y: v.y, z: v.z };
  }

  recomputeStats(): void {
    const oldMax = this.stats.maxHp;
    this.stats = computeStats(this.stacks);
    if (this.stats.maxHp > oldMax) this.hp += this.stats.maxHp - oldMax;
    this.hp = Math.min(this.hp, this.stats.maxHp);
    this.controller.modifiers = {
      speedMul: this.stats.speedMul,
      engineMul: this.stats.engineMul,
      gripMul: this.stats.gripMul,
      hasDash: this.stats.abilities.includes('dash'),
    };
  }

  resetProgress(): void {
    this.stacks = {};
    this.level = 1;
    this.xp = 0;
    this.kills = 0;
    this.deaths = 0;
    this.pendingOffers = 0;
    this.activeOffer = null;
    this.stats = computeStats({});
    this.recomputeStats();
    this.hp = this.stats.maxHp;
    this.damageLog.clear();
  }

  toNetState(): RobotNetState {
    const s = this.controller.getState();
    let flags = 0;
    if (this.alive) flags |= RobotFlags.ALIVE;
    if (this.stunTimer > 0) flags |= RobotFlags.STUNNED;
    if (this.controller.sim.boosting) flags |= RobotFlags.BOOSTING;
    if (this.protectTimer > 0) flags |= RobotFlags.PROTECTED;
    if (this.isBot) flags |= RobotFlags.BOT;
    return {
      id: this.id,
      p: s.p,
      q: s.q,
      v: s.v,
      w: s.w,
      hp: Math.max(0, this.hp),
      maxHp: this.stats.maxHp,
      flags,
      aimYaw: this.aimYaw,
      steer: this.lastInput.steer,
      throttle: this.lastInput.throttle,
      lastSeq: this.lastProcessedSeq,
      boostEnergy: this.controller.sim.boostEnergy,
      dashCooldown: this.controller.sim.dashCooldown,
      empCooldown: this.empCooldown,
      flipTimer: this.controller.sim.flipTimer,
      spawnCount: this.spawnCount,
      fireCooldown: this.fireCooldown,
      aimPitch: this.aimPitch,
    };
  }

  toPlayerInfo(): PlayerInfo {
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      isBot: this.isBot,
      kills: this.kills,
      deaths: this.deaths,
      level: this.level,
      xp: this.xp,
      xpToNext: xpToNext(this.level),
      stacks: { ...this.stacks },
    };
  }
}
