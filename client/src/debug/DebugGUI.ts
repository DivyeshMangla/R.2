import GUI from 'lil-gui';
import Stats from 'stats.js';
import { DEFAULT_PHYSICS_CONFIG, physicsConfig, PHYSICS_CONFIG_RANGES, type PhysicsConfigKey } from '@robot-arena/shared';
import type { CameraController } from '../render/CameraController';
import type { Renderer } from '../render/Renderer';
import { QUALITY_ORDER, type QualityName } from '../render/Quality';
import type { LocalPredictor } from '../physics/LocalPredictor';
import type { RobotFleet } from '../render/robot/RobotFleet';
import type { VFXSystem } from '../render/vfx/VFXSystem';
import type { NetSimSettings } from '../net/NetClient';

const PHYSICS_GROUPS: Record<string, PhysicsConfigKey[]> = {
  World: ['gravity'],
  Chassis: ['chassisMass', 'centerOfMassY', 'linearDamping', 'angularDamping', 'chassisFriction', 'chassisRestitution'],
  Drivetrain: ['engineForce', 'reverseFactor', 'maxSpeed', 'brakeForce', 'rollingBrake', 'maxSteerAngle', 'steerSpeedFalloff', 'steerResponse', 'downforce'],
  'Suspension & Tyres': [
    'suspensionRestLength',
    'suspensionStiffness',
    'suspensionCompression',
    'suspensionRelaxation',
    'maxSuspensionTravel',
    'maxSuspensionForce',
    'wheelRadius',
    'frictionSlip',
    'sideFrictionStiffness',
  ],
  'Boost & Dash': ['boostForceMul', 'boostMaxSpeedMul', 'boostDrainPerSec', 'boostRegenPerSec', 'dashImpulse', 'dashCooldown'],
  'Anti-flip': ['antiFlipDelay', 'antiFlipTorque', 'antiFlipLift'],
  Weapons: [
    'projectileSpeed',
    'projectileLifetime',
    'projectileImpulse',
    'projectileDamage',
    'fireInterval',
    'twinSpread',
    'projectileRadius',
    'projectileGravity',
  ],
  'Aim & hit registration': [
    'aimPitchMinDeg',
    'aimPitchMaxDeg',
    'aimMaxRange',
    'aimSpreadDeg',
    'floorAimRadius',
    'aimDepthRadius',
    'lagCompEnabled',
    'lagCompMaxMs',
    'hitscanAssistMs',
    'selfHitGraceS',
    'aimAssistEnabled',
    'aimAssistRadiusH',
    'aimAssistRadiusV',
    'aimAssistMaxRange',
  ],
  Ramming: ['ramMinSpeed', 'ramDamagePerMps', 'ramSelfDamageFraction', 'ramCooldown', 'ramImpulse'],
  Abilities: [
    'empRadius',
    'empStunDuration',
    'empCooldown',
    'mineDamage',
    'mineBlastRadius',
    'mineTriggerRadius',
    'mineSeekRadius',
    'mineSpeed',
    'mineLifetime',
    'mineArmDelay',
    'mineImpulse',
  ],
  Debris: ['debrisImpulse', 'debrisLifetime'],
};

export interface DebugHooks {
  renderer: Renderer;
  camera: CameraController;
  predictor: LocalPredictor;
  vfx: VFXSystem;
  fleet: RobotFleet;
  net: { interpolationDelayMs: number; showServerGhost: boolean };
  netSim: NetSimSettings;
  onPhysicsChange(key: PhysicsConfigKey, value: number): void;
  onQualityChange(name: QualityName): void;
  currentQuality(): QualityName;
}

/** lil-gui panel for live tuning of physics, camera, graphics and netcode + stats.js FPS meter. */
export class DebugGUI {
  readonly gui: GUI;
  readonly stats: Stats;

