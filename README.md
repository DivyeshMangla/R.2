# Robot Arena — Iteration 1

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
| M | Mute |

## Architecture

```
shared/   types, wire protocol, constants, physicsConfig, power-up data + modifier system,
          arena layout, RobotController (Rapier ray-cast vehicle), swept-ray projectiles
server/   Colyseus ArenaRoom → GameSimulation (fixed 60 Hz, 30 Hz snapshots)
          PhysicsWorld · WeaponSystem · ProgressionSystem · PowerUpSystem · BotAI
client/   Game (fixed-step accumulator loop, rendering decoupled)
          NetClient · SnapshotBuffer (100 ms interpolation) · LocalPredictor (rewind + replay)
          PhysicsWorld · DebrisSystem · Renderer · RobotModelFactory/RobotView · VFXSystem
          GPUParticles · ProjectileSystem · CameraController · AudioSystem · UI · DebugGUI
```

- **Authority:** the server decides every hit, damage, kill, XP, level-up and card draw. Clients send only compact input frames: `[seq, throttle, steer, aimYaw, buttons]`.
- **Prediction:** the client applies each input immediately to the same shared `RobotController` code in its own Rapier world. When a snapshot arrives, it rewinds to the server state and replays every unacknowledged input. The visual error is folded into an offset that decays over about 100 ms.
- **Interpolation:** remote robots render 100 ms in the past. Position is lerped and rotation is slerped between snapshots, and interpolation never crosses a respawn.
- **Events:** shots, impacts, deaths and similar are batched once per server tick and replayed on the interpolated timeline. Events that affect the local player are applied immediately.
- **Physics tuning:** every constant lives in `shared/src/physicsConfig.ts`. Edits in lil-gui are applied locally, sent to the server, validated and clamped there, then broadcast so prediction stays in sync.

## Known limitations

- **Visual feel not checked:** gameplay, prediction error (~1 mm at 8 ms RTT), cards, power-ups and match flow were verified with headless and scripted tests. Visual feel and real-window FPS were not checked on a visible display.
- **No lag compensation:** hits are resolved against the server's current robot positions. A fast-moving remote target can look hit on your screen and still be a miss.
- **Debris is client-side only:** debris runs in a separate client-only Rapier world. Each client sees different chunk trajectories.
- **Horizontal shots only:** projectiles fire along the aim yaw with no pitch. Hitting robots on the platform from the floor relies on the ramp angles and splash from mines.
- **Tuning is unauthenticated:** any connected client can change the server's physics through lil-gui. It is a dev tool and must be gated before any public deployment.
- **Shadows:** three r186 removed `PCFSoftShadowMap`. Shadows use `PCFShadowMap`, with softness controlled by `shadow.radius`.
- **Bloom:** "selective" bloom works through an HDR luminance threshold (about 0.92 before tone mapping), so only emissives and VFX bloom. It does not use a separate selection layer.
- **Tone mapping:** inside the post chain, ACES is applied by `ToneMappingEffect`. On the Low preset (no post chain) it is applied by the renderer's `ACESFilmicToneMapping`.
- **Colyseus 0.18 timing:** the `deltaTime` that Colyseus 0.18 passes to the simulation interval was unreliable. The room measures wall-clock time with `performance.now()` instead.
- **Add-on parts:** some power-ups have no visible add-on part: Rapid Loader, Overclocked Motor and Ricochet Rounds.
- **Bots:** bots use whisker raycasts for avoidance and have no navmesh. They can get briefly stuck on the jump ramps.
- **Rooms and reconnects:** there is one room per server process, and a dropped player cannot reconnect.
- **Bundle size:** the client bundle is about 5.5 MB because the Rapier WASM is inlined. Code splitting is not set up.

## Iteration 2 — top graphics upgrades (by impact)

1. **Authored GLTF robots with full PBR texture sets** (normal, ORM, emissive) plus visible damage states. These drop into the existing `RobotModelFactory` slots without touching gameplay code.
2. **Baked arena lighting:** lightmaps or AO and light probes for static GI, plus screen-space reflections on the floor. This grounds the robots and makes emissives read as real light sources.
3. **Better volumetric VFX:** flipbook fire and smoke with soft-particle depth fade, heat distortion around explosions and boosts, and light shafts from the floodlights.
4. **Temporal AA with motion vectors** in place of SMAA, plus cascaded or contact shadows and a short motion blur on dash. Together these remove shimmer and give speed.
5. **Projected decals and skid marks** (DecalGeometry on any surface, persistent tyre trails), plus per-robot scorch and scratch decals that accumulate as damage is taken.
