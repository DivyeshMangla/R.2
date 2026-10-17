import * as THREE from 'three';
import {
  applyPhysicsTuning,
  Buttons,
  computeStats,
  FIXED_DT,
  getPowerUp,
  initPhysics,
  MatchPhase,
  muzzleTransforms,
  physicsConfig,
  replacePhysicsConfig,
  RobotFlags,
  WHEEL_ANCHORS,
  yawFromQuat,
  type CardOfferMsg,
  type CardResolvedMsg,
  type EventsMsg,
  type GameEvent,
  type PlayerInfo,
  type ResultsMsg,
  type RobotNetState,
  type RobotStats,
  type RosterMsg,
  type SnapshotMsg,
  type WelcomeMsg,
} from '@robot-arena/shared';
import { AudioSystem } from './audio/AudioSystem';
import { DebugGUI } from './debug/DebugGUI';
import { InputManager } from './input/InputManager';
import { NetClient } from './net/NetClient';
import { SnapshotBuffer, type InterpolatedRobot } from './net/SnapshotBuffer';
import { DebrisSystem } from './physics/DebrisSystem';
import { LocalPredictor } from './physics/LocalPredictor';
import { PhysicsWorld } from './physics/PhysicsWorld';
import { buildArena, type ArenaVisuals } from './render/ArenaBuilder';
import { CameraController } from './render/CameraController';
import { ProjectileSystem } from './render/ProjectileSystem';
import { loadSavedQuality, QualityAutoDetector, saveQuality, type QualityName } from './render/Quality';
import { Renderer } from './render/Renderer';
import { RobotModelFactory } from './render/RobotModelFactory';
import { RobotView, type WheelTelemetry } from './render/RobotView';
import { VFXSystem } from './render/VFXSystem';
import { UI, type AbilityDisplay } from './ui/UI';

interface QueuedEvent {
  t: number;
  e: GameEvent;
}

const IMMEDIATE_EVENTS = new Set<GameEvent['k']>(['tune', 'matchStart', 'levelup', 'powerup', 'heal']);

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _vel = new THREE.Vector3();
const _v = new THREE.Vector3();
const _right = new THREE.Vector3();

/** Top-level client orchestrator: fixed-step simulation loop, networking, rendering and UI. */
export class Game {
  private readonly container: HTMLElement;
  private readonly renderer: Renderer;
  private readonly ui = new UI();
  private readonly audio = new AudioSystem();
  private readonly factory = new RobotModelFactory();
  private readonly buffer = new SnapshotBuffer();
  private readonly cameraCtl: CameraController;
  private readonly input: InputManager;
  private readonly net: NetClient;
  private physics!: PhysicsWorld;
  private predictor!: LocalPredictor;
  private vfx!: VFXSystem;
  private projectiles!: ProjectileSystem;
  private debris!: DebrisSystem;
  private arena!: ArenaVisuals;
  private gui!: DebugGUI;

