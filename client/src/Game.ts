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
import { UI, type AbilityDisplay } from './ui/UI';
import { Lobby } from './ui/Lobby';
import { WeaponPickupRenderer } from './render/WeaponPickupRenderer';

interface QueuedEvent {
  t: number;
  e: GameEvent;
}

const IMMEDIATE_EVENTS = new Set<GameEvent['k']>(['tune', 'matchStart', 'levelup', 'powerup', 'heal', 'weapon']);
const HITSTOP_S = 0.08;
const HITSTOP_SCALE = 0.15;

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _vel = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();
const BACK = new THREE.Vector3(0, 0, -1);
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
    this.phase = m.phase;

    for (const id of this.fleet.visuals.keys()) {
      if (!snap.robots.has(id)) {
        this.fleet.remove(id);
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
        this.myWeaponId = p.weaponId ?? null;
        this.predictor?.setModifiers(this.modifiersFromStats());
      }
    }
    this.ui.updateScores(m.players, this.myId);
  }

  private onEvents(m: EventsMsg): void {
    if (!this.vfx) return;
    for (const e of m.e) {
      if (IMMEDIATE_EVENTS.has(e.k) || this.involvesMe(e)) this.handleEvent(e);
      else this.events.push({ t: m.t, e });
    }
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
    this.ui.spawnNumber(p, String(r.dmg), r.dmg >= 30 ? 'crit' : 'dealt');
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

  private muzzleFlashFor(v: RobotVisual, barrel: number): void {
    this.fleet.muzzleWorld(v, barrel, _v);
    v.onFire();
    _dir.set(Math.sin(v.aimYaw) * Math.cos(v.barrelPitch), Math.sin(v.barrelPitch), Math.cos(v.aimYaw) * Math.cos(v.barrelPitch));
    this.vfx.muzzleFlash(_v, _dir, _c.setHex(this.colorOf(v.id)));
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
          this.myWeaponId = e.weaponId;
          this.localFireCooldown = 0;
          if (e.weaponId) this.audio.pick();
        }
        return;
      }
      case 'shot': {
        if (e.owner === this.myId) return;
        this.projectiles.spawn(e.owner, e.p, e.v, e.bounces, getWeapon(e.weaponId).color, e.pid, -1, e.b, false, e.lifetime);
        // The server already flew this shell `ff` seconds (hitscan assist).
        if (e.ff > 0) this.projectiles.fastForward(e.pid, e.ff);
        const v = this.fleet.get(e.owner);
        if (v && e.b % getWeapon(e.weaponId).pellets === 0) this.muzzleFlashFor(v, e.b);
        if (e.b === 0) this.audio.cannon(_v.set(e.p.x, e.p.y, e.p.z), cam, false, e.weaponId);
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
        this.fleet.get(e.target)?.onDamaged();
        if (e.target === this.myId) {
          const src = e.source >= 0 ? this.robotPosition(e.source) : null;
          this.indicateHitFrom(src ?? p, e.amount);
          this.onLocalDamaged(e.amount);
        } else if (e.source === this.myId) this.ui.spawnNumber(p, String(e.amount), 'dealt');
        return;
      }
      case 'heal': {
        if (e.target === this.myId) this.ui.spawnNumber(this.localPosition(), `+${e.amount}`, 'heal');
        // Leech Core: health drained from `from` into `target`.
        if (e.from !== undefined) {
          const a = this.robotPosition(e.from);
          const b = this.robotPosition(e.target);
          if (a && b) this.vfx.leechTether(a, b);
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
        this.vfx.explosion(p, 1.15, _c.setHex(this.colorOf(e.id)));
        this.audio.explosion(p, cam, 1);
        this.traumaFrom(p, 26, 0.7);
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
        this.ui.addKill(killer, victim, assists, mine);
        if (e.killer === this.myId && victim) {
          this.ui.spawnNumber(this.localPosition(), `+100 XP  ${victim.name} destroyed`, 'crit');
          this.ui.showHitmarker(true);
          this.ui.showKillBanner(victim.name, victim.color, '+100 XP');
          this.audio.killConfirm();
          this.cameraCtl.punchIn(1);
          // Hitstop: visuals (not the simulation) slow down for a beat.
          this.hitstop = HITSTOP_S;
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

  private fireLocal(frame: InputFrame): void {
    const c = this.predictor.controller;
    if (!c || !this.myWeaponId) return;
    const cfg = weaponStats(this.myWeaponId);
    const st = this.myStats;
    this.localFireCooldown = cfg.interval / st.fireRateMul;
    // Same shot spec (origin, direction, seeded spread) the server computes for this input seq.
    const shots = computeWeaponShots(c.body.translation(), c.body.rotation(), frame.aimYaw, frame.aimPitch, st.projectileCount, this.myId, frame.seq, this.myWeaponId);
    const color = getWeapon(this.myWeaponId).color;
    const v = this.fleet.get(this.myId);
    for (const s of shots) {
      const vel = { x: s.dir.x * cfg.speed, y: s.dir.y * cfg.speed, z: s.dir.z * cfg.speed };
      this.projectiles.spawn(this.myId, s.origin, vel, st.ricochetBounces, color, 0, frame.seq, s.barrel, true, cfg.lifetime);
      if (v && s.barrel % getWeapon(this.myWeaponId).pellets === 0) this.muzzleFlashFor(v, s.barrel);
    }
    this.audio.cannon(null, null, true, this.myWeaponId);
    this.cameraCtl.addTrauma(0.1);
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
    const strength = slide ? Math.min(1, (lateral - 2.5) / 5 + 0.3) : 0;
    this.fleet.chassisDirection(v, RIGHT, _n);
    for (let i = 0; i < 4; i++) {
      this.fleet.wheelContact(v, i, _v);
      vfx.skids.feed(v.id * 4 + i, _v.x, _v.y, _v.z, _n.x, _n.z, 0.3, strength, t);
      if (strength > 0 && i >= 2) vfx.tireSmoke(_v, v.velocity, strength * dt * 30);
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
    if ((v.stacks.field_repair ?? 0) > 0 && v.hp < v.maxHp && v.sinceDamaged > 4 && Math.random() < dt * 12) vfx.repairSwirl(v.position);
  }

  private renderFrame(dt: number, alpha: number, frameMs: number): void {
    this.processEvents();
    const renderT = this.renderTime();
    const latest = this.buffer.latest();
    const me = latest?.robots.get(this.myId);
    // Hitstop slows only what is drawn (fleet, particles, decals); simulation and netcode run at full speed.
    this.hitstop = Math.max(0, this.hitstop - dt);
    const vdt = this.hitstop > 0 ? dt * HITSTOP_SCALE : dt;

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
      let flags = me.flags & ~RobotFlags.BOOSTING;
      if (boosting) flags |= RobotFlags.BOOSTING;
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
    { id: 'dash', icon: '➤', cooldown: 0, max: 1, key: 'SPACE' },
    { id: 'emp', icon: 'ϟ', cooldown: 0, max: 1, key: 'SPACE' },
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
    ui.setWeapon(equipped?.name ?? 'UNARMED', equipped?.role ?? 'Walk over a weapon to equip');
    let prompt = '';
    let nearest = 2.6;
    const local = this.predictor.controller?.body.translation();
    if (alive && local && this.started && !this.menu.isOpen) {
      for (const pad of this.lastSnap?.pickups ?? []) {
        const distance = Math.hypot(local.x - pad.position.x, local.y - pad.position.y, local.z - pad.position.z);
        if (distance >= nearest) continue;
        nearest = distance;
        const weapon = getWeapon(pad.weaponId);
        prompt = !pad.available ? `${weapon.name} · restocking ${Math.ceil(pad.respawnIn)}s`
          : !this.myWeaponId ? `Walk over to collect ${weapon.name}`
          : pad.weaponId === this.myWeaponId ? `${weapon.name} already equipped`
          : `E · Equip ${weapon.name} / ${weapon.role}`;
      }
    }
    ui.setPickupPrompt(prompt);
    ui.setDriving(this.driveForwardSpeed, this.lastThrottle, this.input.viewYaw - this.driveYaw, this.driveGrounded, !!this.predictor.controller?.sim.boosting, alive);

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
      ui.setStunned(alive && (me.flags & RobotFlags.STUNNED) !== 0);
    }

    let timeLeft = 0;
    if (this.lastSnap) {
      const elapsed = (this.net.serverNow() - this.lastSnap.t) / 1000;
      timeLeft = this.lastSnap.left - elapsed;
      ui.setTimer(timeLeft, this.phase === MatchPhase.RESULTS);
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

    if (me && !alive && this.phase === MatchPhase.PLAYING) {
      const left = Math.max(0, (this.respawnAt - performance.now()) / 1000);
      ui.setCenterMessage('DESTROYED', `${this.killerName ? `by ${this.killerName} — ` : ''}respawning in ${left.toFixed(1)}s`);
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
