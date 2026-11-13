import { DEFAULT_CONFIG } from './config';
import {
  AUTHORED_OASIS,
  AUTHORED_RELIC_SPAWNS,
  AUTHORED_ROCKS,
  isSpawnPointValid,
  selectNextRelicSpawn,
} from './map';
import {
  BuggyState,
  CollisionEvent,
  DeliveryEvent,
  EndReason,
  GameConfig,
  GamePhase,
  InputState,
  PickupEvent,
  SimulationState,
  Vec2,
} from './types';

function sanitizeFinite(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  const safe = sanitizeFinite(value, min);
  return Math.min(max, Math.max(min, safe));
}

function normalizeAngle(angle: number): number {
  const safe = sanitizeFinite(angle, 0);
  return Math.atan2(Math.sin(safe), Math.cos(safe));
}

export function createInitialState(
  bestScore = 0,
  config: GameConfig = DEFAULT_CONFIG
): SimulationState {
  const sanitizedBest = Math.max(0, Math.floor(sanitizeFinite(bestScore, 0)));
  const oasis = {
    x: AUTHORED_OASIS.x,
    y: AUTHORED_OASIS.y,
    radius: config.oasisRadius,
  };
  const rocks = AUTHORED_ROCKS.map((rock) => ({ ...rock }));
  const safeZoneRadius = config.initialSafeZoneRadius;

  const initialRelic = selectNextRelicSpawn(
    {
      safeZoneRadius,
      rocks,
      oasis,
      nextSpawnCursor: 0,
      activeRelic: null,
    },
    config
  );

  const nextSpawnCursor =
    (initialRelic.spawnIndex + 1) % AUTHORED_RELIC_SPAWNS.length;

  const buggy: BuggyState = {
    x: 0,
    y: 150,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 4,
    angularVelocity: 0,
    radius: config.buggyRadius,
    speed: 0,
    lateralSpeed: 0,
    isBoosting: false,
    isDrifting: false,
  };

  return {
    phase: 'title',
    endReason: 'none',
    elapsedSeconds: 0,
    remainingSeconds: config.roundDurationSeconds,
    accumulator: 0,
    tickCount: 0,
    score: 0,
    bestScore: sanitizedBest,
    deliveries: 0,
    hull: config.maxHull,
    boost: config.maxBoost,
    carryingRelic: false,
    showSlowDownPrompt: false,
    inStorm: false,
    safeZoneRadius,
    rockCollisionCooldown: 0,
    buggy,
    oasis,
    rocks,
    activeRelic: initialRelic,
    nextSpawnCursor,
    lastCollision: null,
    lastPickup: null,
    lastDelivery: null,
    objectiveTarget: { x: initialRelic.x, y: initialRelic.y },
  };
}

export function startRun(
  state: SimulationState,
  config: GameConfig = DEFAULT_CONFIG
): SimulationState {
  const preservedBest = Math.max(
    0,
    Math.floor(sanitizeFinite(state.bestScore, 0)),
    Math.floor(sanitizeFinite(state.score, 0))
  );
  const fresh = createInitialState(preservedBest, config);
  return {
    ...fresh,
    phase: 'playing',
  };
}

export function pauseRun(state: SimulationState): SimulationState {
  if (state.phase !== 'playing') {
    return state;
  }
  return {
    ...state,
    phase: 'paused',
    accumulator: 0,
  };
}

export function resumeRun(state: SimulationState): SimulationState {
  if (state.phase !== 'paused') {
    return state;
  }
  return {
    ...state,
    phase: 'playing',
    accumulator: 0,
  };
}

