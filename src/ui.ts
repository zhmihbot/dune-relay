import { BRAND_THEME, DEFAULT_CONFIG } from './config';
import type { TouchControlElements } from './input';
import type { GamePhase, SimulationState } from './types';

export interface UICallbacks {
  onStart: () => void;
  onResume: () => void;
  onRestart: () => void;
  /** HUD Pause button. */
  onPause: () => void;
  /** HUD / title Sound button. */
  onToggleMute: () => void;
}

export interface UI {
  update: (state: SimulationState) => void;
  /** Syncs both Sound buttons (label + aria-pressed) with the mute state. */
  setMuted: (muted: boolean) => void;
  /** Elements to hand to `input.bindTouchControls`. */
  getTouchElements: () => TouchControlElements;
  destroy: () => void;
}

const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** How long (sim seconds) the "RELIC DELIVERED" banner stays up. */
const DELIVERED_BANNER_SECONDS = 1.3;

interface ControlRow {
  keys: string[];
  label: string;
}

const CONTROLS: ControlRow[] = [
  { keys: ['W', 'A', 'S', 'D'], label: 'Steer & Drive  (or Arrow Keys)' },
  { keys: ['Space', 'Shift'], label: 'Boost' },
  { keys: ['Ctrl', 'B'], label: 'Brake / Drift' },
  { keys: ['Esc', 'P'], label: 'Pause' },
  { keys: ['M'], label: 'Mute sound' },
  { keys: ['Touch'], label: 'Joystick direction + Drift / Boost' },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildControlsGuide(): HTMLElement {
  const wrap = el('div', 'controls');
  wrap.appendChild(el('h3', 'controls-title', 'Controls'));
  const list = el('ul', 'controls-list');
  for (const row of CONTROLS) {
    const li = el('li');
    const keys = el('span', 'controls-keys');
    row.keys.forEach((k, i) => {
      if (i > 0) keys.appendChild(document.createTextNode(' '));
      keys.appendChild(el('kbd', undefined, k));
    });
    li.appendChild(keys);
    li.appendChild(el('span', 'controls-label', row.label));
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

function formatTime(seconds: number): string {
  const tenthsTotal = Math.max(0, Math.ceil(seconds * 10 - 1e-6));
  const minutes = Math.floor(tenthsTotal / 600);
  const secs = Math.floor((tenthsTotal % 600) / 10);
  const tenths = tenthsTotal % 10;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

/** Returns a setter that only touches the DOM when the value changes. */
function textSetter(node: HTMLElement): (value: string) => void {
  let last: string | null = null;
  return (value: string) => {
    if (value !== last) {
      last = value;
      node.textContent = value;
    }
  };
}

function classSetter(node: HTMLElement, className: string): (on: boolean) => void {
  let last: boolean | null = null;
  return (on: boolean) => {
    if (on !== last) {
      last = on;
      node.classList.toggle(className, on);
    }
  };
}

function hiddenSetter(node: HTMLElement): (hidden: boolean) => void {
  let last: boolean | null = null;
  return (hidden: boolean) => {
    if (hidden !== last) {
      last = hidden;
      node.hidden = hidden;
    }
  };
}

function gauge(
  labelText: string,
  modifier: string,
): { root: HTMLElement; fill: HTMLElement; value: HTMLElement } {
  const root = el('div', `gauge gauge-${modifier}`);
  const head = el('div', 'gauge-head');
  head.appendChild(el('span', 'hud-label', labelText));
  const value = el('span', 'gauge-value', '100');
  head.appendChild(value);
  const track = el('div', 'gauge-track');
  const fill = el('div', 'gauge-fill');
  track.appendChild(fill);
  root.appendChild(head);
  root.appendChild(track);
  return { root, fill, value };
}

export function initUI(root: HTMLElement, callbacks: UICallbacks): UI {
  root.textContent = '';
  root.classList.add('ui-root');

  const cleanups: Array<() => void> = [];
  const onClick = (node: HTMLElement, handler: () => void): void => {
    const listener = (): void => {
      node.blur();
      handler();
    };
    node.addEventListener('click', listener);
    cleanups.push(() => node.removeEventListener('click', listener));
  };

  // ---------------------------------------------------------------- HUD
  const hud = el('div', 'hud');
  hud.id = 'hud';
  hud.setAttribute('aria-live', 'off');

  const top = el('div', 'hud-top');

  const timePanel = el('div', 'hud-panel hud-time');
  timePanel.appendChild(el('span', 'hud-label', 'Time'));
  const timeValue = el('span', 'hud-time-value', '01:30.0');
  timeValue.id = 'hud-time';
  timePanel.appendChild(timeValue);

  const center = el('div', 'hud-center');
  const carryBadge = el('div', 'carry-badge', 'SEEKING RELIC');
  carryBadge.id = 'hud-carry';
  const objective = el('div', 'objective');
  const arrow = el('span', 'compass-arrow');
  arrow.setAttribute('aria-hidden', 'true');
  const objDir = el('span', 'objective-dir', 'N');
  objDir.id = 'hud-direction';
  const objDist = el('span', 'objective-dist', '0 m');
  objDist.id = 'hud-distance';
  objective.appendChild(arrow);
  objective.appendChild(objDir);
  objective.appendChild(objDist);

  const tools = el('div', 'hud-tools');
  const pauseBtn = el('button', 'hud-btn', 'Pause');
  pauseBtn.id = 'hud-pause-btn';
  pauseBtn.type = 'button';
  pauseBtn.setAttribute('aria-label', 'Pause run');
  const muteBtn = el('button', 'hud-btn', 'Sound: ON');
  muteBtn.id = 'hud-mute-btn';
  muteBtn.type = 'button';
  muteBtn.setAttribute('aria-pressed', 'true');
  muteBtn.setAttribute('aria-label', 'Toggle sound');
  tools.appendChild(pauseBtn);
  tools.appendChild(muteBtn);

  const subrow = el('div', 'hud-subrow');
  subrow.appendChild(objective);
  subrow.appendChild(tools);
  center.appendChild(carryBadge);
  center.appendChild(subrow);

  const scorePanel = el('div', 'hud-panel hud-score');
  const scoreRow = el('div', 'score-main');
  scoreRow.appendChild(el('span', 'hud-label', 'Score'));
  const scoreValue = el('span', 'hud-score-value', '0');
  scoreValue.id = 'hud-score';
  scoreRow.appendChild(scoreValue);
  const metaRow = el('div', 'score-meta');
  const deliveriesWrap = el('span');
  deliveriesWrap.appendChild(el('span', 'hud-label', 'Deliveries '));
  const deliveriesValue = el('b', undefined, '0');
  deliveriesValue.id = 'hud-deliveries';
  deliveriesWrap.appendChild(deliveriesValue);
  const bestWrap = el('span');
  bestWrap.appendChild(el('span', 'hud-label', 'Best '));
  const bestValue = el('b', undefined, '0');
  bestValue.id = 'hud-best';
  bestWrap.appendChild(bestValue);
  metaRow.appendChild(deliveriesWrap);
  metaRow.appendChild(bestWrap);
  scorePanel.appendChild(scoreRow);
  scorePanel.appendChild(metaRow);

  top.appendChild(timePanel);
  top.appendChild(center);
  top.appendChild(scorePanel);

  const banners = el('div', 'hud-banners');
  banners.setAttribute('aria-live', 'polite');
  const slowBanner = el('div', 'banner banner-slow', 'Slow down to deliver');
  slowBanner.id = 'banner-slow';
  slowBanner.hidden = true;
  const stormBanner = el('div', 'banner banner-storm', 'WARNING: OUTSIDE SAFE ZONE — HULL DRAINING');
  stormBanner.id = 'banner-storm';
  stormBanner.hidden = true;
  banners.appendChild(slowBanner);
  banners.appendChild(stormBanner);
  const deliveredBanner = el(
    'div',
    'banner banner-delivered',
    `RELIC DELIVERED +${DEFAULT_CONFIG.deliveryScore}`,
  );
  deliveredBanner.id = 'banner-delivered';
  deliveredBanner.hidden = true;
  banners.appendChild(deliveredBanner);

  const bottom = el('div', 'hud-bottom hud-panel');
  const hull = gauge('Hull', 'hull');
  const boost = gauge('Boost', 'boost');
  hull.value.id = 'hud-hull';
  boost.value.id = 'hud-boost';
  bottom.appendChild(hull.root);
  bottom.appendChild(boost.root);

  hud.appendChild(top);
  hud.appendChild(banners);
  hud.appendChild(bottom);

  // ------------------------------------------------------- Touch controls
  const touch = el('div', 'touch-controls');
  touch.id = 'touch-controls';
  touch.hidden = true;
  const joystick = el('div', 'touch-joystick');
  joystick.id = 'touch-joystick';
  joystick.setAttribute('role', 'group');
  joystick.setAttribute('aria-label', 'Drive joystick');
  const joystickBase = el('div', 'touch-joystick-base');
  joystickBase.id = 'touch-joystick-base';
  const joystickThumb = el('div', 'touch-joystick-thumb');
  joystickThumb.id = 'touch-joystick-thumb';
  joystick.appendChild(joystickBase);
  joystick.appendChild(joystickThumb);
  const actions = el('div', 'touch-actions');
  actions.id = 'touch-actions';
  const touchBoost = el('button', 'touch-btn touch-btn-boost', 'BOOST');
  touchBoost.id = 'touch-boost';
  touchBoost.type = 'button';
  touchBoost.tabIndex = -1;
  const touchBrake = el('button', 'touch-btn touch-btn-brake', 'DRIFT / BRAKE');
  touchBrake.id = 'touch-brake';
  touchBrake.type = 'button';
  touchBrake.tabIndex = -1;
  actions.appendChild(touchBoost);
  actions.appendChild(touchBrake);
  touch.appendChild(joystick);
  touch.appendChild(actions);

  // -------------------------------------------------------------- Title
  const title = el('section', 'overlay overlay-title');
  title.id = 'title-screen';
  title.setAttribute('role', 'dialog');
  title.setAttribute('aria-labelledby', 'title-heading');
  const titleCard = el('div', 'card card-title');
  titleCard.appendChild(el('p', 'eyebrow', BRAND_THEME.eyebrow));
  const heading = el('h1', 'game-title', BRAND_THEME.title);
  heading.id = 'title-heading';
  titleCard.appendChild(heading);
  titleCard.appendChild(el('p', 'premise', BRAND_THEME.subtitle));
  const titleBest = el('p', 'best-line');
  titleBest.appendChild(el('span', 'hud-label', 'Best Score '));
  const titleBestValue = el('b', undefined, '0');
  titleBestValue.id = 'title-best';
  titleBest.appendChild(titleBestValue);
  titleCard.appendChild(titleBest);
  titleCard.appendChild(buildControlsGuide());
  const startBtn = el('button', 'btn btn-primary', 'Launch Courier Run');
  startBtn.id = 'start-btn';
  startBtn.type = 'button';
  titleCard.appendChild(startBtn);
  const titleMuteBtn = el('button', 'btn btn-secondary btn-small', 'Sound: ON');
  titleMuteBtn.id = 'title-mute-btn';
  titleMuteBtn.type = 'button';
  titleMuteBtn.setAttribute('aria-pressed', 'true');
  titleMuteBtn.setAttribute('aria-label', 'Toggle sound');
  titleCard.appendChild(titleMuteBtn);
  titleCard.appendChild(el('p', 'hint', 'or press Enter'));
  title.appendChild(titleCard);

  // -------------------------------------------------------------- Pause
  const pause = el('section', 'overlay overlay-pause');
  pause.id = 'pause-modal';
  pause.setAttribute('role', 'dialog');
  pause.setAttribute('aria-labelledby', 'pause-heading');
  const pauseCard = el('div', 'card');
  const pauseHeading = el('h2', 'modal-title', 'Paused');
  pauseHeading.id = 'pause-heading';
  pauseCard.appendChild(pauseHeading);
  pauseCard.appendChild(el('p', 'premise', 'The storm holds its breath. Your timer is frozen.'));
  pauseCard.appendChild(buildControlsGuide());
  const pauseActions = el('div', 'actions');
  const resumeBtn = el('button', 'btn btn-primary', 'Resume Run');
  resumeBtn.id = 'resume-btn';
  resumeBtn.type = 'button';
  const restartPauseBtn = el('button', 'btn btn-secondary', 'Restart Run');
  restartPauseBtn.id = 'restart-pause-btn';
  restartPauseBtn.type = 'button';
  pauseActions.appendChild(resumeBtn);
  pauseActions.appendChild(restartPauseBtn);
  pauseCard.appendChild(pauseActions);
  pause.appendChild(pauseCard);

  // ------------------------------------------------------------ Results
  const results = el('section', 'overlay overlay-results');
  results.id = 'results-modal';
  results.setAttribute('role', 'dialog');
  results.setAttribute('aria-labelledby', 'results-heading');
  const resultsCard = el('div', 'card');
  resultsCard.appendChild(el('p', 'eyebrow', 'Run Complete'));
  const resultsHeading = el('h2', 'modal-title', 'Sandstorm Survived — Time Expired');
  resultsHeading.id = 'results-heading';
  resultsCard.appendChild(resultsHeading);
  const stats = el('dl', 'stats');
  const statItem = (label: string, id: string): HTMLElement => {
    const wrap = el('div', 'stat');
    wrap.appendChild(el('dt', undefined, label));
    const dd = el('dd', undefined, '0');
    dd.id = id;
    wrap.appendChild(dd);
    stats.appendChild(wrap);
    return dd;
  };
  const resScore = statItem('Final Score', 'results-score');
  const resDeliveries = statItem('Deliveries', 'results-deliveries');
  const resBest = statItem('Best Score', 'results-best');
  resultsCard.appendChild(stats);
  const newBest = el('p', 'new-best', 'New best score!');
  newBest.hidden = true;
  resultsCard.appendChild(newBest);
  const restartBtn = el('button', 'btn btn-primary', 'Run Again');
  restartBtn.id = 'restart-btn';
  restartBtn.type = 'button';
  resultsCard.appendChild(restartBtn);
  resultsCard.appendChild(el('p', 'hint', 'or press Enter'));
  results.appendChild(resultsCard);

  root.appendChild(hud);
  root.appendChild(touch);
  root.appendChild(title);
  root.appendChild(pause);
  root.appendChild(results);

  onClick(startBtn, callbacks.onStart);
  onClick(resumeBtn, callbacks.onResume);
  onClick(restartPauseBtn, callbacks.onRestart);
  onClick(restartBtn, callbacks.onRestart);
  onClick(pauseBtn, callbacks.onPause);
  onClick(muteBtn, callbacks.onToggleMute);
  onClick(titleMuteBtn, callbacks.onToggleMute);

  // aria-pressed mirrors the label: "true" = sound is ON, "false" = muted.
  const setMuted = (muted: boolean): void => {
    for (const btn of [muteBtn, titleMuteBtn]) {
      btn.textContent = muted ? 'Muted' : 'Sound: ON';
      btn.setAttribute('aria-pressed', muted ? 'false' : 'true');
    }
  };

  const setTouchHidden = hiddenSetter(touch);
  const setPauseBtnHidden = hiddenSetter(pauseBtn);
  const setDeliveredHidden = hiddenSetter(deliveredBanner);

  // ------------------------------------------------------------ Setters
  const setTime = textSetter(timeValue);
  const setTimeWarn = classSetter(timePanel, 'is-warning');
  const setCarry = textSetter(carryBadge);
  const setCarryOn = classSetter(carryBadge, 'is-carrying');
  const setDir = textSetter(objDir);
  const setDist = textSetter(objDist);
  const setScore = textSetter(scoreValue);
  const setDeliveries = textSetter(deliveriesValue);
  const setBest = textSetter(bestValue);
  const setTitleBest = textSetter(titleBestValue);
  const setHullText = textSetter(hull.value);
  const setBoostText = textSetter(boost.value);
  const setHullLow = classSetter(hull.root, 'is-low');
  const setHullStorm = classSetter(hull.root, 'is-storm');
  const setBoostEmpty = classSetter(boost.root, 'is-empty');
  const setSlowHidden = hiddenSetter(slowBanner);
  const setStormHidden = hiddenSetter(stormBanner);
  const setHudHidden = hiddenSetter(hud);
  const setTitleHidden = hiddenSetter(title);
  const setPauseHidden = hiddenSetter(pause);
  const setResultsHidden = hiddenSetter(results);
  const setResHeading = textSetter(resultsHeading);
  const setResScore = textSetter(resScore);
  const setResDeliveries = textSetter(resDeliveries);
  const setResBest = textSetter(resBest);
  const setNewBestHidden = hiddenSetter(newBest);

  let lastHullPct = -1;
  let lastBoostPct = -1;
  let lastArrowDeg = Number.NaN;
  let lastPhase: GamePhase | null = null;
  const setPhaseData = (phase: GamePhase): void => {
    if (phase !== lastPhase) {
      lastPhase = phase;
      root.dataset.phase = phase;
    }
  };

  let bestAtRunStart = 0;

  function update(state: SimulationState): void {
    const phase = state.phase;
    // Best only changes on a delivery, so before the first delivery of a run it is the run-start best.
    // This also covers restarts from the pause menu (paused -> playing).
    if (
      phase === 'playing' &&
      (state.score === 0 || lastPhase === 'title' || lastPhase === 'results' || lastPhase === null)
    ) {
      bestAtRunStart = state.bestScore;
    }
    setPhaseData(phase);
    setHudHidden(phase === 'title');
    setTitleHidden(phase !== 'title');
    setPauseHidden(phase !== 'paused');
    setResultsHidden(phase !== 'results');
    setTouchHidden(phase !== 'playing');
    setPauseBtnHidden(phase !== 'playing');

    setTitleBest(String(state.bestScore));

    if (phase === 'title') return;

    // Time
    setTime(formatTime(state.remainingSeconds));
    setTimeWarn(state.remainingSeconds < 15 && phase !== 'results');

    // Hull / boost gauges
    const hullPct = Math.max(0, Math.min(100, state.hull));
    const boostPct = Math.max(0, Math.min(100, state.boost));
    setHullText(String(Math.ceil(hullPct)));
    setBoostText(String(Math.floor(boostPct)));
    const hullRounded = Math.round(hullPct * 2) / 2;
    if (hullRounded !== lastHullPct) {
      lastHullPct = hullRounded;
      hull.fill.style.width = `${hullRounded}%`;
    }
    const boostRounded = Math.round(boostPct * 2) / 2;
    if (boostRounded !== lastBoostPct) {
      lastBoostPct = boostRounded;
      boost.fill.style.width = `${boostRounded}%`;
    }
    setHullLow(hullPct < 30);
    setHullStorm(state.inStorm);
    setBoostEmpty(boostPct < 1);

    // Score
    setScore(String(state.score));
    setDeliveries(String(state.deliveries));
    setBest(String(state.bestScore));

    // Carry state + objective readout
    setCarryOn(state.carryingRelic);
    setCarry(state.carryingRelic ? 'CARRYING RELIC — RETURN TO OASIS' : 'SEEKING RELIC');
    const dx = state.objectiveTarget.x - state.buggy.x;
    const dy = state.objectiveTarget.y - state.buggy.y;
    const dist = Math.hypot(dx, dy);
    // World +y points down the screen, so north is -y.
    const bearing = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const deg = Math.round((bearing + 360) % 360);
    setDir(DIRECTIONS[Math.round(deg / 45) % 8]);
    setDist(`${Math.round(dist)} m`);
    if (deg !== lastArrowDeg) {
      lastArrowDeg = deg;
      arrow.style.transform = `rotate(${deg}deg)`;
    }

    // Banners
    setSlowHidden(!(state.showSlowDownPrompt && phase === 'playing'));
    setStormHidden(!(state.inStorm && phase === 'playing'));
    const sinceDelivery = state.lastDelivery ? state.elapsedSeconds - state.lastDelivery.time : Infinity;
    setDeliveredHidden(
      !(
        (phase === 'playing' || phase === 'paused') &&
        sinceDelivery >= 0 &&
        sinceDelivery < DELIVERED_BANNER_SECONDS
      ),
    );

    // Results
    if (phase === 'results') {
      setResHeading(
        state.endReason === 'hull_depleted'
          ? 'Hull Critical — Buggy Disabled'
          : state.endReason === 'time_expired'
            ? 'Sandstorm Survived — Time Expired'
            : 'Run Complete',
      );
      setResScore(String(state.score));
      setResDeliveries(String(state.deliveries));
      setResBest(String(state.bestScore));
      setNewBestHidden(!(state.score > 0 && state.score > bestAtRunStart));
    }
  }

  return {
    update,
    setMuted,
    getTouchElements: () => ({
      joystickZone: joystick,
      joystickThumb,
      brakeBtn: touchBrake,
      boostBtn: touchBoost,
    }),
    destroy: () => {
      for (const fn of cleanups) fn();
      cleanups.length = 0;
      root.textContent = '';
    },
  };
}
