/// <reference lib="dom" />
/** Headless camera/input checks. No browser or display is controlled. */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { aimDirection, angleDiff, Buttons, cameraOrigin, DEFAULT_CAMERA_RIG, RobotFlags } from '@robot-arena/shared';
import { InputManager } from '../../../client/src/input/InputManager';
import { CameraController } from '../../../client/src/render/CameraController';
import { DRIVING_CAMERA_AUTO_RATE, DrivingCamera, type DrivingViewIntent } from '../../../client/src/render/DrivingCamera';
import { RobotVisual } from '../../../client/src/render/robot/RobotVisual';

const results: { scenario: string; metrics: Record<string, number | boolean> }[] = [];
const intent = (extra: Partial<DrivingViewIntent> = {}): DrivingViewIntent => ({
  active: true, mouseIdleSeconds: 3, mouseSerial: 1, firing: false, steady: false, recenter: false, ...extra,
});

function scenario(name: string, run: () => Record<string, number | boolean>): void {
  const metrics = run();
  results.push({ scenario: name, metrics });
}

scenario('aim ownership and inactive driving', () => {
  const cases = [
    { speed: 8, state: { firing: true } }, { speed: 8, state: { steady: true } },
    { speed: 8, state: { active: false, recenter: true } }, { speed: 0, state: {} },
    { speed: -6, state: {} }, { speed: 8, state: { mouseIdleSeconds: 0.64 } },
  ];
  for (const c of cases) {
    const drive = new DrivingCamera();
    let yaw = 0.7;
    for (let i = 0; i < 120; i++) yaw = drive.update(yaw, 0, c.speed, 1 / 60, intent(c.state));
    assert(Math.abs(angleDiff(0.7, yaw)) < 1e-10, 'Camera moved while the driver owned aim or chase was inactive');
  }
  return { heldCases: cases.length };
});

scenario('shortest path across yaw wrap', () => {
  const drive = new DrivingCamera();
  const target = -Math.PI + 0.08;
  let yaw = Math.PI - 0.08;
  let total = 0;
  let maxStep = 0;
  for (let i = 0; i < 120; i++) {
    const next = drive.update(yaw, target, 10, 1 / 60, intent());
    const step = angleDiff(yaw, next);
    assert(step >= -1e-10, 'Follow took the long path across ±PI');
    maxStep = Math.max(maxStep, Math.abs(step));
    total += step;
    yaw = next;
  }
  assert(maxStep <= DRIVING_CAMERA_AUTO_RATE / 60 + 1e-10);
  assert(total < 0.17 && Math.abs(angleDiff(yaw, target)) < 0.002);
  return { totalRadians: total, maxStepRadians: maxStep };
});

scenario('intentional lookback and manual recenter', () => {
  const drive = new DrivingCamera();
  let yaw = Math.PI;
  for (let i = 0; i < 120; i++) yaw = drive.update(yaw, 0, 8, 1 / 60, intent());
  assert(Math.abs(angleDiff(Math.PI, yaw)) < 1e-10, 'Chase stole a deliberate lookback');
  let maxStep = 0;
  for (let i = 0; i < 240; i++) {
    const next = drive.update(yaw, 0, 0, 1 / 60, intent({ recenter: i === 0 }));
    maxStep = Math.max(maxStep, Math.abs(angleDiff(yaw, next)));
    yaw = next;
  }
  assert(maxStep < 0.047, 'C recenter snapped rather than smoothly turning');
  assert(Math.abs(yaw) < 0.006, 'C failed to recenter a 180 degree lookback at rest');
  return { remainingRadians: yaw, maxStepRadians: maxStep };
});

