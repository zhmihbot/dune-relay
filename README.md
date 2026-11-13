# DUNE RELAY

A top-down 2D desert courier arcade game built with TypeScript, Vite, HTML5 Canvas 2D, Web Audio, and Vitest.

- **Public Playable Game (GitHub Pages)**: [https://zhmihbot.github.io/dune-relay/](https://zhmihbot.github.io/dune-relay/)
- **Public Repository**: [https://github.com/zhmihbot/dune-relay](https://github.com/zhmihbot/dune-relay)

## Gameplay Overview
- **Objective**: Pilot your desert hover-buggy out from the central oasis, collect glowing relics across the rocky basin, and deliver them back to the oasis within **90 seconds**.
- **Momentum & Drift**: Request any screen direction (`WASD` / Arrows or touch joystick) and the hover-buggy smoothly steers along the shortest angular arc while accelerating with full momentum and lateral drift physics.
- **Delivery Speed Rule**: You can carry one relic at a time and must enter the central oasis at or below the safe delivery speed (`125` units/s). Entering too fast displays **"Slow down to deliver"**.
- **Shrinking Sandstorm**: A circular safe zone shrinks linearly from radius `860` to `230` over the 90-second round. New relic spawns include an early/mid-game safety buffer so newly spawned targets remain reachable inside the safe zone. Driving outside the safe zone drains hull integrity (`14`/s).
- **Boost, Hull & Audio**: Activate boost for extra speed (`540` units/s cap; auto-regenerates when released), avoid high-speed rock impacts that damage your hull, and toggle procedural Web Audio SFX on or off anytime (`localStorage` persisted).

## Controls

### Desktop Keyboard (Screen-Relative Directional Controls)
- **Steer & Drive (Screen Direction)**:
  - `W` or `↑` — Steer & drive toward the top of the screen
  - `S` or `↓` — Steer & drive toward the bottom of the screen
  - `A` or `←` — Steer & drive toward the left of the screen
  - `D` or `→` — Steer & drive toward the right of the screen
  - Combined keys (`W+D`, `S+A`, etc.) steer along the diagonal with normalized magnitude (`1.0`).
- **Boost**: `Space` or `Shift`
- **Brake / Drift**: `Ctrl`, `B`, or `C`
- **Pause / Resume**: `Esc` or `P` (also auto-pauses on window blur or hidden tab)
- **Mute / Unmute Audio**: `M`
- **Start / Restart**: `Enter` on Title or Results screens, or click the on-screen buttons

### Mobile / Touch Controls (Pointer Events)
- **Left Virtual Joystick (`#touch-joystick`)**: Drag thumb in any screen direction to steer the buggy smoothly toward that angle; deflection magnitude (`0.12` deadzone rescaled to `[0, 1]`) controls throttle intensity.
- **Right Action Buttons**: `#touch-brake` (Drift / Brake) and `#touch-boost` (Boost), supporting simultaneous multi-pointer thumb input alongside the joystick.
- **HUD Buttons (`>= 44px` targets)**: `#hud-pause-btn` (Pause) and `#hud-mute-btn` (Audio Mute/Unmute), plus `#title-mute-btn` on the Title screen.

## Commands (Windows PowerShell)
PowerShell ExecutionPolicy blocks `npm.ps1` and `npx.ps1`; always invoke `npm.cmd`:

```powershell
npm.cmd install
npm.cmd run dev
npm.cmd run typecheck
npm.cmd run test
npm.cmd run build
npm.cmd run preview
```

## Static Hosting Instructions
[`vite.config.ts`](vite.config.ts) sets `base: './'`, so all script and stylesheet references in `dist/index.html` use relative paths. After running `npm.cmd run build`, deploy the contents of `dist/` directly to any static host—including **GitHub Pages**, **Netlify**, **Cloudflare Pages**, **Amazon S3**, or any sub-path—with no server-side path rewrites required.

## Branded Playable-Ad Customization Guide (Perfume / Luxury Brand Demo)
DUNE RELAY is structured for quick white-labeling as an interactive playable ad (for example, a desert-themed luxury perfume campaign):

1. **Edit `BRAND_THEME` in [`src/config.ts`](src/config.ts)**:
   - Update copy strings:
     - `title` (e.g. `"SOLAIRE OUD"`)
     - `eyebrow` (e.g. `"Maison Interactive Experience"`)
     - `subtitle` (brief campaign premise shown on the title overlay)
     - `relicName` (e.g. `"Signature Flacon"`)
     - `baseName` (e.g. `"Sanctuary"`)
   - Update the 18 `palette` hex/color tokens (`sandLight`, `sandMid`, `sandDeep`, `duneShadow`, `oasisWater`, `oasisShallow`, `oasisFoliage`, `relicCore`, `relicGlow`, `buggyPrimary`, `buggyAccent`, `boostFlame`, `stormWall`, `stormDanger`, `uiBg`, `uiBorder`, `uiText`, `uiAccent`) to match brand art direction.
2. **Swap the Collectible Silhouette in [`src/renderer.ts`](src/renderer.ts)**:
   - Replace `drawCrystal(x, y, radius, rot, pulse)` (used for both the ground relic and carried rear-rack icon) with your custom Canvas 2D perfume bottle/flacon silhouette and brand crest/logo mark.

## Architecture
- `src/types.ts` & `src/config.ts`: Shared TypeScript contracts, `DEFAULT_CONFIG`, and centralized `BRAND_THEME`.
- `src/map.ts`: Central oasis, 12 authored rock obstacles, 16 validated relic spawns, proportional spawn safety buffer, and inner fallback spawn `(0, -165)`.
- `src/simulation.ts`: Pure deterministic `120 Hz` fixed-timestep engine (`FIXED_DT = 1/120`, render-schedule invariant across 30/60/120 FPS).
- `src/persistence.ts`: Safe `localStorage` persistence for `dune_relay_best_score` and `dune_relay_muted`.
- `src/audio.ts`: Procedural Web Audio synthesizer with gesture-gated unlock and pause/mute suspension.
- `src/renderer.ts`: Canvas 2D desert renderer with offscreen static world cache, fast storm annulus bands, adaptive DPR cap, and `prefers-reduced-motion` support.
- `src/input.ts`, `src/ui.ts`, `src/styles.css`, `src/main.ts`: Multi-pointer touch + keyboard controller, `#ui-layer` HUD/modals, responsive layouts, and `requestAnimationFrame` loop.
- `tests/simulation.test.ts`: Vitest verification suite (`13/13` passing).

## Documentation
- [docs/SPEC.md](docs/SPEC.md) — Game & simulation specification
- [docs/QA.md](docs/QA.md) — Test results, browser checks, and verification sign-off
- [docs/EVALUATION.md](docs/EVALUATION.md) — Honest multi-dimensional quality evaluation
- [docs/SESSION_STATE.md](docs/SESSION_STATE.md) — Project status, model history, and session handoff
