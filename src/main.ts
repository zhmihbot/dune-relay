import './styles.css';
import { createAudioController } from './audio';
import { DEFAULT_CONFIG } from './config';
import { createInputController } from './input';
import {
  loadBestScore,
  loadMutedPreference,
  saveBestScore,
  saveMutedPreference,
} from './persistence';
import { createRenderer } from './renderer';
import {
  advanceSimulation,
  createInitialState,
  pauseRun,
  resumeRun,
  startRun,
} from './simulation';
import type { SimulationState } from './types';
import { initUI } from './ui';

function boot(): void {
  const canvas = document.getElementById('game-canvas');
  const uiRoot = document.getElementById('ui-layer');
  if (!(canvas instanceof HTMLCanvasElement) || !uiRoot) {
    throw new Error('DUNE RELAY: #game-canvas or #ui-layer is missing from index.html');
  }

  let state: SimulationState = createInitialState(loadBestScore(), DEFAULT_CONFIG);
  let savedBest = state.bestScore;
  let lastTimestamp: number | null = null;

  const renderer = createRenderer(canvas, DEFAULT_CONFIG);
  const audio = createAudioController(loadMutedPreference());

  /** Drops frame-time continuity so paused / hidden / restarted time never becomes a catch-up step. */
  const resetClock = (): void => {
    lastTimestamp = null;
  };

  const persistBest = (): void => {
    if (state.bestScore > savedBest) {
      // Even if storage is unavailable, remember in-memory so we do not retry every frame.
      saveBestScore(state.bestScore);
      savedBest = state.bestScore;
    }
  };

  function toggleMute(): void {
    const muted = audio.toggleMuted();
    saveMutedPreference(muted);
    ui.setMuted(muted);
  }

  const input = createInputController({
    getPhase: () => state.phase,
    onTogglePause: () => togglePause(),
    onToggleMute: () => toggleMute(),
    onConfirm: () => {
      if (state.phase === 'title' || state.phase === 'results') beginRun();
    },
    onAutoPause: () => {
      resetClock();
      if (state.phase === 'playing') {
        state = pauseRun(state);
        audio.setPaused(true);
      }
    },
  });

  /** Keeps the audio controller's pause flag and phase in step with `state` right away. */
  function syncAudioNow(): void {
    audio.setPaused(state.phase === 'paused');
    audio.syncState(state);
  }

  function beginRun(): void {
    state = startRun(state, DEFAULT_CONFIG);
    input.clearHeldKeys();
    resetClock();
    // Still inside the user gesture: lets the AudioContext resume immediately.
    syncAudioNow();
  }

  function togglePause(): void {
    if (state.phase === 'playing') {
      state = pauseRun(state);
    } else if (state.phase === 'paused') {
      state = resumeRun(state);
    } else {
      return;
    }
    input.clearHeldKeys();
    resetClock();
    syncAudioNow();
  }

  function resume(): void {
    if (state.phase === 'paused') {
      state = resumeRun(state);
      input.clearHeldKeys();
      resetClock();
      syncAudioNow();
    }
  }

  function restart(): void {
    if (state.phase === 'paused' || state.phase === 'results') beginRun();
  }

  const ui = initUI(uiRoot, {
    onStart: () => {
      if (state.phase === 'title' || state.phase === 'results') beginRun();
    },
    onResume: resume,
    onRestart: restart,
    onPause: () => {
      if (state.phase === 'playing') togglePause();
    },
    onToggleMute: toggleMute,
  });
  ui.setMuted(audio.isMuted());
  input.bindTouchControls(ui.getTouchElements());

  // Browsers only allow audio after a user gesture; unlock() is idempotent and never throws.
  const unlockAudio = (): void => audio.unlock();
  window.addEventListener('keydown', unlockAudio, true);
  window.addEventListener('pointerdown', unlockAudio, true);

  let rafId = 0;
  let audioPausedFlag = false;
  function frame(timestamp: number): void {
    rafId = requestAnimationFrame(frame);

    const frameDeltaSeconds =
      lastTimestamp === null ? 0 : Math.max(0, (timestamp - lastTimestamp) / 1000);
    lastTimestamp = timestamp;

    const previousPhase = state.phase;
    if (state.phase === 'playing') {
      state = advanceSimulation(state, input.getInputState(), frameDeltaSeconds, DEFAULT_CONFIG);
      if (previousPhase === 'playing' && state.phase === 'results') {
        input.clearHeldKeys();
      }
    }
    persistBest();

    const paused = state.phase === 'paused';
    if (paused !== audioPausedFlag) {
      audioPausedFlag = paused;
      audio.setPaused(paused);
    }
    audio.syncState(state);

    renderer.render(state, frameDeltaSeconds);
    ui.update(state);
  }

  rafId = requestAnimationFrame(frame);

  window.addEventListener('pagehide', (event) => {
    persistBest();
    // Page entering the back/forward cache may come back; keep everything alive.
    if (event.persisted) return;
    cancelAnimationFrame(rafId);
    window.removeEventListener('keydown', unlockAudio, true);
    window.removeEventListener('pointerdown', unlockAudio, true);
    input.destroy();
    renderer.destroy();
    audio.destroy();
  });
}

boot();
