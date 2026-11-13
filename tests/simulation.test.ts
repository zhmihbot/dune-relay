import { describe, expect, it } from 'vitest';
import { BRAND_THEME, DEFAULT_CONFIG } from '../src/config';
import {
  AUTHORED_OASIS,
  AUTHORED_RELIC_SPAWNS,
  AUTHORED_ROCKS,
  FALLBACK_INNER_SPAWN,
  isSpawnPointValid,
  selectNextRelicSpawn,
} from '../src/map';
import {
  BEST_SCORE_STORAGE_KEY,
  MUTED_STORAGE_KEY,
  loadBestScore,
  loadMutedPreference,
  saveBestScore,
  saveMutedPreference,
} from '../src/persistence';
import {
  advanceSimulation,
  createInitialState,
  pauseRun,
  resumeRun,
  startRun,
  stepSimulation,
} from '../src/simulation';
import { InputState, SimulationState } from '../src/types';

const NEUTRAL_INPUT: InputState = {
  throttle: 0,
  steer: 0,
  brake: false,
  boost: false,
};

function assertAllFieldsFinite(state: SimulationState): void {
  expect(Number.isFinite(state.elapsedSeconds)).toBe(true);
  expect(Number.isFinite(state.remainingSeconds)).toBe(true);
  expect(Number.isFinite(state.accumulator)).toBe(true);
  expect(Number.isFinite(state.tickCount)).toBe(true);
  expect(Number.isFinite(state.score)).toBe(true);
  expect(Number.isFinite(state.bestScore)).toBe(true);
  expect(Number.isFinite(state.deliveries)).toBe(true);
  expect(Number.isFinite(state.hull)).toBe(true);
  expect(Number.isFinite(state.boost)).toBe(true);
  expect(Number.isFinite(state.safeZoneRadius)).toBe(true);
  expect(Number.isFinite(state.rockCollisionCooldown)).toBe(true);
  expect(Number.isFinite(state.buggy.x)).toBe(true);
  expect(Number.isFinite(state.buggy.y)).toBe(true);
  expect(Number.isFinite(state.buggy.vx)).toBe(true);
  expect(Number.isFinite(state.buggy.vy)).toBe(true);
  expect(Number.isFinite(state.buggy.angle)).toBe(true);
  expect(Number.isFinite(state.buggy.angularVelocity)).toBe(true);
  expect(Number.isFinite(state.buggy.speed)).toBe(true);
  expect(Number.isFinite(state.buggy.lateralSpeed)).toBe(true);
  expect(Number.isFinite(state.objectiveTarget.x)).toBe(true);
  expect(Number.isFinite(state.objectiveTarget.y)).toBe(true);
}

