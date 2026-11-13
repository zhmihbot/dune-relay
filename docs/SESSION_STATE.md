# DUNE RELAY — Session State

## Current Phase
**Session 2 + Directional Controls, Mobile HUD Polish & GitHub Pages Publication — Complete & Verified.**
- **Public Repository**: `https://github.com/zhmihbot/dune-relay`
- **Public Playable URL (GitHub Pages)**: `https://zhmihbot.github.io/dune-relay/`
- **Session 1**: Completed scaffolding, docs, dependencies (`npm.cmd install`), shared contracts, map, persistence, pure `120 Hz` fixed-step simulation (`7/7` tests), Canvas 2D renderer, keyboard input, `#ui-layer` HUD/modals, `opus-review` audit (4 minor fixes resolved), and host smoke test (`final_step_12.png`).
- **Session 2**: Upgraded steering (`steerRate: 3.7`, `stationarySteerAuthority: 0.85`), early/mid-game relic spawn safety buffer (`earlySpawnExtraMargin: 135`, outer spawns `~558–565`), `lastPickup`/`lastDelivery` events, centralized `BRAND_THEME`, procedural Web Audio synthesizer (`src/audio.ts` + `dune_relay_muted`), `Space`/`Shift` boost + `Ctrl`/`B`/`C` brake, multi-pointer touch joystick/buttons, offscreen static world cache, `drawStorm` annulus bands (no `clip('evenodd')`), adaptive DPR cap, `prefers-reduced-motion`, and responsive `390x844` / `844x390` layouts.
- **Post-Session 2 Update (Directional Controls, Real-Device iPhone 13 Mobile HUD & GitHub Pages)**:
  - Replaced vehicle-relative `W/S` + `A/D` with screen-relative directional controls (`moveX`, `moveY`) on desktop (`WASD`/Arrows with normalized diagonals) and mobile virtual joystick (angle + deadzone-rescaled magnitude), preserving all driving physics (`13/13` unit tests passing).
  - Compacted mobile portrait (`390x660` / `390x844`) and landscape (`844x285` / `844x390`) HUDs using `100dvh` and `env(safe-area-inset-*)` so `.hud-top` stays `<= 48px` in landscape, `.hud-bottom` sits at bottom-center (`220x31px`) with `>= 170px` clearance from touch controls, and `#touch-boost` / `#touch-brake` sit side-by-side (`60x60px` each) at bottom-right.
  - Published public GitHub repository `zhmihbot/dune-relay` with automated GitHub Pages deployment (`.github/workflows/deploy.yml`).
- **Host Verification**: Verified on `http://127.0.0.1:5173/` across `1280x800`, `390x660`, `390x844`, `844x285`, and `844x390` (`0` console/page errors, verified touch targets and zero HUD/control overlap) and on live GitHub Pages (`https://zhmihbot.github.io/dune-relay/`).

---

## Latest Verified Gate Output
- `npm.cmd run typecheck`: **PASS** (`tsc --noEmit`, exit 0)
- `npm.cmd run test`: **PASS** (`tests/simulation.test.ts`, `13/13` tests passed in `105 ms`)
- `npm.cmd run build`: **PASS** (`vite build`, `12` modules transformed -> `dist/index.html` `0.53 kB`, `dist/assets/index-DdxZ1qmW.css` `15.95 kB`, `dist/assets/index-CP5skHuF.js` `54.70 kB`)

---

## Verified Model Assignments & Session History

### Session 1 Assignments (All 100% Quota at Start)
| Agent | Model ID (Display Name) | Role | Session 1 Observed Quota |
| --- | --- | --- | --- |
| `coordinator` | `gemini-4-argon-high` (Gemini 4 Argon (High)) | Swarm coordinator | `100% -> 90%` remaining |
| `monitor` | `gemini-4-argon-high` (Gemini 4 Argon (High)) | Idle stall monitor | `100% -> 90%` remaining |
| `setup` | `gemini-3.8-flash-high` (Gemini 3.8 Flash (High)) | Setup, scaffolding, docs, routine verification | `100% -> 99%` remaining |
| `arch-sim` | `gemini-4-argon-high` (Gemini 4 Argon (High)) | Architecture, shared types, pure simulation, unit tests | `100% -> 90%` remaining |
| `ui-render` | `claude-sonnet-5-5-high` (Claude Sonnet 5.5 (High)) | Canvas 2D renderer, input handler, HTML/CSS UI, `main.ts` | `100% -> 1%` remaining |
| `opus-review` | `claude-opus-5-5-high` (Claude Opus 5.5 (High)) | Independent final review & verification | `100% -> 1%` remaining |