  private readonly netTuning = { interpolationDelayMs: 100, showServerGhost: false };
  private readonly views = new Map<number, RobotView>();
  private readonly interp = new Map<number, InterpolatedRobot>();
  private readonly players = new Map<number, PlayerInfo>();
  private readonly events: QueuedEvent[] = [];
  private myId = -1;
  private myStats: RobotStats = computeStats({});
  private mySpawnCount = -1;
  private localFireCooldown = 0;
  private lastThrottle = 0;
  private phase: number = MatchPhase.PLAYING;
  private lastSnap: SnapshotMsg | null = null;
  private deathPos = new THREE.Vector3();
  private respawnAt = 0;
  private killerName = '';
  private accumulator = 0;
  private lastFrame = performance.now();
  private time = 0;
  private started = false;
  private connected = false;
  private quality: QualityName;
  private autoDetect: QualityAutoDetector | null;
  private ghost: THREE.Mesh | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new Renderer(container);
    this.cameraCtl = new CameraController(this.renderer.camera);
    this.input = new InputManager(this.renderer.renderer.domElement);
    const saved = loadSavedQuality();
    this.quality = saved ?? 'High';
    this.autoDetect = saved ? null : new QualityAutoDetector();
    this.net = new NetClient({
      onWelcome: (m) => this.onWelcome(m),
      onSnapshot: (m) => this.onSnapshot(m),
      onRoster: (m) => this.onRoster(m),
      onEvents: (m) => this.onEvents(m),
      onCards: (m) => this.onCards(m),
      onCardsResolved: (m) => this.onCardsResolved(m),
      onResults: (m) => this.onResults(m),
      onDisconnect: (reason) => {
        this.connected = false;
        this.ui.setSplashVisible(true);
        this.ui.setStatus(`${reason}. Reload to reconnect.`, true);
      },
    });
  }

  async start(): Promise<void> {
    await initPhysics();
    this.physics = new PhysicsWorld();
    this.predictor = new LocalPredictor(this.physics);
    const scene = this.renderer.scene;
    this.vfx = new VFXSystem(scene);
    this.arena = buildArena(this.renderer.maxAnisotropy);
    scene.add(this.arena.group);
    this.debris = new DebrisSystem(scene, this.vfx);
    this.projectiles = new ProjectileSystem(scene, this.physics, this.vfx, {
      onPredictedRobotHit: () => {
        this.ui.showHitmarker();
        this.audio.hitMarker();
      },
      onSurfaceHit: (p) => {
        if (Math.random() < 0.5) this.audio.impact(_v.set(p.x, p.y, p.z), this.renderer.camera, false);
      },
    });
    this.setQuality(this.quality, false);

    this.gui = new DebugGUI({
      renderer: this.renderer,
      camera: this.cameraCtl,
      predictor: this.predictor,
      net: this.netTuning,
      onPhysicsChange: (key, value) => {
        applyPhysicsTuning(key, value);
        this.net.sendTune(key, value);
      },
      onQualityChange: (name) => this.setQuality(name, true),
      currentQuality: () => this.quality,
    });

    this.bindInput();
    this.ui.onPick = (i) => this.pickCard(i);
    this.ui.onPlay = () => this.onPlayClicked();

    requestAnimationFrame(this.loop);

    const params = new URLSearchParams(location.search);
    const name = params.get('name') ?? undefined;
    try {
      this.ui.setStatus('Connecting to server…');
      await this.net.connect(name ?? '');
      this.connected = true;
      this.ui.setStatus('Connected. Click to deploy.');
    } catch (err) {
      console.error(err);
      this.ui.setStatus(`Cannot reach the game server on ws://${location.hostname}:2567 — is "npm run dev" running?`, true);
    }
  }

  private setQuality(name: QualityName, persist: boolean): void {
    this.quality = name;
    this.renderer.applyQuality(name);
    this.vfx.particleMultiplier = this.renderer.quality.particleMultiplier;
    this.vfx.maxDecals = this.renderer.quality.maxDecals;
    if (persist) {
      saveQuality(name);
      this.autoDetect = null;
    }
  }

  private onPlayClicked(): void {
    this.audio.unlock();
    if (!this.connected) return;
    this.started = true;
    this.ui.setSplashVisible(false);
    this.input.requestLock();
  }

  private bindInput(): void {
    this.renderer.renderer.domElement.addEventListener('click', () => {
      if (this.started && !this.input.isLocked) this.input.requestLock();
    });
    this.input.onKey((code) => {
      if (code === 'Backquote' || code === 'F2') this.gui.toggle();
      if (code === 'KeyM') this.audio.setMuted(!this.audio.muted);
      if (code === 'Digit1' || code === 'Numpad1') this.pickCard(0);
      if (code === 'Digit2' || code === 'Numpad2') this.pickCard(1);
      if (code === 'Digit3' || code === 'Numpad3') this.pickCard(2);
    });
  }

  private pickCard(index: number): void {
    const offer = this.ui.activeOffer;
    if (!offer || index >= offer.cards.length) return;
    this.ui.markChosen(index);
    this.net.sendPick(offer.offerId, index);
  }

  // ------------------------------------------------------------------ network handlers

  private onWelcome(m: WelcomeMsg): void {
    this.myId = m.yourId;
    replacePhysicsConfig(m.tuning as unknown as Record<string, unknown>);
  }

  private onSnapshot(m: SnapshotMsg): void {
    this.lastSnap = m;
    const snap = this.buffer.push(m);
    this.phase = m.phase;

    const ids = new Set(snap.robots.keys());
    for (const [id, view] of this.views) {
      if (!ids.has(id)) {
        view.dispose(this.renderer.scene);
        this.views.delete(id);
        this.interp.delete(id);
        this.physics.removeProxy(id);
      }
    }
    this.debris.pruneRobots(ids);
    for (const [id, s] of snap.robots) {
      if (!this.views.has(id)) {
        const info = this.players.get(id);
        const view = new RobotView(id, info?.color ?? 0xffffff, this.factory, this.renderer.scene);
        if (info) {
          view.setLevel(info.level);
          view.setPowerUps(info.stacks);
        }
        this.views.set(id, view);
      }
      if (id === this.myId) this.reconcileLocal(s);
    }
  }

  private reconcileLocal(s: RobotNetState): void {
    const alive = (s.flags & RobotFlags.ALIVE) !== 0;
    if (!this.predictor.active) {
      this.predictor.ensure(this.myId, s);
      this.predictor.setModifiers(this.modifiersFromStats());
      this.input.resetAim(yawFromQuat(s.q));
      this.cameraCtl.snap();
      this.mySpawnCount = s.spawnCount;
    }
    this.predictor.stunned = (s.flags & RobotFlags.STUNNED) !== 0;
    this.predictor.setEnabled(alive);
    if (s.spawnCount !== this.mySpawnCount) {
      this.mySpawnCount = s.spawnCount;
      this.input.resetAim(yawFromQuat(s.q));
      this.cameraCtl.snap();
    }
    if (alive) this.predictor.reconcile(s, FIXED_DT);
  }

  private modifiersFromStats(): { speedMul: number; engineMul: number; gripMul: number; hasDash: boolean } {
    const st = this.myStats;
    return { speedMul: st.speedMul, engineMul: st.engineMul, gripMul: st.gripMul, hasDash: st.abilities.includes('dash') };
  }

  private onRoster(m: RosterMsg): void {
    this.players.clear();
    for (const p of m.players) {
      this.players.set(p.id, p);
      const view = this.views.get(p.id);
      if (view) {
        view.setColor(p.color);
        view.setLevel(p.level);
        view.setPowerUps(p.stacks);
      }
      if (p.id === this.myId) {
        this.myStats = computeStats(p.stacks);
        this.predictor?.setModifiers(this.modifiersFromStats());
      }
    }
    this.ui.updateScores(m.players, this.myId);
  }

  private onEvents(m: EventsMsg): void {
    for (const e of m.e) {
      if (IMMEDIATE_EVENTS.has(e.k) || this.involvesMe(e)) this.handleEvent(e);
      else this.events.push({ t: m.t, e });
    }
  }

  private involvesMe(e: GameEvent): boolean {
    const me = this.myId;
    switch (e.k) {
      case 'impact':
        return e.target === me;
      case 'dmg':
        return e.target === me;
      case 'death':
      case 'respawn':
      case 'dash':
        return e.id === me;
      case 'emp':
        return e.hits.includes(me);
      default:
        return false;
    }
  }

  private onCards(m: CardOfferMsg): void {
    const me = this.players.get(this.myId);
    this.ui.showCards(m, me?.stacks ?? {});
  }

  private onCardsResolved(m: CardResolvedMsg): void {
    if (this.ui.activeOffer?.offerId === m.offerId) this.ui.hideCards();
    this.audio.pick();
    const def = getPowerUp(m.picked);
    if (def && m.auto) this.ui.spawnNumber(this.localPosition(), `AUTO: ${def.name}`, 'heal');
  }

  private onResults(m: ResultsMsg): void {
    this.ui.showResults(m, this.myId);
    this.ui.hideCards();
    if (this.input.isLocked) document.exitPointerLock();
  }

  // ------------------------------------------------------------------ events

  private colorOf(id: number): number {
    return this.players.get(id)?.color ?? 0xffffff;
  }

  private robotPosition(id: number): THREE.Vector3 | null {
    const v = this.views.get(id);
    return v ? v.root.position : null;
  }

  private localPosition(): THREE.Vector3 {
    return this.views.get(this.myId)?.root.position.clone() ?? this.deathPos.clone();
  }

  private traumaFrom(p: THREE.Vector3, radius: number, strength: number): void {
    const d = this.localPosition().distanceTo(p);
    if (d < radius) this.cameraCtl.addTrauma(strength * (1 - d / radius));
  }

  private handleEvent(e: GameEvent): void {
    const cam = this.renderer.camera;
    switch (e.k) {
      case 'shot': {
        if (e.owner === this.myId) return;
        const p = new THREE.Vector3(e.p.x, e.p.y, e.p.z);
        const dir = new THREE.Vector3(e.v.x, e.v.y, e.v.z).normalize();
        this.projectiles.spawn(e.owner, e.p, e.v, e.bounces, this.colorOf(e.owner), false, e.pid, this.physics.proxyCollider(e.owner));
        this.vfx.muzzleFlash(p, dir);
        this.audio.cannon(p, cam, false);
        return;
      }
      case 'bounce':
        this.projectiles.correctBounce(e.pid, e.p, e.v);
        return;
      case 'impact': {
        const p = new THREE.Vector3(e.p.x, e.p.y, e.p.z);
        if (e.owner !== this.myId) this.projectiles.removeByServerPid(e.pid);
        if (e.target < 0) return;
        const n = new THREE.Vector3(e.n.x, e.n.y, e.n.z);
        this.views.get(e.target)?.flashHit();
        if (e.owner === this.myId) {
          if (e.dmg > 0) this.ui.spawnNumber(p, String(e.dmg), e.dmg >= 30 ? 'crit' : 'dealt');
          this.ui.showHitmarker();
          this.audio.hitMarker();
        } else {
          this.vfx.impactSparks(p, n, new THREE.Color(this.colorOf(e.owner)), 1.2);
          this.audio.impact(p, cam, true);
        }
        if (e.target === this.myId) this.onLocalDamaged(e.dmg);
        return;
      }
      case 'dmg': {
        const p = new THREE.Vector3(e.p.x, e.p.y, e.p.z);
        this.views.get(e.target)?.flashHit();
        if (e.target === this.myId) this.onLocalDamaged(e.amount);
        else if (e.source === this.myId) this.ui.spawnNumber(p, String(e.amount), 'dealt');
        return;
      }
      case 'heal':
        if (e.target === this.myId) this.ui.spawnNumber(this.localPosition(), `+${e.amount}`, 'heal');
        return;
      case 'death': {
        const view = this.views.get(e.id);
        const p = new THREE.Vector3(e.p.x, e.p.y, e.p.z);
        if (view) {
          this.debris.spawn(this.factory.createDebris(view.model), e.p, e.q, e.v);
          view.setVisible(false);
        }
        this.vfx.explosion(p, 1.15, new THREE.Color(this.colorOf(e.id)));
        this.audio.explosion(p, cam, 1);
        this.traumaFrom(p, 26, 0.7);
        if (e.id === this.myId) {
          this.deathPos.copy(p);
          this.respawnAt = performance.now() + 3000;
          this.killerName = e.killer >= 0 ? this.players.get(e.killer)?.name ?? '' : '';
          this.cameraCtl.addTrauma(0.8);
          this.renderer.pulseChromatic(1);
        }
        return;
      }
      case 'kill': {
        const killer = e.killer >= 0 ? this.players.get(e.killer) : undefined;
        const victim = this.players.get(e.victim);
        const assists = e.assists.map((a) => this.players.get(a)).filter((x): x is PlayerInfo => !!x);
        const mine = e.killer === this.myId || e.victim === this.myId || e.assists.includes(this.myId);
        this.ui.addKill(killer, victim, assists, mine);
        if (e.killer === this.myId && victim) this.ui.spawnNumber(this.localPosition(), `+100 XP  ${victim.name} destroyed`, 'crit');
        else if (e.assists.includes(this.myId)) this.ui.spawnNumber(this.localPosition(), '+40 XP assist', 'heal');
        return;
      }
      case 'respawn': {
        const view = this.views.get(e.id);
        view?.setVisible(true);
        this.interp.delete(e.id);
        if (e.id === this.myId) {
          this.ui.setCenterMessage('');
          this.cameraCtl.snap();
        }
        return;
      }
      case 'levelup': {
        const pos = this.robotPosition(e.id);
        if (pos) this.vfx.shockwave(pos.clone(), 6, new THREE.Color(3, 2, 0.4), 0.7);
        if (e.id === this.myId) {
          this.audio.levelUp();
          this.ui.spawnNumber(this.localPosition(), `LEVEL ${e.level}`, 'crit');
        }
        return;
      }
      case 'powerup':
        return;
      case 'emp': {
        const p = new THREE.Vector3(e.p.x, e.p.y, e.p.z);
        this.vfx.empBurst(p, e.r);
        this.audio.emp(p, cam);
        if (e.hits.includes(this.myId)) {
          this.cameraCtl.addTrauma(0.6);
          this.renderer.pulseChromatic(0.9);
        }
        return;
      }
      case 'dash': {
        if (e.id === this.myId) return;
        const view = this.views.get(e.id);
        if (view) this.dashEffect(view);
        return;
      }
      case 'mineBoom': {
        const p = new THREE.Vector3(e.p.x, e.p.y, e.p.z);
        this.vfx.explosion(p, 0.7, new THREE.Color(this.colorOf(e.owner)));
        this.audio.explosion(p, cam, 0.6);
        this.traumaFrom(p, 16, 0.45);
        return;
      }
      case 'ram': {
        const p = new THREE.Vector3(e.p.x, e.p.y, e.p.z);
        this.vfx.impactSparks(p, new THREE.Vector3(0, 1, 0), new THREE.Color(1, 0.8, 0.5), 1.8);
        this.audio.ram(p, cam, e.speed);
        if (e.a === this.myId || e.b === this.myId) this.cameraCtl.addTrauma(Math.min(0.7, e.speed * 0.04));
        return;
      }
      case 'tune':
        applyPhysicsTuning(e.key, e.value);
        return;
      case 'matchStart':
        this.ui.hideResults();
        this.ui.hideCards();
        this.debris.clear();
        this.projectiles.clear();
        this.vfx.clearTransient();
        if (this.started) this.input.requestLock();
        return;
    }
  }

  private onLocalDamaged(amount: number): void {
    if (amount <= 0) return;
    this.ui.damageFlash();
    this.ui.spawnNumber(this.localPosition(), `-${amount}`, 'taken');
    this.renderer.pulseChromatic(Math.min(0.9, 0.25 + amount / 40));
    this.cameraCtl.addTrauma(Math.min(0.6, 0.15 + amount / 60));
    this.audio.hurt();
  }

  private dashEffect(view: RobotView): void {
    const root = view.root;
    for (const n of view.model.nozzleLocal) {
      const wp = n.clone().applyQuaternion(root.quaternion).add(root.position);
      const back = new THREE.Vector3(0, 0, -1).applyQuaternion(root.quaternion);
      for (let i = 0; i < 14; i++) this.vfx.exhaust(wp, back, false);
    }
    this.vfx.shockwave(root.position.clone(), 3.5, new THREE.Color(3, 1.6, 0.5), 0.35);
    this.audio.dash(root.position, this.renderer.camera);
  }

  // ------------------------------------------------------------------ simulation

  private renderTime(): number {
    return this.net.serverNow() - this.netTuning.interpolationDelayMs;
  }

  private fixedUpdate(dt: number): void {
    const renderT = this.renderTime();
    const latest = this.buffer.latest();

    // Remote robots become kinematic proxies at their interpolated poses.
    if (latest) {
      for (const id of latest.robots.keys()) {
        if (id === this.myId) continue;
        const s = this.buffer.sample(id, renderT, this.interp.get(id) ?? null);
        if (!s) continue;
        this.interp.set(id, s);
        const alive = (s.latest.flags & RobotFlags.ALIVE) !== 0;
        this.physics.setProxy(id, s.position, s.quaternion, alive);
      }
    }

    const me = latest?.robots.get(this.myId);
    if (me && this.predictor.active && this.connected) {
      const alive = (me.flags & RobotFlags.ALIVE) !== 0;
      const playing = this.phase === MatchPhase.PLAYING;
      const frame = this.input.sample();
      if (!playing) {
        frame.throttle = 0;
        frame.steer = 0;
        frame.buttons = 0;
      }
      this.lastThrottle = frame.throttle;
      this.net.sendInput(frame);
      if (alive) {
        this.predictor.applyInput(frame, dt);
        if (this.predictor.lastDashed) {
          const v = this.views.get(this.myId);
          if (v) this.dashEffect(v);
        }
      }
      this.localFireCooldown = Math.max(0, this.localFireCooldown - dt);
      if (alive && playing && !this.predictor.stunned && (frame.buttons & Buttons.FIRE) && this.localFireCooldown <= 0) this.fireLocal(frame.aimYaw);
    }

    this.physics.step();
    this.predictor.afterStep();
    this.projectiles.fixedUpdate(dt);
    this.debris.fixedUpdate(dt);
  }

  private fireLocal(aimYaw: number): void {
    const c = this.predictor.controller;
    if (!c) return;
    const cfg = physicsConfig;
    const st = this.myStats;
    this.localFireCooldown = cfg.fireInterval / st.fireRateMul;
    const muzzles = muzzleTransforms(c.body.translation(), c.body.rotation(), aimYaw, st.projectileCount, cfg.twinSpread);
    const color = this.colorOf(this.myId);
    for (const m of muzzles) {
      this.projectiles.spawn(
        this.myId,
        m.p,
        { x: m.d.x * cfg.projectileSpeed, y: m.d.y * cfg.projectileSpeed, z: m.d.z * cfg.projectileSpeed },
        st.ricochetBounces,
        color,
        true,
        0,
        c.collider,
      );
      this.vfx.muzzleFlash(new THREE.Vector3(m.p.x, m.p.y, m.p.z), new THREE.Vector3(m.d.x, m.d.y, m.d.z));
    }
    this.audio.cannon(null, null, true);
    this.cameraCtl.addTrauma(0.1);
  }

  // ------------------------------------------------------------------ frame

  private readonly loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const frameDt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.time += frameDt;

    if (this.physics) {
      this.accumulator = Math.min(this.accumulator + frameDt, 0.25);
      while (this.accumulator >= FIXED_DT) {
        this.fixedUpdate(FIXED_DT);
        this.accumulator -= FIXED_DT;
      }
      this.renderFrame(frameDt, this.accumulator / FIXED_DT);
    }
    this.gui?.stats.update();
  };

  private processEvents(): void {
    const renderT = this.renderTime();
    let i = 0;
    while (i < this.events.length && this.events[i].t <= renderT) {
      this.handleEvent(this.events[i].e);
      i++;
    }
    if (i > 0) this.events.splice(0, i);
    // Safety valve if the clock jumps.
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000).forEach((q) => this.handleEvent(q.e));
  }

  private wheelTelemetry(): WheelTelemetry | null {
    const c = this.predictor.controller;
    if (!c) return null;
    const v = c.vehicle;
    const t: WheelTelemetry = { suspension: [], rotation: [], steering: [] };
    for (let i = 0; i < WHEEL_ANCHORS.length; i++) {
      t.suspension.push(v.wheelSuspensionLength(i) ?? physicsConfig.suspensionRestLength);
      t.rotation.push(v.wheelRotation(i) ?? 0);
      t.steering.push(v.wheelSteering(i) ?? 0);
    }
    return t;
  }

  private surfaceEffects(view: RobotView, pos: THREE.Vector3, quat: THREE.Quaternion, vel: THREE.Vector3, flags: number, grounded: boolean, dt: number): void {
    _right.set(1, 0, 0).applyQuaternion(quat);
    const lateral = Math.abs(vel.dot(_right));
    const speed = Math.hypot(vel.x, vel.z);
    if (grounded && (lateral > 3.2 || (speed > 6 && Math.abs(this.lastThrottle) > 0 && view.id === this.myId && lateral > 2))) {
      const amount = Math.min(3, (lateral - 2) * 0.35) * dt * 60 * 0.35;
      for (const a of [WHEEL_ANCHORS[2], WHEEL_ANCHORS[3]]) {
        _v.set(a.x, a.y - physicsConfig.suspensionRestLength - physicsConfig.wheelRadius, a.z).applyQuaternion(quat).add(pos);
        this.vfx.dust(_v, vel, amount);
      }
    }
    if (flags & RobotFlags.BOOSTING) {
      const back = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
      for (const sx of [-0.25, 0.25]) {
        _v.set(sx, -0.05, -1.32).applyQuaternion(quat).add(pos);
        this.vfx.exhaust(_v, back, true);
      }
    }
    if (flags & RobotFlags.STUNNED) this.vfx.stunSparks(pos);
  }

  private renderFrame(dt: number, alpha: number): void {
    this.processEvents();
    const renderT = this.renderTime();
    const latest = this.buffer.latest();
    const me = latest?.robots.get(this.myId);

    // Local robot (predicted + smoothed).
    let camTarget = this.deathPos;
    let camVel = _vel.set(0, 0, 0);
    let boosting = false;
    const myView = this.views.get(this.myId);
    if (me && myView && this.predictor.active) {
      const alive = (me.flags & RobotFlags.ALIVE) !== 0;
      this.predictor.renderPose(alpha, dt, _pos, _quat);
      const c = this.predictor.controller;
      const v = this.predictor.velocity();
      camVel = _vel.set(v.x, v.y, v.z);
      boosting = !!c?.sim.boosting;
      let flags = me.flags & ~RobotFlags.BOOSTING;
      if (boosting) flags |= RobotFlags.BOOSTING;
      if (alive) {
        myView.setVisible(true);
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(_quat);
        myView.update(
          { position: _pos, quaternion: _quat, aimYaw: this.input.aimYaw, steer: 0, forwardSpeed: camVel.dot(fwd), flags, wheels: this.wheelTelemetry() },
          dt,
          this.time,
        );
        let grounded = false;
        if (c) for (let i = 0; i < 4; i++) grounded = grounded || c.vehicle.wheelIsInContact(i);
        this.surfaceEffects(myView, _pos, _quat, camVel, flags, grounded, dt);
        camTarget = _pos;
        this.debris.syncRobot(this.myId, _pos, _quat, true);
      } else {
        myView.setVisible(false);
        this.debris.syncRobot(this.myId, _pos, _quat, false);
      }
      this.audio.updateEngine(camVel.length(), this.lastThrottle, boosting, alive);
    }

    // Remote robots (interpolated ~100 ms in the past).
    for (const [id, view] of this.views) {
      if (id === this.myId) continue;
      const s = this.buffer.sample(id, renderT, this.interp.get(id) ?? null);
      if (!s) continue;
      this.interp.set(id, s);
      const alive = (s.latest.flags & RobotFlags.ALIVE) !== 0;
      if (!alive) {
        view.setVisible(false);
        this.debris.syncRobot(id, s.position, s.quaternion, false);
        continue;
      }
      view.setVisible(true);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(s.quaternion);
      view.update({ position: s.position, quaternion: s.quaternion, aimYaw: s.aimYaw, steer: s.steer, forwardSpeed: s.velocity.dot(fwd), flags: s.latest.flags, wheels: null }, dt, this.time);
      this.surfaceEffects(view, s.position, s.quaternion, s.velocity, s.latest.flags, Math.abs(s.velocity.y) < 2.5, dt);
      this.debris.syncRobot(id, s.position, s.quaternion, true);
    }

    // Camera, shadows, audio listener.
    this.cameraCtl.update(camTarget, camVel, this.input.aimYaw, this.input.cameraPitch, boosting, dt);
    this.renderer.followShadow(camTarget);
    this.audio.setListener(this.renderer.camera.position);

    // World effects.
    this.vfx.updateMines(this.buffer.sampleMines(renderT), (o) => this.colorOf(o), this.time);
    this.projectiles.update();
    this.debris.update();
    this.vfx.update(dt, this.time);
    this.arena.update(this.time);
    this.updateGhost(me);

    this.updateHud(me, dt);
    this.renderer.info.reset();
    this.renderer.render(dt);

    if (this.autoDetect && this.started) {
      const rec = this.autoDetect.sample(dt);
      if (rec) {
        console.info(`[quality] auto-detected preset: ${rec}`);
        this.setQuality(rec, true);
      }
    }
  }

  private updateGhost(me: RobotNetState | undefined): void {
    if (this.netTuning.showServerGhost && me) {
      if (!this.ghost) {
        this.ghost = new THREE.Mesh(
          new THREE.BoxGeometry(1.7, 0.6, 2.3),
          new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true, transparent: true, opacity: 0.6 }),
        );
        this.renderer.scene.add(this.ghost);
      }
      this.ghost.visible = true;
      this.ghost.position.set(me.p.x, me.p.y, me.p.z);
      this.ghost.quaternion.set(me.q.x, me.q.y, me.q.z, me.q.w);
    } else if (this.ghost) {
      this.ghost.visible = false;
    }
  }

  private updateHud(me: RobotNetState | undefined, dt: number): void {
    const ui = this.ui;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const info = this.players.get(this.myId);
    const alive = me ? (me.flags & RobotFlags.ALIVE) !== 0 : false;

    if (me && info) {
      const c = this.predictor.controller;
      ui.updateVitals(me.hp, me.maxHp, info.level, info.xp, info.xpToNext, c ? c.sim.boostEnergy : me.boostEnergy, alive);
      const abilities: AbilityDisplay[] = [];
      if (this.myStats.abilities.includes('dash'))
        abilities.push({ id: 'dash', icon: '➤', cooldown: c ? c.sim.dashCooldown : me.dashCooldown, max: physicsConfig.dashCooldown, key: 'SPACE' });
      if (this.myStats.abilities.includes('emp')) abilities.push({ id: 'emp', icon: 'ϟ', cooldown: me.empCooldown, max: physicsConfig.empCooldown, key: 'SPACE' });
      ui.updateAbilities(abilities);
      ui.setStunned(alive && (me.flags & RobotFlags.STUNNED) !== 0);
    }

    if (this.lastSnap) {
      const elapsed = (this.net.serverNow() - this.lastSnap.t) / 1000;
      ui.setTimer(this.lastSnap.left - elapsed, this.phase === MatchPhase.RESULTS);
    }

    if (me && !alive && this.phase === MatchPhase.PLAYING) {
      const left = Math.max(0, (this.respawnAt - performance.now()) / 1000);
      ui.setCenterMessage('DESTROYED', `${this.killerName ? `by ${this.killerName} — ` : ''}respawning in ${left.toFixed(1)}s`);
    } else if (this.started && this.connected && !this.input.isLocked && this.phase === MatchPhase.PLAYING) {
      ui.setCenterMessage('CLICK TO RESUME', 'mouse aims • 1/2/3 picks cards');
    } else {
      ui.setCenterMessage('');
    }

    ui.setScoreboardVisible(this.input.isDown('Tab'));

    // Crosshair sits where the turret is actually pointing.
    const c = this.predictor?.controller;
    if (c && alive) {
      const m = muzzleTransforms(c.body.translation(), c.body.rotation(), this.input.aimYaw, 1, 0)[0];
      _v.set(m.p.x + m.d.x * 30, m.p.y, m.p.z + m.d.z * 30).project(this.renderer.camera);
      ui.setCrosshair((_v.x * 0.5 + 0.5) * w, (-_v.y * 0.5 + 0.5) * h, _v.z < 1);
    } else {
      ui.setCrosshair(w / 2, h / 2, false);
    }

    const ps = this.predictor?.stats;
    ui.setNetInfo(
      `${this.quality.toUpperCase()}  RTT ${this.net.rtt.toFixed(0)}ms` +
        (ps ? `\npred err ${ps.lastErrorM.toFixed(3)}m  replay ${ps.replayed}` : '') +
        `\ndraw ${this.renderer.info.render.calls}  tris ${(this.renderer.info.render.triangles / 1000).toFixed(0)}k`,
    );
    ui.update(dt, this.renderer.camera, w, h);
  }
}
