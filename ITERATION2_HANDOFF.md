# Iteration 2 handoff — work in progress

**The client does not compile right now.** `client/src/Game.ts` and `client/src/physics/DebrisSystem.ts` still import files that have been deleted. Nothing from Iteration 2 is committed. The last pushed commit is `b4bbf43` (Iteration 1).

## Done

### Shared / server (typechecks clean)
- **`shared/src/projectile.ts`:** `stepProjectile` now mutates the projectile in place and returns reused result objects, so the hot loop doesn't allocate. Callers must copy `r.point` / `r.normal` before the next step. The server `WeaponSystem` already does this.
- **`shared/src/arenaPhysics.ts`:** `buildArenaColliders` now returns `Map<handle, ArenaBlockKind>`, for impact effects that depend on the surface. The server `PhysicsWorld` type is updated.
- **Leech source on heal events (documented schema change):**
  - The `heal` event gained an optional `from?: number`.
  - `PowerUpHookContext.heal(amount, sourceId?)` takes the source robot.
  - The Leech Core hook passes the victim's id.
  - `GameSimulation.heal` emits `from`.
  - Purpose: the Leech tether effect needs to know who the health was drained from.

### Client (new or rewritten files)
- **`render/Quality.ts`:** `GraphicsSettings` holds a preset plus per-feature toggles: shadows, post, bloom, ao, smaa, grading, filmGrain, vignette, lensEffects, motionBlur, softParticles, distortion, maxDynamicLights, particleDensity, maxDecals, skidMarks, dustMotes, contactShadows, envMapSize. It also has `TOGGLE_LABELS`, `loadSavedSettings` / `saveSettings` (localStorage key `robot-arena.graphics.v2`), and `QualityAutoDetector`.
- **`render/robot/RobotTextures.ts`:** procedural painted-metal detail maps (seams, rivets, scratches, grime, stencils), with matching roughness and normal maps. Also steel and rubber maps, and `NumberAtlas` (8 cells, one stencilled team number per fleet slot).
- **`render/robot/RobotMaterials.ts`:**
  - `RobotDataTexture` is an 8×4 float texture with one column per robot, read in shaders via `gl_InstanceID / uInstPerRobot`:
    - row 0: paint rgb, hit flash
    - row 1: accent rgb, intensity
    - row 2: damage, wear seed, regen, aura
    - row 3: heat, booster glow, stun, alive
  - Materials are patched with `onBeforeCompile`:
    - worn edges from a screen-space curvature estimate
    - scorch from the damage value
    - barrel heat glow
    - accent emissive
    - number-atlas UV offset
  - `createDebris(kind, slot)` makes a fade-able material bound to one fleet slot.
- **`render/robot/RobotGeometry.ts`:** all parts are named and swappable as `PartDef` (name, slot, material, geometry, locals, addon, variant):
  - chassis (paint, steel, chrome, accent, lamps, glass, number), rivets, turret, single and twin barrels
  - treaded tire, spoked rim, hub, suspension arms and shocks
  - add-ons: plates ×5, boosters, mine rack, repair beacon, EMP coil, leech core
  - exported constants: `TURRET_MOUNT`, `BARREL_MOUNT`, `BARREL_TIP_Z`, `EXHAUST_TIPS`, `NOZZLE_TIPS`, `DAMAGE_POINTS`
- **`render/robot/RobotVisual.ts`:** per-robot visual-only state, updated by `update(dt, leanStrength)`:
  - lean springs from acceleration, landing detection (`landingImpact`) and squash
  - recoil spring (`onFire`), barrel heat, hit flash (`onDamaged`), dash timer (`onDash`)
  - `damageTier`, aura, and remote-robot wheel integration
  - `setTelemetry(...)` takes local-robot data: suspension, rotation, steering, contact