scenario('new mouse movement cancels C', () => {
  const drive = new DrivingCamera();
  let yaw = 2;
  yaw = drive.update(yaw, 0, 8, 1 / 60, intent({ recenter: true }));
  for (let i = 0; i < 10; i++) yaw = drive.update(yaw, 0, 8, 1 / 60, intent());
  const held = yaw;
  for (let i = 0; i < 60; i++) yaw = drive.update(yaw, 0, 8, 1 / 60, intent({ mouseSerial: i + 2, mouseIdleSeconds: 0 }));
  assert(Math.abs(angleDiff(held, yaw)) < 1e-10, 'C kept rotating after fresh pointer input');
  return { heldRadians: yaw };
});

scenario('chase timing across render rates', () => {
  const yawAtRate = (fps: number): number => {
    const drive = new DrivingCamera();
    let yaw = 0.95;
    for (let i = 0; i < fps * 3; i++) {
      yaw = drive.update(yaw, -0.15, 9, 1 / fps, intent({ mouseIdleSeconds: i / fps }));
    }
    return yaw;
  };
  const y30 = yawAtRate(30), y60 = yawAtRate(60), y144 = yawAtRate(144);
  const spread = Math.max(y30, y60, y144) - Math.min(y30, y60, y144);
  assert(spread < 0.005, 'Chase feel changed materially with render framerate');
  assert(Math.abs(angleDiff(y60, -0.15)) < 0.025, 'Chase did not converge behind the robot');
  return { yaw30: y30, yaw60: y60, yaw144: y144, spread };
});

scenario('continuous normal/drift follow and explicit aim ownership', () => {
  const sliding = new DrivingCamera();
  let driftYaw = 0;
  let worstHeadingError = 0;
  let wrongWayTicks = 0;
  // Fixed target checks miss the camera falling >180 degrees behind a held
  // drift. Exercise repeated real heading wraps for ten seconds in both turns.
  for (const driftAmount of [0, 1]) for (const direction of [-1, 1]) {
    const chase = new DrivingCamera();
    let view = 0;
    for (let i = 1; i <= 600; i++) {
      const heading = Math.atan2(Math.sin(direction * 1.8 * i / 60), Math.cos(direction * 1.8 * i / 60));
      const next = chase.update(view, heading, 16, 1 / 60, intent({ driftAmount }));
      const step = angleDiff(view, next);
      if (step * direction < -1e-10) wrongWayTicks++;
      worstHeadingError = Math.max(worstHeadingError, Math.abs(angleDiff(next, heading)));
      view = next;
    }
  }
  assert(wrongWayTicks === 0 && worstHeadingError < 0.6,
    'Continuous drift outran the chase camera or reversed its follow direction');
  for (let i = 0; i < 30; i++) driftYaw = sliding.update(driftYaw, 1, 15, 1 / 60, intent({ driftAmount: 1 }));
  for (const extra of [{ steady: true }, { firing: true }, { mouseIdleSeconds: 0, mouseSerial: 2 }]) {
    const held = driftYaw;
    for (let i = 0; i < 600; i++) {
      const heading = Math.atan2(Math.sin(-1.8 * i / 60), Math.cos(-1.8 * i / 60));
      driftYaw = sliding.update(driftYaw, heading, 15, 1 / 60, intent({ driftAmount: 1, ...extra }));
      assert(Math.abs(angleDiff(held, driftYaw)) < 1e-10, 'Drifting stole mouse or combat camera ownership');
    }
  }
  const manual = new DrivingCamera();
  const manualDrift = new DrivingCamera();
  let plain = 1;
  let drift = 1;
  for (let i = 0; i < 30; i++) {
    plain = manual.update(plain, 0, 15, 1 / 60, intent({ recenter: i === 0 }));
    drift = manualDrift.update(drift, 0, 15, 1 / 60, intent({ driftAmount: 1, recenter: i === 0 }));
  }
  assert(Math.abs(angleDiff(plain, drift)) < 1e-10, 'Explicit recenter lost authority during a drift');
  return { worstHeadingErrorDegrees: worstHeadingError * 180 / Math.PI, wrongWayTicks, manualDriftError: Math.abs(angleDiff(plain, drift)) };
});

