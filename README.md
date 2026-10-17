# Robot Arena — Iteration 2

A 3D multiplayer arena brawler in the style of Smash Karts, with wheeled combat robots. The server is authoritative and runs Rapier physics at a fixed 60 Hz. The client predicts the local robot and interpolates remote robots. Rendering uses Three.js with a `postprocessing` HDR chain.

## Run

Requirements: Node 20+ (tested on Node 24) and a WebGL2 browser.

```bash
npm install
npm run dev
```

- Game client (Vite): http://localhost:5173
- Game server (Colyseus WebSocket): ws://localhost:2567. Override the port with the `ARENA_PORT` environment variable.

Open http://localhost:5173 in two tabs. Both tabs join the same match, and bots fill the remaining seats up to 6. You can add `?name=YourName` to the URL to choose a display name.

Other scripts:

```bash
npm run typecheck   # strict tsc over shared, server and client
npm run build       # production client build (client/dist)
npm run test:aim    # headless aim / hit-registration harness (writes server/test-results/aim-after.txt)
```

## Controls

| Input | Action |
| --- | --- |
| W A S D / arrow keys | Drive |
| Mouse (pointer lock) | Aim the turret and orbit the camera |
| Left click | Fire the cannon |
| Shift | Boost (uses the energy meter) |
| Space | Use active abilities (Rocket Dash, EMP Burst) |
| 1 / 2 / 3, or click a card | Pick a level-up card |
| Tab | Full scoreboard |
| ` or F2 | lil-gui tuning panel |
| F3 | Performance overlay (FPS, frame time, scene/total draw calls, triangles, particles, lights) |
| F4 / F5 | Aim debug overlay / side-view picture-in-picture |
| Esc | Release the mouse and open the settings menu |
| M | Mute |

## Architecture

```
shared/   types, wire protocol, constants, physicsConfig, power-up data + modifier system,
          arena layout, RobotController (Rapier ray-cast vehicle), projectile stepper,
          robot hitboxes, aim solver (turret geometry, camera rig)
server/   Colyseus ArenaRoom → GameSimulation (fixed 60 Hz, 30 Hz snapshots)
          PhysicsWorld · LagCompensator · WeaponSystem · ProgressionSystem · PowerUpSystem · BotAI
client/   Game (fixed-step accumulator loop, rendering decoupled)
          NetClient · SnapshotBuffer (100 ms interpolation) · LocalPredictor (rewind + replay)
          PhysicsWorld · DebrisSystem · ProjectileSystem · CameraController · AudioSystem
          render/ Renderer (post chain) · Quality (GraphicsSettings)
          render/robot/  RobotFleet (instanced fleet) · RobotVisual · RobotGeometry · RobotMaterials · RobotTextures
          render/vfx/    VFXSystem facade · Particles + ParticlePass · LightPool · DecalSystem · SkidMarks
                         ElectricArcs · TransientMeshes · ProjectileRenderer · MineRenderer · ParticleAtlas
          render/post/   Distortion · LensEffect · Grading
          render/env/    ArenaBuilder · ScoreboardScreen · HeightFog · EnvironmentBake · DustMotes
          ui/ UI · SettingsMenu · DebugOverlay      debug/ DebugGUI · AimDebug
