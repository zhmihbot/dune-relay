# DUNE RELAY — QA & Verification Report

## Summary
- **Overall Status**: **PASS** (Session 1 & Session 2 complete; independent `opus-review` verification signed off with `0` remaining defects).
- **Latest Verification Gate (`npm.cmd`)**:
  - `npm.cmd run typecheck` (`tsc --noEmit`): **PASS** (exit 0)
  - `npm.cmd run test` (`vitest run`): **PASS** — `1 passed (1)` file, `13 passed (13)` tests (`tests/simulation.test.ts`, `105 ms` test execution)
  - `npm.cmd run build` (`tsc --noEmit && vite build`): **PASS** — `12 modules transformed`, built in `219 ms`:
    - `dist/index.html` (`0.53 kB │ gzip: 0.34 kB`)
    - `dist/assets/index-DdxZ1qmW.css` (`15.95 kB │ gzip: 4.01 kB`)
    - `dist/assets/index-CP5skHuF.js` (`54.70 kB │ gzip: 19.83 kB`)

---

## Automated Unit Test Coverage (`tests/simulation.test.ts`, 13/13 Passed)
1. **Pickup, Carry Limit & Delivery Speed Rule**: `+100` score once per oasis delivery, 1-relic carry cap enforced, and `"Slow down to deliver"` (`showSlowDownPrompt = true`) when entering the oasis above `maxDeliverySpeed` (`125`).
2. **Round Expiration & Hull Depletion**: Entering `'results'` cleanly once on `90s` timeout (`time_expired`) or `0` hull (`hull_depleted`), with subsequent steps acting as no-ops.
3. **Pause / Resume**: Preserves remaining round time and zeroes the fixed-step accumulator.
4. **High-Speed Collisions & Zero-Distance Overlap**: `buggy.x === rock.x && buggy.y === rock.y` uses deterministic fallback normal without producing `NaN`/`Infinity` and cleanly separates from the rock.
5. **Cooldown, Speed Caps & Bounds**: Rock collision cooldown prevents per-frame damage drain during sustained contact; speed caps (`380` normal / `540` boost / `160` reverse) and `[0, 100]` hull/boost bounds strictly enforced.
6. **Shrinking Safe Zone Spawn Validity & Persistence**: Relic spawns stay inside `safeZoneRadius - 45`, outside `oasis.radius + 35`, outside all `rock.radius + 32` down to `minSafeZoneRadius = 230` (including inner fallback `(0, -165)`); `loadBestScore`/`saveBestScore` handle missing, throwing, or malformed `localStorage`.
7. **Render Schedule Invariance (`120 Hz` Fixed Step)**: Identical control inputs over multi-second runs yield equivalent state across `30 FPS` (`1/30`), `60 FPS` (`1/60`), and `120 FPS` (`1/120`).
8. **Stationary & Moving Turning Speeds**: Verifies brisk standstill pivoting using `stationarySteerAuthority` (`0.85` × `steerRate` `3.7`) and moving turn speed.
9. **Early/Mid-Game Proportional Spawn Buffer**: Newly spawned relics have `>= 120` units safety buffer inside `safeZoneRadius` at `t = 0` so they do not prematurely teleport, while still relocating once the storm reaches within `45` units.
10. **Muted Preference Persistence & `BRAND_THEME` Config**: Verifies `loadMutedPreference` / `saveMutedPreference` (`dune_relay_muted`) resilience and centralized `BRAND_THEME`.
11. **Screen-Relative Directional Controls (Cardinal & Diagonal + Speed Normalization)**: Verifies `W/S/A/D` cardinal directions and normalized diagonal `moveX`/`moveY` vectors never exceed cardinal `maxSpeed`.
12. **Monotonic 180-Degree Reversal & Shortest-Path `±π` Wraparound**: Verifies 180-degree opposite-heading turn from rest commits to one turn sign without `±π` chatter and wraps along the shortest angular arc.
13. **Directional Release Coasting & Joystick Throttle Scaling**: Verifies releasing directional input (`moveX = 0, moveY = 0`) preserves momentum coasting and partial joystick deflection (`0.4` vs `1.0`) scales throttle intensity.

---

## Independent Audit (`opus-review`, #25 & #28)
- **Session 1 Audit**: Verified pure simulation (`src/simulation.ts`, `src/map.ts`), 60 randomized invariant fuzz runs (`0` violations), and resolved 4 minor UI/renderer/lifecycle defects (`pagehide` bfcache, `"New best score!"` tie/pause-restart guard, short-viewport `.card` centering, strata `lineDashOffset` reset).
- **Session 2 Audit (#25 & #28)**:
  - Verified snappier turning (`steerRate: 3.7`, `stationarySteerAuthority: 0.85`), outer spawn positions (`~558.6–565.0`) + `earlySpawnExtraMargin: 135`, `lastPickup`/`lastDelivery` events, and `BRAND_THEME`.
  - Verified `Space`/`Shift` boost, `Ctrl`/`B`/`C` brake/drift, `Esc`/`P` pause, `M` mute, independent multi-pointer tracking (`joystickPointerId`, `brakePointerIds`, `boostPointerIds`), offscreen static world cache, `drawStorm` annulus optimization (no `clip('evenodd')`), adaptive DPR cap, `prefers-reduced-motion`, and Web Audio gesture unlock/suspend safety.
  - Identified 1 minor CSS selector mismatch at `src/styles.css:212` (`.carry-badge.is-carrying + .objective .compass-arrow` -> `.carry-badge.is-carrying + .hud-subrow .compass-arrow`), which `ui-render` fixed and `opus-review` re-verified in #28 (**PASS, 0 remaining defects**).

---

## Host-Verified Browser Verification (`http://127.0.0.1:5173/`)
- **Viewports Tested**: `1280x800` (desktop), `390x844` (mobile portrait), `844x390` (mobile landscape).
- **Functional & Persistence Checks**:
  - Verified `Space` and `Shift` boost hotkeys, brisk stationary turning, `Ctrl`/`B` drift/brake, mute toggle persistence (`dune_relay_muted`), best score persistence (`dune_relay_best_score`), window blur / tab visibility auto-pause, `3` consecutive restarts, and `0` console/page errors.
- **Touch Target & Layout Measurements (`390x844` Portrait)**:
  - `#hud-pause-btn`: `73.85 × 44.0 px`
  - `#hud-mute-btn`: `109.44 × 44.0 px`
  - `#touch-brake`: `76.0 × 76.0 px`
  - `#touch-boost`: `76.0 × 76.0 px`
  - `#touch-joystick`: `150.0 × 150.0 px`
  - **Overlap Check**: Zero overlap between `.hud-bottom` (`y = 200..252 px`) and bottom touch controls (`y = 662..826 px`).

### Browser Emulation vs. Physical-Phone Testing Boundary
- **What Was Verified (Emulated Chromium)**: Viewport resizing (`1280x800`, `390x844`, `844x390`), DOM layout bounding boxes, CSS media queries, keyboard/focus lifecycle, `localStorage` persistence, and synthetic `PointerEvent` dispatch were verified in the host Chromium browser environment.
- **What Remains Untested (Physical Mobile Hardware)**: Real capacitive multi-touch palm/thumb ergonomics on physical iOS/Android screens, hardware Web Audio speaker behavior under iOS mute/silent-switch policies, and sustained real-device mobile GPU thermal/battery throttling remain untested and require human physical-device QA before mobile ad distribution.
