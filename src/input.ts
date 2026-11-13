import type { GamePhase, InputState } from './types';

export interface InputCallbacks {
  /** Current game phase; used to decide when Enter / Space should be consumed. */
  getPhase: () => GamePhase;
  /** Escape / P pressed: pause when playing, resume when paused. */
  onTogglePause: () => void;
  /** M pressed: toggle audio mute. */
  onToggleMute?: () => void;
  /** Enter pressed while on the title or results screen: start / restart a run. */
  onConfirm: () => void;
  /**
   * Window blur or tab hidden. The listener has already cleared held input;
   * the owner should pause an active run and reset its frame timer.
   */
  onAutoPause: () => void;
}

export interface TouchControlElements {
  joystickZone: HTMLElement;
  joystickThumb: HTMLElement;
  brakeBtn: HTMLElement;
  boostBtn: HTMLElement;
}

export interface InputController {
  /** Returns a snapshot of the current held input (fresh object each call). */
  getInputState: () => InputState;
  /** Releases every held key and touch pointer (throttle/steer 0, brake/boost false). */
  clearHeldKeys: () => void;
  /** Wires the on-screen joystick and Drift / Boost buttons. Re-binding replaces the old binding. */
  bindTouchControls: (elements: TouchControlElements) => void;
  /** Removes every listener registered by this controller. Safe to call twice. */
  destroy: () => void;
}

const UP = new Set(['KeyW', 'ArrowUp']);
const DOWN = new Set(['KeyS', 'ArrowDown']);
const LEFT = new Set(['KeyA', 'ArrowLeft']);
const RIGHT = new Set(['KeyD', 'ArrowRight']);
const BRAKE = new Set(['ControlLeft', 'ControlRight', 'KeyB', 'KeyC']);
const BOOST = new Set(['ShiftLeft', 'ShiftRight', 'Space']);
const PAUSE_KEYS = new Set(['Escape', 'KeyP']);

const JOYSTICK_MAX_RADIUS = 46;
const JOYSTICK_DEADZONE = 0.12;

function isDriveKey(code: string): boolean {
  return (
    UP.has(code) ||
    DOWN.has(code) ||
    LEFT.has(code) ||
    RIGHT.has(code) ||
    BRAKE.has(code) ||
    BOOST.has(code)
  );
}

function isCtrlKey(code: string): boolean {
  return code === 'ControlLeft' || code === 'ControlRight';
}

