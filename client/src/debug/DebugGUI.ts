import GUI from 'lil-gui';
import Stats from 'stats.js';
import { DEFAULT_PHYSICS_CONFIG, physicsConfig, PHYSICS_CONFIG_RANGES, type PhysicsConfigKey } from '@robot-arena/shared';
import type { CameraController } from '../render/CameraController';
import type { Renderer } from '../render/Renderer';
import { QUALITY_ORDER, type QualityName } from '../render/Quality';
import type { LocalPredictor } from '../physics/LocalPredictor';

const PHYSICS_GROUPS: Record<string, PhysicsConfigKey[]> = {
  World: ['gravity'],
  Chassis: ['chassisMass', 'centerOfMassY', 'linearDamping', 'angularDamping', 'chassisFriction', 'chassisRestitution'],
  Drivetrain: ['engineForce', 'reverseFactor', 'maxSpeed', 'brakeForce', 'rollingBrake', 'maxSteerAngle', 'steerSpeedFalloff', 'downforce'],
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
  Weapons: ['projectileSpeed', 'projectileLifetime', 'projectileImpulse', 'projectileDamage', 'fireInterval', 'twinSpread'],
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
  net: { interpolationDelayMs: number; showServerGhost: boolean };
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

    const g = this.gui.addFolder('Graphics');
    const quality = { preset: hooks.currentQuality() };
    g.add(quality, 'preset', QUALITY_ORDER as unknown as string[])
      .name('Quality preset')
      .onChange((v: string) => hooks.onQualityChange(v as QualityName))
      .listen();
    const t = hooks.renderer.tuning;
    const apply = (): void => hooks.renderer.applyTuning();
    g.add(t, 'exposure', 0.2, 3, 0.01).onChange(apply);
    g.add(t, 'bloomIntensity', 0, 5, 0.01).onChange(apply);
    g.add(t, 'bloomThreshold', 0, 3, 0.01).onChange(apply);
    g.add(t, 'bloomSmoothing', 0, 1, 0.01).onChange(apply);
    g.add(t, 'bloomRadius', 0, 1, 0.01).onChange(apply);
    g.add(t, 'aoIntensity', 0, 10, 0.05).onChange(apply);
    g.add(t, 'aoRadius', 0.1, 8, 0.05).onChange(apply);
    g.add(t, 'vignetteDarkness', 0, 1, 0.01).onChange(apply);
    g.add(t, 'envIntensity', 0, 3, 0.01).onChange(apply);
    g.add(t, 'sunIntensity', 0, 10, 0.05).onChange(apply);
    g.add(t, 'hemiIntensity', 0, 3, 0.01).onChange(apply);
    g.add(t, 'shadowRadius', 0, 10, 0.1).onChange(apply);
    g.add(t, 'fogDensity', 0, 0.03, 0.0005).onChange(apply);
    // Keep the dropdown in sync when the auto-detector changes the preset.
    window.setInterval(() => {
      quality.preset = hooks.currentQuality();
    }, 500);

    const c = this.gui.addFolder('Camera');
    const ct = hooks.camera.tuning;
    c.add(ct, 'distance', 3, 20, 0.1);
    c.add(ct, 'height', 0.5, 10, 0.1);
    c.add(ct, 'stiffness', 5, 300, 1);
    c.add(ct, 'damping', 0.2, 2, 0.01);
    c.add(ct, 'lookAhead', 0, 1, 0.01);
    c.add(ct, 'lookHeight', 0, 4, 0.05);
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
