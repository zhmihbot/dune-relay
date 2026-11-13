# DUNE RELAY — Game & Simulation Specification

## 1. Fixed Scope
DUNE RELAY is a top-down 2D desert courier arcade game built with TypeScript, Vite, HTML5 Canvas 2D, procedural Web Audio, and HTML/CSS overlays, tested with Vitest. Players pilot a desert hover-buggy around a circular basin, collecting relics scattered across rock fields and delivering them to the central oasis before the 90-second timer expires or the shrinking sandstorm destroys the hull.

Non-goals for this scope: multiplayer, procedural infinite terrain, or external audio/texture asset pipelines.

---

## 2. Arena Geometry & Map Layout
- **Coordinate System**: Cartesian 2D world centered at `(0, 0)`.
- **Arena Boundary**: Circular basin with **1800-unit diameter** (`arenaRadius = 900`). The buggy is clamped inside `arenaRadius - buggy.radius`.
- **Central Oasis**: Safe delivery zone centered at `(0, 0)` with `oasisRadius = 110`.
- **Authored Rocks**: 12 circular rock obstacles (`RockObstacle`) distributed across inner, mid, and outer rings around `(0, 0)` with wide driving corridors (minimum rock-to-rock gap `153` units vs `36`-unit buggy diameter) and zero overlap with the central oasis.
- **Validated Relic Spawns + Proportional Safety Buffer + Inner Fallback**:
  - 16 authored `RelicSpawnPoint` candidates across `outer`, `mid`, and `inner` rings. The 6 `'outer'` spawns sit at `~558–565` units from `(0, 0)` with full rock clearance.
  - Active validity (`isSpawnPointValid`) for `safeZoneRadius` requires:
    1. `hypot(x, y) <= safeZoneRadius - relicSafeZoneMargin` (`45` units inside safe zone)
    2. `hypot(x, y) >= oasis.radius + relicOasisMargin` (`35` units outside oasis)
    3. For every rock, `hypot(x - rock.x, y - rock.y) >= rock.radius + relicRockMargin` (`32` units clear of rock edge)
  - **Early/Mid-Game Proportional Spawn Buffer (`selectNextRelicSpawn`)**:
    - When selecting a **new** relic spawn, `selectNextRelicSpawn` computes:
      - `shrinkRatio = clamp((safeZoneRadius - minSafeZoneRadius) / (initialSafeZoneRadius - minSafeZoneRadius), 0, 1)`
      - `bufferedSafeRadius = safeZoneRadius - earlySpawnExtraMargin * shrinkRatio` (`earlySpawnExtraMargin = 135`)
    - It prefers candidates valid against `bufferedSafeRadius` first, falling back to `safeZoneRadius` (`relicSafeZoneMargin = 45`) and finally `FALLBACK_INNER_SPAWN` (`(0, -165)`, distance `165` from `(0, 0)`) in late-game contraction.
    - Keeping `isSpawnPointValid` at `relicSafeZoneMargin = 45` ensures already-active relics only relocate when the shrinking storm actually reaches within `45` units of them, preventing sudden early/mid-game teleports.

---

## 3. Round, Scoring, Pickup, Delivery & Events
- **Round Duration**: `90` seconds (`roundDurationSeconds = 90`).
- **Carry Limit**: Maximum of **1 relic** carried at a time (`carryingRelic: boolean`).
- **Automatic Pickup**: When `!carryingRelic` and `activeRelic !== null`, entering `buggy.radius + activeRelic.pickupRadius` (`18 + 28 = 46` units) collects the relic (`carryingRelic = true`, `objectiveTarget` switches to `(0, 0)`), and records `lastPickup: PickupEvent | null` (`{ id, x, y, time }`).
- **Oasis Delivery**:
  - When `carryingRelic` is `true` and the buggy is within `oasis.radius` (`110` units from `(0, 0)`):
    - If `buggy.speed <= maxDeliverySpeed` (`125` units/s): delivery succeeds once (`score += 100`, `deliveries += 1`, `bestScore = Math.max(bestScore, score)`), records `lastDelivery: DeliveryEvent | null` (`{ x, y, score, deliveries, time }`), sets `carryingRelic = false`, `showSlowDownPrompt = false`, and spawns the next valid relic.
    - If `buggy.speed > maxDeliverySpeed`: delivery is withheld and `showSlowDownPrompt = true` so the HUD prompts **"Slow down to deliver"**.
- **Persistence (`src/persistence.ts`)**:
  - Best score stored under `localStorage` key `'dune_relay_best_score'` (`loadBestScore`, `saveBestScore`).
  - Audio mute preference stored under `localStorage` key `'dune_relay_muted'` (`loadMutedPreference`, `saveMutedPreference`).
  - Both safely handle unavailable, throwing, or malformed storage without throwing.

---

