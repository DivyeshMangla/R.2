import {
  BOT_NAMES,
  Buttons,
  dot,
  encodeRobot,
  FIXED_DT,
  MATCH_DURATION_S,
  MatchPhase,
  MAX_INPUT_QUEUE,
  MAX_PLAYERS,
  Msg,
  physicsConfig,
  RESPAWN_DELAY_S,
  RESULTS_DURATION_S,
  RobotController,
  ROBOT_COLORS,
  SNAPSHOT_EVERY_TICKS,
  SPAWN_POINTS,
  SPAWN_PROTECTION_S,
  applyPhysicsTuning,
  distance,
  type EventsMsg,
  type GameEvent,
  type InputFrame,
  type MatchPhaseValue,
  type ResultsMsg,
  type RosterMsg,
  type SnapshotMsg,
  type SpawnPoint,
  type Vec3,
  type WelcomeMsg,
} from '@robot-arena/shared';
import { BotAI } from './BotAI';
import type { DamageCause, GameHost } from './GameHost';
import { PhysicsWorld } from './PhysicsWorld';
import { PowerUpSystem } from './PowerUpSystem';
import { ProgressionSystem } from './ProgressionSystem';
import { ServerRobot } from './ServerRobot';
import { WeaponSystem } from './WeaponSystem';

export interface NetSink {
  broadcast(type: string, msg: unknown): void;
  send(sessionId: string, type: string, msg: unknown): void;
}

const MAX_CATCHUP_STEPS = 5;

/** The authoritative match: fixed 60 Hz physics, combat resolution, bots and match flow. */
export class GameSimulation implements GameHost {
  readonly physics = new PhysicsWorld();
  time = 0;

  private readonly net: NetSink;
  private readonly robotMap = new Map<number, ServerRobot>();
  private readonly weapons: WeaponSystem;
  private readonly powerups: PowerUpSystem;
  private readonly progression: ProgressionSystem;
  private readonly ramCooldowns = new Map<string, number>();
  private readonly startMs = performance.now();

  private nextRobotId = 1;
  private tick = 0;
  private accumulator = 0;
  private events: GameEvent[] = [];
  private rosterDirty = true;
  private rosterTimer = 0;
  private phase: MatchPhaseValue = MatchPhase.PLAYING;
  private phaseTimeLeft = MATCH_DURATION_S;
  private humanCounter = 0;

  constructor(net: NetSink) {
    this.net = net;
    this.weapons = new WeaponSystem(this);
    this.powerups = new PowerUpSystem(this);
    this.progression = new ProgressionSystem(this, this.powerups);
    this.balanceBots();
  }

  // ---------------------------------------------------------------- GameHost

  robots(): Iterable<ServerRobot> {
    return this.robotMap.values();
  }

  robotById(id: number): ServerRobot | undefined {
    return this.robotMap.get(id);
  }

  emit(e: GameEvent): void {
    this.events.push(e);
  }

  combatEnabled(): boolean {
    return this.phase === MatchPhase.PLAYING;
  }

  sendTo(robot: ServerRobot, type: string, msg: unknown): void {
    if (robot.sessionId) this.net.send(robot.sessionId, type, msg);
  }

  markRosterDirty(): void {
    this.rosterDirty = true;
  }

  serverTimeMs(): number {
    return performance.now() - this.startMs;
  }

  heal(target: ServerRobot, amount: number): void {
    if (!target.alive || amount <= 0) return;
    const before = target.hp;
    target.hp = Math.min(target.stats.maxHp, target.hp + amount);
    const healed = target.hp - before;
    if (healed >= 0.5) this.emit({ k: 'heal', target: target.id, amount: Math.round(healed) });
  }

  applyDamage(target: ServerRobot, amount: number, attacker: ServerRobot | null, cause: DamageCause, point: Vec3): number {
    if (!this.combatEnabled() || !target.alive || target.protectTimer > 0 || amount <= 0) return 0;
    const dealt = Math.min(target.hp, amount);
    target.hp -= amount;
    target.lastCombatTime = this.time;
    if (attacker && attacker !== target) {
      attacker.lastCombatTime = this.time;
      target.damageLog.set(attacker.id, this.time);
    }
    if (cause !== 'projectile') {
      this.emit({ k: 'dmg', target: target.id, source: attacker ? attacker.id : -1, amount: Math.round(amount), p: point, cause });
    }
    this.powerups.onDamaged(target, { attackerId: attacker ? attacker.id : null, damage: dealt });
    if (attacker && attacker !== target && attacker.alive) this.powerups.onHit(attacker, { targetId: target.id, damage: dealt, point });
    if (target.hp <= 0) this.kill(target, attacker && attacker !== target ? attacker : null);
    return amount;
  }