  constructor(hooks: DebugHooks) {
    this.stats = new Stats();
    this.stats.showPanel(0);
    this.stats.dom.style.cssText = 'position:fixed;right:12px;bottom:52px;z-index:30;opacity:0.85;';
    document.body.appendChild(this.stats.dom);

    this.gui = new GUI({ title: 'Robot Arena — Tuning (` to toggle)', width: 320 });
    this.gui.close();

    const r = hooks.renderer;
    const t = r.tuning;
    const apply = (): void => r.applyTuning();

    const g = this.gui.addFolder('Graphics');
    const quality = { preset: hooks.currentQuality() };
    g.add(quality, 'preset', QUALITY_ORDER as unknown as string[])
      .name('Quality preset')
      .onChange((v: string) => hooks.onQualityChange(v as QualityName))
      .listen();
    // Keep the dropdown in sync when the auto-detector or settings menu changes the preset.
    window.setInterval(() => {
      quality.preset = hooks.currentQuality();
    }, 500);

    const light = g.addFolder('Lighting');
    light.add(t, 'exposure', 0.2, 3, 0.01).onChange(apply);
    light.add(t, 'sunIntensity', 0, 10, 0.05).name('key light').onChange(apply);
    light.add(t, 'rimIntensity', 0, 6, 0.05).name('rim light').onChange(apply);
    light.add(t, 'hemiIntensity', 0, 3, 0.01).name('hemisphere').onChange(apply);
    light.add(t, 'envIntensity', 0, 3, 0.01).name('environment').onChange(apply);
    light.add(t, 'shadowRadius', 0, 10, 0.1).onChange(apply);
    light.add(t, 'aoIntensity', 0, 10, 0.05).name('AO intensity').onChange(apply);
    light.add(t, 'aoRadius', 0.1, 8, 0.05).name('AO radius').onChange(apply);
    light.close();

    const bloom = g.addFolder('Bloom');
    bloom.add(t, 'bloomIntensity', 0, 5, 0.01).name('intensity').onChange(apply);
    bloom.add(t, 'bloomThreshold', 0, 3, 0.01).name('threshold').onChange(apply);
    bloom.add(t, 'bloomSmoothing', 0, 1, 0.01).name('smoothing').onChange(apply);
    bloom.add(t, 'bloomRadius', 0, 1, 0.01).name('radius').onChange(apply);
    bloom.close();

    const fog = g.addFolder('Fog');
    fog.add(t, 'fogDensity', 0, 0.06, 0.0005).name('density').onChange(apply);
    fog.add(t, 'fogFalloff', 0, 0.6, 0.005).name('height falloff').onChange(apply);
    fog.addColor(r.fog, 'color').name('colour');
    fog.close();

    const grade = g.addFolder('Grading');
    const regrade = (): void => r.applyGrading();
    grade.add(t, 'gradeShadowTint', 0, 3, 0.05).name('teal shadows').onFinishChange(regrade);
    grade.add(t, 'gradeHighlightTint', 0, 3, 0.05).name('warm highlights').onFinishChange(regrade);
    grade.add(t, 'gradeSaturation', 0, 2, 0.01).name('saturation').onFinishChange(regrade);
    grade.add(t, 'gradeContrast', 0, 1, 0.01).name('contrast').onFinishChange(regrade);
    grade.add(t, 'vignetteDarkness', 0, 1, 0.01).name('vignette').onChange(apply);
    grade.add(t, 'grainOpacity', 0, 0.5, 0.01).name('film grain').onChange(apply);
    grade.close();

    const part = g.addFolder('Particles & VFX');
    part.add(hooks.vfx, 'density', 0, 2, 0.05).name('particle density');
    part.add(t, 'particleSoftness', 0, 2, 0.05).name('soft particle fade (m)').onChange(apply);
    part.add(t, 'distortionStrength', 0, 3, 0.05).name('distortion').onChange(apply);
    part.add(hooks.fleet, 'leanStrength', 0, 2, 0.05).name('robot lean');
    part.close();

    const c = this.gui.addFolder('Camera');
    const ct = hooks.camera.tuning;
    c.add(ct, 'distance', 3, 20, 0.1);
    c.add(ct, 'height', -1, 5, 0.05);
    c.add(ct, 'lookHeight', 0, 4, 0.05);
    c.add(ct, 'stiffness', 5, 300, 1);
    c.add(ct, 'damping', 0.2, 2, 0.01);
    c.add(ct, 'fov', 40, 110, 1);
    c.add(ct, 'boostFov', 40, 120, 1);
    c.add(ct, 'fovLerp', 0.5, 20, 0.1);
    c.add(ct, 'shakeMaxOffset', 0, 2, 0.01);
    c.add(ct, 'shakeMaxAngle', 0, 0.3, 0.005);
    c.add(ct, 'shakeDecay', 0.1, 6, 0.05);
    c.add(ct, 'shakeFrequency', 1, 60, 0.5);
    c.close();

    const n = this.gui.addFolder('Network');
    n.add(hooks.net, 'interpolationDelayMs', 0, 300, 5).name('Interp delay (ms)');
    n.add(hooks.predictor, 'smoothTime', 0.01, 0.5, 0.01).name('Correction smoothing (s)');
    n.add(hooks.net, 'showServerGhost').name('Show server ghost');
    const sim = n.addFolder('Latency simulator (this client)');
    sim.add(hooks.netSim, 'latencyMs', 0, 300, 5).name('Extra one-way (ms)');
    sim.add(hooks.netSim, 'jitterMs', 0, 100, 1).name('Jitter (ms)');
    sim.add(hooks.netSim, 'inputLoss', 0, 0.5, 0.01).name('Input packet loss');
    sim.close();
    n.close();

    const p = this.gui.addFolder('Physics (synced to server)');
    for (const [groupName, keys] of Object.entries(PHYSICS_GROUPS)) {
      const f = p.addFolder(groupName);
      for (const key of keys) {
        const [min, max, step] = PHYSICS_CONFIG_RANGES[key];
        f.add(physicsConfig, key, min, max, step).onFinishChange((v: number) => hooks.onPhysicsChange(key, v)).listen();
      }
      f.close();
    }
    p.add(
      {
        reset: () => {
          for (const key of Object.keys(DEFAULT_PHYSICS_CONFIG) as PhysicsConfigKey[]) {
            physicsConfig[key] = DEFAULT_PHYSICS_CONFIG[key];
            hooks.onPhysicsChange(key, DEFAULT_PHYSICS_CONFIG[key]);
          }
        },
      },
      'reset',
    ).name('Reset physics to defaults');
    p.close();
  }

  toggle(): void {
    if (this.gui._closed) this.gui.open();
    else this.gui.close();
  }
}