## 4. Driving Physics, Boost & Hull Rules
- **Momentum + Lateral Slip Model**:
  - Velocity `(vx, vy)` is decomposed each step into forward `(cos(angle), sin(angle))` and lateral `(-sin(angle), cos(angle))`.
  - Longitudinal motion applies throttle/reverse/brake acceleration and `longitudinalDrag` (`1.35`).
  - Lateral velocity decays according to `normalLateralGrip` (`7.5`) normally, or `driftLateralGrip` (`2.2`) when `input.brake` is active.
  - Steering uses `steerRate = 3.7` rad/s, `driftSteerMultiplier = 1.3`, and `speedAuthority = minSteerAuthority + (1 - minSteerAuthority) * min(1, preStepSpeed / 95)` with `stationarySteerAuthority = 0.85` (yielding `3.145 rad/s` brisk pivot authority even at `speed === 0`).
  - **Screen-Relative Directional Target Steering (`moveX`, `moveY`)**:
    - When `InputState` includes `moveX` / `moveY` with `hypot(moveX, moveY) > 1e-4`, `stepSimulation` computes `targetAngle = atan2(moveY, moveX)`, shortest signed `angleDiff`, monotonic turn-sign locking when `|angleDiff| > π - 0.08` (preventing `±π` oscillation on 180-degree reversals), proportional arrival damping `steer = clamp(angleDiff / max(maxTurnStep, 0.12), -1, 1)`, and forward `throttle = clamp(hypot(moveX, moveY), 0, 1)`. Releasing directional input (`hypot(moveX, moveY) <= 1e-4`) sets `throttle = 0, steer = 0` for natural coasting.
- **Speed Caps**:
  - Forward non-boost cap: `maxSpeed = 380`
  - Reverse cap: `maxReverseSpeed = 160`
  - Boost cap: `maxBoostSpeed = 540`
- **Boost Meter (`[0, 100]`)**:
  - `input.boost` while `boost > 0` applies `boostAccel = 360`, raises cap to `maxBoostSpeed`, and drains at `36`/s; otherwise regenerates at `18`/s, clamped to `[0, 100]`.
- **Hull Integrity (`[0, 100]`) & Collisions**:
  - Circle-circle separation against every `RockObstacle` with deterministic fallback normal `(cos(angle), sin(angle))` when `dist === 0` (preventing `NaN`/`Infinity`).
  - Hull damage occurs only when inward impact speed `>= minImpactDamageSpeed` (`95`) and `rockCollisionCooldown <= 0`, scaled by `0.12` clamped to `[6, 34]`, and sets `rockCollisionCooldown = 0.5`s.

---

## 5. Shrinking Sandstorm Safe Zone
- **Linear Contraction**: `safeZoneRadius` shrinks linearly from `initialSafeZoneRadius = 860` at `t = 0` to `minSafeZoneRadius = 230` at `t = 90s`.
- **Storm Exposure**: When `hypot(buggy.x, buggy.y) > safeZoneRadius`, `inStorm = true` and hull drains at `stormDrainPerSecond = 14`/s.

---

## 6. State Machine & Fixed-Step 120Hz Contract
- **Phases (`GamePhase`)**: `'title' | 'playing' | 'paused' | 'results'`; `EndReason`: `'none' | 'time_expired' | 'hull_depleted'`.
- **Fixed-Step 120Hz Contract**:
  - `FIXED_DT = 1 / 120`, `maxCatchUpSeconds = 0.1`.
  - `advanceSimulation` clamps frame delta to `[0, maxCatchUpSeconds]` and steps `stepSimulation` while `accumulator + 1e-9 >= fixedDt`, ensuring 30 FPS, 60 FPS, and 120 FPS render schedules produce bit-for-bit identical simulation state.
  - `src/simulation.ts` and `src/map.ts` are strictly pure and deterministic (no DOM, `window`, `performance.now()`, or `Math.random()`).

---

## 7. Presentation, Input, Audio & Brand Theme
- **Centralized Brand Config (`BRAND_THEME` in `src/config.ts`)**: `title`, `eyebrow`, `subtitle`, `relicName`, `baseName`, and 18 `palette` tokens typed via `BrandThemeConfig` in `src/types.ts`.
- **Procedural Web Audio (`src/audio.ts`)**:
  - `createAudioController(initialMuted)` lazily creates/resumes `AudioContext` strictly inside user-gesture `unlock()`, wraps Web Audio calls in `try/catch`, suspends when muted/paused/non-playing (with a 1.6s tail on `'results'`), and synthesizes pickup chimes, delivery fanfare, impact thud, boost ignition, and low-boost pulses from `SimulationState` events.
- **Desktop & Multi-Pointer Touch Input (`src/input.ts`)**:
  - Keyboard: `WASD`/Arrows drive & steer, `Space` / `Shift` boost, `Ctrl` / `B` / `C` brake/drift, `Esc` / `P` pause, `M` mute, `Enter` confirm on title/results.
  - Pointer Events (`bindTouchControls`): independent `joystickPointerId`, `brakePointerIds`, and `boostPointerIds` enable simultaneous left-thumb joystick driving + right-thumb brake/boost; `clearHeldKeys()` resets both keyboard and touch pointers on `blur`, `visibilitychange`, pause, restart, or results.
- **Renderer Performance & Accessibility (`src/renderer.ts`, `src/ui.ts`, `src/styles.css`)**:
  - Offscreen static world canvas cache (`1900 x 1900` covering `-950..+950`) blitted via one `drawImage` per frame.
  - Fast `drawStorm` using concentric annulus ring strokes and swirl arcs (eliminating `ctx.clip('evenodd')`).
  - Adaptive DPR cap (`1.5` above `1280x800`, `2.0` at/below, `2.2M` pixel cap), bounded particle (`80`) and skid (`128`) pools, pickup (`0.55s`) & delivery (`0.85s` + `+100`) celebrations, `prefers-reduced-motion` support, `>= 44px` HUD buttons with `:focus-visible`, and responsive `390x844` / `844x390` layouts.