describe('DUNE RELAY Simulation & Architecture Verification', () => {
  it('1. pickup/delivery increments score once (+100), enforces one-item carrying limit, and shows slow-down prompt when entering oasis too fast', () => {
    let state = startRun(createInitialState(0, DEFAULT_CONFIG), DEFAULT_CONFIG);
    expect(state.phase).toBe('playing');
    expect(state.carryingRelic).toBe(false);
    expect(state.activeRelic).not.toBeNull();
    expect(state.lastPickup).toBeNull();
    expect(state.lastDelivery).toBeNull();

    const firstRelic = state.activeRelic!;

    // Move buggy directly onto the active relic
    state = {
      ...state,
      buggy: {
        ...state.buggy,
        x: firstRelic.x,
        y: firstRelic.y,
        vx: 0,
        vy: 0,
        speed: 0,
      },
    };

    state = stepSimulation(state, NEUTRAL_INPUT, DEFAULT_CONFIG.fixedDt);
    expect(state.carryingRelic).toBe(true);
    expect(state.activeRelic).toBeNull();
    expect(state.lastPickup).toEqual({
      id: firstRelic.id,
      x: firstRelic.x,
      y: firstRelic.y,
      time: state.elapsedSeconds,
    });
    expect(state.objectiveTarget).toEqual({
      x: state.oasis.x,
      y: state.oasis.y,
    });

    // Enforce one-item carrying limit even if an activeRelic is synthetically present while already carrying
    const syntheticExtraRelic = {
      id: 'extra-relic',
      x: state.buggy.x,
      y: state.buggy.y,
      pickupRadius: DEFAULT_CONFIG.relicPickupRadius,
      spawnIndex: 3,
      pulsePhase: 0,
    };
    const stateWithExtra = stepSimulation(
      { ...state, activeRelic: syntheticExtraRelic },
      NEUTRAL_INPUT,
      DEFAULT_CONFIG.fixedDt
    );
    expect(stateWithExtra.carryingRelic).toBe(true);
    expect(stateWithExtra.score).toBe(0);
    expect(stateWithExtra.deliveries).toBe(0);

    // Enter oasis too fast (> maxDeliverySpeed = 125): should NOT deliver, and should set showSlowDownPrompt = true
    state = {
      ...state,
      buggy: {
        ...state.buggy,
        x: 0,
        y: 0,
        vx: 240,
        vy: 0,
        angle: 0,
        speed: 240,
      },
    };
    state = stepSimulation(state, NEUTRAL_INPUT, DEFAULT_CONFIG.fixedDt);
    expect(state.carryingRelic).toBe(true);
    expect(state.showSlowDownPrompt).toBe(true);
    expect(state.score).toBe(0);
    expect(state.deliveries).toBe(0);
    expect(state.lastDelivery).toBeNull();

    // Slow down inside the oasis (<= maxDeliverySpeed): delivers once (+100), clears carryingRelic & prompt, spawns next relic
    state = {
      ...state,
      buggy: {
        ...state.buggy,
        x: 0,
        y: 0,
        vx: 60,
        vy: 0,
        angle: 0,
        speed: 60,
      },
    };
    state = stepSimulation(state, NEUTRAL_INPUT, DEFAULT_CONFIG.fixedDt);
    expect(state.carryingRelic).toBe(false);
    expect(state.showSlowDownPrompt).toBe(false);
    expect(state.score).toBe(100);
    expect(state.bestScore).toBe(100);
    expect(state.deliveries).toBe(1);
    expect(state.lastDelivery).toEqual({
      x: state.oasis.x,
      y: state.oasis.y,
      score: 100,
      deliveries: 1,
      time: state.elapsedSeconds,
    });
    expect(state.activeRelic).not.toBeNull();
    expect(state.activeRelic!.id).not.toBe(firstRelic.id);

    // Staying in the oasis on subsequent ticks does not double-increment score
    state = stepSimulation(state, NEUTRAL_INPUT, DEFAULT_CONFIG.fixedDt);
    expect(state.score).toBe(100);
    expect(state.deliveries).toBe(1);
  });

  it('2. round expiration (90s) and hull depletion (0 hull) each enter results once and do not continue advancing', () => {
    // Case A: Time expiration at 90s
    let timeState = startRun(createInitialState(0, DEFAULT_CONFIG));
    timeState = {
      ...timeState,
      elapsedSeconds:
        DEFAULT_CONFIG.roundDurationSeconds - DEFAULT_CONFIG.fixedDt * 0.5,
      remainingSeconds: DEFAULT_CONFIG.fixedDt * 0.5,
    };

    timeState = stepSimulation(
      timeState,
      { throttle: 1, steer: 0, brake: false, boost: false },
      DEFAULT_CONFIG.fixedDt
    );
    expect(timeState.phase).toBe('results');
    expect(timeState.endReason).toBe('time_expired');
    expect(timeState.remainingSeconds).toBe(0);

    const tickAtExpiry = timeState.tickCount;
    const posAtExpiry = { x: timeState.buggy.x, y: timeState.buggy.y };

    // Further stepSimulation or advanceSimulation calls must be no-ops
    const afterStep = stepSimulation(
      timeState,
      { throttle: 1, steer: 1, brake: false, boost: true },
      DEFAULT_CONFIG.fixedDt
    );
    expect(afterStep.phase).toBe('results');
    expect(afterStep.endReason).toBe('time_expired');
    expect(afterStep.tickCount).toBe(tickAtExpiry);
    expect(afterStep.buggy.x).toBe(posAtExpiry.x);

    const afterAdvance = advanceSimulation(
      timeState,
      { throttle: 1, steer: 1, brake: false, boost: true },
      1 / 30
    );
    expect(afterAdvance.phase).toBe('results');
    expect(afterAdvance.tickCount).toBe(tickAtExpiry);

    // Case B: Hull depletion in storm
    let hullState = startRun(createInitialState(0, DEFAULT_CONFIG));
    hullState = {
      ...hullState,
      hull: 0.05,
      buggy: {
        ...hullState.buggy,
        x: DEFAULT_CONFIG.arenaRadius - 25,
        y: 0,
      },
    };

    hullState = stepSimulation(
      hullState,
      NEUTRAL_INPUT,
      DEFAULT_CONFIG.fixedDt
    );
    expect(hullState.phase).toBe('results');
    expect(hullState.endReason).toBe('hull_depleted');
    expect(hullState.hull).toBe(0);

    const tickAtHullZero = hullState.tickCount;
    const afterHullAdvance = advanceSimulation(
      hullState,
      { throttle: 1, steer: 0, brake: false, boost: false },
      1 / 60
    );
    expect(afterHullAdvance.phase).toBe('results');
    expect(afterHullAdvance.endReason).toBe('hull_depleted');
    expect(afterHullAdvance.tickCount).toBe(tickAtHullZero);
  });

  it('3. pause and resume do not consume round time and reset accumulator cleanly', () => {
    let state = startRun(createInitialState(0, DEFAULT_CONFIG));
    state = advanceSimulation(
      state,
      { throttle: 1, steer: 0.2, brake: false, boost: false },
      0.05
    );
    // Add partial accumulator residue
    state = { ...state, accumulator: 0.004 };

    const paused = pauseRun(state);
    expect(paused.phase).toBe('paused');
    expect(paused.accumulator).toBe(0);

    const elapsedBeforePause = paused.elapsedSeconds;
    const remainingBeforePause = paused.remainingSeconds;
    const tickBeforePause = paused.tickCount;
    const buggyBeforePause = { ...paused.buggy };

    // Advancing while paused must not consume round time or move the buggy
    const whilePaused = advanceSimulation(
      paused,
      { throttle: 1, steer: -1, brake: true, boost: true },
      0.5
    );
    expect(whilePaused.phase).toBe('paused');
    expect(whilePaused.elapsedSeconds).toBe(elapsedBeforePause);
    expect(whilePaused.remainingSeconds).toBe(remainingBeforePause);
    expect(whilePaused.tickCount).toBe(tickBeforePause);
    expect(whilePaused.buggy).toEqual(buggyBeforePause);
    expect(whilePaused.accumulator).toBe(0);

    const resumed = resumeRun(whilePaused);
    expect(resumed.phase).toBe('playing');
    expect(resumed.accumulator).toBe(0);
    expect(resumed.elapsedSeconds).toBe(elapsedBeforePause);
  });

  it('4. high-speed collisions and exact zero-distance overlap remain finite and recover cleanly outside the rock', () => {
    const baseState = startRun(createInitialState(0, DEFAULT_CONFIG));
    const targetRock = baseState.rocks[0];

    // Case A: Exact zero-distance center overlap (buggy.x === rock.x && buggy.y === rock.y)
    let zeroOverlapState: SimulationState = {
      ...baseState,
      buggy: {
        ...baseState.buggy,
        x: targetRock.x,
        y: targetRock.y,
        vx: 0,
        vy: 0,
        angle: 0,
        speed: 0,
      },
    };

    zeroOverlapState = stepSimulation(
      zeroOverlapState,
      NEUTRAL_INPUT,
      DEFAULT_CONFIG.fixedDt
    );
    assertAllFieldsFinite(zeroOverlapState);

    const distAfterZeroOverlap = Math.hypot(
      zeroOverlapState.buggy.x - targetRock.x,
      zeroOverlapState.buggy.y - targetRock.y
    );
    expect(distAfterZeroOverlap).toBeGreaterThanOrEqual(
      zeroOverlapState.buggy.radius + targetRock.radius
    );

    // Case B: High-speed head-on impact into a rock
    const minDist = baseState.buggy.radius + targetRock.radius;
    let highSpeedState: SimulationState = {
      ...baseState,
      buggy: {
        ...baseState.buggy,
        x: targetRock.x - minDist - 1,
        y: targetRock.y,
        vx: 500,
        vy: 0,
        angle: 0,
        speed: 500,
      },
    };

    highSpeedState = stepSimulation(
      highSpeedState,
      { throttle: 1, steer: 0, brake: false, boost: true },
      DEFAULT_CONFIG.fixedDt
    );
    assertAllFieldsFinite(highSpeedState);

    const distAfterImpact = Math.hypot(
      highSpeedState.buggy.x - targetRock.x,
      highSpeedState.buggy.y - targetRock.y
    );
    expect(distAfterImpact).toBeGreaterThanOrEqual(minDist);
    expect(highSpeedState.hull).toBeLessThan(DEFAULT_CONFIG.maxHull);
    expect(highSpeedState.lastCollision).not.toBeNull();
  });

  it('5. rock-contact cooldown prevents damage on consecutive frames; speed limits and [0, 100] resource bounds hold strictly', () => {
    const baseState = startRun(createInitialState(0, DEFAULT_CONFIG));
    const rock = baseState.rocks[0];
    const minDist = baseState.buggy.radius + rock.radius;

    // Start just outside rock moving fast toward rock center
    let state: SimulationState = {
      ...baseState,
      buggy: {
        ...baseState.buggy,
        x: rock.x - minDist - 0.5,
        y: rock.y,
        vx: 320,
        vy: 0,
        angle: 0,
        speed: 320,
      },
    };

    // Frame 1: Impact occurs, hull takes damage once, cooldown is set
    state = stepSimulation(
      state,
      { throttle: 1, steer: 0, brake: false, boost: false },
      DEFAULT_CONFIG.fixedDt
    );
    const hullAfterFirstHit = state.hull;
    expect(hullAfterFirstHit).toBeLessThan(DEFAULT_CONFIG.maxHull);
    expect(state.rockCollisionCooldown).toBeCloseTo(
      DEFAULT_CONFIG.collisionCooldownSeconds,
      5
    );

    // Consecutive frames of sustained contact during cooldown window must NOT deal additional damage
    for (let i = 0; i < 20; i++) {
      // Force high inward velocity into the rock while cooldown is still active
      state = {
        ...state,
        buggy: {
          ...state.buggy,
          x: rock.x - minDist + 2,
          y: rock.y,
          vx: 350,
          vy: 0,
          angle: 0,
          speed: 350,
        },
      };
      state = stepSimulation(
        state,
        { throttle: 1, steer: 0, brake: false, boost: false },
        DEFAULT_CONFIG.fixedDt
      );
      expect(state.hull).toBe(hullAfterFirstHit);
    }

    // Verify normal speed limit, boost speed limit, reverse speed limit, and [0, 100] boost/hull bounds
    let driveState = startRun(createInitialState(0, DEFAULT_CONFIG));
    // Clear rocks for open-field top-speed test
    driveState = { ...driveState, rocks: [] };

    for (let i = 0; i < 360; i++) {
      driveState = stepSimulation(
        driveState,
        { throttle: 1, steer: 0.1, brake: false, boost: false },
        DEFAULT_CONFIG.fixedDt
      );
      expect(driveState.buggy.speed).toBeLessThanOrEqual(
        DEFAULT_CONFIG.maxSpeed + 1e-9
      );
      expect(driveState.boost).toBeGreaterThanOrEqual(0);
      expect(driveState.boost).toBeLessThanOrEqual(DEFAULT_CONFIG.maxBoost);
      expect(driveState.hull).toBeGreaterThanOrEqual(0);
      expect(driveState.hull).toBeLessThanOrEqual(DEFAULT_CONFIG.maxHull);
    }

    // Boosted driving
    for (let i = 0; i < 500; i++) {
      driveState = stepSimulation(
        driveState,
        { throttle: 1, steer: 0.08, brake: false, boost: true },
        DEFAULT_CONFIG.fixedDt
      );
      const limit = driveState.buggy.isBoosting
        ? DEFAULT_CONFIG.maxBoostSpeed
        : DEFAULT_CONFIG.maxSpeed;
      expect(driveState.buggy.speed).toBeLessThanOrEqual(limit + 1e-9);
      expect(driveState.boost).toBeGreaterThanOrEqual(0);
      expect(driveState.boost).toBeLessThanOrEqual(DEFAULT_CONFIG.maxBoost);
    }
  });

  it('6. relic spawn validity holds as storm shrinks from initialSafeZoneRadius to minSafeZoneRadius, and persistence handles malformed localStorage', () => {
    // Verify all 16 authored spawns + inner fallback at initialSafeZoneRadius
    for (const point of AUTHORED_RELIC_SPAWNS) {
      expect(
        isSpawnPointValid(
          point,
          DEFAULT_CONFIG.initialSafeZoneRadius,
          AUTHORED_ROCKS,
          AUTHORED_OASIS,
          DEFAULT_CONFIG
        )
      ).toBe(true);
    }
    expect(
      isSpawnPointValid(
        FALLBACK_INNER_SPAWN,
        DEFAULT_CONFIG.minSafeZoneRadius,
        AUTHORED_ROCKS,
        AUTHORED_OASIS,
        DEFAULT_CONFIG
      )
    ).toBe(true);

    // Sweep safeZoneRadius from initialSafeZoneRadius (860) down to minSafeZoneRadius (230)
    const stateTemplate = createInitialState(0, DEFAULT_CONFIG);
    let sawFallbackAtMinRadius = false;

    for (
      let radius = DEFAULT_CONFIG.initialSafeZoneRadius;
      radius >= DEFAULT_CONFIG.minSafeZoneRadius;
      radius -= 15
    ) {
      for (let cursor = 0; cursor < AUTHORED_RELIC_SPAWNS.length; cursor++) {
        const spawned = selectNextRelicSpawn(
          {
            safeZoneRadius: radius,
            rocks: AUTHORED_ROCKS,
            oasis: AUTHORED_OASIS,
            nextSpawnCursor: cursor,
            activeRelic: null,
          },
          DEFAULT_CONFIG
        );

        expect(
          isSpawnPointValid(
            spawned,
            radius,
            AUTHORED_ROCKS,
            AUTHORED_OASIS,
            DEFAULT_CONFIG
          )
        ).toBe(true);

        const distCenter = Math.hypot(spawned.x, spawned.y);
        expect(distCenter).toBeLessThanOrEqual(
          radius - DEFAULT_CONFIG.relicSafeZoneMargin
        );

        const distOasis = Math.hypot(
          spawned.x - AUTHORED_OASIS.x,
          spawned.y - AUTHORED_OASIS.y
        );
        expect(distOasis).toBeGreaterThanOrEqual(
          AUTHORED_OASIS.radius + DEFAULT_CONFIG.relicOasisMargin
        );

        for (const rock of AUTHORED_ROCKS) {
          const distRock = Math.hypot(spawned.x - rock.x, spawned.y - rock.y);
          expect(distRock).toBeGreaterThanOrEqual(
            rock.radius + DEFAULT_CONFIG.relicRockMargin
          );
        }

        if (
          radius === DEFAULT_CONFIG.minSafeZoneRadius &&
          spawned.id === FALLBACK_INNER_SPAWN.id
        ) {
          sawFallbackAtMinRadius = true;
        }
      }
    }

    expect(sawFallbackAtMinRadius).toBe(true);
    expect(stateTemplate.activeRelic).not.toBeNull();

    // Persistence tests: unavailable / throwing / malformed storage
    expect(loadBestScore(null)).toBe(0);
    expect(saveBestScore(200, null)).toBe(false);
    expect(saveBestScore(Number.NaN, null)).toBe(false);
    expect(saveBestScore(-100, null)).toBe(false);

    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;

    expect(loadBestScore(mockStorage)).toBe(0);
    expect(saveBestScore(400, mockStorage)).toBe(true);
    expect(loadBestScore(mockStorage)).toBe(400);

    for (const malformed of [
      'not-a-number',
      'NaN',
      'Infinity',
      '-200',
      '[300]',
      '{"score":500}',
      '',
      '   ',
    ]) {
      store.set(BEST_SCORE_STORAGE_KEY, malformed);
      expect(loadBestScore(mockStorage)).toBe(0);
    }

    const throwingStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage;

    expect(() => loadBestScore(throwingStorage)).not.toThrow();
    expect(loadBestScore(throwingStorage)).toBe(0);
    expect(() => saveBestScore(500, throwingStorage)).not.toThrow();
    expect(saveBestScore(500, throwingStorage)).toBe(false);
  });

  it('7. render schedule invariance: 30 FPS, 60 FPS, and 120 FPS produce equivalent simulation state', () => {
    // 6-second scripted maneuver sequence where inputs change on 1/30s boundaries
    const phases: { durationSeconds: number; input: InputState }[] = [
      {
        durationSeconds: 1.5,
        input: { throttle: 1, steer: 0.4, brake: false, boost: true },
      },
      {
        durationSeconds: 1.5,
        input: { throttle: 1, steer: -0.85, brake: true, boost: false },
      },
      {
        durationSeconds: 1.5,
        input: { throttle: 0.8, steer: 0.25, brake: false, boost: false },
      },
      {
        durationSeconds: 1.5,
        input: { throttle: -0.6, steer: -0.3, brake: true, boost: false },
      },
    ];

    function runSchedule(fps: number): SimulationState {
      let state = startRun(createInitialState(0, DEFAULT_CONFIG));
      const frameDt = 1 / fps;

      for (const segment of phases) {
        const frames = Math.round(segment.durationSeconds * fps);
        for (let f = 0; f < frames; f++) {
          state = advanceSimulation(state, segment.input, frameDt);
        }
      }
      return state;
    }

    const state30 = runSchedule(30);
    const state60 = runSchedule(60);
    const state120 = runSchedule(120);

    expect(state30.tickCount).toBe(720);
    expect(state60.tickCount).toBe(720);
    expect(state120.tickCount).toBe(720);

    expect(state30.elapsedSeconds).toBeCloseTo(state120.elapsedSeconds, 10);
    expect(state60.elapsedSeconds).toBeCloseTo(state120.elapsedSeconds, 10);

    expect(state30.buggy.x).toBeCloseTo(state120.buggy.x, 9);
    expect(state60.buggy.x).toBeCloseTo(state120.buggy.x, 9);
    expect(state30.buggy.y).toBeCloseTo(state120.buggy.y, 9);
    expect(state60.buggy.y).toBeCloseTo(state120.buggy.y, 9);
    expect(state30.buggy.vx).toBeCloseTo(state120.buggy.vx, 9);
    expect(state60.buggy.vx).toBeCloseTo(state120.buggy.vx, 9);
    expect(state30.buggy.vy).toBeCloseTo(state120.buggy.vy, 9);
    expect(state60.buggy.vy).toBeCloseTo(state120.buggy.vy, 9);
    expect(state30.buggy.angle).toBeCloseTo(state120.buggy.angle, 9);
    expect(state60.buggy.angle).toBeCloseTo(state120.buggy.angle, 9);
    expect(state30.boost).toBeCloseTo(state120.boost, 9);
    expect(state60.boost).toBeCloseTo(state120.boost, 9);
    expect(state30.hull).toBeCloseTo(state120.hull, 9);
    expect(state60.hull).toBeCloseTo(state120.hull, 9);
  });

  it('8. stationary and moving turning speeds use stationarySteerAuthority for responsive hover-buggy pivoting', () => {
    let stationaryState = startRun(createInitialState(0, DEFAULT_CONFIG));
    stationaryState = {
      ...stationaryState,
      buggy: {
        ...stationaryState.buggy,
        vx: 0,
        vy: 0,
        speed: 0,
        angle: 0,
      },
    };

    const steppedStationary = stepSimulation(
      stationaryState,
      { throttle: 0, steer: 1, brake: false, boost: false },
      DEFAULT_CONFIG.fixedDt
    );

    const expectedStationaryAngularVel =
      DEFAULT_CONFIG.steerRate * DEFAULT_CONFIG.stationarySteerAuthority;
    expect(steppedStationary.buggy.angularVelocity).toBeCloseTo(
      expectedStationaryAngularVel,
      6
    );
    expect(steppedStationary.buggy.angularVelocity).toBeGreaterThan(3.0);

    // Moving at >= 30 u/s reaches 100% steering authority (and drift multiplier when braking)
    let movingState: SimulationState = {
      ...stationaryState,
      buggy: {
        ...stationaryState.buggy,
        vx: 100,
        vy: 0,
        speed: 100,
        angle: 0,
      },
    };
    const steppedMoving = stepSimulation(
      movingState,
      { throttle: 1, steer: 1, brake: true, boost: false },
      DEFAULT_CONFIG.fixedDt
    );
    expect(steppedMoving.buggy.angularVelocity).toBeCloseTo(
      DEFAULT_CONFIG.steerRate * DEFAULT_CONFIG.driftSteerMultiplier,
      6
    );
  });

  it('9. early/mid-game newly spawned relics have >= 120u safety buffer from storm and only relocate when storm reaches within 45u', () => {
    // At t = 0 (safeZoneRadius = 860), every newly spawned relic across all cursors has >= 180u buffer from safeZoneRadius
    for (let cursor = 0; cursor < AUTHORED_RELIC_SPAWNS.length; cursor++) {
      const spawned = selectNextRelicSpawn(
        {
          safeZoneRadius: DEFAULT_CONFIG.initialSafeZoneRadius,
          rocks: AUTHORED_ROCKS,
          oasis: AUTHORED_OASIS,
          nextSpawnCursor: cursor,
          activeRelic: null,
        },
        DEFAULT_CONFIG
      );
      const distFromOrigin = Math.hypot(spawned.x, spawned.y);
      expect(
        DEFAULT_CONFIG.initialSafeZoneRadius - distFromOrigin
      ).toBeGreaterThanOrEqual(120);
    }

    // Verify an outer relic (e.g. relic-outer-s at dist ~565) does NOT teleport during the first 25 seconds of storm shrink,
    // and DOES teleport once safeZoneRadius - relicSafeZoneMargin drops below distFromOrigin.
    const outerPoint = AUTHORED_RELIC_SPAWNS.find((p) => p.ring === 'outer')!;
    const outerDist = Math.hypot(outerPoint.x, outerPoint.y);
    expect(outerDist).toBeGreaterThanOrEqual(540);
    expect(outerDist).toBeLessThanOrEqual(585);

    let state = startRun(createInitialState(0, DEFAULT_CONFIG));
    state = {
      ...state,
      activeRelic: {
        id: outerPoint.id,
        x: outerPoint.x,
        y: outerPoint.y,
        pickupRadius: DEFAULT_CONFIG.relicPickupRadius,
        spawnIndex: 1,
        pulsePhase: 0,
      },
    };

    // Advance 20 seconds: storm shrinks from 860 to 720; outer relic at ~560 must remain untouched
    for (let i = 0; i < 20 * 120; i++) {
      state = stepSimulation(state, NEUTRAL_INPUT, DEFAULT_CONFIG.fixedDt);
    }
    expect(state.activeRelic).not.toBeNull();
    expect(state.activeRelic!.id).toBe(outerPoint.id);

    // Jump to when safeZoneRadius shrinks just below outerDist + relicSafeZoneMargin: relic must relocate inward
    const triggerElapsed =
      DEFAULT_CONFIG.roundDurationSeconds *
      ((DEFAULT_CONFIG.initialSafeZoneRadius -
        (outerDist + DEFAULT_CONFIG.relicSafeZoneMargin - 2)) /
        (DEFAULT_CONFIG.initialSafeZoneRadius -
          DEFAULT_CONFIG.minSafeZoneRadius));
    state = {
      ...state,
      elapsedSeconds: triggerElapsed,
    };
    state = stepSimulation(state, NEUTRAL_INPUT, DEFAULT_CONFIG.fixedDt);
    expect(state.activeRelic).not.toBeNull();
    expect(state.activeRelic!.id).not.toBe(outerPoint.id);
    expect(
      Math.hypot(state.activeRelic!.x, state.activeRelic!.y)
    ).toBeLessThanOrEqual(
      state.safeZoneRadius - DEFAULT_CONFIG.relicSafeZoneMargin
    );
  });

  it('10. muted preference persistence and centralized BRAND_THEME config', () => {
    expect(BRAND_THEME.title).toBe('DUNE RELAY');
    expect(BRAND_THEME.relicName).toBe('Relic');
    expect(BRAND_THEME.baseName).toBe('Oasis');
    expect(BRAND_THEME.palette.relicCore).toBeTruthy();

    expect(loadMutedPreference(null)).toBe(false);
    expect(saveMutedPreference(true, null)).toBe(false);

    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    } as unknown as Storage;

    expect(loadMutedPreference(mockStorage)).toBe(false);
    expect(saveMutedPreference(true, mockStorage)).toBe(true);
    expect(loadMutedPreference(mockStorage)).toBe(true);
    expect(saveMutedPreference(false, mockStorage)).toBe(true);
    expect(loadMutedPreference(mockStorage)).toBe(false);

    store.set(MUTED_STORAGE_KEY, 'corrupted_value');
    expect(loadMutedPreference(mockStorage)).toBe(false);

    const throwingStorage = {
      getItem: () => {
        throw new Error('Blocked');
      },
      setItem: () => {
        throw new Error('Blocked');
      },
    } as unknown as Storage;
    expect(loadMutedPreference(throwingStorage)).toBe(false);
    expect(saveMutedPreference(true, throwingStorage)).toBe(false);
  });

  it('11. screen-relative directional controls: cardinal & diagonal movement and normalized diagonal top speed', () => {
    const base = { ...startRun(createInitialState(0, DEFAULT_CONFIG)), rocks: [] };

    // Cardinal right (D) from facing angle 0: moves along +x
    let rightState: SimulationState = {
      ...base,
      buggy: { ...base.buggy, x: 0, y: 0, vx: 0, vy: 0, angle: 0, speed: 0 },
    };
    for (let i = 0; i < 360; i++) {
      rightState = stepSimulation(
        rightState,
        { throttle: 1, steer: 0, moveX: 1, moveY: 0, brake: false, boost: false },
        DEFAULT_CONFIG.fixedDt
      );
    }
    expect(rightState.buggy.x).toBeGreaterThan(200);
    expect(Math.abs(rightState.buggy.y)).toBeLessThan(1e-3);
    expect(rightState.buggy.speed).toBeLessThanOrEqual(DEFAULT_CONFIG.maxSpeed + 1e-9);

    // Cardinal up (W) from angle 0: turns toward -π/2 and moves along -y
    let upState: SimulationState = {
      ...base,
      buggy: { ...base.buggy, x: 0, y: 0, vx: 0, vy: 0, angle: 0, speed: 0 },
    };
    for (let i = 0; i < 360; i++) {
      upState = stepSimulation(
        upState,
        { throttle: 1, steer: 0, moveX: 0, moveY: -1, brake: false, boost: false },
        DEFAULT_CONFIG.fixedDt
      );
    }
    expect(upState.buggy.y).toBeLessThan(-200);
    expect(upState.buggy.angle).toBeCloseTo(-Math.PI / 2, 2);

    // Diagonal down-left (S + A normalized): moves along (-x, +y) and never exceeds cardinal top speed
    const invSqrt2 = Math.SQRT1_2;
    let diagState: SimulationState = {
      ...base,
      buggy: { ...base.buggy, x: 0, y: 0, vx: 0, vy: 0, angle: (3 * Math.PI) / 4, speed: 0 },
    };
    for (let i = 0; i < 360; i++) {
      diagState = stepSimulation(
        diagState,
        {
          throttle: 1,
          steer: 0,
          moveX: -invSqrt2,
          moveY: invSqrt2,
          brake: false,
          boost: false,
        },
        DEFAULT_CONFIG.fixedDt
      );
      expect(diagState.buggy.speed).toBeLessThanOrEqual(DEFAULT_CONFIG.maxSpeed + 1e-9);
    }
    expect(diagState.buggy.x).toBeLessThan(-150);
    expect(diagState.buggy.y).toBeGreaterThan(150);
    expect(diagState.buggy.speed).toBeCloseTo(rightState.buggy.speed, 2);
  });

  it('12. screen-relative 180-degree reversal turns monotonically without oscillation and wraps shortest path across ±π', () => {
    const base = { ...startRun(createInitialState(0, DEFAULT_CONFIG)), rocks: [] };

    // Stationary 180-degree reversal: facing +x (angle 0), request -x (moveX = -1, moveY = 0)
    let turnState: SimulationState = {
      ...base,
      buggy: {
        ...base.buggy,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        angle: 0,
        angularVelocity: 0,
        speed: 0,
      },
    };
    const signHistory: number[] = [];
    for (let i = 0; i < 240; i++) {
      turnState = stepSimulation(
        turnState,
        { throttle: 1, steer: 0, moveX: -1, moveY: 0, brake: false, boost: false },
        DEFAULT_CONFIG.fixedDt
      );
      if (Math.abs(turnState.buggy.angularVelocity) > 1e-4) {
        signHistory.push(Math.sign(turnState.buggy.angularVelocity));
      }
    }
    // Every non-zero turning tick stays on the same positive turn sign (no ±π chatter)
    expect(signHistory.length).toBeGreaterThan(20);
    expect(signHistory.every((s) => s > 0)).toBe(true);
    expect(Math.abs(Math.abs(turnState.buggy.angle) - Math.PI)).toBeLessThan(0.05);
    expect(turnState.buggy.vx).toBeLessThan(-150);

    // Shortest-path wraparound across ±π: facing +0.9π, requesting -0.9π turns positively (+0.2π arc)
    const wrapState = stepSimulation(
      {
        ...base,
        buggy: {
          ...base.buggy,
          vx: 0,
          vy: 0,
          speed: 0,
          angle: 0.9 * Math.PI,
          angularVelocity: 0,
        },
      },
      {
        throttle: 1,
        steer: 0,
        moveX: Math.cos(-0.9 * Math.PI),
        moveY: Math.sin(-0.9 * Math.PI),
        brake: false,
        boost: false,
      },
      DEFAULT_CONFIG.fixedDt
    );
    expect(wrapState.buggy.angularVelocity).toBeGreaterThan(0);

    // Opposite wraparound: facing -0.9π, requesting +0.9π turns negatively (-0.2π arc)
    const wrapStateNeg = stepSimulation(
      {
        ...base,
        buggy: {
          ...base.buggy,
          vx: 0,
          vy: 0,
          speed: 0,
          angle: -0.9 * Math.PI,
          angularVelocity: 0,
        },
      },
      {
        throttle: 1,
        steer: 0,
        moveX: Math.cos(0.9 * Math.PI),
        moveY: Math.sin(0.9 * Math.PI),
        brake: false,
        boost: false,
      },
      DEFAULT_CONFIG.fixedDt
    );
    expect(wrapStateNeg.buggy.angularVelocity).toBeLessThan(0);
  });

  it('13. releasing directional input coasts cleanly and partial joystick magnitude scales throttle intensity', () => {
    const base = { ...startRun(createInitialState(0, DEFAULT_CONFIG)), rocks: [] };

    // Coasting when moveX = 0, moveY = 0
    let coastState: SimulationState = {
      ...base,
      buggy: {
        ...base.buggy,
        x: 0,
        y: 0,
        vx: 250,
        vy: 0,
        angle: 0,
        angularVelocity: 1.5,
        speed: 250,
      },
    };
    const afterCoast = stepSimulation(
      coastState,
      { throttle: 0, steer: 0, moveX: 0, moveY: 0, brake: false, boost: false },
      DEFAULT_CONFIG.fixedDt
    );
    expect(afterCoast.buggy.angularVelocity).toBe(0);
    expect(afterCoast.buggy.angle).toBe(0);
    expect(afterCoast.buggy.speed).toBeGreaterThan(240);
    expect(afterCoast.buggy.speed).toBeLessThan(250);

    // Partial joystick magnitude (0.4 vs 1.0)
    let partialState: SimulationState = {
      ...base,
      buggy: { ...base.buggy, x: 0, y: 0, vx: 0, vy: 0, angle: 0, speed: 0 },
    };
    let fullState = partialState;
    for (let i = 0; i < 180; i++) {
      partialState = stepSimulation(
        partialState,
        { throttle: 0.4, steer: 0, moveX: 0.4, moveY: 0, brake: false, boost: false },
        DEFAULT_CONFIG.fixedDt
      );
      fullState = stepSimulation(
        fullState,
        { throttle: 1.0, steer: 0, moveX: 1.0, moveY: 0, brake: false, boost: false },
        DEFAULT_CONFIG.fixedDt
      );
    }
    expect(partialState.buggy.speed).toBeGreaterThan(50);
    expect(partialState.buggy.speed).toBeLessThan(fullState.buggy.speed * 0.55);
  });
});