- **`render/robot/RobotFleet.ts`:** one `InstancedMesh` per part type for the whole fleet (about 30 draw calls in total), plus contact-shadow blobs and a fresnel level aura.
  - Robot management: `add(id, color)`, `remove`, `get`, `setStacks`.
  - Per-frame: `update(dt, time, groundHeight)`.
  - Effect anchor points: `muzzleWorld`, `chassisPoint`, `chassisDirection`, `wheelContact`.
  - `createDebris(visual)` returns `DebrisPiece[]` with materials already unique per chunk. Don't clone them; the clone loses the shader patch.
  - Debris and contact shadows: `setContactShadows`.
- **`render/vfx/ParticleAtlas.ts`:** `PType` enum (14 types), `TYPE_DEFS` (blend, atlas frames, color and size curves), `createCurveTexture()` (RGBA8; row 2t = color, row 2t+1 = size/2), and `createParticleAtlas()` (4×4 procedural cells: 0 glow, 1 spark, 2 star, 3 ring, 4–7 smoke, 8–11 fire flipbook, 12 electric, 13 chunk, 14 dust, 15 nano).

### Deleted (Game.ts still references them)
`render/RobotView.ts`, `render/RobotModelFactory.ts`, `render/VFXSystem.ts`, `render/GPUParticles.ts`.

## Remaining (planned design)
1. **`render/vfx/Particles.ts`:** instanced billboard particles.
   - Attributes: `aPos`, `aVel`, `aTime` (birth, life, gravity, drag), `aSize` (size, stretch, rot, rotSpeed), `aTint` (rgb, intensity), `aType` (row, frame0, frames, seed).
   - Ring buffer with update ranges, two systems (add and alpha).
   - Soft particles: compare against the composer's stable depth (`uDepth`, `perspectiveDepthToViewZ`, `uSoft`). Use depthTest false when soft, true otherwise.
2. **`render/vfx/ParticlePass.ts`:** a postprocessing `Pass`.
   - `needsDepthTexture = true`, `needsSwap = false`.
   - `setDepthTexture` forwards the texture to the particle uniforms.
   - Renders `particleScene` into `inputBuffer` with `autoClear` off.
   - The stable depth texture is safe to sample here (no feedback loop).
3. **Small VFX modules:**
   - `LightPool` (N pooled point lights; nearest-to-camera wins)
   - `DecalSystem` (instanced scorch marks and cooling spark marks; procedural shader)
   - `SkidMarks` (one dynamic ribbon geometry, fading by birth time)
   - `ElectricArcs` (LineSegments)
   - `TransientMeshes` (pooled noise-shader fireballs, shockwave rings, level-up pillars, EMP domes)
   - `ProjectileRenderer` (instanced cores + camera-facing ribbon trails; the same geometry is reused in the distortion scene)
   - `MineRenderer` (instanced body, light and beacon)
4. **Post effects:**
   - `Distortion.ts`: an Effect with `mainUv`; renders the distortion scene into a half-resolution render target in `update()`.
   - `LensEffect.ts`: a convolution effect combining chromatic aberration and radial dash blur.
   - `Grading.ts`: `LookupTexture.createNeutral(32)` (Float32 data) tinted teal in shadows, warm in highlights, then `LUT3DEffect`.
   - Film grain: `NoiseEffect` with premultiply and opacity about 0.12.