scenario('first turn after mouse movement keeps a readable chase angle', () => {
  let worstHeadingError = 0;
  let wrongWayTicks = 0;
  for (const driftAmount of [0, 1]) for (const direction of [-1, 1]) {
    const chase = new DrivingCamera();
    let view = 0;
    for (let i = 1; i <= 600; i++) {
      const seconds = i / 60;
      const heading = Math.atan2(Math.sin(direction * 1.8 * seconds), Math.cos(direction * 1.8 * seconds));
      const next = chase.update(view, heading, 16, 1 / 60,
        intent({ mouseIdleSeconds: seconds, driftAmount }));
      if (angleDiff(view, next) * direction < -1e-10) wrongWayTicks++;
      worstHeadingError = Math.max(worstHeadingError, Math.abs(angleDiff(next, heading)));
      view = next;
    }
  }
  assert(wrongWayTicks === 0 && worstHeadingError < 100 * Math.PI / 180,
    'First-turn aim grace left the camera too far behind or reversed its follow');
  return { worstHeadingErrorDegrees: worstHeadingError * 180 / Math.PI, wrongWayTicks };
});

scenario('bounded framing, steady aim and unshaken aim ray', () => {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
  const ctl = new CameraController(camera);
  const target = new THREE.Vector3();
  const motion = { velocity: { x: 0, y: 0, z: 15 }, referenceSpeed: 12, steady: false, active: true };
  for (let i = 0; i < 240; i++) ctl.update(target, 0, -0.12, true, 1 / 60, motion);
  const boostFov = camera.fov;
  assert(boostFov > 79.5 && boostFov <= 80, 'Boost FOV did not settle within its bound');
  motion.steady = true;
  ctl.addTrauma(1);
  ctl.punchIn(1);
  ctl.update(target, 0.4, -0.2, true, 1 / 60, motion);
  const expected = aimDirection(0.4, -0.2, { x: 0, y: 0, z: 0 });
  const aimError = Math.hypot(ctl.aimDir.x - expected.x, ctl.aimDir.y - expected.y, ctl.aimDir.z - expected.z);
  const shakeOffset = camera.position.distanceTo(new THREE.Vector3(ctl.aimOrigin.x, ctl.aimOrigin.y, ctl.aimOrigin.z));
  assert(aimError < 1e-10 && shakeOffset <= Math.sqrt(3) * 0.12 * 0.25, 'Steady aim trauma contaminated aim or exceeded its reduced position envelope');
  for (let i = 0; i < 240; i++) ctl.update(target, 0, -0.12, true, 1 / 60, motion);
  const steadyFov = camera.fov;
  assert(Math.abs(steadyFov - 70) < 0.01, 'RMB did not restore stable base framing');
  const steadyOrigin = { ...ctl.aimOrigin };
  motion.velocity = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 240; i++) ctl.update(target, 0, -0.12, false, 1 / 60, motion);
  const frameShift = Math.hypot(steadyOrigin.x - ctl.aimOrigin.x, steadyOrigin.y - ctl.aimOrigin.y, steadyOrigin.z - ctl.aimOrigin.z);
  assert(frameShift < 0.01, 'RMB camera framing still depended on vehicle speed or boost');
  return { boostFov, steadyFov, aimError, shakeOffset, steadyFrameShift: frameShift };
});