```

- **Authority:** the server decides every hit, damage, kill, XP, level-up and card draw. Clients send only compact input frames: `[seq, throttle, steer, aimYaw, buttons, aimPitch, viewT]`, the last three per packet for loss tolerance.
- **Prediction:** the client applies each input immediately to the same shared `RobotController` code in its own Rapier world. When a snapshot arrives, it rewinds to the server state and replays every unacknowledged input. The visual error is folded into an offset that decays over about 100 ms.
- **Interpolation:** remote robots render 100 ms in the past. Position is lerped and rotation is slerped between snapshots, and interpolation never crosses a respawn.
- **Events:** shots, impacts, deaths and similar are batched once per server tick and replayed on the interpolated timeline. Events that affect the local player are applied immediately.
- **Physics tuning:** every constant lives in `shared/src/physicsConfig.ts`. Edits in lil-gui are applied locally, sent to the server, validated and clamped there, then broadcast so prediction stays in sync.

## Known limitations

- **Headless verification only:** this container has no GPU. Shader compilation, draw calls and rendering were verified in headless Chromium (SwiftShader), where the game runs at about 1 FPS. Frame times and visual feel on real hardware still need a person at a real display.
- **Debris is client-side only:** debris runs in a separate client-only Rapier world, so each client sees different chunk trajectories. At most 20 chunks are live at once (about two fresh wrecks); older chunks are removed early to keep draw calls bounded.
- **Tuning is unauthenticated:** any connected client can change the server's physics through lil-gui. It is a dev tool and must be gated before any public deployment.
- **Shadows:** three r186 removed `PCFSoftShadowMap`. Shadows use `PCFShadowMap`, with softness controlled by `shadow.radius`. Only the key light casts shadows.
- **Bloom:** "selective" bloom works through an HDR luminance threshold (about 0.95 before tone mapping), so only emissives and VFX bloom.
- **Colyseus 0.18 timing:** the room measures wall-clock time with `performance.now()`, because the `deltaTime` Colyseus passes in was unreliable.
- **Add-on parts:** Rapid Loader, Overclocked Motor and Ricochet Rounds have no visible add-on part.
- **Bots:** bots use whisker raycasts for avoidance and have no navmesh. They can get briefly stuck on the jump ramps. Since the aim fix they also aim with pitch, which makes them much more accurate than before.
- **Rooms and reconnects:** there is one room per server process, and a dropped player cannot reconnect.
- **Bundle size:** the client bundle is large because the Rapier WASM is inlined. Code splitting is not set up.

## Iteration 2 — graphics, VFX and game feel

Constraints for this iteration:
- no external assets (every texture, sprite and LUT is procedural)
- no per-frame allocations in render or VFX loops
- under 150 draw calls on High
- no changes to netcode or gameplay rules

### Step 0 audit (before)

**Top weak elements:**
1. Primitive robots with no material detail
2. Flat, generic arena
3. Generic `RoomEnvironment` reflections
4. Weak silhouettes (no rim light)
5. Billboard-only explosions
6. Thin mesh-per-projectile trails
7. No readable damage or level state
8. Floating robots (no contact shadows)
9. Static camera feel (no collision, no kill feedback)
10. No game-feel motion (lean, skid marks, landings)

**Performance risks in Iteration 1:**
- About 294 draw calls on High, even after merging
- One mesh per projectile, decal, explosion ring and mine
- `new Vector3` in the per-frame render and VFX paths
- A material clone on every death
- 64 decals drawn as separate draw calls

### Changelog by goal area

**Robots** (`render/robot/`)
- The whole fleet renders through one `InstancedMesh` per part type, about 30 draw calls for every robot together.
- Per-robot shader inputs live in an 8×4 float `RobotDataTexture`: paint, accent, damage, wear seed, regen, aura, barrel heat, booster glow, stun.
- Materials are patched with `onBeforeCompile`:
  - worn paint edges from a screen-space curvature estimate
  - scorch that grows with damage
  - barrel heat glow, accent emissive, stencilled team numbers
- Visual-only motion in `RobotVisual`: lean springs, landing squash, recoil, wheel animation, and barrel pitch smoothed in about 75 ms.
- Contact-shadow blobs and a fresnel level aura.
- Death debris uses the robot's own worn materials without cloning them.

**Arena and environment** (`render/env/`)
- An industrial pit built exactly on the shared collider layout:
  - worn floor plates and hazard strips
  - barrier walls with outside support ribs
  - jersey barriers (cover) and machinery columns (pillars)
  - tread ramps with lit rails
- Decor stays outside the barriers so nothing visible lacks collision: machinery with spinning fans, crate stacks, stands, floodlight towers with additive light cones, sagging cables that spark, blinking warning lights, and cooling towers.
- A holographic jumbotron shows the kill leader and match clock. Its canvas redraws only when the text changes.
- About 15 arena draw calls: one merged mesh per material, with every glowing trim in one vertex-coloured emissive material.
- `EnvironmentBake` bakes the built arena into the reflection map (PMREM, size set by the preset).
- `HeightFog` replaces three's linear-fog chunks with exponential height fog.
- `DustMotes` adds floating dust in the floodlights, one `Points` draw call that wraps around the camera.

**Lighting and post** (`render/Renderer.ts`, `render/post/`)
- Light rig: a warm shadowed key, a cool rim light from behind for silhouettes, and a low hemisphere fill.
- Composer chain, built from `GraphicsSettings`: Render → N8AO → ParticlePass → EffectPass(Distortion, Bloom, ACES, LUT grading, Vignette, film grain) → Lens (chromatic aberration + dash radial blur) → SMAA.
- Grading is a procedural 32³ LUT: teal shadows, warm highlights, an S-curve.
- Distortion renders shockwaves, fireball heat and shell trails into a half-resolution float target, then bends every UV in its pass through `mainUv`.
- Draw calls are reported per frame: scene (main + shadow) and total.

**VFX** (`render/vfx/`)
- Every effect goes through the allocation-free `VFXSystem` facade.
- Instanced billboard particles: two draw calls (additive and alpha), ring-buffered, with motion evaluated in the vertex shader and only the dirty range uploaded.
  - 14 particle types share a procedural atlas and colour/size curve textures.
  - Soft particles fade against the composer's stable depth texture.
- Each kind of effect is pooled into one draw call:
  - `LightPool`: N real point lights shared by every flash, nearest-to-camera first, with a fixed light count so shaders never recompile
  - `DecalSystem`: procedural scorch and cooling spark marks, instanced
  - `SkidMarks`: one ribbon geometry
  - `ElectricArcs`: line segments
  - `TransientMeshes`: fireballs, shockwave rings, level-up pillars, EMP domes
  - `ProjectileRenderer`: instanced cores plus camera-facing ribbon trails
  - `MineRenderer`: instanced
- Layered effects: explosions (flash, fireball + heat haze, shockwave, sparks, embers, smoke column, chunks, scorch), surface-specific impacts (metal, concrete, ground, robot), EMP burst with arcs, dash thrusters and streaks, boost exhaust, tyre smoke and skid marks, landing dust, damage sparks and smoke, Leech tether, repair swirl, level-up pillar, cable sparks.

**Camera and game feel**
- Camera spherecast collision against the arena (Rapier `castShape`, 0.35 m ball): pulls in immediately, eases back out.
- A 2-second death cam that orbits the killer.
- Kill feedback: punch-in (FOV and boom), hitstop (visuals at 0.15× speed for 80 ms; the simulation is untouched), kill banner, kill sting sound.
- Directional hit indicator.
- Debris chunks clank when they hit something.

**UI**
- `SettingsMenu`: opens on Esc / pointer-lock loss. Offers the preset, every per-feature toggle, mouse sensitivity and volume, saved under `robot-arena.graphics.v2`.
- `DebugOverlay` (F3).
- lil-gui folders: Lighting, Bloom, Fog, Grading, Particles & VFX, Camera.

### Schema and shared-code notes

None of these change gameplay rules or the authoritative simulation.
- **`heal` event** gained an optional `from?: number`, the robot that Leech Core drained the health from. It drives the tether effect. `PowerUpHookContext.heal(amount, sourceId?)` forwards it.
- **`buildArenaColliders`** now returns `Map<colliderHandle, ArenaBlockKind>` instead of a `Set`, so impact effects can pick the surface type.
- **`EnvHit.handle` / `StepResult.envHandle`** were added to the shared projectile stepper, so the client can look up which surface a shell hit. The server ignores them.

### Before / after checklist

Draw calls were measured in headless Chromium with `renderer.info` (eight samples during live bot combat):

| | Iteration 1 | Iteration 2 |
| --- | --- | --- |
| Draw calls, High (total incl. post) | ~294 | 109–122 |
| Draw calls, Low / Medium / Ultra (total) | — | ~80 / ~104 / 120–125 |
| Scene draws (main + shadow), High | — | 77–90 |
| Shader compile errors / console errors (all presets) | — | 0 |
| `npm run typecheck` | client did not compile mid-refactor | clean |
| Per-frame allocations in render / VFX loops | `new Vector3`, per-death material clones | none (scratch objects, pools, ring buffers) |
| Projectiles / decals / rings / mines | one mesh each | one instanced draw per kind |

Visual checklist:
- [x] Robots have worn and scorched PBR paint, readable damage tiers and a level aura.
- [x] Robots are grounded by contact shadows; lean, landing squash and recoil read.
- [x] The arena is an industrial pit, with reflections baked from the arena itself.
- [x] Rim light separates robots from the background haze.
- [x] Explosions are layered (fireball, heat haze, shockwave, smoke column, embers, scorch).
- [x] Shells have glowing cores and ribbon trails.
- [x] The camera collides with walls, punches in on kills and runs a death cam; hitstop on kills.
- [x] Skid marks, tyre smoke and landing dust appear while driving.
- [x] F3 overlay, settings menu, and lil-gui folders for bloom, fog, grading, particles, lighting and camera.
- [ ] Frame time on real GPUs (not measurable in this headless container).

Two fixes came out of the draw-call measurement:
- **N8AO** turns on its transparency mode by itself whenever the scene has any transparent material. That mode re-renders the whole scene twice per frame. It is now forced off: transparent objects here never write depth, so AO is unaffected. This saved about 100 draws.
- **Death debris** is capped at 20 live chunks, and only hull halves cast shadows. Before the cap, debris cost up to about 110 draws during heavy fighting.

### Iteration 3 recommendations

1. **Authored robot meshes:** replace the procedural parts with GLTF meshes through `RobotFleet.part(name)`, which is already set up for swapping geometry. Bake curvature and AO maps instead of using the screen-space curvature estimate.
2. **Temporal AA with motion vectors** in place of SMAA, with a velocity buffer reused for real per-object motion blur on dash.
3. **Shadows:** cascaded or virtual shadow maps for the key light, plus shadowed floodlight spot lights on Ultra. The arena's static shadows could be baked into a lightmap so the shadow pass only draws robots.
4. **Instanced, pooled debris** sharing the fleet's data texture, so wrecks can persist longer at a fixed draw-call cost.
5. **Measure and tune on real hardware:** profile frame time per preset on low-end and high-end GPUs, then retune the auto-detect thresholds and the particle density per preset.
6. **Gate tuning and debug channels**, and code-split the bundle (Rapier WASM, postprocessing) before any public deployment.