5. **`render/vfx/VFXSystem.ts` facade** (allocation-free): `muzzleFlash`, `impact(surface metal/wall/robot)`, `explosion` (layered), `empBurst` + arcs, dash thrusters + streaks, exhaust, tire smoke and dust, `landingDust`, `leechTether`, `repairSwirl`, `levelUp` (pillar + ring), damage sparks and smoke, `debrisSmoke`, `cableSparks`, decals.
6. **`render/env/`:**
   - `HeightFog.ts`: globally patch the `fog_*` ShaderChunks; a `Fog` subclass reuses `near` as density and `far` as height falloff; world height computed in the vertex shader from `viewMatrix`.
   - `EnvironmentBake.ts`: `pmrem.fromScene(scene, 0.03, 0.1, 300, { size })` after the arena is built.
   - `ArenaBuilder.ts` (replaces `render/ArenaBuilder.ts`): industrial pit.
     - Surfaces: worn floor plates, hazard border strips, barrier walls with supports, platform hazard edges, tread ramps.
     - Cover: crates (instanced), jersey barriers, machinery with fans, cooling towers.
     - Stadium and floodlight towers with additive light cones; holographic `ScoreboardScreen` (canvas: kill leader + timer).
     - Ambient life: cables with spark points, instanced blinking warning lights, rotating fans.
     - Draw calls: merge per material and use one vertex-colored emissive trim material, targeting about 20 arena draw calls.
   - `DustMotes.ts`: one Points draw call.
7. **`render/Renderer.ts` rewrite:**
   - Lights: key directional (shadowed), rim directional (cool, from behind), low hemisphere.
   - Composer built from settings: Render → N8AO → ParticlePass → EffectPass(Distortion, Bloom, ToneMapping ACES, LUT, Vignette, Noise) → Lens → SMAA.
   - Draw-call reporting: subclass `RenderPass` to record scene draws (main + shadow) separately from total draws.
   - Light pool size follows the preset.
8. **`render/CameraController.ts`:**
   - Spherecast collision via Rapier `castShape(... Ball(0.35) ...)`; the result field is `time_of_impact`.
   - 2-second death cam orbiting the killer, kill punch-in, smoother damping.
9. **`physics/DebrisSystem.ts`:** import `DebrisPiece` from `RobotFleet`, don't clone materials, play a bounce sound on velocity drops, and dispose non-shared geometry.
10. **`render/ProjectileSystem.ts`:** pooled projectiles with a history ring for trails; surface kind from the collider map.
11. **UI:**
    - `ui/SettingsMenu.ts`: opens on pointer-lock loss or Esc; preset + toggles + sensitivity + volume.
    - `ui/DebugOverlay.ts` (F3): FPS, frame time, scene/total draws, triangles, particles, lights.
    - Directional hit indicator and kill banner.
12. **`Game.ts` rewrite:**
    - Replace views with `RobotFleet`.
    - Feed local telemetry, including `wheelIsInContact`.
    - Hitstop: visual time scale of 0.15 for 80 ms on my kill.
    - Skid marks and tire smoke when lateral speed > 3.
    - Landing dust.
    - Damage-tier sparks and smoke.
    - Leech tether on `heal.from`.
    - Repair swirl.
    - Dash: motion blur + thrusters.
    - Scoreboard screen fed from the roster.
    - Remove all per-frame `new` calls.
    - `SnapshotBuffer.sampleMines` must write into a pool.
13. **lil-gui:** add folders for bloom, fog, grading, particles, lighting and camera.
14. **Verification:** run the typecheck, run `npm run dev`, check the console for shader errors, and measure draw calls (target < 150 on High).
15. **Docs:** README section with the audit, changelog by goal area, before/after checklist, the schema-change note (`heal.from`, arena collider Map), and Iteration 3 recommendations. Then commit **without a Claude co-author line** and push to `origin main` (https://github.com/DivyeshMangla/R.2.git).

## Step 0 audit (already done; include it in the README)
**Top weak elements:**
1. Primitive robots with no material detail
2. Flat, generic arena
3. Generic RoomEnvironment reflections
4. Weak silhouettes (no rim light)
5. Billboard-only explosions
6. Thin mesh-per-projectile trails
7. No damage or level readability
8. Floating robots (no contact shadows)
9. Static camera feel (no collision or kill feedback)
10. No game-feel motion (lean, skid marks, landings)

**Performance risks found in Iteration 1:**
- About 294 draw calls on High, even after merging.
- One mesh per projectile, decal, explosion ring and mine.
- `new Vector3` in the per-frame render and VFX paths.
- Per-death material clones.
- 64 decals as separate draw calls.