function anyHeld(held: Set<string>, keys: Set<string>): boolean {
  for (const code of keys) {
    if (held.has(code)) return true;
  }
  return false;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createInputController(callbacks: InputCallbacks): InputController {
  const held = new Set<string>();
  let destroyed = false;

  // --- touch state ---
  let touchEls: TouchControlElements | null = null;
  let joystickPointerId: number | null = null;
  let joyX = 0;
  let joyY = 0;
  const brakePointerIds = new Set<number>();
  const boostPointerIds = new Set<number>();
  let unbindTouch: (() => void) | null = null;

  const resetJoystickVisual = (): void => {
    if (!touchEls) return;
    touchEls.joystickThumb.style.transform = 'translate3d(0px, 0px, 0)';
    touchEls.joystickZone.classList.remove('is-active');
  };

  const clearHeldKeys = (): void => {
    held.clear();
    joystickPointerId = null;
    joyX = 0;
    joyY = 0;
    brakePointerIds.clear();
    boostPointerIds.clear();
    resetJoystickVisual();
    if (touchEls) {
      touchEls.brakeBtn.classList.remove('is-active');
      touchEls.boostBtn.classList.remove('is-active');
    }
  };

  const getInputState = (): InputState => {
    let kbX = (anyHeld(held, RIGHT) ? 1 : 0) - (anyHeld(held, LEFT) ? 1 : 0);
    let kbY = (anyHeld(held, DOWN) ? 1 : 0) - (anyHeld(held, UP) ? 1 : 0);
    if (kbX !== 0 || kbY !== 0) {
      const len = Math.hypot(kbX, kbY);
      kbX /= len;
      kbY /= len;
    }

    const useKeyboard = kbX !== 0 || kbY !== 0;
    const moveX = useKeyboard ? kbX : joyX;
    const moveY = useKeyboard ? kbY : joyY;

    return {
      moveX,
      moveY,
      throttle: clamp(Math.hypot(moveX, moveY), 0, 1),
      steer: 0,
      brake: anyHeld(held, BRAKE) || brakePointerIds.size > 0,
      boost: anyHeld(held, BOOST) || boostPointerIds.size > 0,
    };
  };

  // ------------------------------------------------------------------ keyboard

  const onKeyDown = (event: KeyboardEvent): void => {
    const code = event.code;
    const phase = callbacks.getPhase();

    if (isDriveKey(code)) {
      // Ctrl is a brake key, so while driving Ctrl+<letter> must still steer / accelerate.
      // Meta / Alt combos are always left to the browser; outside a run so is Ctrl+<letter>.
      if (event.metaKey || event.altKey) return;
      if (event.ctrlKey && !isCtrlKey(code) && phase !== 'playing') return;
      held.add(code);
      // Stop page scroll, Space activating a focused button, and browser shortcuts mid-run.
      if (phase === 'playing' || code.startsWith('Arrow')) {
        event.preventDefault();
      }
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (PAUSE_KEYS.has(code)) {
      event.preventDefault();
      if (!event.repeat) callbacks.onTogglePause();
      return;
    }

    if (code === 'KeyM') {
      if (!event.repeat && callbacks.onToggleMute) callbacks.onToggleMute();
      return;
    }

    if (code === 'Enter' || code === 'NumpadEnter') {
      if (phase === 'title' || phase === 'results') {
        // Consume so a focused button does not also fire its click handler.
        event.preventDefault();
        if (!event.repeat) callbacks.onConfirm();
      }
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (isDriveKey(event.code)) {
      held.delete(event.code);
      if (event.code === 'Space' && callbacks.getPhase() === 'playing') {
        event.preventDefault();
      }
    }
  };

  const onBlur = (): void => {
    clearHeldKeys();
    callbacks.onAutoPause();
  };

  const onVisibilityChange = (): void => {
    if (document.hidden) {
      clearHeldKeys();
      callbacks.onAutoPause();
    }
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);

  // --------------------------------------------------------------------- touch

  function bindTouchControls(elements: TouchControlElements): void {
    if (destroyed) return;
    if (unbindTouch) unbindTouch();
    clearHeldKeys();
    touchEls = elements;
    const { joystickZone, joystickThumb, brakeBtn, boostBtn } = elements;

    const updateJoystick = (event: PointerEvent): void => {
      const rect = joystickZone.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dx = event.clientX - cx;
      let dy = event.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > JOYSTICK_MAX_RADIUS) {
        dx = (dx / len) * JOYSTICK_MAX_RADIUS;
        dy = (dy / len) * JOYSTICK_MAX_RADIUS;
      }
      joystickThumb.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
      joystickZone.classList.add('is-active');

      const nx = dx / JOYSTICK_MAX_RADIUS;
      const ny = dy / JOYSTICK_MAX_RADIUS;
      const rawMag = Math.hypot(nx, ny);
      if (rawMag < JOYSTICK_DEADZONE) {
        joyX = 0;
        joyY = 0;
        return;
      }
      const scaledMag = clamp((rawMag - JOYSTICK_DEADZONE) / (1 - JOYSTICK_DEADZONE), 0, 1);
      joyX = (nx / rawMag) * scaledMag;
      joyY = (ny / rawMag) * scaledMag;
    };

    const releaseJoystick = (): void => {
      joystickPointerId = null;
      joyX = 0;
      joyY = 0;
      resetJoystickVisual();
    };

    const capture = (el: HTMLElement, id: number): void => {
      try {
        el.setPointerCapture(id);
      } catch {
        // Synthetic / unsupported pointers: tracking still works without capture.
      }
    };

    const onJoyDown = (e: PointerEvent): void => {
      e.preventDefault();
      if (joystickPointerId !== null) return;
      joystickPointerId = e.pointerId;
      capture(joystickZone, e.pointerId);
      updateJoystick(e);
    };
    const onJoyMove = (e: PointerEvent): void => {
      if (e.pointerId !== joystickPointerId) return;
      e.preventDefault();
      updateJoystick(e);
    };
    const onJoyEnd = (e: PointerEvent): void => {
      if (e.pointerId !== joystickPointerId) return;
      e.preventDefault();
      releaseJoystick();
    };

    const makeButtonHandlers = (
      el: HTMLElement,
      ids: Set<number>,
    ): { down: (e: PointerEvent) => void; up: (e: PointerEvent) => void } => ({
      down: (e: PointerEvent): void => {
        e.preventDefault();
        ids.add(e.pointerId);
        capture(el, e.pointerId);
        el.classList.add('is-active');
      },
      up: (e: PointerEvent): void => {
        if (!ids.has(e.pointerId)) return;
        e.preventDefault();
        ids.delete(e.pointerId);
        if (ids.size === 0) el.classList.remove('is-active');
      },
    });
    const brakeHandlers = makeButtonHandlers(brakeBtn, brakePointerIds);
    const boostHandlers = makeButtonHandlers(boostBtn, boostPointerIds);

    const stop = (e: Event): void => e.preventDefault();

    const registrations: Array<[HTMLElement, string, EventListener]> = [
      [joystickZone, 'pointerdown', onJoyDown as EventListener],
      [joystickZone, 'pointermove', onJoyMove as EventListener],
      [joystickZone, 'pointerup', onJoyEnd as EventListener],
      [joystickZone, 'pointercancel', onJoyEnd as EventListener],
      [joystickZone, 'lostpointercapture', onJoyEnd as EventListener],
      [joystickZone, 'contextmenu', stop],
      [brakeBtn, 'pointerdown', brakeHandlers.down as EventListener],
      [brakeBtn, 'pointerup', brakeHandlers.up as EventListener],
      [brakeBtn, 'pointercancel', brakeHandlers.up as EventListener],
      [brakeBtn, 'lostpointercapture', brakeHandlers.up as EventListener],
      [brakeBtn, 'contextmenu', stop],
      [boostBtn, 'pointerdown', boostHandlers.down as EventListener],
      [boostBtn, 'pointerup', boostHandlers.up as EventListener],
      [boostBtn, 'pointercancel', boostHandlers.up as EventListener],
      [boostBtn, 'lostpointercapture', boostHandlers.up as EventListener],
      [boostBtn, 'contextmenu', stop],
    ];
    for (const [el, type, handler] of registrations) {
      el.addEventListener(type, handler);
    }

    unbindTouch = () => {
      for (const [el, type, handler] of registrations) {
        el.removeEventListener(type, handler);
      }
      clearHeldKeys();
      touchEls = null;
      unbindTouch = null;
    };
  }

  return {
    getInputState,
    clearHeldKeys,
    bindTouchControls,
    destroy: () => {
      if (destroyed) return;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (unbindTouch) unbindTouch();
      clearHeldKeys();
      destroyed = true;
    },
  };
}
