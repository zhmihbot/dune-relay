# AGENTS.md — DUNE RELAY Workspace Guide

> **MANDATORY FIRST STEP FOR NEW CONVERSATIONS:**
> Always read [`docs/SESSION_STATE.md`](docs/SESSION_STATE.md) first before making edits or running commands, followed by [`docs/SPEC.md`](docs/SPEC.md).

---

## Environment & Commands (Windows PowerShell)
PowerShell's ExecutionPolicy blocks `npm.ps1` and `npx.ps1`. **Always invoke `npm.cmd` and `npx.cmd`** (never bare `npm` or `npx`).

- **Install dependencies**: `npm.cmd install`
- **Dev server**: `npm.cmd run dev`
- **Typecheck**: `npm.cmd run typecheck`
- **Unit tests**: `npm.cmd run test`
- **Production build**: `npm.cmd run build`
- **Preview build**: `npm.cmd run preview`

`git` is not available on `PATH` in this environment; track progress via `docs/SESSION_STATE.md` and verified file checkpoints.

---

## Module Ownership & Architecture Rules
Respect strict file ownership to prevent merge conflicts or overwritten work:

1. **Configuration, Scaffolding & Docs (`setup`)**:
   - `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `docs/*`, `AGENTS.md`, `README.md`
2. **Core Simulation & Contracts (`arch-sim`)**:
   - `src/types.ts`, `src/config.ts`, `src/map.ts`, `src/persistence.ts`, `src/simulation.ts`, `tests/simulation.test.ts`
   - **Rule**: `src/simulation.ts` MUST stay pure and deterministic (`FIXED_DT = 1/120`). Never read DOM, `window`, `performance.now()`, or `Math.random()` inside simulation modules.
3. **Rendering, Input & UI (`ui-render`)**:
   - `src/renderer.ts`, `src/input.ts`, `src/ui.ts`, `src/styles.css`, `src/main.ts`
   - **Rule**: Render and UI layers consume `SimulationState` from `src/simulation.ts` and shared types from `src/types.ts` without duplicating physics or game rules.

---

## Verification Gate
Before marking any phase complete, run:
```powershell
npm.cmd run typecheck
npm.cmd run test
npm.cmd run build
```
(During Phase A before `src/main.ts` exists, `typecheck` and `test` validate the simulation layer; `build` also passes once Phase B adds `src/main.ts` or all referenced modules.)
