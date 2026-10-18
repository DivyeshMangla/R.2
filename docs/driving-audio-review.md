# Driving and audio design review

Three independent sub-agents reviewed five successive proposals before implementation: a vehicle physics critic, an audio critic, and a controls/camera critic. Scores below are **design assessments**, not listening tests, player ratings, or claims of AAA production quality.

| Round | Proposal | Driving | Audio | Controls / camera | Refinement requested |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | Heavy pursuit | 8.1 | 8.1 | 8.1 | Preserve aiming ownership; quantify stopping/turning; replace tonal whine with combustion and broad noise. |
| 2 | Weighted chase | 8.7 | 8.5 | 8.7 | Smooth direction changes; hold camera while lining up shots; use recorded texture with modest pitch changes. |
| 3 | Driver intent | 9.0 | 8.8 | 9.0 | Smooth the steering limit; reserve the recording for loaded RPM; stabilize framing while aiming. |
| 4 | Traction & intent | 9.15 | 9.0 | 9.2 | Keep assists grounded and slope-aware; cap sound voices; test wraparound/recenter and frame-rate independence. |
| 5 | Rally pursuit | 9.25 | 9.1 | 9.3 | Selected for implementation with the measurable gates below. |

The key diagnosis was a mismatch between chassis steering and an orbit camera that never returned behind the vehicle. The former engine sound was an unmodulated saw/square pair through a high-Q resonant filter, normalized against an obsolete speed limit. Both problems required changes to the behavior, rather than simply lowering speed or volume.

## Selected behavior

- Chassis-relative vehicle steering remains consistent. The chase camera gradually follows during forward driving after mouse inactivity. Moving the mouse, firing, or holding RMB preserves camera control; C deliberately recenters. Reversing never flips the view. Losing pointer lock clears controls.
- Propulsion builds progressively; braking overrides stored propulsion and reverse begins near a stop. Steering has a smooth, speed-dependent cornering envelope. Momentum, jumps, collision impulses and authoritative prediction remain physical.
- Body pitch and roll show actual world acceleration transformed into chassis space. The HUD distinguishes speed, braking, reverse and coasting.
- Audio uses a small licensed engine recording under load, original quiet idle, intake, shifting, surface-dependent rolling noise, tire scrub, wind, landing impacts and distinct weapons. Inactive play fades the vehicle sound. One-shots have bounded concurrency and release their graph nodes.

## Acceptance targets

Keep the existing 12 m/s normal and 15 m/s boost limits. The driving harness confirms the selected targets:

| Measurement | Target | Measured |
| --- | --- | --- |
| 0–90% normal speed | 3–4 s | 3.20 s |
| Braking from cruising speed | 1.2–1.7 s / 7–11 m | 1.48 s / 7.66 m |
| Speed retained after 3 s coasting | 45–65% | 60.8% |
| Full-speed turn radius | 16–21 m | 17.82 m |
| Low-speed turn radius | Tight enough for cover and pickups | 3.58 m |
| Steering application / return to centre | Progressive / quicker centering | 167 ms / 100 ms |

Implementation review also removed a second world-position camera spring that lagged several metres behind a moving chassis. Normal driving now uses the shared orbit directly, with filtered lookahead, boom length, FOV and collision release; the death camera retains its spring.

Tests must also cover reverse, slalom, airborne behavior, ramps, old snapshot decoding, restoration/replay of propulsion state, camera ownership and wraparound, audio gear hysteresis, idle/slip gating, inactivity fades, and bounded one-shot allocation. Browser listening and a real driving playtest remain necessary to judge the final subjective result.