  // ---------------------------------------------------------------- players

  addHuman(sessionId: string, requestedName: unknown): ServerRobot {
    this.humanCounter += 1;
    const name = typeof requestedName === 'string' && requestedName.trim() ? requestedName.trim().slice(0, 16) : `Player ${this.humanCounter}`;
    this.removeOneBot();
    const robot = this.spawnRobot(name, sessionId);
    this.balanceBots();
    return robot;
  }

  removeHuman(sessionId: string): void {
    for (const r of this.robotMap.values()) {
      if (r.sessionId === sessionId) {
        this.destroyRobot(r);
        break;
      }
    }
    this.balanceBots();
  }

  welcomeFor(robot: ServerRobot): WelcomeMsg {
    return { yourId: robot.id, serverTime: this.serverTimeMs(), tuning: { ...physicsConfig } };
  }

  humanCount(): number {
    let n = 0;
    for (const r of this.robotMap.values()) if (!r.isBot) n++;
    return n;
  }

  robotForSession(sessionId: string): ServerRobot | undefined {
    for (const r of this.robotMap.values()) if (r.sessionId === sessionId) return r;
    return undefined;
  }

  queueInput(sessionId: string, input: InputFrame): void {
    const r = this.robotForSession(sessionId);
    if (!r) return;
    if (input.seq <= r.lastProcessedSeq) return;
    const last = r.inputQueue[r.inputQueue.length - 1];
    if (last && input.seq <= last.seq) return;
    r.inputQueue.push(input);
    while (r.inputQueue.length > MAX_INPUT_QUEUE) {
      const dropped = r.inputQueue.shift();
      if (dropped) r.lastProcessedSeq = dropped.seq;
    }
  }

  pickCard(sessionId: string, offerId: unknown, index: unknown): void {
    const r = this.robotForSession(sessionId);
    if (!r || typeof offerId !== 'number' || typeof index !== 'number') return;
    this.progression.pick(r, offerId, index);
  }

  tune(key: unknown, value: unknown): void {
    if (typeof key !== 'string') return;
    const applied = applyPhysicsTuning(key, value);
    if (applied !== null) this.emit({ k: 'tune', key, value: applied });
  }

  private usedColors(): Set<number> {
    return new Set([...this.robotMap.values()].map((r) => r.color));
  }

  private spawnRobot(name: string, sessionId: string | null): ServerRobot {
    const used = this.usedColors();
    const color = ROBOT_COLORS.find((c) => !used.has(c)) ?? ROBOT_COLORS[this.nextRobotId % ROBOT_COLORS.length];
    const spawn = this.safestSpawn(null);
    const controller = new RobotController(this.physics.world, spawn.position, spawn.yaw);
    const robot = new ServerRobot(this.nextRobotId++, name, color, sessionId, controller);
    robot.recomputeStats();
    robot.hp = robot.stats.maxHp;
    robot.aimYaw = spawn.yaw;
    robot.protectTimer = SPAWN_PROTECTION_S;
    if (sessionId === null) robot.bot = new BotAI();
    this.physics.registerRobot(controller.collider, robot.id);
    this.robotMap.set(robot.id, robot);
    this.markRosterDirty();
    return robot;
  }

  private destroyRobot(r: ServerRobot): void {
    this.physics.unregisterRobot(r.controller.collider);
    r.controller.dispose();
    this.robotMap.delete(r.id);
    this.markRosterDirty();
  }

  private removeOneBot(): void {
    const bots = [...this.robotMap.values()].filter((r) => r.isBot);
    const victim = bots.sort((a, b) => a.kills - b.kills)[0];
    if (victim) this.destroyRobot(victim);
  }

  private balanceBots(): void {
    let total = this.robotMap.size;
    while (total > MAX_PLAYERS) {
      const bot = [...this.robotMap.values()].find((r) => r.isBot);
      if (!bot) break;
      this.destroyRobot(bot);
      total--;
    }
    const usedNames = new Set([...this.robotMap.values()].map((r) => r.name));
    while (total < MAX_PLAYERS) {
      const base = BOT_NAMES.find((n) => !usedNames.has(n)) ?? `Bot ${this.nextRobotId}`;
      usedNames.add(base);
      this.spawnRobot(base, null);
      total++;
    }
  }

