import * as THREE from 'three';
import {
  applyPhysicsTuning,
  Buttons,
  computeWeaponShots,
  getCharacter,
  getWeapon,
  getMap,
  weaponStats,
  computeStats,
  FIXED_DT,
  getPowerUp,
  getTurretPivot,
  initPhysics,
  makeAimSolution,
  makeEnvHit,
  makeHitTarget,
  MATCH_DURATION_S,
  MatchPhase,
  MAX_PLAYERS,
  physicsConfig,
  replacePhysicsConfig,
  RobotFlags,
  solveAim,
  WHEEL_ANCHORS,
  yawFromQuat,
  type CardOfferMsg,
  type CardResolvedMsg,
  type EventsMsg,
  type GameEvent,
  type HitTarget,
  type InputFrame,
  type PlayerInfo,
  type ResultsMsg,
  type RobotNetState,
  type RobotStats,
  type RosterMsg,
  type ShotResultMsg,
  type SnapshotMsg,
  type Vec3,
  type WelcomeMsg,
  type LobbySelection,
  type MapId,
  type StatusEffect,
  type WeaponId,
} from '@robot-arena/shared';
import { AudioSystem } from './audio/AudioSystem';
import type { VehicleAudioInput } from './audio/VehicleAudioModel';
import { AimDebug } from './debug/AimDebug';
import { DebugGUI } from './debug/DebugGUI';
import { InputManager } from './input/InputManager';
import { NetClient } from './net/NetClient';
import { SnapshotBuffer, type InterpolatedRobot } from './net/SnapshotBuffer';
import { DebrisSystem } from './physics/DebrisSystem';
import { LocalPredictor } from './physics/LocalPredictor';
import { PhysicsWorld } from './physics/PhysicsWorld';
import { CameraController, type CameraMotion } from './render/CameraController';
import type { DrivingViewIntent } from './render/DrivingCamera';
import { buildArena, type ArenaVisuals } from './render/env/ArenaBuilder';
import { DustMotes } from './render/env/DustMotes';
import { ProjectileSystem } from './render/ProjectileSystem';
import { loadSavedSettings, QualityAutoDetector, saveSettings, settingsForPreset, type GraphicsSettings, type QualityName } from './render/Quality';
import { Renderer } from './render/Renderer';
import { DAMAGE_POINTS, EXHAUST_TIPS, NOZZLE_TIPS } from './render/robot/RobotGeometry';
import { RobotFleet } from './render/robot/RobotFleet';
import type { RobotVisual, WheelTelemetry } from './render/robot/RobotVisual';
import type { MineSample } from './render/vfx/MineRenderer';
import { VFXSystem, type VFXStats } from './render/vfx/VFXSystem';
import { DebugOverlay, type PerfSample } from './ui/DebugOverlay';
import { SettingsMenu } from './ui/SettingsMenu';
import { UI, type AbilityDisplay, type KillWeapon } from './ui/UI';
import { estimateDamage, fxSize, weaponIcon, weaponWeight } from './ui/weaponInfo';
import { Lobby } from './ui/Lobby';
import { WeaponPickupRenderer } from './render/WeaponPickupRenderer';

interface QueuedEvent {
  t: number;
  e: GameEvent;
}

const IMMEDIATE_EVENTS = new Set<GameEvent['k']>(['tune', 'matchStart', 'levelup', 'powerup', 'heal', 'weapon']);
const HITSTOP_S = 0.08;
/** Server barrel offset per follow-up shot of a burst (WeaponSystem BURST_BARREL_STRIDE). */
const BURST_BARREL_STRIDE = 100;
/** Damage ticks below this are summed into one floating number instead of spamming. */
const TICK_DAMAGE = 5;
/** Weapons whose first volley is predicted locally (firework homing is server-only). */
function predictsShells(weaponId: WeaponId | undefined): boolean {
  if (!weaponId) return true;
  const def = getWeapon(weaponId);
  return (def.kind === 'projectile' || def.kind === 'lob') && def.homing <= 0;
}
const STATUS_LABEL: Record<StatusEffect, string> = { burn: 'BURNING', poison: 'POISONED', stun: 'STUNNED', slow: 'SLOWED' };

/** A sustained weapon use (torch flame, chainsaw) drawn every frame until `until`. */
interface ActiveUse {
  id: number;
  weaponId: WeaponId;
  until: number;
}

/** Summed small damage ticks waiting to be shown as one number. */
interface TickAccum {
  amount: number;
  since: number;
  p: THREE.Vector3;
  taken: boolean;
}
const HITSTOP_SCALE = 0.15;
/** Own-kill slow motion: visuals run at SLOWMO_SCALE, easing back to full speed over SLOWMO_S. */
const SLOWMO_S = 0.55;
const SLOWMO_SCALE = 0.25;
/** A hit older than this no longer earns the kill credit for its weapon. */
const CREDIT_S = 8;

/** Who / what last hurt a robot, for kill-feed weapon attribution. */
interface KillCredit {
  owner: number;
  weaponId: WeaponId | null;
  cause: string | null;
  t: number;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _vel = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const BACK = new THREE.Vector3(0, 0, -1);
const FORWARD = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const DOWN: Vec3 = { x: 0, y: -1, z: 0 };

/** Top-level client orchestrator: fixed-step simulation loop, networking, rendering and UI. */
export class Game {
  private readonly container: HTMLElement;
  private readonly renderer: Renderer;
  private readonly ui = new UI();
  private readonly audio = new AudioSystem();
  private readonly lobby = new Lobby();
  private joining = false;
  private mapId: MapId = 'foundry';
  private myWeaponId: WeaponId | null = null;
  private pickups!: WeaponPickupRenderer;
  private readonly buffer = new SnapshotBuffer();
  private readonly cameraCtl: CameraController;
  private readonly input: InputManager;
  private readonly net: NetClient;
  private readonly perf = new DebugOverlay();
  private physics!: PhysicsWorld;
  private predictor!: LocalPredictor;
  private vfx!: VFXSystem;
  private fleet!: RobotFleet;
  private projectiles!: ProjectileSystem;
  private debris!: DebrisSystem;
  private arena!: ArenaVisuals;
  private dust!: DustMotes;
  private gui!: DebugGUI;
  private aimDebug!: AimDebug;
  private menu!: SettingsMenu;

  private readonly netTuning = { interpolationDelayMs: 100, showServerGhost: false };
  private readonly interp = new Map<number, InterpolatedRobot>();
  private readonly players = new Map<number, PlayerInfo>();
  private readonly events: QueuedEvent[] = [];
  private myId = -1;
  private myStats: RobotStats = computeStats({});
  private mySpawnCount = -1;
  private localFireCooldown = 0;
  private lastThrottle = 0;
  private driveForwardSpeed = 0;
  private driveGrounded = false;
  private driveYaw = 0;
  private phase: number = MatchPhase.PLAYING;
  private lastSnap: SnapshotMsg | null = null;
  private readonly deathPos = new THREE.Vector3();
  private respawnAt = 0;
  private killerName = '';
  private killerId = -1;
  private accumulator = 0;
  private lastFrame = performance.now();
  /** Wall-clock seconds since start (UI, audio). */
  private time = 0;
  private hitstop = 0;
  private started = false;
  private connected = false;
  private wasLocked = false;
  private settings: GraphicsSettings;
  private autoDetect: QualityAutoDetector | null;
  private ghost: THREE.Mesh | null = null;
  private cableTimer = 2;
  private netInfoTimer = 0;
  private readonly activeUses: ActiveUse[] = [];
  /** Last weapon use per robot (wall time), to pair `use` with later `teleport` / `shield` events. */
  private readonly lastUse = new Map<number, { weaponId: WeaponId; t: number }>();
  /** Our own non-projectile use was already drawn by local prediction at this time. */
  private localUseAt = -10;
  /** Weapon we optimistically spent on the trigger pull; stale roster echoes of it are ignored briefly. */
  private optimisticSpent: { id: WeaponId; until: number } | null = null;
  private lastDisarmAt = -10;
  private readonly meleeFeedbackAt = new Map<string, number>();
  private readonly tickDamage = new Map<number, TickAccum>();
  /** Last weapon each robot fired / swung (the server's `kill` event carries none). */
  private readonly ownerWeapon = new Map<number, WeaponId>();
  /** Server projectile id -> weapon, so `impact` events can be credited. */
  private readonly pidWeapon = new Map<number, WeaponId>();
  /** Victim -> last damaging source. */
  private readonly lastHit = new Map<number, KillCredit>();
  private slowmo = 0;
  private killerWeapon = '';

  /** Latest aim solution (screen-centre ray -> world point -> turret yaw/pitch). */
  private readonly aim = makeAimSolution();
  private aimValid = false;
  private readonly pivot: Vec3 = { x: 0, y: 0, z: 0 };
  /** Hitboxes as this screen shows them: interpolated remotes + the predicted local robot. */
  private readonly hitTargets: HitTarget[] = Array.from({ length: MAX_PLAYERS + 2 }, makeHitTarget);
  private hitTargetCount = 0;

