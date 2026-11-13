import type { SimulationState } from './types';

export interface AudioController {
  /** Creates / resumes the AudioContext. Call from a user-gesture handler (keydown, pointerdown, click). */
  unlock: () => void;
  setMuted: (muted: boolean) => void;
  isMuted: () => boolean;
  /** Toggles mute and returns the new muted state. */
  toggleMuted: () => boolean;
  setPaused: (paused: boolean) => void;
  /** Call once per frame with the latest state; plays one-shot cues for new events. */
  syncState: (state: SimulationState) => void;
  destroy: () => void;
}

type AudioContextCtor = typeof AudioContext;

interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: AudioContextCtor;
}

const MASTER_GAIN = 0.55;
const LOW_BOOST_THRESHOLD = 15;
const LOW_BOOST_INTERVAL = 0.8;
/** After a run ends, keep the context alive briefly so the final impact / fanfare can ring out. */
const RESULTS_TAIL_MS = 1600;

export function createAudioController(initialMuted: boolean): AudioController {
  let muted = initialMuted;
  let paused = false;
  let destroyed = false;

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let suspendTimer: number | null = null;
  let lastPhase: SimulationState['phase'] = 'title';

  // Event bookkeeping (null = nothing seen yet in this run)
  let seenPickup: number | null = null;
  let seenDelivery: number | null = null;
  let seenCollision: number | null = null;
  let primed = false;
  let prevBoosting = false;
  let lastLowBoostAt = -Infinity;

  // ------------------------------------------------------------------ context

  function safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // Blocked / unavailable audio must never break the game.
    }
  }

  function clearSuspendTimer(): void {
    if (suspendTimer !== null) {
      window.clearTimeout(suspendTimer);
      suspendTimer = null;
    }
  }

  function wantsRunning(): boolean {
    return !muted && !paused && lastPhase === 'playing';
  }

  /** Brings the context's running/suspended state in line with mute / pause / phase. */
  function applyRunState(): void {
    if (!ctx || destroyed) return;
    const c = ctx;
    safe(() => {
      if (master) master.gain.value = muted ? 0 : MASTER_GAIN;
    });
    clearSuspendTimer();
    if (wantsRunning()) {
      safe(() => {
        void c.resume().catch(() => undefined);
      });
      return;
    }
    const tail = !muted && !paused && lastPhase === 'results';
    if (tail) {
      suspendTimer = window.setTimeout(() => {
        suspendTimer = null;
        safe(() => {
          void c.suspend().catch(() => undefined);
        });
      }, RESULTS_TAIL_MS);
      return;
    }
    safe(() => {
      void c.suspend().catch(() => undefined);
    });
  }

  function unlock(): void {
    if (destroyed) return;
    safe(() => {
      if (!ctx) {
        const w = window as WindowWithWebkitAudio;
        const Ctor: AudioContextCtor | undefined = window.AudioContext ?? w.webkitAudioContext;
        if (!Ctor) return;
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : MASTER_GAIN;
        master.connect(ctx.destination);

        // One second of white noise, reused by every noise-based cue.
        const length = ctx.sampleRate;
        noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        let seed = 0x9e3779b9;
        for (let i = 0; i < length; i++) {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          data[i] = ((seed >>> 0) / 4294967296) * 2 - 1;
        }
      }
      // A first gesture while paused/muted should still unlock, then settle back.
      if (wantsRunning()) {
        void ctx.resume().catch(() => undefined);
      } else if (ctx.state === 'suspended') {
        // Resume once so the browser marks audio as allowed, then re-apply our state.
        void ctx
          .resume()
          .then(() => applyRunState())
          .catch(() => undefined);
      }
    });
  }

  // ------------------------------------------------------------------ synthesis

  function ready(): { c: AudioContext; out: GainNode } | null {
    if (!ctx || !master || destroyed || muted || paused) return null;
    if (ctx.state !== 'running') return null;
    return { c: ctx, out: master };
  }

  function tone(
    freq: number,
    start: number,
    duration: number,
    type: OscillatorType,
    peak: number,
    endFreq?: number,
    attack = 0.008,
  ): void {
    const r = ready();
    if (!r) return;
    const { c, out } = r;
    const t0 = c.currentTime + start;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t0 + duration);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(out);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  function noise(
    start: number,
    duration: number,
    filterType: BiquadFilterType,
    freq: number,
    endFreq: number,
    peak: number,
    q = 0.8,
  ): void {
    const r = ready();
    if (!r || !noiseBuffer) return;
    const { c, out } = r;
    const t0 = c.currentTime + start;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = filterType;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + duration);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    src.start(t0);
    src.stop(t0 + duration + 0.05);
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  function playPickup(): void {
    // Bright ascending crystal arpeggio with a glassy shimmer on top.
    const notes = [880, 1108.73, 1318.51, 1760];
    notes.forEach((f, i) => {
      tone(f, i * 0.07, 0.34, 'sine', 0.2);
      tone(f * 2, i * 0.07, 0.2, 'triangle', 0.05);
    });
    tone(3520, 0.28, 0.45, 'sine', 0.05, 3000);
  }

  function playDelivery(): void {
    // Warm two-step fanfare: C major lifts into a sustained G-based chord.
    const first = [523.25, 659.25, 783.99];
    for (const f of first) {
      tone(f, 0, 0.45, 'triangle', 0.16);
      tone(f / 2, 0, 0.45, 'sine', 0.08);
    }
    const second = [783.99, 987.77, 1174.66, 1567.98];
    for (const f of second) {
      tone(f, 0.2, 1.0, 'triangle', 0.14, undefined, 0.02);
      tone(f * 2, 0.2, 0.7, 'sine', 0.04);
    }
    tone(261.63, 0.2, 1.0, 'sine', 0.12);
  }

  function playImpact(impactSpeed: number): void {
    const k = Math.min(1, Math.max(0.3, impactSpeed / 300));
    noise(0, 0.28, 'lowpass', 1100, 160, 0.55 * k, 0.7);
    tone(96, 0, 0.32, 'sine', 0.6 * k, 38);
    tone(180, 0, 0.1, 'square', 0.08 * k, 70);
  }

  function playBoostIgnition(): void {
    noise(0, 0.38, 'bandpass', 320, 2400, 0.32, 1.1);
    tone(90, 0, 0.36, 'sawtooth', 0.1, 260);
  }

  function playLowBoostPulse(): void {
    tone(330, 0, 0.12, 'triangle', 0.1, 260);
  }

  // ------------------------------------------------------------------ state sync

  function syncState(state: SimulationState): void {
    if (destroyed) return;

    if (state.phase !== lastPhase) {
      lastPhase = state.phase;
      applyRunState();
    }

    const pickupTime = state.lastPickup ? state.lastPickup.time : null;
    const deliveryTime = state.lastDelivery ? state.lastDelivery.time : null;
    const collisionTime = state.lastCollision ? state.lastCollision.time : null;
    const boosting = state.buggy.isBoosting && state.phase === 'playing';

    // First sync only records what already exists so nothing stale is replayed.
    if (!primed) {
      primed = true;
      seenPickup = pickupTime;
      seenDelivery = deliveryTime;
      seenCollision = collisionTime;
      prevBoosting = boosting;
      return;
    }

    const live = state.phase === 'playing' || state.phase === 'results';

    if (pickupTime === null) {
      seenPickup = null;
    } else if (pickupTime !== seenPickup) {
      seenPickup = pickupTime;
      if (live) safe(playPickup);
    }

    if (deliveryTime === null) {
      seenDelivery = null;
    } else if (deliveryTime !== seenDelivery) {
      seenDelivery = deliveryTime;
      if (live) safe(playDelivery);
    }

    if (collisionTime === null) {
      seenCollision = null;
    } else if (collisionTime !== seenCollision) {
      seenCollision = collisionTime;
      if (live && state.lastCollision) {
        const speed = state.lastCollision.impactSpeed;
        safe(() => playImpact(speed));
      }
    }

    if (boosting && !prevBoosting) safe(playBoostIgnition);
    prevBoosting = boosting;

    if (state.phase === 'playing' && state.buggy.isBoosting && state.boost < LOW_BOOST_THRESHOLD && ctx) {
      const now = ctx.currentTime;
      if (now - lastLowBoostAt >= LOW_BOOST_INTERVAL) {
        lastLowBoostAt = now;
        safe(playLowBoostPulse);
      }
    }
  }

  return {
    unlock,
    setMuted: (next: boolean) => {
      muted = next;
      applyRunState();
    },
    isMuted: () => muted,
    toggleMuted: () => {
      muted = !muted;
      applyRunState();
      return muted;
    },
    setPaused: (next: boolean) => {
      paused = next;
      applyRunState();
    },
    syncState,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      clearSuspendTimer();
      const c = ctx;
      ctx = null;
      master = null;
      noiseBuffer = null;
      if (c) {
        safe(() => {
          void c.close().catch(() => undefined);
        });
      }
    },
  };
}