  /** The spawn point farthest from every living enemy. */
  private safestSpawn(self: ServerRobot | null): SpawnPoint {
    let best = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
    let bestScore = -Infinity;
    for (const s of SPAWN_POINTS) {
      let minD = Infinity;
      for (const r of this.robotMap.values()) {
        if (r === self || !r.alive) continue;
        minD = Math.min(minD, distance(s.position, r.position()));
      }
      const score = minD + Math.random() * 2;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- life & death

  private kill(victim: ServerRobot, killer: ServerRobot | null): void {
    if (!victim.alive) return;
    const s = victim.controller.getState();
    victim.alive = false;
    victim.hp = 0;
    victim.deaths += 1;
    victim.respawnTimer = RESPAWN_DELAY_S;
    victim.stunTimer = 0;
    victim.inputQueue.length = 0;
    victim.controller.setEnabled(false);
    this.emit({ k: 'death', id: victim.id, p: s.p, q: s.q, v: s.v, killer: killer ? killer.id : -1 });
    if (killer) killer.kills += 1;
    const assists = this.progression.onKill(killer, victim);
    if (killer && killer.alive) this.powerups.onKill(killer, { victimId: victim.id, position: s.p });
    this.emit({ k: 'kill', killer: killer ? killer.id : -1, victim: victim.id, assists });
    this.markRosterDirty();
  }

  private respawn(r: ServerRobot): void {
    const spawn = this.safestSpawn(r);
    r.controller.setEnabled(true);
    r.controller.teleport(spawn.position, spawn.yaw);
    r.alive = true;
    r.hp = r.stats.maxHp;
    r.protectTimer = SPAWN_PROTECTION_S;
    r.fireCooldown = 0;
    r.empCooldown = Math.min(r.empCooldown, 3);
    r.spawnCount += 1;
    r.aimYaw = spawn.yaw;
    r.lastCombatTime = -1e9;
    this.emit({ k: 'respawn', id: r.id, p: spawn.position, yaw: spawn.yaw });
  }

  // ---------------------------------------------------------------- loop

  /** Called by the room's simulation interval with elapsed milliseconds. */
  update(elapsedMs: number): void {
    this.accumulator += Math.min(elapsedMs / 1000, 0.25);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_CATCHUP_STEPS) {
      this.accumulator -= FIXED_DT;
      this.step(FIXED_DT);
      steps++;
    }
    if (steps === MAX_CATCHUP_STEPS) this.accumulator = 0;
  }

  private nextInput(r: ServerRobot, dt: number): InputFrame {
    if (r.bot) return r.bot.think(r, this, dt);
    const next = r.inputQueue.shift();
    if (next) {
      r.lastInput = next;
      r.lastProcessedSeq = next.seq;
    }
    return r.lastInput;
  }

  private step(dt: number): void {
    this.tick += 1;
    this.time += dt;
    this.updatePhase(dt);
    const playing = this.phase === MatchPhase.PLAYING;

    for (const r of this.robotMap.values()) {
      const input = this.nextInput(r, dt);
      if (r.isBot) r.lastInput = input;
      r.fireCooldown = Math.max(0, r.fireCooldown - dt);
      r.empCooldown = Math.max(0, r.empCooldown - dt);
      r.stunTimer = Math.max(0, r.stunTimer - dt);
      r.protectTimer = Math.max(0, r.protectTimer - dt);
      if (!r.alive) {
        r.respawnTimer -= dt;
        if (r.respawnTimer <= 0 && playing) this.respawn(r);
        continue;
      }
      const stunned = r.stunTimer > 0;
      const driveInput = playing
        ? { throttle: input.throttle, steer: input.steer, boost: (input.buttons & Buttons.BOOST) !== 0, ability: (input.buttons & Buttons.ABILITY) !== 0 }
        : { throttle: 0, steer: 0, boost: false, ability: false };
      r.aimYaw = input.aimYaw;
      const res = r.controller.drive(driveInput, dt, stunned);
      if (res.dashed) this.emit({ k: 'dash', id: r.id });
      if (!playing || stunned) continue;
      if (input.buttons & Buttons.ABILITY) this.powerups.tryAbilities(r);
      if (input.buttons & Buttons.FIRE) this.weapons.tryFire(r, input.aimYaw);
    }

    this.physics.step();

    this.detectRams();
    this.weapons.update(dt);
    this.powerups.update(dt);
    this.progression.update();

    for (const r of this.robotMap.values()) {
      if (r.alive && r.position().y < -12) {
        if (playing) this.kill(r, null);
        else {
          const s = this.safestSpawn(r);
          r.controller.teleport(s.position, s.yaw);
          r.spawnCount += 1;
        }
      }
    }

    this.flush(dt);
  }

  private detectRams(): void {
    if (!this.combatEnabled()) return;
    const cfg = physicsConfig;
    const list = [...this.robotMap.values()].filter((r) => r.alive);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let touching = false;
        this.physics.world.contactPair(a.controller.collider, b.controller.collider, (manifold) => {
          if (manifold.numContacts() > 0) touching = true;
        });
        if (!touching) continue;
        const key = `${a.id}:${b.id}`;
        const until = this.ramCooldowns.get(key) ?? 0;
        if (this.time < until) continue;
        const pa = a.position();
        const pb = b.position();
        const dx = pb.x - pa.x, dz = pb.z - pa.z;
        const d = Math.hypot(dx, dz) || 1;
        const n = { x: dx / d, y: 0, z: dz / d };
        const va = a.velocity();
        const vb = b.velocity();
        const closing = dot(va, n) - dot(vb, n);
        if (closing < cfg.ramMinSpeed) continue;
        this.ramCooldowns.set(key, this.time + cfg.ramCooldown);
        const aToward = dot(va, n);
        const bToward = -dot(vb, n);
        const [rammer, victim, dir] = aToward >= bToward ? [a, b, n] : [b, a, { x: -n.x, y: 0, z: -n.z }];
        const dmg = (closing - cfg.ramMinSpeed) * cfg.ramDamagePerMps + 4;
        const contact = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 + 0.2, z: (pa.z + pb.z) / 2 };
        const k = cfg.ramImpulse * Math.min(2.5, closing / 10);
        victim.controller.body.applyImpulseAtPoint({ x: dir.x * k, y: k * 0.35, z: dir.z * k }, contact, true);
        this.emit({ k: 'ram', a: rammer.id, b: victim.id, p: contact, speed: closing });
        this.applyDamage(victim, dmg, rammer, 'ram', victim.position());
        if (rammer.alive) this.applyDamage(rammer, dmg * cfg.ramSelfDamageFraction, victim, 'ram', rammer.position());
      }
    }
  }

  private updatePhase(dt: number): void {
    this.phaseTimeLeft -= dt;
    if (this.phaseTimeLeft > 0) return;
    if (this.phase === MatchPhase.PLAYING) {
      this.phase = MatchPhase.RESULTS;
      this.phaseTimeLeft = RESULTS_DURATION_S;
      const standings = [...this.robotMap.values()]
        .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.level - a.level)
        .map((r) => ({ id: r.id, name: r.name, color: r.color, kills: r.kills, deaths: r.deaths, level: r.level }));
      const msg: ResultsMsg = { standings, duration: RESULTS_DURATION_S };
      this.net.broadcast(Msg.RESULTS, msg);
    } else {
      this.restartMatch();
    }
  }

  private restartMatch(): void {
    this.phase = MatchPhase.PLAYING;
    this.phaseTimeLeft = MATCH_DURATION_S;
    this.weapons.clear();
    this.powerups.clear();
    this.ramCooldowns.clear();
    const spawns = [...SPAWN_POINTS].sort(() => Math.random() - 0.5);
    let i = 0;
    for (const r of this.robotMap.values()) {
      r.resetProgress();
      const s = spawns[i++ % spawns.length];
      r.controller.setEnabled(true);
      r.controller.teleport(s.position, s.yaw);
      r.alive = true;
      r.hp = r.stats.maxHp;
      r.protectTimer = SPAWN_PROTECTION_S;
      r.stunTimer = 0;
      r.fireCooldown = 0;
      r.empCooldown = 0;
      r.spawnCount += 1;
      r.aimYaw = s.yaw;
    }
    this.emit({ k: 'matchStart' });
    this.markRosterDirty();
  }

  private flush(dt: number): void {
    if (this.events.length > 0) {
      const msg: EventsMsg = { t: this.serverTimeMs(), e: this.events };
      this.net.broadcast(Msg.EVENTS, msg);
      this.events = [];
    }
    if (this.tick % SNAPSHOT_EVERY_TICKS === 0) {
      const snap: SnapshotMsg = {
        t: this.serverTimeMs(),
        tick: this.tick,
        phase: this.phase,
        left: Math.max(0, Math.round(this.phaseTimeLeft * 10) / 10),
        r: [...this.robotMap.values()].map((r) => encodeRobot(r.toNetState())),
        m: this.powerups.mineWire(),
      };
      this.net.broadcast(Msg.SNAPSHOT, snap);
    }
    this.rosterTimer -= dt;
    if (this.rosterDirty && this.rosterTimer <= 0) {
      this.rosterDirty = false;
      this.rosterTimer = 0.1;
      const roster: RosterMsg = { players: [...this.robotMap.values()].map((r) => r.toPlayerInfo()) };
      this.net.broadcast(Msg.ROSTER, roster);
    }
  }

  dispose(): void {
    for (const r of [...this.robotMap.values()]) this.destroyRobot(r);
    this.physics.world.free();
  }
}