  // Reused per-frame scratch (no allocation in the frame loop).
  private readonly telemetry: WheelTelemetry = { suspension: [0, 0, 0, 0], rotation: [0, 0, 0, 0], steering: [0, 0, 0, 0], contact: [true, true, true, true] };
  private readonly vehicleAudio: VehicleAudioInput = { forwardSpeed: 0, lateralSpeed: 0, throttle: 0, driveDemand: 0, grounded: false, boosting: false, alive: false, maxSpeed: 12, surface: 'volcanic', dt: 0, active: false };
  private readonly cameraMotion: CameraMotion = { velocity: { x: 0, y: 0, z: 0 }, referenceSpeed: 12, steady: false, active: false };
  private readonly drivingIntent: DrivingViewIntent = { active: false, mouseIdleSeconds: 0, mouseSerial: 0, firing: false, steady: false, recenter: false };
  private readonly mineSamples: MineSample[] = [];
  private readonly vfxStats: VFXStats = { particles: 0, lights: 0 };
  private readonly perfSample: PerfSample = { frameMs: 0, sceneDraws: 0, totalDraws: 0, triangles: 0, particles: 0, lights: 0, preset: 'High' };
  private readonly groundHit = makeEnvHit();
  private readonly groundOrigin: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly groundHeight = (x: number, y: number, z: number): number => {
    const o = this.groundOrigin;
    o.x = x; o.y = y + 0.5; o.z = z;
    return this.projectiles.world.castEnv(o, DOWN, 30, this.groundHit) ? o.y - this.groundHit.t : 0;
  };
  private readonly colorOfFn = (owner: number): number => this.colorOf(owner);

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new Renderer(container);
    this.cameraCtl = new CameraController(this.renderer.camera);
    this.input = new InputManager(this.renderer.renderer.domElement);
    const saved = loadSavedSettings();
    this.settings = saved ?? settingsForPreset('High');
    this.autoDetect = saved ? null : new QualityAutoDetector();
    this.net = new NetClient({
      onWelcome: (m) => this.onWelcome(m),
      onSnapshot: (m) => this.onSnapshot(m),
      onRoster: (m) => this.onRoster(m),
      onEvents: (m) => this.onEvents(m),
      onCards: (m) => this.onCards(m),
      onCardsResolved: (m) => this.onCardsResolved(m),
      onResults: (m) => this.onResults(m),
      onShotResult: (m) => this.onShotResult(m),
      onDisconnect: (reason) => {
        this.audio.setActive(false);
        this.connected = false;
        this.started = false;
        this.ui.setHudVisible(false);
        this.menu?.hide();
        document.exitPointerLock();
        this.lobby.showDisconnected(reason);
        this.lobby.onDeploy = () => location.reload();
      },
    });
    // These events run even when requestAnimationFrame pauses in a hidden tab.
    window.addEventListener('blur', () => this.audio.setActive(false));
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.audio.setActive(false); });
  }

  /** Last countdown digit shown (0 = none); `goUntil` keeps "GO!" up briefly once the match begins. */
  private countdownShown = 0;
  private goUntil = 0;

  async start(): Promise<void> {
    this.ui.setSplashVisible(false);
    this.ui.setHudVisible(false);
    this.lobby.onDeploy = (selection) => { void this.deploy(selection); };
    this.lobby.show();
  }

  private async deploy(selection: LobbySelection): Promise<void> {
    if (this.joining || this.started) return;
    this.joining = true;
    this.mapId = selection.mapId;
    this.myWeaponId = null;
    let joined = false;
    this.audio.unlock();
    // Lock now, while the Deploy click is still a user gesture; after the awaits below the browser refuses.
    this.input.requestLock();
    this.lobby.setBusy(true, `Connecting to ${getMap(this.mapId).name}…`);
    try {
      await initPhysics();
      await this.net.connect(selection);
      joined = true;
      this.connected = true;
      this.prepareMatch();
      if (this.lastSnap) this.onSnapshot(this.lastSnap);
      this.started = true;
      this.lobby.hide();
      this.ui.setHudVisible(true);
      this.input.requestLock();
    } catch (err) {
      console.error('[deploy]', err);
      this.connected = false;
      if (joined) {
        this.started = false;
        this.ui.setHudVisible(false);
        this.net.dispose();
        this.lobby.showDisconnected('The arena could not finish loading');
        this.lobby.onDeploy = () => location.reload();
      } else {
        this.lobby.setBusy(false);
        this.lobby.setStatus('Could not deploy. Check that the game server is running, then try again.', true);
      }
    } finally {
      this.joining = false;
    }
  }

  private prepareMatch(): void {
    this.ui.setMapTheme(this.mapId);
    this.renderer.setMapTheme(this.mapId);
    this.physics = new PhysicsWorld(this.mapId);
    this.predictor = new LocalPredictor(this.physics);
    const r = this.renderer;
    const scene = r.scene;
    this.cameraCtl.setCollisionWorld(this.physics.world);

    this.arena = buildArena(r.maxAnisotropy, this.mapId);
    scene.add(this.arena.group);
    this.pickups = new WeaponPickupRenderer(scene, this.mapId);
    this.vfx = new VFXSystem(scene, r.distortionScene, this.settings.maxDynamicLights, this.settings.maxDecals);
    r.setParticles(this.vfx.particleScene, [this.vfx.alpha, this.vfx.add]);
    this.fleet = new RobotFleet(scene, r.maxAnisotropy);
    this.fleet.setMapTheme(this.mapId);
    this.dust = new DustMotes(scene);
    // Reflections come from this arena, baked once it exists (robots/VFX not yet spawned).
    r.bakeEnvironment();

    this.aimDebug = new AimDebug(scene);
    this.debris = new DebrisSystem(scene, this.vfx, (p, s) => this.audio.debrisClank(p, r.camera, s), this.mapId);
    // Predicted robot contacts never give feedback; hitmarkers wait for SHOT_RESULT.
    this.projectiles = new ProjectileSystem(this.physics, this.vfx, {
      onSurfaceHit: (p, _n2, surface) => {
        if (Math.random() < 0.5) this.audio.impact(_v.set(p.x, p.y, p.z), r.camera, surface === 'metal');
      },
      onPredictedDone: (_seq, _b, path) => this.aimDebug.onClientPath(path),
    });
    this.projectiles.recordPaths = true;
    this.applySettings(this.settings, false);

    this.gui = new DebugGUI({
      renderer: r,
      camera: this.cameraCtl,
      predictor: this.predictor,
      vfx: this.vfx,
      fleet: this.fleet,
      net: this.netTuning,
      netSim: this.net.sim,
      onPhysicsChange: (key, value) => {
        applyPhysicsTuning(key, value);
        this.net.sendTune(key, value);
      },
      onQualityChange: (name) => this.applySettings(settingsForPreset(name), true),
      currentQuality: () => this.settings.preset,
    });
    this.menu = new SettingsMenu({
      getSettings: () => this.settings,
      onSettings: (s) => this.applySettings(s, true),
      getSensitivity: () => this.input.settings.mouseSensitivity,
      onSensitivity: (v) => {
        this.input.settings.mouseSensitivity = v;
      },
      getVolume: () => this.audio.volume,
      onVolume: (v) => this.audio.setVolume(v),
      onResume: () => {
        if (this.started) this.input.requestLock();
      },
    });

    this.bindInput();
    this.ui.onPick = (i) => this.pickCard(i);
    this.ui.onPlay = () => this.onPlayClicked();

    requestAnimationFrame(this.loop);
  }

  /** Applies a graphics settings set to every system that depends on it. */
  private applySettings(s: GraphicsSettings, persist: boolean): void {
    this.settings = { ...s };
    this.renderer.applySettings(this.settings);
    if (this.vfx) {
      this.vfx.density = s.particleDensity;
      this.vfx.lights.resize(s.maxDynamicLights);
      this.vfx.decals.setLimit(s.maxDecals);
      this.vfx.skids.enabled = s.skidMarks;
    }
    this.fleet?.setContactShadows(s.contactShadows);
    if (this.dust) this.dust.visible = s.dustMotes;
    if (persist) {
      saveSettings(this.settings);
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
      if (this.started && !this.input.isLocked && !this.menu.isOpen) this.input.requestLock();
    });
    this.input.onKey((code, e) => {
      if (code === 'Backquote' || code === 'F2') this.gui.toggle();
      if (code === 'F3') {
        e.preventDefault();
        this.perf.toggle();
      }
      if (code === 'F4') {
        e.preventDefault();
        this.aimDebug.toggle();
      }
      if (code === 'F5') {
        e.preventDefault();
        this.aimDebug.togglePip();
      }
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
    if (!this.fleet) return;
    const snap = this.buffer.push(m);
    if (this.phase === MatchPhase.COUNTDOWN && m.phase === MatchPhase.PLAYING && this.started) {
      this.goUntil = performance.now() + 900;
      this.countdownShown = 0;
      this.audio.countdown(true);
    }
    this.phase = m.phase;

    for (const id of this.fleet.visuals.keys()) {
      if (!snap.robots.has(id)) {
        this.fleet.remove(id);
        this.vfx.weaponFx.remove(id);
        this.interp.delete(id);
        this.physics.removeProxy(id);
      }
    }
    this.debris.pruneRobots(snap.robots);
    for (const [id, s] of snap.robots) {
      if (!this.fleet.get(id)) {
        const info = this.players.get(id);
        const v = this.fleet.add(id, info?.color ?? 0xffffff);
        if (info) this.syncVisualInfo(v, info);
      }
      if (id === this.myId) this.reconcileLocal(s);
    }
  }

  private syncVisualInfo(v: RobotVisual, info: PlayerInfo): void {
    v.color = info.color;
    v.characterId = getCharacter(info.characterId).id;
    v.weaponId = info.weaponId ?? null;
    v.level = info.level;
    this.fleet.setStacks(v, info.stacks);
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
      this.myWeaponId = null;
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
      const v = this.fleet?.get(p.id);
      if (v) this.syncVisualInfo(v, p);
      if (p.id === this.myId) {
        this.myStats = computeStats(p.stacks);
        const spent = this.optimisticSpent;
        const stale = spent && this.time < spent.until && p.weaponId === spent.id;
        if (!stale) this.myWeaponId = p.weaponId ?? null;
        this.predictor?.setModifiers(this.modifiersFromStats());
      }
    }
    this.ui.updateScores(m.players, this.myId);
  }

  private onEvents(m: EventsMsg): void {
    if (!this.vfx) return;
    for (const e of m.e) {
      // Credit is tracked on receipt (not render time) so it is ready when an immediate `kill` lands.
      this.trackCredit(e);
      if (IMMEDIATE_EVENTS.has(e.k) || this.involvesMe(e)) this.handleEvent(e);
      else this.events.push({ t: m.t, e });
    }
  }

  private credit(victim: number, owner: number, weaponId: WeaponId | null, cause: string | null = null): void {
    if (victim < 0 || owner < 0 || victim === owner) return;
    this.lastHit.set(victim, { owner, weaponId, cause, t: this.time });
  }

  /** Remembers which weapon last hurt each robot, from every weapon-bearing event. */
  private trackCredit(e: GameEvent): void {
    switch (e.k) {
      case 'shot':
        if (e.weaponId) {
          this.ownerWeapon.set(e.owner, e.weaponId);
          this.pidWeapon.set(e.pid, e.weaponId);
          if (this.pidWeapon.size > 600) this.pidWeapon.delete(this.pidWeapon.keys().next().value as number);
        }
        return;
      case 'use':
        this.ownerWeapon.set(e.id, e.weaponId);
        return;
      case 'beam':
        this.ownerWeapon.set(e.owner, e.weaponId);
        this.credit(e.target, e.owner, e.weaponId);
        return;
      case 'melee':
        this.ownerWeapon.set(e.owner, e.weaponId);
        this.credit(e.target, e.owner, e.weaponId);
        return;
      case 'explode':
        this.ownerWeapon.set(e.owner, e.weaponId);
        return;
      case 'impact':
        if (e.target >= 0) this.credit(e.target, e.owner, this.pidWeapon.get(e.pid) ?? this.ownerWeapon.get(e.owner) ?? null);
        return;
      case 'dmg': {
        if (e.source < 0) return;
        if (e.cause === 'ram') this.credit(e.target, e.source, null, 'RAM');
        else if (e.cause === 'mine') this.credit(e.target, e.source, null, 'MINE');
        else {
          // Keep a precise credit from the same owner (beam / melee / impact); else use their last weapon.
          const prev = this.lastHit.get(e.target);
          if (prev && prev.owner === e.source && prev.weaponId && this.time - prev.t < 1) prev.t = this.time;
          else this.credit(e.target, e.source, this.ownerWeapon.get(e.source) ?? null);
        }
        return;
      }
      case 'kill':
        return;
      default:
        return;
    }
  }

  /** Weapon (or cause) credited for `victim`'s death by `killer`. */
  private killWeapon(killer: number, victim: number): KillWeapon | null {
    if (killer < 0) return null;
    const hit = this.lastHit.get(victim);
    this.lastHit.delete(victim);
    const fresh = hit && hit.owner === killer && this.time - hit.t < CREDIT_S ? hit : null;
    const weaponId = fresh ? fresh.weaponId : this.ownerWeapon.get(killer) ?? null;
    if (fresh?.cause && !fresh.weaponId) return { name: fresh.cause, color: 0x8a7a66, icon: fresh.cause === 'RAM' ? '⇶' : '✹' };
    if (!weaponId) return null;
    const def = getWeapon(weaponId);
    return { name: def.name, color: def.color, icon: weaponIcon(def) };
  }

  private involvesMe(e: GameEvent): boolean {
    const me = this.myId;
    switch (e.k) {
      case 'impact':
        // Our own shells too, so the target flash lines up with the confirmed hitmarker.
        return e.target === me || e.owner === me;
      case 'kill':
        return e.killer === me || e.victim === me;
      case 'dmg':
        return e.target === me;
      case 'death':
      case 'respawn':
      case 'dash':
        return e.id === me;
      case 'emp':
        return e.hits.includes(me);
      case 'shot':
        // Burst follow-ups are not predicted locally: draw them as soon as they arrive.
        return e.owner === me && (e.b >= BURST_BARREL_STRIDE || !predictsShells(e.weaponId));
      case 'use':
      case 'teleport':
      case 'shield':
        return e.id === me;
      case 'beam':
        return e.owner === me || e.target === me;
      case 'melee':
        return e.owner === me || e.target === me;
      case 'status':
        return e.target === me;
      case 'disarm':
        return e.owner === me || e.victim === me;
      case 'explode':
      case 'chain':
        return e.owner === me;
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

  /** The server's verdict on one of our shells: the only source of hit feedback. */
  private onShotResult(r: ShotResultMsg): void {
    if (!this.projectiles) return;
    this.projectiles.confirmShot(r, this.colorOf(this.myId));
    this.aimDebug.onShotResult(r, r.target >= 0 ? this.players.get(r.target)?.name ?? `#${r.target}` : '');
    if (!r.hit || r.dmg <= 0) return;
    const p = new THREE.Vector3(r.point.x, r.point.y, r.point.z);
    this.ui.spawnNumber(p, String(r.dmg), r.dmg >= 100 ? 'mega' : r.dmg >= 30 ? 'crit' : 'dealt');
    if (r.dmg >= 100) this.renderer.pulseChromatic(0.35);
    this.ui.showHitmarker();
    this.audio.hitMarker();
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
    const v = this.fleet.get(id);
    return v ? v.position : null;
  }

  private localPosition(): THREE.Vector3 {
    return this.fleet.get(this.myId)?.position.clone() ?? this.deathPos.clone();
  }

  private traumaFrom(p: THREE.Vector3, radius: number, strength: number): void {
    const me = this.fleet.get(this.myId);
    const d = (me ? me.position : this.deathPos).distanceTo(p);
    if (d < radius) this.cameraCtl.addTrauma(strength * (1 - d / radius));
  }

  /** Points the HUD hit indicator at a world position (relative to the view). */
  private indicateHitFrom(p: Vec3, amount: number): void {
    const me = this.fleet.get(this.myId);
    if (!me) return;
    const cam = this.renderer.camera;
    _dir.set(p.x - me.position.x, 0, p.z - me.position.z);
    if (_dir.lengthSq() < 0.01) return;
    cam.getWorldDirection(_v).setY(0).normalize();
    _v2.crossVectors(_v, UP);
    const angle = Math.atan2(_dir.dot(_v2), _dir.dot(_v));
    this.ui.showHitIndicator(angle, amount);
  }

  /** Muzzle blast tinted by the weapon and scaled by its model size (sizeMul). */
  private muzzleFlashFor(v: RobotVisual, barrel: number, weaponId?: WeaponId | null): void {
    this.fleet.muzzleWorld(v, barrel, _v);
    v.onFire();
    _dir.set(Math.sin(v.aimYaw) * Math.cos(v.barrelPitch), Math.sin(v.barrelPitch), Math.cos(v.aimYaw) * Math.cos(v.barrelPitch));
    const def = weaponId ? getWeapon(weaponId) : null;
    if (def) _c.setHex(def.color).lerp(_c2.setHex(this.colorOf(v.id)), 0.25);
    else _c.setHex(this.colorOf(v.id));
    this.vfx.muzzleFlash(_v, _dir, _c, def ? fxSize(def) * weaponWeight(def) * 0.85 : 1);
  }

  private handleEvent(e: GameEvent): void {
    const cam = this.renderer.camera;
    switch (e.k) {
      case 'weapon': {
        const visual = this.fleet.get(e.id);
        if (visual) visual.weaponId = e.weaponId;
        const info = this.players.get(e.id);
        if (info) info.weaponId = e.weaponId;
        if (e.id === this.myId) {
          const prev = this.myWeaponId;
          this.myWeaponId = e.weaponId;
          this.optimisticSpent = null;
          this.localFireCooldown = 0;
          if (e.weaponId && e.weaponId !== prev) {
            const def = getWeapon(e.weaponId);
            this.audio.pick();
            this.ui.weaponSplash(def);
          } else if (!e.weaponId && prev) this.showSpent(prev);
        }
        return;
      }
      case 'shot': {
        // Our first volley is predicted in fireLocal; burst follow-ups come from the server.
        if (e.owner === this.myId && e.b < BURST_BARREL_STRIDE && predictsShells(e.weaponId)) return;
        const own = e.owner === this.myId;
        const def = getWeapon(e.weaponId);
        this.projectiles.spawn(e.owner, e.p, e.v, e.bounces, def.color, e.pid, -1, e.b, false, e.lifetime, e.weaponId);
        // The server already flew this shell `ff` seconds (hitscan assist).
        if (e.ff > 0) this.projectiles.fastForward(e.pid, e.ff);
        const v = this.fleet.get(e.owner);
        if (v && e.b % Math.max(1, def.pellets) === 0) this.muzzleFlashFor(v, e.b, e.weaponId);
        if (e.b % BURST_BARREL_STRIDE === 0) {
          this.audio.cannon(own ? null : _v.set(e.p.x, e.p.y, e.p.z), own ? null : cam, own, e.weaponId);
          if (own) this.cameraCtl.addTrauma(0.06 * weaponWeight(e.weaponId));
        }
        return;
      }
      case 'bounce':
        this.projectiles.correctBounce(e.pid, e.p, e.v);
        return;
      case 'impact': {
        if (e.owner !== this.myId) this.projectiles.removeByServerPid(e.pid);
        if (e.target < 0) return;
        const target = this.fleet.get(e.target);
        target?.onDamaged();
        const p = _v.set(e.p.x, e.p.y, e.p.z);
        // Our own hits are drawn from SHOT_RESULT (onShotResult); everyone else's from this event.
        if (e.owner !== this.myId) {
          this.vfx.impact(p, _n.set(e.n.x, e.n.y, e.n.z), 'robot', _c.setHex(this.colorOf(e.owner)), 1.2);
          this.audio.impact(p, cam, true);
        }
        if (e.target === this.myId) {
          const shooter = this.robotPosition(e.owner);
          if (shooter) this.indicateHitFrom(shooter, e.dmg);
          this.onLocalDamaged(e.dmg);
        }
        return;
      }
      case 'dmg': {
        const p = new THREE.Vector3(e.p.x, e.p.y, e.p.z);
        const mine = e.target === this.myId;
        const dealt = !mine && e.source === this.myId;
        // Sustained sources (burn / poison / zones / torch / chainsaw ticks) are summed into one number.
        if (e.amount < TICK_DAMAGE || e.cause === 'burn' || e.cause === 'poison' || e.cause === 'zone') {
          if (mine || dealt) this.accumulateTick(e.target, e.amount, p, mine);
          if (Math.random() < 0.15) this.fleet.get(e.target)?.onDamaged();
          return;
        }
        this.fleet.get(e.target)?.onDamaged();
        if (mine) {
          const src = e.source >= 0 ? this.robotPosition(e.source) : null;
          this.indicateHitFrom(src ?? p, e.amount);
          this.onLocalDamaged(e.amount);
        } else if (dealt) {
          this.ui.spawnNumber(p, String(e.amount), e.amount >= 100 ? 'mega' : e.amount >= 30 ? 'crit' : 'dealt');
          if (e.cause !== 'ram') {
            this.ui.showHitmarker();
            this.audio.hitMarker();
          }
        }
        return;
      }
      case 'heal': {
        if (e.target === this.myId) this.ui.spawnNumber(this.localPosition(), `+${e.amount}`, 'heal');
        // Leech Core: health drained from `from` into `target`.
        if (e.from !== undefined) {
          const a = this.robotPosition(e.from);
          const b = this.robotPosition(e.target);
          if (a && b) {
            this.vfx.leechTether(a, b);
            // Big lifesteal drains (leech dart) land as a visible heal surge on the shooter.
            if (e.amount >= 30) {
              this.vfx.healBurst(b, Math.min(1.8, 0.8 + e.amount / 150));
              this.audio.heal(e.target === this.myId ? null : b, e.target === this.myId ? null : this.renderer.camera);
            }
          }
        }
        return;
      }
      case 'death': {
        const v = this.fleet.get(e.id);
        const p = new THREE.Vector3(e.p.x, e.p.y, e.p.z);
        if (v) {
          this.debris.spawn(this.fleet.createDebris(v), e.p, e.q, e.v);
          v.visible = false;
        }
        // Every weapon one-shots now, so each wreck goes up big.
        this.vfx.explosion(p, 1.35, _c.setHex(this.colorOf(e.id)));
        this.audio.explosion(p, cam, 1.2);
        this.traumaFrom(p, 30, 0.75);
        if (e.id === this.myId) {
          this.deathPos.copy(p);
          this.respawnAt = performance.now() + 3000;
          this.killerId = e.killer;
          this.killerName = e.killer >= 0 ? this.players.get(e.killer)?.name ?? '' : '';
          this.cameraCtl.addTrauma(0.8);
          this.cameraCtl.startDeathCam(this.input.viewYaw);
          this.renderer.pulseChromatic(1);
        }
        return;
      }
      case 'kill': {
        const killer = e.killer >= 0 ? this.players.get(e.killer) : undefined;
        const victim = this.players.get(e.victim);
        const assists = e.assists.map((a) => this.players.get(a)).filter((x): x is PlayerInfo => !!x);
        const mine = e.killer === this.myId || e.victim === this.myId || e.assists.includes(this.myId);
        const weapon = this.killWeapon(e.killer, e.victim);
        this.ui.addKill(killer, victim, assists, mine, weapon);
        if (e.victim === this.myId) this.killerWeapon = weapon?.name ?? '';
        if (e.killer === this.myId && victim) {
          this.ui.spawnNumber(this.localPosition(), '+100 XP', 'crit');
          this.ui.showHitmarker(true);
          this.ui.showKillBanner(victim.name, victim.color, '+100 XP', weapon);
          this.ui.killFlash(weapon?.color ?? victim.color);
          this.audio.killConfirm();
          this.cameraCtl.punchIn(1);
          this.cameraCtl.addTrauma(0.35);
          this.renderer.pulseChromatic(0.8);
          // Hitstop then a short slow-mo: visuals (not the simulation) linger on the kill.
          this.hitstop = HITSTOP_S * 1.5;
          this.slowmo = SLOWMO_S;
        } else if (e.assists.includes(this.myId)) this.ui.spawnNumber(this.localPosition(), '+40 XP assist', 'heal');
        return;
      }
      case 'respawn': {
        const v = this.fleet.get(e.id);
        if (v) {
          v.visible = true;
          v.resetMotion();
        }
        this.interp.delete(e.id);
        if (e.id === this.myId) {
          this.ui.setCenterMessage('');
          this.killerWeapon = '';
          this.cameraCtl.snap();
        }
        return;
      }
      case 'levelup': {
        const pos = this.robotPosition(e.id);
        if (pos) this.vfx.levelUp(pos, _c.setHex(this.colorOf(e.id)));
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
        for (const id of e.hits) {
          const t = this.robotPosition(id);
          if (t) this.vfx.empArc(p, t);
        }
        this.audio.emp(p, cam);
        if (e.hits.includes(this.myId)) {
          this.cameraCtl.addTrauma(0.6);
          this.renderer.pulseChromatic(0.9);
        }
        return;
      }
      case 'dash': {
        if (e.id === this.myId) return;
        const v = this.fleet.get(e.id);
        if (v) this.dashEffect(v);
        return;
      }
      case 'mineBoom': {
        const p = new THREE.Vector3(e.p.x, e.p.y, e.p.z);
        this.vfx.explosion(p, 0.7, _c.setHex(this.colorOf(e.owner)));
        this.audio.explosion(p, cam, 0.6);
        this.traumaFrom(p, 16, 0.45);
        return;
      }
      case 'ram': {
        const p = new THREE.Vector3(e.p.x, e.p.y, e.p.z);
        this.vfx.impact(p, UP, 'metal', _c.setRGB(1, 0.8, 0.5), 1.8);
        this.audio.ram(p, cam, e.speed);
        if (e.a === this.myId || e.b === this.myId) this.cameraCtl.addTrauma(Math.min(0.7, e.speed * 0.04));
        return;
      }
      case 'use': {
        this.lastUse.set(e.id, { weaponId: e.weaponId, t: this.time });
        // Our own non-projectile uses were already drawn by local prediction.
        if (e.id === this.myId && this.time - this.localUseAt < 1) return;
        this.playUse(e.id, e.weaponId, e.p, e.yaw, e.pitch);
        return;
      }
      case 'beam': {
        const def = getWeapon(e.weaponId);
        const from = new THREE.Vector3(e.from.x, e.from.y, e.from.z);
        const to = new THREE.Vector3(e.to.x, e.to.y, e.to.z);
        // Start remote beams at the shooter's drawn muzzle so the beam leaves the gun.
        const shooter = this.fleet.get(e.owner);
        if (shooter && shooter.visible) {
          this.fleet.muzzleWorld(shooter, 0, from);
          shooter.onFire();
        }
        const weight = weaponWeight(def);
        this.vfx.beam(from, to, _c.setHex(def.color), e.target >= 0, fxSize(def) * weight * 0.85);
        this.audio.beam(e.owner === this.myId ? null : from, e.owner === this.myId ? null : cam, e.owner === this.myId, weight);
        if (e.target >= 0) this.traumaFrom(to, 10, 0.25);
        if (e.target >= 0) this.fleet.get(e.target)?.onDamaged();
        if (e.owner === this.myId) {
          this.cameraCtl.addTrauma(0.15 * weight);
          this.renderer.pulseChromatic(0.3);
        }
        if (e.target === this.myId) {
          this.indicateHitFrom(from, 40);
          this.renderer.pulseChromatic(0.6);
        }
        return;
      }
      case 'explode': {
        const def = getWeapon(e.weaponId);
        const p = new THREE.Vector3(e.p.x, e.p.y, e.p.z);
        const color = _c.setHex(def.color);
        const r = Math.max(1, e.r);
        // Branch on what the weapon does, never on its id: kinds and fields change with balance passes.
        if (def.kind === 'self' || def.kind === 'pulse' || (def.shield > 0 && !def.zone)) {
          // Energy shockwave (e.g. shield canister): cyan rings and lightning, no fireball.
          this.vfx.energyBlast(p, r, color);
          this.audio.zap(p, cam, true, weaponWeight(def));
          this.audio.explosion(p, cam, Math.min(1, r / 10));
          this.traumaFrom(p, r * 3 + 8, 0.7);
        } else {
          if (def.kind === 'deploy') this.vfx.zones.detonateNear(p.x, p.z, Math.max(4, def.triggerRadius ?? 0) + 2);
          const zoneKind = def.zone?.kind;
          const style = zoneKind === 'fire' && def.kind === 'lob' ? 'fire'
            : zoneKind === 'acid' && def.kind === 'lob' ? 'acid'
            : zoneKind === 'toxic' || zoneKind === 'acid' ? 'toxic'
            : zoneKind === 'fire' && def.explodeRadius < 4 ? 'fire'
            : 'rocket';
          this.vfx.blast(p, r, color, style);
          const scale = Math.max(0.5, Math.min(2, r / 6));
          if (style === 'rocket' || style === 'toxic') this.audio.explosion(p, cam, scale * Math.min(1.25, weaponWeight(def)));
          else {
            this.audio.ignite(p, cam, style === 'fire');
            if (r >= 4) this.audio.explosion(p, cam, scale * 0.6);
          }
          // Shake falls off with distance; big blasts reach much further.
          this.traumaFrom(p, r * 3.5 + 8, style === 'rocket' || style === 'toxic' ? Math.min(1, 0.55 + r * 0.04) : 0.4);
        }
        if (e.owner === this.myId) this.renderer.pulseChromatic(0.3);
        return;
      }
      case 'zone': {
        this.vfx.addZone(e.zid, e.kind, e.p, e.r, e.dur);
        // A deploy weapon with a trigger radius drops a live proximity bomb at the zone's centre.
        const used = this.lastUse.get(e.owner);
        const droppedId = used && this.time - used.t < 3 ? used.weaponId : this.ownerWeapon.get(e.owner);
        const dropped = droppedId ? getWeapon(droppedId) : null;
        if (dropped && dropped.kind === 'deploy' && (dropped.triggerRadius ?? 0) > 0) this.vfx.zones.armBomb(e.zid, dropped.color, dropped.triggerRadius);
        if (e.kind === 'toxic') this.audio.ignite(_v.set(e.p.x, e.p.y, e.p.z), cam, false);
        return;
      }
      case 'chain': {
        if (e.pts.length < 2) return;
        const owned = this.ownerWeapon.get(e.owner);
        const def = owned ? getWeapon(owned) : null;
        this.vfx.chain(e.pts, _c.setHex(def && def.chain > 0 ? def.color : 0x7ff3ff), def ? fxSize(def) : 1.2);
        this.audio.zap(_v.set(e.pts[0].x, e.pts[0].y, e.pts[0].z), cam, true, def ? weaponWeight(def) : 1);
        for (let i = 1; i < e.pts.length; i++) this.traumaFrom(_v.set(e.pts[i].x, e.pts[i].y, e.pts[i].z), 9, 0.2);
        return;
      }
      case 'teleport': {
        const from = new THREE.Vector3(e.from.x, e.from.y, e.from.z);
        const to = new THREE.Vector3(e.to.x, e.to.y, e.to.z);
        const use = this.lastUse.get(e.id);
        const recent = use && this.time - use.t < 1.5 ? getWeapon(use.weaponId) : null;
        const shotBy = this.ownerWeapon.get(e.id);
        const blinker = recent ?? (shotBy ? getWeapon(shotBy) : null);
        if (blinker && blinker.kind === 'dash') this.vfx.dashSlash(from, to, _c.setHex(blinker.color), fxSize(blinker));
        else this.vfx.teleport(from, to, _c.setHex(blinker && blinker.teleport ? blinker.color : 0x8fd8ff), blinker ? fxSize(blinker) : 1.2);
        this.audio.teleport(to, cam);
        if (e.id !== this.myId) this.interp.delete(e.id);
        else {
          this.renderer.dashBlur(1);
          this.cameraCtl.addTrauma(0.3);
        }
        return;
      }
      case 'status': {
        const v = this.fleet.get(e.target);
        if (v && v.visible) this.vfx.statusBurst(v.position, e.effect);
        if (e.effect === 'stun' && v) this.audio.zap(v.position, cam, false);
        if (e.target === this.myId) {
          this.ui.spawnNumber(this.localPosition(), STATUS_LABEL[e.effect], 'taken');
          if (e.effect === 'stun') this.cameraCtl.addTrauma(0.3);
        }
        return;
      }
      case 'shield': {
        const v = this.fleet.get(e.id);
        if (!v) return;
        if (e.amount > 0) {
          const use = this.lastUse.get(e.id);
          const justUsed = !!use && getWeapon(use.weaponId).shield > 0 && this.time - use.t < 1;
          if (!justUsed && v.visible) this.vfx.shieldUp(v.position, 1.2);
          if (e.id === this.myId) this.ui.spawnNumber(this.localPosition(), `+${e.amount} SHIELD`, 'heal');
        } else {
          if (v.visible) this.vfx.shieldBreak(v.position);
          this.audio.shield(v.position, cam, true);
          if (e.id === this.myId) this.ui.spawnNumber(this.localPosition(), 'SHIELD DOWN', 'taken');
        }
        return;
      }
      case 'melee': {
        const def = getWeapon(e.weaponId);
        const p = new THREE.Vector3(e.p.x, e.p.y, e.p.z);
        // Sustained weapons (torch, chainsaw) report a hit every tick: throttle the feedback.
        const key = `${e.owner}:${e.target}`;
        const last = this.meleeFeedbackAt.get(key) ?? -10;
        if (this.time - last < (def.duration > 0 ? 0.22 : 0.05)) return;
        this.meleeFeedbackAt.set(key, this.time);
        const target = this.fleet.get(e.target);
        target?.onDamaged();
        const owner = this.robotPosition(e.owner);
        _n.set(0, 1, 0);
        if (owner) _n.set(p.x - owner.x, 0.4, p.z - owner.z).normalize();
        if (def.kind === 'cone') this.vfx.statusBurst(p, 'burn');
        else {
          this.vfx.impact(p, _n, 'robot', _c.setHex(def.color), def.duration > 0 ? 0.9 : 1.8);
          // Impact frame: a big flash + punched ring for every decisive (non-sustained) hit.
          if (def.duration <= 0) this.vfx.impactFrame(p, _n, _c.setHex(def.color), Math.max(0.6, e.dmg / 100) * fxSize(def) / 1.2);
          this.audio.meleeHit(p, cam, e.dmg);
        }
        if (def.duration <= 0) this.traumaFrom(p, 12, Math.min(0.4, e.dmg / 400));
        if (e.owner === this.myId) {
          if (def.duration <= 0) {
            this.cameraCtl.addTrauma(Math.min(0.6, 0.2 + e.dmg / 200));
            // Hit-stop scales with the blow: kill-tier hits freeze the frame noticeably.
            this.hitstop = Math.max(this.hitstop, HITSTOP_S * Math.min(1.6, 0.6 + e.dmg / 120));
            this.renderer.pulseChromatic(Math.min(0.6, e.dmg / 250));
          }
        }
        if (e.target === this.myId && owner) this.indicateHitFrom(owner, e.dmg);
        return;
      }
      case 'disarm': {
        const victim = this.robotPosition(e.victim);
        if (victim) this.ui.spawnNumber(victim, 'DISARMED!', 'crit');
        if (e.victim === this.myId) {
          this.lastDisarmAt = this.time;
          this.ui.toast('DISARMED!', 'Your weapon was knocked away. Find another pad.', null, 'warn');
          this.audio.spent(true);
          this.cameraCtl.addTrauma(0.3);
        } else if (e.owner === this.myId) {
          this.ui.showHitmarker(true);
          this.audio.hitMarker();
        }
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
        this.activeUses.length = 0;
        this.tickDamage.clear();
        this.lastHit.clear();
        this.pidWeapon.clear();
        this.slowmo = 0;
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

  /** Toast + sound when our single-use weapon is consumed (not on death or disarm). */
  private showSpent(weaponId: WeaponId): void {
    if (this.time - this.lastDisarmAt < 1 || performance.now() < this.respawnAt) return;
    const def = getWeapon(weaponId);
    this.ui.toast(`${def.name.toUpperCase()} SPENT`, 'Drive over a weapon pad to re-arm', def.color);
    this.audio.spent();
  }

  private accumulateTick(target: number, amount: number, p: THREE.Vector3, taken: boolean): void {
    if (amount <= 0) return;
    const acc = this.tickDamage.get(target);
    if (acc) {
      acc.amount += amount;
      acc.p.copy(p);
    } else this.tickDamage.set(target, { amount, since: this.time, p: p.clone(), taken });
  }

  /** Shows summed damage ticks every ~0.6 s. */
  private flushTickDamage(): void {
    for (const [target, acc] of this.tickDamage) {
      if (this.time - acc.since < 0.6) continue;
      this.tickDamage.delete(target);
      const amount = Math.round(acc.amount);
      if (amount <= 0) continue;
      if (acc.taken) {
        this.ui.spawnNumber(this.localPosition(), `-${amount}`, 'taken');
        this.ui.damageFlash();
      } else {
        const pos = this.robotPosition(target) ?? acc.p;
        this.ui.spawnNumber(pos, String(amount), 'dealt');
      }
    }
  }

  /**
   * Weapon-kind specific feedback for one trigger pull. Projectile / lob kinds
   * are drawn by their `shot` events; this covers everything else.
   */
  private playUse(id: number, weaponId: WeaponId, p: Vec3, yaw: number, pitch: number): void {
    const def = getWeapon(weaponId);
    const v = this.fleet.get(id);
    const pos = v && v.visible ? v.position.clone() : new THREE.Vector3(p.x, p.y, p.z);
    const cam = this.renderer.camera;
    const local = id === this.myId;
    const at = local ? null : pos;
    const color = new THREE.Color(def.color);
    const size = fxSize(def);
    const weight = weaponWeight(def);
    const lethal = estimateDamage(def) >= 100;
    switch (def.kind) {
      case 'projectile':
      case 'lob':
        // Shells are drawn from `shot` events; only a self-buff riding on the shot (e.g. a speed rush) shows here.
        break;
      case 'beam':
        if (v) this.muzzleFlashFor(v, 0, weaponId);
        return;
      case 'melee': {
        v?.onFire();
        const heavy = lethal || def.launch > 0 || def.push >= 20;
        this.vfx.slash(pos, yaw, def.arc, def.range, color, heavy, size * weight * 0.85);
        if (def.duration > 0) {
          this.activeUses.push({ id, weaponId, until: this.time + def.duration });
          this.audio.chainsaw(at, local ? null : cam, def.duration);
        } else this.audio.swing(at, local ? null : cam, heavy, weight);
        if (def.lunge > 0 && v) {
          this.fleet.chassisDirection(v, BACK, _dir);
          this.vfx.dashStreaks(pos, _dir);
          this.vfx.dashStreaks(pos, _dir);
        }
        if (local) this.cameraCtl.addTrauma(heavy ? 0.28 : 0.14);
        break;
      }
      case 'dash': {
        if (v) {
          v.onDash();
          this.fleet.chassisDirection(v, BACK, _dir);
          this.vfx.dashStreaks(pos, _dir);
          this.vfx.dashStreaks(pos, _dir);
          for (const n of NOZZLE_TIPS) this.vfx.dashThrusters(this.fleet.chassisPoint(v, n, _v), _dir);
        }
        this.vfx.slash(pos, yaw, Math.max(1.4, def.arc), Math.max(5, def.range * 0.25), color, true, size);
        this.audio.swing(at, local ? null : cam, true, weight);
        this.audio.dash(at, local ? null : cam);
        if (local) {
          this.renderer.dashBlur(1);
          this.cameraCtl.addTrauma(0.25);
        }
        break;
      }
      case 'cone':
        v?.onFire();
        this.activeUses.push({ id, weaponId, until: this.time + Math.max(0.3, def.duration) });
        this.audio.flame(at, local ? null : cam, def.duration);
        break;
      case 'pulse':
        if (lethal) this.vfx.energyBlast(pos, def.range, color);
        else this.vfx.shockRing(pos, def.range, color);
        this.audio.zap(at, local ? null : cam, true, weight);
        if (lethal) this.audio.explosion(at, local ? null : cam, Math.min(1.2, def.range / 12));
        this.traumaFrom(pos, def.range * 2, lethal ? 0.7 : 0.4);
        if (local) this.renderer.pulseChromatic(lethal ? 0.7 : 0.4);
        break;
      case 'self':
        // A self weapon with damage also blasts a shockwave; the server's `explode` event draws it.
        if (local) this.cameraCtl.addTrauma(def.damage > 0 ? 0.3 : 0.1);
        break;
      case 'deploy': {
        // Dropped behind the robot.
        const back = v ? this.fleet.chassisDirection(v, BACK, _dir) : _dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        const drop = pos.clone().addScaledVector(back.setY(0).normalize(), 2.4);
        this.vfx.deployThud(drop, color, size);
        this.audio.deploy(local ? null : drop, local ? null : cam);
        break;
      }
    }
    // Buff fields apply whatever the kind (a leech dart can carry a speed rush, a pulse a shield...).
    if (def.heal > 0) {
      this.vfx.healBurst(pos, size);
      this.audio.heal(at, local ? null : cam);
    }
    if (def.shield > 0) {
      this.vfx.shieldUp(pos, size);
      this.audio.shield(at, local ? null : cam, false);
    }
    if (def.speedBoost > 0 && v && def.kind !== 'melee') {
      this.fleet.chassisDirection(v, BACK, _dir);
      for (const n of NOZZLE_TIPS) this.vfx.dashThrusters(this.fleet.chassisPoint(v, n, _v), _dir);
    }
    void pitch;
  }

  /** Per-frame emitters for sustained uses (torch flames, chainsaw sparks). */
  private updateActiveUses(dt: number): void {
    for (let i = this.activeUses.length - 1; i >= 0; i--) {
      const a = this.activeUses[i];
      const v = this.fleet.get(a.id);
      if (!v || !v.visible || this.time >= a.until) {
        this.activeUses.splice(i, 1);
        continue;
      }
      const def = getWeapon(a.weaponId);
      this.fleet.muzzleWorld(v, 0, _v);
      _dir.set(Math.sin(v.aimYaw) * Math.cos(v.barrelPitch), Math.sin(v.barrelPitch), Math.cos(v.aimYaw) * Math.cos(v.barrelPitch));
      if (def.kind === 'cone') this.vfx.flameCone(_v, _dir, def.range, def.arc, dt, fxSize(def));
      else {
        // Chainsaw: sparks off the front of the chassis.
        this.fleet.chassisDirection(v, FORWARD, _dir);
        _v.copy(v.position).addScaledVector(_dir, 1.6).setY(v.position.y + 0.5);
        this.vfx.sawSparks(_v, _dir, dt, fxSize(def));
      }
    }
  }

  private dashEffect(v: RobotVisual): void {
    v.onDash();
    this.fleet.chassisDirection(v, BACK, _dir);
    for (const n of NOZZLE_TIPS) this.vfx.dashThrusters(this.fleet.chassisPoint(v, n, _v), _dir);
    this.vfx.shockwave(v.position, 3.5, _c.setRGB(3, 1.6, 0.5), 0.35);
    this.audio.dash(v.position, this.renderer.camera);
    if (v.id === this.myId) this.renderer.dashBlur(1);
  }

  // ------------------------------------------------------------------ simulation

  private renderTime(): number {
    return this.net.serverNow() - this.netTuning.interpolationDelayMs;
  }

  private fixedUpdate(dt: number): void {
    const renderT = this.renderTime();
    const latest = this.buffer.latest();

    // Remote robots become kinematic proxies (for bumping) and hitboxes (for aiming and shells)
    // at their interpolated poses: exactly what the server rewinds to for our shots.
    let n = 0;
    if (latest) {
      for (const id of latest.robots.keys()) {
        if (id === this.myId) continue;
        const s = this.buffer.sample(id, renderT, this.interp.get(id) ?? null);
        if (!s) continue;
        this.interp.set(id, s);
        const alive = (s.latest.flags & RobotFlags.ALIVE) !== 0;
        this.physics.setProxy(id, s.position, s.quaternion, alive);
        if (alive && n < this.hitTargets.length - 1) this.setHitTarget(n++, id, s.position, s.quaternion);
      }
    }
    const lc = this.predictor.controller;
    const meState = latest?.robots.get(this.myId);
    const meAlive = meState ? (meState.flags & RobotFlags.ALIVE) !== 0 : false;
    if (lc && meAlive) this.setHitTarget(n++, this.myId, lc.body.translation(), lc.body.rotation());
    this.hitTargetCount = n;
    this.projectiles.setTargets(this.hitTargets, n);

    if (meState && this.predictor.active && this.connected) {
      const playing = this.phase === MatchPhase.PLAYING;
      const frame = this.input.sample();
      this.solveLocalAim(frame, renderT);
      if (!playing || this.menu.isOpen || !this.input.isLocked || document.hidden) {
        frame.throttle = 0;
        frame.steer = 0;
        frame.buttons = 0;
      }
      this.lastThrottle = frame.throttle;
      this.net.sendInput(frame);
      if (meAlive) {
        this.predictor.applyInput(frame, dt);
        if (this.predictor.lastDashed) {
          const v = this.fleet.get(this.myId);
          if (v) this.dashEffect(v);
        }
      }
      this.localFireCooldown = Math.max(0, this.localFireCooldown - dt);
      if (meAlive && playing && !this.predictor.stunned && (frame.buttons & Buttons.FIRE) && this.localFireCooldown <= 0) this.fireLocal(frame);
    }

    this.physics.step();
    this.predictor.afterStep();
    this.projectiles.fixedUpdate(dt);
    this.debris.fixedUpdate(dt);
  }

  private setHitTarget(i: number, id: number, p: Vec3, q: { x: number; y: number; z: number; w: number }): void {
    const t = this.hitTargets[i];
    t.id = id;
    t.p.x = p.x; t.p.y = p.y; t.p.z = p.z;
    t.q.x = q.x; t.q.y = q.y; t.q.z = q.z; t.q.w = q.w;
  }

  /**
   * Turns the screen-centre ray (last rendered camera) into turret yaw/pitch
   * with the shared solver, and stamps the frame with the time of the world
   * this screen shows so the server can rewind to it.
   */
  private solveLocalAim(frame: InputFrame, renderT: number): void {
    const c = this.predictor.controller;
    frame.viewT = renderT;
    if (!c || this.cameraCtl.deathCamActive) {
      this.aimValid = false;
      frame.aimYaw = this.input.viewYaw;
      frame.aimPitch = 0;
      return;
    }
    getTurretPivot(c.body.translation(), c.body.rotation(), this.pivot);
    solveAim(
      {
        world: this.projectiles.world,
        targets: this.hitTargets,
        targetCount: this.hitTargetCount,
        selfId: this.myId,
        camOrigin: this.cameraCtl.aimOrigin,
        camDir: this.cameraCtl.aimDir,
        pivot: this.pivot,
      },
      this.aim,
    );
    this.aimValid = true;
    frame.aimYaw = this.aim.yaw;
    frame.aimPitch = this.aim.pitch;
  }

  /**
   * One trigger pull of the single-use weapon. Shells (first volley only) are
   * predicted for projectile / lob kinds; other kinds play their use effect
   * immediately and the server echo is skipped. The weapon is treated as spent
   * right away, exactly as the server does.
   */
  private fireLocal(frame: InputFrame): void {
    const c = this.predictor.controller;
    const weaponId = this.myWeaponId;
    if (!c || !weaponId) return;
    const def = getWeapon(weaponId);
    const cfg = weaponStats(weaponId);
    const st = this.myStats;
    this.localFireCooldown = cfg.interval / st.fireRateMul;
    const v = this.fleet.get(this.myId);
    if (def.kind === 'projectile' || def.kind === 'lob') {
      if (predictsShells(weaponId)) {
        // Same shot spec (origin, direction, seeded spread) the server computes for this input seq.
        const shots = computeWeaponShots(c.body.translation(), c.body.rotation(), frame.aimYaw, frame.aimPitch, st.projectileCount, this.myId, frame.seq, weaponId);
        for (const s of shots) {
          const vel = { x: s.dir.x * cfg.speed, y: s.dir.y * cfg.speed, z: s.dir.z * cfg.speed };
          this.projectiles.spawn(this.myId, s.origin, vel, st.ricochetBounces, def.color, 0, frame.seq, s.barrel, true, cfg.lifetime, weaponId);
          if (v && s.barrel % Math.max(1, def.pellets) === 0) this.muzzleFlashFor(v, s.barrel, weaponId);
        }
        this.audio.cannon(null, null, true, weaponId);
        this.cameraCtl.addTrauma((def.knockbackMul >= 2 ? 0.18 : 0.09) * weaponWeight(def));
        if (def.heal > 0 || def.shield > 0 || def.speedBoost > 0) {
          this.localUseAt = this.time;
          this.playUse(this.myId, weaponId, c.body.translation(), frame.aimYaw, frame.aimPitch);
        }
      }
    } else if (def.kind !== 'beam') {
      const p = c.body.translation();
      this.localUseAt = this.time;
      this.playUse(this.myId, weaponId, p, frame.aimYaw, frame.aimPitch);
    }
    // Single use: spent on this pull (burst follow-ups and sustained effects keep running server-side).
    this.myWeaponId = null;
    this.optimisticSpent = { id: weaponId, until: this.time + 1.5 };
    this.showSpent(weaponId);
  }

  // ------------------------------------------------------------------ frame

  private readonly loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const frameMs = now - this.lastFrame;
    const frameDt = Math.min(0.1, frameMs / 1000);
    this.lastFrame = now;
    this.time += frameDt;

    if (this.physics) {
      this.accumulator = Math.min(this.accumulator + frameDt, 0.25);
      while (this.accumulator >= FIXED_DT) {
        this.fixedUpdate(FIXED_DT);
        this.accumulator -= FIXED_DT;
      }
      this.renderFrame(frameDt, this.accumulator / FIXED_DT, frameMs);
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
    const t = this.telemetry;
    for (let i = 0; i < WHEEL_ANCHORS.length; i++) {
      t.suspension[i] = v.wheelSuspensionLength(i) ?? physicsConfig.suspensionRestLength;
      t.rotation[i] = v.wheelRotation(i) ?? 0;
      t.steering[i] = v.wheelSteering(i) ?? 0;
      t.contact[i] = v.wheelIsInContact(i);
    }
    return t;
  }

  /** Pushes a pose + state into a fleet visual. */
  private poseVisual(v: RobotVisual, pos: THREE.Vector3, quat: THREE.Quaternion, vel: THREE.Vector3, aimYaw: number, aimPitch: number, state: RobotNetState, flags: number, steer: number): void {
    v.position.copy(pos);
    v.quaternion.copy(quat);
    v.velocity.copy(vel);
    v.aimYaw = aimYaw;
    v.aimPitch = aimPitch;
    v.flags = flags;
    v.hp = state.hp;
    v.maxHp = state.maxHp;
    v.steerInput = steer;
    v.steeringAngle = state.steeringAngle;
  }

  /** Visual-only effects that follow a robot: skids, tyre smoke, exhaust, damage, repair, landings. */
  private robotEffects(v: RobotVisual, grounded: boolean, isMe: boolean, dt: number): void {
    if (!v.visible) return;
    const vfx = this.vfx;
    const t = vfx.time;
    const lateral = Math.abs(v.lateralSpeed);
    const slide = grounded && (lateral > 3 || (isMe && Math.abs(this.lastThrottle) > 0 && Math.abs(v.forwardSpeed) < 2 && v.velocity.lengthSq() > 4));
    const strength = grounded ? Math.max(slide ? Math.min(1, (lateral - 2.5) / 5 + 0.3) : 0, v.driftAmount * Math.min(0.8, lateral / 4)) : 0;
    this.fleet.chassisDirection(v, RIGHT, _n);
    for (let i = 0; i < 4; i++) {
      this.fleet.wheelContact(v, i, _v);
      const tireStrength = grounded && (!v.hasTelemetry || v.wheelContact[i]) ? strength * (i < 2 ? 0.45 : 1) : 0;
      vfx.skids.feed(v.id * 4 + i, _v.x, _v.y, _v.z, _n.x, _n.z, 0.3, tireStrength, t);
      if (tireStrength > 0 && i >= 2) vfx.tireSmoke(_v, v.velocity, tireStrength * dt * 24);
    }
    if (v.landingImpact > 0) {
      vfx.landingDust(v.position, v.landingImpact);
      if (isMe) {
        this.cameraCtl.addTrauma(Math.min(0.25, v.landingImpact * 0.02));
        this.audio.landing(v.landingImpact);
      }
    }
    if (v.flags & RobotFlags.BOOSTING) {
      this.fleet.chassisDirection(v, BACK, _dir);
      for (const tip of EXHAUST_TIPS) vfx.exhaust(this.fleet.chassisPoint(v, tip, _v), _dir, true);
    }
    if (v.dashTimer > 0.3) {
      this.fleet.chassisDirection(v, BACK, _dir);
      for (const tip of NOZZLE_TIPS) vfx.exhaust(this.fleet.chassisPoint(v, tip, _v), _dir, true);
    }
    if (v.damageTier >= 1 && Math.random() < dt * (v.damageTier === 2 ? 10 : 4)) {
      const p = DAMAGE_POINTS[v.damagePointIndex];
      vfx.damageSmoke(this.fleet.chassisPoint(v, p, _v), v.damageTier === 2);
    }
    if (v.damageTier === 2 && Math.random() < dt * 1.5) {
      const p = DAMAGE_POINTS[(v.damagePointIndex + 2) % DAMAGE_POINTS.length];
      vfx.damageSparks(this.fleet.chassisPoint(v, p, _v), this.fleet.chassisDirection(v, UP, _n));
    }
    if (v.flags & RobotFlags.STUNNED) vfx.stunSparks(v.position);
    if (v.flags & RobotFlags.BURNING) vfx.burning(v.position, dt);
    if (v.flags & RobotFlags.POISONED) vfx.poisoned(v.position, dt);
    if (v.flags & RobotFlags.SLOWED) vfx.acidDrip(v.position, dt);
    if (v.flags & RobotFlags.SHIELDED) vfx.shieldBubble(v.id, v.position);
    if ((v.stacks.field_repair ?? 0) > 0 && v.hp < v.maxHp && v.sinceDamaged > 4 && Math.random() < dt * 12) vfx.repairSwirl(v.position);
  }

  private renderFrame(dt: number, alpha: number, frameMs: number): void {
    this.processEvents();
    const renderT = this.renderTime();
    const latest = this.buffer.latest();
    const me = latest?.robots.get(this.myId);
    // Hitstop slows only what is drawn (fleet, particles, decals); simulation and netcode run at full speed.
    this.hitstop = Math.max(0, this.hitstop - dt);
    this.slowmo = Math.max(0, this.slowmo - dt);
    // Kill slow-mo eases from SLOWMO_SCALE back to full speed.
    const slow = this.slowmo > 0 ? SLOWMO_SCALE + (1 - SLOWMO_SCALE) * (1 - this.slowmo / SLOWMO_S) ** 2 : 1;
    const vdt = this.hitstop > 0 ? dt * HITSTOP_SCALE : dt * slow;

    // Local robot (predicted + smoothed).
    let camTarget = this.deathPos;
    let boosting = false;
    const myVisual = this.fleet.get(this.myId);
    if (me && myVisual && this.predictor.active) {
      const alive = (me.flags & RobotFlags.ALIVE) !== 0;
      this.predictor.renderPose(alpha, dt, _pos, _quat);
      const c = this.predictor.controller;
      const v = this.predictor.velocity();
      _vel.set(v.x, v.y, v.z);
      boosting = !!c?.sim.boosting;
      let flags = me.flags & ~(RobotFlags.BOOSTING | RobotFlags.DRIFTING);
      if (boosting) flags |= RobotFlags.BOOSTING;
      if ((c?.sim.driftAmount ?? 0) > 0.15) flags |= RobotFlags.DRIFTING;
      myVisual.visible = alive;
      if (alive) {
        this.poseVisual(myVisual, _pos, _quat, _vel, this.aimValid ? this.aim.yaw : this.input.viewYaw, this.aimValid ? this.aim.pitch : 0, me, flags, 0);
        myVisual.setTelemetry(this.wheelTelemetry());
        camTarget = myVisual.position;
        this.debris.syncRobot(this.myId, _pos, _quat, true);
      } else {
        this.debris.syncRobot(this.myId, _pos, _quat, false);
      }
    }

    // Remote robots (interpolated ~100 ms in the past).
    for (const v of this.fleet.visuals.values()) {
      const id = v.id;
      if (id === this.myId) continue;
      const s = this.buffer.sample(id, renderT, this.interp.get(id) ?? null);
      if (!s) continue;
      this.interp.set(id, s);
      const alive = (s.latest.flags & RobotFlags.ALIVE) !== 0;
      v.visible = alive;
      if (!alive) {
        this.debris.syncRobot(id, s.position, s.quaternion, false);
        continue;
      }
      this.poseVisual(v, s.position, s.quaternion, s.velocity, s.aimYaw, s.aimPitch, s.latest, s.latest.flags, s.steer);
      v.setTelemetry(null);
      this.debris.syncRobot(id, s.position, s.quaternion, true);
    }

    this.fleet.update(vdt, this.vfx.time, this.groundHeight);
    for (const v of this.fleet.visuals.values()) {
      const isMe = v.id === this.myId;
      let grounded = Math.abs(v.velocity.y) < 2.5;
      if (isMe) {
        grounded = false;
        for (let i = 0; i < 4; i++) grounded = grounded || this.telemetry.contact[i];
      }
      this.robotEffects(v, grounded, isMe, vdt);
    }
    this.updateActiveUses(vdt);
    this.flushTickDamage();

    const alive = !!me && (me.flags & RobotFlags.ALIVE) !== 0;
    const drivingActive = alive && this.started && this.connected && this.phase === MatchPhase.PLAYING
      && this.input.isLocked && !this.menu.isOpen && !document.hidden && document.hasFocus();
    const controller = this.predictor.controller;
    const referenceSpeed = physicsConfig.maxSpeed * (controller?.modifiers.speedMul ?? 1);
    this.driveYaw = myVisual ? yawFromQuat(myVisual.quaternion) : this.input.viewYaw;
    const sin = Math.sin(this.driveYaw), cos = Math.cos(this.driveYaw);
    this.driveForwardSpeed = myVisual ? myVisual.velocity.x * sin + myVisual.velocity.z * cos : 0;
    this.driveGrounded = alive && this.telemetry.contact.some(Boolean);
    const sound = this.vehicleAudio;
    sound.forwardSpeed = this.driveForwardSpeed;
    sound.lateralSpeed = myVisual ? myVisual.velocity.x * cos - myVisual.velocity.z * sin : 0;
    sound.throttle = this.lastThrottle;
    sound.driveDemand = controller?.sim.driveDemand ?? 0;
    sound.driftAmount = controller?.sim.driftAmount ?? 0;
    sound.grounded = this.driveGrounded;
    sound.boosting = boosting;
    sound.alive = alive;
    sound.maxSpeed = referenceSpeed;
    sound.surface = getMap(this.mapId).biome;
    sound.dt = dt;
    sound.active = drivingActive;
    this.audio.updateVehicle(sound);

    // Camera: death cam orbits the killer for 2 s, otherwise the orbit rig.
    const cam = this.renderer.camera;
    const killer = this.killerId >= 0 ? this.fleet.get(this.killerId) : undefined;
    const deathFocus = killer && killer.visible ? killer.position : this.deathPos;
    if (!(me && (me.flags & RobotFlags.ALIVE) === 0 && this.cameraCtl.updateDeathCam(deathFocus, dt))) {
      this.cameraCtl.deathCamActive = false;
      const intent = this.drivingIntent;
      intent.active = drivingActive;
      intent.mouseIdleSeconds = this.input.mouseIdleSeconds;
      intent.mouseSerial = this.input.mouseSerial;
      intent.firing = this.input.isFiring;
      intent.steady = this.input.isSteadyCamera;
      intent.recenter = this.input.consumeRecenter();
      intent.driftAmount = controller?.sim.driftAmount ?? 0;
      this.input.viewYaw = this.cameraCtl.resolveDrivingYaw(this.input.viewYaw, this.driveYaw, this.driveForwardSpeed, dt, intent);
      const motion = this.cameraMotion;
      motion.velocity = myVisual?.velocity ?? this.cameraMotion.velocity;
      motion.referenceSpeed = referenceSpeed;
      motion.steady = intent.steady;
      motion.active = drivingActive;
      this.cameraCtl.update(camTarget, this.input.viewYaw, this.input.viewPitch, boosting, dt, motion);
    }
    this.renderer.followShadow(camTarget);
    this.audio.setListener(cam.position);

    // World effects.
    const mines = this.buffer.sampleMines(renderT, this.mineSamples);
    this.vfx.mines.update(this.mineSamples, mines, this.colorOfFn, this.vfx.time);
    this.projectiles.render(this.vfx.time);
    this.debris.update();
    this.vfx.update(vdt, cam.position);
    this.arena.update(this.time, dt);
    this.pickups.update(this.time, dt, this.lastSnap?.pickups ?? []);
    this.dust.update(this.time, this.renderer.renderer.getPixelRatio());
    this.cableTimer -= dt;
    if (this.cableTimer <= 0 && this.arena.sparkPoints.length > 0) {
      this.cableTimer = 1.5 + Math.random() * 4;
      this.vfx.cableSparks(this.arena.sparkPoints[Math.floor(Math.random() * this.arena.sparkPoints.length)]);
    }
    this.updateGhost(me);

    this.updateHud(me, dt);
    this.aimDebug.update(
      this.aimValid ? { camOrigin: this.cameraCtl.aimOrigin, aim: this.aim, pivot: this.pivot, targets: this.hitTargets, targetCount: this.hitTargetCount } : null,
      dt,
    );
    this.renderer.info.reset();
    this.renderer.render(dt);
    this.aimDebug.renderPip(this.renderer.renderer, this.renderer.scene);

    const ps = this.perfSample;
    ps.frameMs = frameMs;
    ps.sceneDraws = this.renderer.draws.scene;
    ps.totalDraws = this.renderer.draws.total;
    ps.triangles = this.renderer.draws.triangles;
    const vs = this.vfx.stats(this.vfxStats, this.perf.enabled);
    ps.particles = vs.particles;
    ps.lights = vs.lights;
    ps.preset = this.settings.preset;
    this.perf.update(dt, ps);

    if (this.autoDetect && this.started) {
      const rec: QualityName | null = this.autoDetect.sample(dt);
      if (rec) {
        console.info(`[quality] auto-detected preset: ${rec}`);
        this.applySettings(settingsForPreset(rec), true);
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

  private readonly abilitySlots: AbilityDisplay[] = [
    { id: 'dash', icon: '➤', cooldown: 0, max: 1, key: 'Q' },
    { id: 'emp', icon: 'ϟ', cooldown: 0, max: 1, key: 'Q' },
  ];
  private readonly abilityList: AbilityDisplay[] = [];
  private leaderName = '—';
  private leaderKills = 0;

  private updateHud(me: RobotNetState | undefined, dt: number): void {
    const ui = this.ui;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const info = this.players.get(this.myId);
    const alive = me ? (me.flags & RobotFlags.ALIVE) !== 0 : false;
    const equipped = this.myWeaponId ? getWeapon(this.myWeaponId) : null;
    ui.setWeapon(equipped);
    let prompt = '';
    let nearest = 2.6;
    const local = this.predictor.controller?.body.translation();
    if (alive && local && this.started && !this.menu.isOpen) {
      for (const pad of this.lastSnap?.pickups ?? []) {
        const distance = Math.hypot(local.x - pad.position.x, local.y - pad.position.y, local.z - pad.position.z);
        if (distance >= nearest) continue;
        nearest = distance;
        const weapon = getWeapon(pad.weaponId);
        prompt = !pad.available ? `Pad restocking · new weapon in ${Math.ceil(pad.respawnIn)}s`
          : !this.myWeaponId ? `Drive over to grab ${weapon.name} · ${weapon.power}`
          : pad.weaponId === this.myWeaponId ? `${weapon.name} already equipped`
          : `E · Swap to ${weapon.name} · ${weapon.power}`;
      }
    }
    ui.setPickupPrompt(prompt);
    ui.setDriving(this.driveForwardSpeed, this.lastThrottle, this.input.viewYaw - this.driveYaw, this.driveGrounded, !!this.predictor.controller?.sim.boosting, alive, this.predictor.controller?.sim.driftAmount ?? 0);

    if (me && info) {
      const c = this.predictor.controller;
      ui.updateVitals(me.hp, me.maxHp, info.level, info.xp, info.xpToNext, c ? c.sim.boostEnergy : me.boostEnergy, alive);
      const abilities = this.abilityList;
      abilities.length = 0;
      if (this.myStats.abilities.includes('dash')) {
        const a = this.abilitySlots[0];
        a.cooldown = c ? c.sim.dashCooldown : me.dashCooldown;
        a.max = physicsConfig.dashCooldown;
        abilities.push(a);
      }
      if (this.myStats.abilities.includes('emp')) {
        const a = this.abilitySlots[1];
        a.cooldown = me.empCooldown;
        a.max = physicsConfig.empCooldown;
        abilities.push(a);
      }
      ui.updateAbilities(abilities);
      const f = alive ? me.flags : 0;
      const tags: string[] = [];
      if (f & RobotFlags.STUNNED) tags.push('STUNNED');
      if (f & RobotFlags.BURNING) tags.push('BURNING');
      if (f & RobotFlags.POISONED) tags.push('POISONED');
      if (f & RobotFlags.SLOWED) tags.push('SLOWED');
      if (f & RobotFlags.SHIELDED) tags.push('SHIELDED');
      ui.setStatusTag(tags.join(' · '));
    }

    let timeLeft = 0;
    if (this.lastSnap) {
      const elapsed = (this.net.serverNow() - this.lastSnap.t) / 1000;
      timeLeft = this.lastSnap.left - elapsed;
      ui.setTimer(this.phase === MatchPhase.COUNTDOWN ? MATCH_DURATION_S : timeLeft, this.phase === MatchPhase.RESULTS);
    }
    // Jumbotron: kill leader + match clock (redraws only when the text changes).
    this.leaderKills = -1;
    for (const p of this.players.values()) {
      if (p.kills > this.leaderKills) {
        this.leaderKills = p.kills;
        this.leaderName = p.name;
      }
    }
    this.arena.scoreboard.set(this.leaderName, Math.max(0, this.leaderKills), timeLeft);

    // Pointer lock lost (Esc) mid-match: open the settings / pause menu.
    const locked = this.input.isLocked;
    if (this.wasLocked && !locked && this.started && this.connected && !this.menu.isOpen && this.phase === MatchPhase.PLAYING) this.menu.show();
    if (locked && this.menu.isOpen) this.menu.hide();
    this.wasLocked = locked;

    if (this.started && this.connected && this.phase === MatchPhase.COUNTDOWN) {
      const n = Math.min(3, Math.max(1, Math.ceil(timeLeft)));
      if (n !== this.countdownShown) {
        this.countdownShown = n;
        this.audio.countdown(false);
      }
      ui.setCenterMessage(String(n), locked ? 'get ready' : 'click to lock the mouse', true);
    } else if (this.started && performance.now() < this.goUntil) {
      ui.setCenterMessage('GO!', '', true);
    } else if (me && !alive && this.phase === MatchPhase.PLAYING) {
      const left = Math.max(0, (this.respawnAt - performance.now()) / 1000);
      const by = this.killerName ? `by ${this.killerName}${this.killerWeapon ? `'s ${this.killerWeapon}` : ''} — ` : '';
      ui.setCenterMessage('DESTROYED', `${by}respawning in ${left.toFixed(1)}s`);
    } else if (this.started && this.connected && !locked && !this.menu.isOpen && this.phase === MatchPhase.PLAYING) {
      ui.setCenterMessage('CLICK TO RESUME', 'mouse aims • 1/2/3 picks cards');
    } else {
      ui.setCenterMessage('');
    }

    ui.setScoreboardVisible(this.input.isDown('Tab'));

    // The crosshair is the screen centre: the ray the aim solver resolves every tick.
    ui.setCrosshair(w / 2, h / 2, alive && !this.cameraCtl.deathCamActive);
    ui.setCrosshairState(!alive || !this.aimValid ? 'none' : this.aim.clamped ? 'clamped' : this.aim.kind === 'robot' ? 'enemy' : 'none');

    this.netInfoTimer -= dt;
    if (this.netInfoTimer <= 0) {
      this.netInfoTimer = 0.25;
      const ps = this.predictor?.stats;
      ui.setNetInfo(
        `${this.settings.preset.toUpperCase()}  RTT ${this.net.rtt.toFixed(0)}ms` +
          (ps ? `\npred err ${ps.lastErrorM.toFixed(3)}m  replay ${ps.replayed}` : '') +
          `\ndraws ${this.renderer.draws.total}  tris ${(this.renderer.draws.triangles / 1000).toFixed(0)}k`,
      );
    }
    ui.update(dt, this.renderer.camera, w, h);
  }
}