export function stepSimulation(
  state: SimulationState,
  input: InputState,
  dt: number,
  config: GameConfig = DEFAULT_CONFIG
): SimulationState {
  if (state.phase !== 'playing') {
    return state;
  }
  if (typeof dt !== 'number' || !Number.isFinite(dt) || dt <= 0) {
    return state;
  }

  let throttle = clamp(input?.throttle ?? 0, -1, 1);
  let steer = clamp(input?.steer ?? 0, -1, 1);
  const brake = Boolean(input?.brake);
  const boostInput = Boolean(input?.boost);

  let elapsedSeconds = clamp(
    state.elapsedSeconds,
    0,
    config.roundDurationSeconds
  );
  let score = Math.max(0, Math.floor(sanitizeFinite(state.score, 0)));
  let bestScore = Math.max(
    score,
    Math.floor(sanitizeFinite(state.bestScore, 0))
  );
  let deliveries = Math.max(0, Math.floor(sanitizeFinite(state.deliveries, 0)));
  let hull = clamp(state.hull, 0, config.maxHull);
  let boost = clamp(state.boost, 0, config.maxBoost);
  let carryingRelic = Boolean(state.carryingRelic);
  let showSlowDownPrompt = false;
  let rockCollisionCooldown = Math.max(
    0,
    sanitizeFinite(state.rockCollisionCooldown, 0) - dt
  );
  let nextSpawnCursor = Math.max(
    0,
    Math.floor(sanitizeFinite(state.nextSpawnCursor, 0))
  );
  let lastCollision: CollisionEvent | null = state.lastCollision;
  let lastPickup: PickupEvent | null = state.lastPickup ?? null;
  let lastDelivery: DeliveryEvent | null = state.lastDelivery ?? null;

  // Boost drain / regeneration
  const isBoosting = boostInput && boost > 0;
  if (isBoosting) {
    boost = clamp(boost - config.boostDrainPerSecond * dt, 0, config.maxBoost);
  } else {
    boost = clamp(boost + config.boostRegenPerSecond * dt, 0, config.maxBoost);
  }

  // Sanitize incoming buggy kinematics
  let x = sanitizeFinite(state.buggy.x, 0);
  let y = sanitizeFinite(state.buggy.y, 150);
  let vx = sanitizeFinite(state.buggy.vx, 0);
  let vy = sanitizeFinite(state.buggy.vy, 0);
  let angle = normalizeAngle(state.buggy.angle);
  const buggyRadius =
    sanitizeFinite(state.buggy.radius, config.buggyRadius) > 0
      ? sanitizeFinite(state.buggy.radius, config.buggyRadius)
      : config.buggyRadius;

  // Steering & drift dynamics (hover-buggy retains strong pivot authority even at standstill)
  const preStepSpeed = Math.hypot(vx, vy);
  const minSteerAuthority = clamp(
    config.stationarySteerAuthority ?? 0.85,
    0.1,
    1.0
  );
  const turnMultiplier = brake ? config.driftSteerMultiplier : 1.0;
  let speedAuthority: number;

  if (input?.moveX !== undefined || input?.moveY !== undefined) {
    const mx = sanitizeFinite(input.moveX ?? 0, 0);
    const my = sanitizeFinite(input.moveY ?? 0, 0);
    const rawMag = Math.hypot(mx, my);
    speedAuthority =
      minSteerAuthority +
      (1 - minSteerAuthority) * Math.min(1, preStepSpeed / 95);

    if (rawMag > 1e-4) {
      throttle = clamp(rawMag, 0, 1);
      const targetAngle = Math.atan2(my, mx);
      let angleDiff = Math.atan2(
        Math.sin(targetAngle - angle),
        Math.cos(targetAngle - angle)
      );

      // Lock turn direction across ±π so a 180-degree reversal never chatters.
      if (Math.abs(angleDiff) > Math.PI - 0.08) {
        const prevAngVel = sanitizeFinite(state.buggy.angularVelocity, 0);
        angleDiff =
          Math.abs(prevAngVel) > 1e-3
            ? Math.sign(prevAngVel) * Math.abs(angleDiff)
            : Math.abs(angleDiff);
      }

      const maxTurnStep = config.steerRate * turnMultiplier * speedAuthority * dt;
      steer = clamp(angleDiff / Math.max(maxTurnStep, 0.12), -1, 1);
    } else {
      throttle = 0;
      steer = 0;
    }
  } else {
    speedAuthority = clamp(preStepSpeed / 30, minSteerAuthority, 1.0);
  }

  const angularVelocity =
    steer * config.steerRate * turnMultiplier * speedAuthority;
  angle = normalizeAngle(angle + angularVelocity * dt);

  const fx = Math.cos(angle);
  const fy = Math.sin(angle);
  const lx = -Math.sin(angle);
  const ly = Math.cos(angle);

  let forwardSpeed = vx * fx + vy * fy;
  let lateralSpeed = vx * lx + vy * ly;

  if (throttle > 0) {
    forwardSpeed += throttle * config.forwardAccel * dt;
  } else if (throttle < 0) {
    if (forwardSpeed > 15) {
      forwardSpeed = Math.max(
        0,
        forwardSpeed + throttle * config.brakeDecel * dt
      );
    } else {
      forwardSpeed += throttle * config.reverseAccel * dt;
    }
  }

  if (isBoosting) {
    forwardSpeed += config.boostAccel * dt;
  }

  if (brake) {
    if (throttle <= 0 && !isBoosting) {
      if (forwardSpeed > 0) {
        forwardSpeed = Math.max(0, forwardSpeed - config.brakeDecel * dt);
      } else if (forwardSpeed < 0) {
        forwardSpeed = Math.min(0, forwardSpeed + config.brakeDecel * dt);
      }
    } else {
      // Mild longitudinal drag during handbrake drift turns
      forwardSpeed *= Math.max(0, 1 - 0.65 * dt);
    }
  }

  // Natural longitudinal rolling/air drag
  forwardSpeed *= Math.max(0, 1 - config.longitudinalDrag * dt);

  // Momentum + lateral slip: reduced lateral grip while handbrake drifting
  const lateralGrip = brake
    ? config.driftLateralGrip
    : config.normalLateralGrip;
  lateralSpeed *= Math.exp(-lateralGrip * dt);

  // Enforce longitudinal speed limits
  const maxForwardAllowed = isBoosting ? config.maxBoostSpeed : config.maxSpeed;
  forwardSpeed = clamp(
    forwardSpeed,
    -config.maxReverseSpeed,
    maxForwardAllowed
  );

  vx = fx * forwardSpeed + lx * lateralSpeed;
  vy = fy * forwardSpeed + ly * lateralSpeed;

  // Strictly enforce overall speed limits
  let totalSpeed = Math.hypot(vx, vy);
  const maxTotalAllowed =
    forwardSpeed < 0 && !isBoosting && throttle < 0
      ? config.maxReverseSpeed
      : maxForwardAllowed;
  if (totalSpeed > maxTotalAllowed && totalSpeed > 1e-6) {
    const scale = maxTotalAllowed / totalSpeed;
    vx *= scale;
    vy *= scale;
    totalSpeed = maxTotalAllowed;
  }

  // Integrate position
  x += vx * dt;
  y += vy * dt;

  // Circle-circle rock collision detection & response
  for (const rock of state.rocks) {
    const dx = x - rock.x;
    const dy = y - rock.y;
    const dist = Math.hypot(dx, dy);
    const minDist = buggyRadius + rock.radius;

    if (dist < minDist) {
      let nx: number;
      let ny: number;
      if (dist > 1e-6) {
        nx = dx / dist;
        ny = dy / dist;
      } else {
        // Deterministic fallback normal when centers coincide (dist === 0)
        nx = Math.cos(angle);
        ny = Math.sin(angle);
        const normLen = Math.hypot(nx, ny);
        if (normLen > 1e-6) {
          nx /= normLen;
          ny /= normLen;
        } else {
          nx = 1;
          ny = 0;
        }
      }

      // Push buggy cleanly outside the rock with a tiny epsilon to prevent FP re-overlap
      const pushDist = minDist + 1e-3;
      x = rock.x + nx * pushDist;
      y = rock.y + ny * pushDist;

      // Velocity normal component relative to outward normal
      const vn = vx * nx + vy * ny;
      const inwardSpeed = Math.max(0, -vn);
      if (vn < 0) {
        vx -= vn * nx;
        vy -= vn * ny;
        // Slight tangential scrape damping
        vx *= 0.94;
        vy *= 0.94;
      }

      if (
        inwardSpeed >= config.minImpactDamageSpeed &&
        rockCollisionCooldown <= 0
      ) {
        const rawDamage =
          config.minImpactDamage +
          (inwardSpeed - config.minImpactDamageSpeed) *
            config.impactDamageScale;
        const damage = clamp(
          rawDamage,
          config.minImpactDamage,
          config.maxImpactDamage
        );
        hull = clamp(hull - damage, 0, config.maxHull);
        rockCollisionCooldown = config.collisionCooldownSeconds;
        lastCollision = {
          x: rock.x + nx * rock.radius,
          y: rock.y + ny * rock.radius,
          normalX: nx,
          normalY: ny,
          impactSpeed: inwardSpeed,
          damage,
          time: elapsedSeconds + dt,
        };
      }
    }
  }

  // Arena outer boundary clamping
  const maxBuggyArenaDist = Math.max(0, config.arenaRadius - buggyRadius);
  const distFromCenter = Math.hypot(x, y);
  if (distFromCenter > maxBuggyArenaDist) {
    let bx: number;
    let by: number;
    if (distFromCenter > 1e-6) {
      bx = x / distFromCenter;
      by = y / distFromCenter;
    } else {
      bx = Math.cos(angle);
      by = Math.sin(angle);
    }
    x = bx * maxBuggyArenaDist;
    y = by * maxBuggyArenaDist;

    const vnOut = vx * bx + vy * by;
    if (vnOut > 0) {
      vx -= vnOut * bx;
      vy -= vnOut * by;
    }
  }

  // Recompute body speeds after collision resolution
  forwardSpeed = vx * fx + vy * fy;
  lateralSpeed = vx * lx + vy * ly;
  totalSpeed = Math.hypot(vx, vy);
  if (totalSpeed > maxForwardAllowed && totalSpeed > 1e-6) {
    const scale = maxForwardAllowed / totalSpeed;
    vx *= scale;
    vy *= scale;
    forwardSpeed *= scale;
    lateralSpeed *= scale;
    totalSpeed = maxForwardAllowed;
  }

  const isDrifting =
    brake && (Math.abs(lateralSpeed) > 12 || totalSpeed > 45);

  // Advance round clock and shrinking sandstorm safe zone
  elapsedSeconds = clamp(
    elapsedSeconds + dt,
    0,
    config.roundDurationSeconds
  );
  const remainingSeconds = Math.max(
    0,
    config.roundDurationSeconds - elapsedSeconds
  );
  const stormProgress = clamp(
    elapsedSeconds / config.roundDurationSeconds,
    0,
    1
  );
  const safeZoneRadius =
    config.initialSafeZoneRadius +
    (config.minSafeZoneRadius - config.initialSafeZoneRadius) * stormProgress;

  // Update active relic pulse, pickup, delivery, and storm-shrinking validity
  let activeRelic = state.activeRelic
    ? {
        ...state.activeRelic,
        pulsePhase: (state.activeRelic.pulsePhase + dt * 3.2) % (Math.PI * 2),
      }
    : null;

  if (!carryingRelic) {
    if (!activeRelic) {
      const spawned = selectNextRelicSpawn(
        {
          safeZoneRadius,
          rocks: state.rocks,
          oasis: state.oasis,
          nextSpawnCursor,
          activeRelic: null,
        },
        config
      );
      activeRelic = spawned;
      nextSpawnCursor =
        (spawned.spawnIndex + 1) % AUTHORED_RELIC_SPAWNS.length;
    }

    const distToRelic = Math.hypot(x - activeRelic.x, y - activeRelic.y);
    if (distToRelic <= buggyRadius + activeRelic.pickupRadius) {
      lastPickup = {
        id: activeRelic.id,
        x: activeRelic.x,
        y: activeRelic.y,
        time: elapsedSeconds,
      };
      carryingRelic = true;
      activeRelic = null;
    } else if (
      !isSpawnPointValid(
        activeRelic,
        safeZoneRadius,
        state.rocks,
        state.oasis,
        config
      )
    ) {
      const relocated = selectNextRelicSpawn(
        {
          safeZoneRadius,
          rocks: state.rocks,
          oasis: state.oasis,
          nextSpawnCursor,
          activeRelic,
        },
        config
      );
      activeRelic = relocated;
      nextSpawnCursor =
        (relocated.spawnIndex + 1) % AUTHORED_RELIC_SPAWNS.length;
    }
  }

  if (carryingRelic) {
    const distToOasis = Math.hypot(x - state.oasis.x, y - state.oasis.y);
    if (distToOasis <= state.oasis.radius) {
      if (totalSpeed <= config.maxDeliverySpeed) {
        score += config.deliveryScore;
        deliveries += 1;
        bestScore = Math.max(bestScore, score);
        carryingRelic = false;
        showSlowDownPrompt = false;
        lastDelivery = {
          x: state.oasis.x,
          y: state.oasis.y,
          score,
          deliveries,
          time: elapsedSeconds,
        };

        const spawned = selectNextRelicSpawn(
          {
            safeZoneRadius,
            rocks: state.rocks,
            oasis: state.oasis,
            nextSpawnCursor,
            activeRelic,
          },
          config
        );
        activeRelic = spawned;
        nextSpawnCursor =
          (spawned.spawnIndex + 1) % AUTHORED_RELIC_SPAWNS.length;
      } else {
        showSlowDownPrompt = true;
      }
    }
  }

  // Storm hull drain when outside safeZoneRadius
  const buggyDistFromOrigin = Math.hypot(x, y);
  const inStorm = buggyDistFromOrigin > safeZoneRadius;
  if (inStorm) {
    hull = clamp(hull - config.stormDrainPerSecond * dt, 0, config.maxHull);
  }

  // Determine objective target for compass / HUD arrow
  const objectiveTarget: Vec2 =
    carryingRelic || !activeRelic
      ? { x: state.oasis.x, y: state.oasis.y }
      : { x: activeRelic.x, y: activeRelic.y };

  // Check end-of-round conditions
  let phase: GamePhase = state.phase;
  let endReason: EndReason = state.endReason;
  let accumulator = sanitizeFinite(state.accumulator, 0);

  if (hull <= 0) {
    hull = 0;
    phase = 'results';
    endReason = 'hull_depleted';
    accumulator = 0;
  } else if (elapsedSeconds >= config.roundDurationSeconds - 1e-9) {
    elapsedSeconds = config.roundDurationSeconds;
    phase = 'results';
    endReason = 'time_expired';
    accumulator = 0;
  }

  return {
    phase,
    endReason,
    elapsedSeconds,
    remainingSeconds:
      phase === 'results' && endReason === 'time_expired'
        ? 0
        : remainingSeconds,
    accumulator,
    tickCount: state.tickCount + 1,
    score,
    bestScore,
    deliveries,
    hull,
    boost,
    carryingRelic,
    showSlowDownPrompt,
    inStorm,
    safeZoneRadius,
    rockCollisionCooldown,
    buggy: {
      x,
      y,
      vx,
      vy,
      angle,
      angularVelocity,
      radius: buggyRadius,
      speed: totalSpeed,
      lateralSpeed,
      isBoosting,
      isDrifting,
    },
    oasis: state.oasis,
    rocks: state.rocks,
    activeRelic,
    nextSpawnCursor,
    lastCollision,
    lastPickup,
    lastDelivery,
    objectiveTarget,
  };
}

export function advanceSimulation(
  state: SimulationState,
  input: InputState,
  frameDeltaSeconds: number,
  config: GameConfig = DEFAULT_CONFIG
): SimulationState {
  if (state.phase !== 'playing') {
    if (state.accumulator === 0) {
      return state;
    }
    return {
      ...state,
      accumulator: 0,
    };
  }

  const safeDelta =
    typeof frameDeltaSeconds === 'number' && Number.isFinite(frameDeltaSeconds)
      ? Math.max(0, frameDeltaSeconds)
      : 0;
  const clampedDelta = Math.min(safeDelta, config.maxCatchUpSeconds);

  let current: SimulationState = state;
  let accumulator = sanitizeFinite(state.accumulator, 0) + clampedDelta;
  const fixedDt = config.fixedDt;

  while (accumulator + 1e-9 >= fixedDt && current.phase === 'playing') {
    current = stepSimulation(current, input, fixedDt, config);
    accumulator = Math.max(0, accumulator - fixedDt);
  }

  if (accumulator < 1e-9 || current.phase !== 'playing') {
    accumulator = 0;
  }

  return {
    ...current,
    accumulator,
  };
}