scenario('direct orbit framing while driving and moving the mouse', () => {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
  const ctl = new CameraController(camera);
  const target = new THREE.Vector3();
  const motion = { velocity: { x: 0, y: 0, z: 12 }, referenceSpeed: 12, steady: false, active: true };
  // Let speed framing settle, then measure ONLY extra lag from translation.
  for (let i = 0; i < 300; i++) ctl.update(target, 0, -0.12, false, 1 / 60, motion);
  const relativeZ = ctl.aimOrigin.z - target.z;
  let maxExtraLag = 0;
  for (let i = 0; i < 120; i++) {
    target.z += 12 / 60;
    ctl.update(target, 0, -0.12, false, 1 / 60, motion);
    maxExtraLag = Math.max(maxExtraLag, Math.abs(ctl.aimOrigin.z - target.z - relativeZ));
  }
  assert(maxExtraLag < 0.01, 'Normal driving introduced a second positional lag behind the predicted vehicle');
  ctl.snap();
  motion.steady = true;
  ctl.update(target, 0, -0.12, false, 1 / 60, motion);
  ctl.update(target, Math.PI / 2, -0.12, false, 1 / 60, motion);
  const expected = cameraOrigin(target, Math.PI / 2, -0.12, DEFAULT_CAMERA_RIG, { x: 0, y: 0, z: 0 });
  const orbitError = Math.hypot(ctl.aimOrigin.x - expected.x, ctl.aimOrigin.y - expected.y, ctl.aimOrigin.z - expected.z);
  assert(orbitError < 1e-10, 'Mouse orbit direction and camera position did not update together');
  return { maxExtraLag, mouseOrbitError: orbitError };
});

scenario('body load transfer follows acceleration and steady corners', () => {
  const accelerating = new RobotVisual(1, 0, 0xffffff);
  accelerating.update(1 / 60, 1);
  for (let i = 1; i <= 60; i++) {
    accelerating.velocity.z = 5 * i / 60;
    accelerating.update(1 / 60, 1);
  }
  const noseUp = accelerating.leanPitch;
  assert(noseUp < -0.02, 'Acceleration should lift the nose');
  for (let i = 1; i <= 30; i++) {
    accelerating.velocity.z = 5 - 8 * i / 60;
    accelerating.update(1 / 60, 1);
  }
  const brakingDip = accelerating.leanPitch;
  assert(brakingDip > 0.025, 'Braking should dip the nose');
  const cornering = new RobotVisual(2, 1, 0xffffff);
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 180; i++) {
    const yaw = -0.5 * i / 60;
    cornering.quaternion.setFromAxisAngle(up, yaw);
    cornering.velocity.set(Math.sin(yaw) * 8, 0, Math.cos(yaw) * 8);
    cornering.update(1 / 60, 1);
  }
  const cornerRoll = cornering.leanRoll;
  assert(cornerRoll < -0.025, 'Steady right-hand corner should roll the body outward');
  assert(Math.abs(cornering.lateralSpeed) < 1e-8, 'The test must be a steady corner without local side-slip');
  cornering.resetMotion();
  assert(cornering.leanPitch === 0 && cornering.leanRoll === 0);
  cornering.velocity.set(40, 0, -30);
  cornering.update(1 / 60, 1);
  assert(cornering.leanPitch === 0 && cornering.leanRoll === 0, 'Respawn velocity generated a fake body impulse');
  // The presentation spring must stay bounded even at a low render rate.
  let maxLean = 0;
  for (let i = 0; i < 300; i++) {
    cornering.velocity.set(Math.sin(i * 0.2) * 12, 0, Math.cos(i * 0.2) * 12);
    cornering.update(1 / 15, 1);
    maxLean = Math.max(maxLean, Math.abs(cornering.leanPitch), Math.abs(cornering.leanRoll));
    assert(Number.isFinite(maxLean) && maxLean < 0.15, 'Body load spring became unstable at 15 FPS');
  }
  return { acceleratingNoseUp: noseUp, brakingDip, steadyCornerRoll: cornerRoll, maxLeanAt15FPS: maxLean };
});