### Session 2 Assignments, Disclosed Quota Switches & Live Quota Readings
During Session 2, Claude quota hit `0%` mid-session; affected workers were hot-swapped in-place via `swarm(model)` while preserving conversation context:
- `opus-review`: `claude-opus-5-5-high` -> `gemini-4-argon-high` (when Claude quota hit `0%`)
- `ui-render`: `claude-sonnet-5-5-high` -> `gemini-4-hydrogen-high` (for the #27 `src/styles.css:212` fix after Claude quota hit `0%`)
- `setup`: `gemini-3.8-flash-high` -> `gemini-4-hydrogen-high` (post-restart model switch)

| Agent | Session 2 Final Model ID | Role | Session 2 Live Observed Quota |
| --- | --- | --- | --- |
| `coordinator` | `gemini-4-argon-high` | Swarm coordinator | `86% -> 63%` remaining |
| `monitor` | `gemini-4-argon-high` | Idle stall monitor | `86% -> 63%` remaining |
| `arch-sim` | `gemini-4-argon-high` | Simulation, map, persistence, tests | `86% -> 63%` remaining |
| `opus-review` | `gemini-4-argon-high` *(switched from `claude-opus-5-5-high`)* | Independent audit & sign-off | `claude-*: 50% -> 0%`; `gemini-4-argon-high: 86% -> 63%` |
| `ui-render` | `gemini-4-hydrogen-high` *(switched from `claude-sonnet-5-5-high`)* | Audio, input, renderer, UI, styles, main | `claude-*: 50% -> 0%`; `gemini-4-hydrogen-high: 100% -> 98%` |
| `setup` | `gemini-4-hydrogen-high` *(switched from `gemini-3.8-flash-high`)* | Documentation, QA & handoff | `gemini-3.8-flash-high / gemini-4-hydrogen-high: 100% -> 98%` |

---

## Important Interfaces
- **Contracts (`src/types.ts`)**: `SimulationState`, `GameConfig`, `InputState`, `BrandThemeConfig`, `PickupEvent`, `DeliveryEvent`
- **Simulation (`src/simulation.ts`)**: `createInitialState`, `startRun`, `pauseRun`, `resumeRun`, `stepSimulation`, `advanceSimulation`
- **Presentation, Audio & Input (`src/renderer.ts`, `src/audio.ts`, `src/input.ts`, `src/ui.ts`)**: `createRenderer`, `createAudioController`, `createInputController`, `initUI`

---

## File Ownership Table

| Owner | Files |
| --- | --- |
| `setup` | `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `docs/SPEC.md`, `docs/QA.md`, `docs/EVALUATION.md`, `docs/SESSION_STATE.md`, `AGENTS.md`, `README.md` |
| `arch-sim` | `src/types.ts`, `src/config.ts`, `src/map.ts`, `src/persistence.ts`, `src/simulation.ts`, `tests/simulation.test.ts` |
| `ui-render` | `src/audio.ts`, `src/renderer.ts`, `src/input.ts`, `src/ui.ts`, `src/styles.css`, `src/main.ts` |
| `opus-review` | Read-only audit + test/build verification |

---

## Next Potential Tasks (Post-Session 2)
1. Run physical-device QA on iOS Safari and Android Chrome to validate capacitive multi-touch feel, iOS silent-switch audio behavior, and mobile GPU thermals.
2. Add optional automated Playwright E2E tests (`tests/e2e.spec.ts`) covering a full browser relic pickup + low-speed oasis delivery flow.
3. Add per-run telemetry summary (top speed reached, total distance driven, storm exposure time) on the Results modal if desired for deeper post-run feedback.

---

## Exact Resume Instruction
`Read docs/SESSION_STATE.md and docs/SPEC.md first, run npm.cmd run typecheck && npm.cmd run test, then inspect docs/QA.md and docs/EVALUATION.md before making further edits.`

---

## Project Commands (Windows PowerShell)
PowerShell ExecutionPolicy blocks `npm.ps1` and `npx.ps1`. **Always use `npm.cmd` and `npx.cmd`:**

- `npm.cmd install` — install devDependencies (`typescript`, `vite`, `vitest`)
- `npm.cmd run dev` — start Vite dev server
- `npm.cmd run build` — run `tsc --noEmit && vite build` (outputs to `dist/` with `base: "./"`)
- `npm.cmd run preview` — preview production bundle locally
- `npm.cmd run typecheck` — run strict TypeScript check (`tsc --noEmit`)
- `npm.cmd run test` — run Vitest suite once (`vitest run`)

---

## Environment & Checkpoint Notes
- **OS / Shell**: Windows PowerShell.
- **Git**: `git` is not installed on `PATH`; progress tracked via `docs/SESSION_STATE.md` and verified file checkpoints.