scenario('drift feedback follows real grounded slip and resets', () => {
  const visual = new RobotVisual(7, 0, 0xffffff);
  visual.flags = RobotFlags.ALIVE | RobotFlags.DRIFTING;
  visual.velocity.set(4, 0, 12);
  for (let i = 0; i < 60; i++) visual.update(1 / 60, 1);
  const slideBlend = visual.driftAmount;
  assert(slideBlend > 0.8 && slideBlend < 1, 'Grounded drift never acquired visible tire feedback');
  visual.setTelemetry({ suspension: [0, 0, 0, 0], steering: [0, 0, 0, 0], rotation: [0, 0, 0, 0], contact: [false, false, false, false] });
  for (let i = 0; i < 90; i++) visual.update(1 / 60, 1);
  assert(visual.driftAmount < 0.002, 'Airborne drift retained tire smoke/marks');
  visual.resetMotion();
  assert(visual.driftAmount === 0, 'Respawn retained the previous drift envelope');
  visual.setTelemetry(null);
  visual.velocity.set(0, 0, 0);
  for (let i = 0; i < 60; i++) visual.update(1 / 60, 1);
  assert(visual.driftAmount === 0, 'Stationary handbrake created fake slide feedback');
  return { groundedSlideBlend: slideBlend, resetAndRestAreSilent: true };
});

scenario('pointer unlock clears movement, fire, RMB and C', () => {
  const windowMock = new EventTarget();
  const documentMock = Object.assign(new EventTarget(), { pointerLockElement: null as MockElement | null });
  class MockElement extends EventTarget {
    isContentEditable = false;
    closest(): null { return null; }
    requestPointerLock(): void {
      documentMock.pointerLockElement = this;
      documentMock.dispatchEvent(new Event('pointerlockchange'));
    }
  }
  class MockInput extends MockElement {}
  class MockSelect extends MockElement {}
  class MockTextArea extends MockElement {}
  const globals: Record<string, unknown> = { window: windowMock, document: documentMock, HTMLElement: MockElement,
    HTMLInputElement: MockInput, HTMLSelectElement: MockSelect, HTMLTextAreaElement: MockTextArea };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  try {
    const element = new MockElement();
    const input = new InputManager(element as unknown as ConstructorParameters<typeof InputManager>[0]);
    input.requestLock();
    for (const code of ['KeyW', 'KeyD', 'KeyC', 'Space']) windowMock.dispatchEvent(Object.assign(new Event('keydown'), { code, repeat: false }));
    element.dispatchEvent(Object.assign(new Event('mousedown'), { button: 0 }));
    windowMock.dispatchEvent(Object.assign(new Event('mouseup'), { button: 0 }));
    element.dispatchEvent(Object.assign(new Event('mousedown'), { button: 2 }));
    const armed = input.sample();
    assert(armed.throttle === 1 && armed.steer === 1 && (armed.buttons & Buttons.FIRE));
    assert((armed.buttons & Buttons.DRIFT) !== 0 && (armed.buttons & Buttons.ABILITY) === 0,
      'Space must drift without spending the character ability');
    windowMock.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyQ', repeat: false }));
    const both = input.sample();
    assert((both.buttons & Buttons.DRIFT) !== 0 && (both.buttons & Buttons.ABILITY) !== 0,
      'Q ability and Space drift must remain independent input bits');
    assert(input.isFiring && input.isSteadyCamera, 'Quick click lost camera ownership when sample consumed its fire latch');
    documentMock.pointerLockElement = null;
    documentMock.dispatchEvent(new Event('pointerlockchange'));
    const released = input.sample();
    assert(released.throttle === 0 && released.steer === 0 && released.buttons === 0);
    assert(!input.isFiring && !input.isSteadyCamera && !input.consumeRecenter());
    windowMock.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyW', repeat: false }));
    input.requestLock();
    assert(input.sample().throttle === 0, 'Old driving keys resumed after pointer lock returned');
    return { quickClickKeptCameraOwnership: true, unlockClearedAll: true };
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

for (const result of results) console.log(`PASS ${result.scenario}: ${JSON.stringify(result.metrics)}`);
console.log(`CAMERA HARNESS PASS (${results.length} scenarios)`);
