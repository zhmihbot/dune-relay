import { DEFAULT_CONFIG } from './config';
import {
  ActiveRelic,
  GameConfig,
  OasisZone,
  RelicSpawnPoint,
  RockObstacle,
  SimulationState,
  Vec2,
} from './types';

export const AUTHORED_OASIS: OasisZone = {
  x: 0,
  y: 0,
  radius: DEFAULT_CONFIG.oasisRadius,
};

export const AUTHORED_ROCKS: RockObstacle[] = [
  // Inner-mid ring (4 rocks on diagonals, leaving wide N/E/S/W lanes around the central oasis)
  { id: 'rock-inner-ne', x: 185, y: -185, radius: 34, heightShade: 0.9 },
  { id: 'rock-inner-se', x: 195, y: 180, radius: 38, heightShade: 1.0 },
  { id: 'rock-inner-sw', x: -185, y: 190, radius: 36, heightShade: 0.85 },
  { id: 'rock-inner-nw', x: -190, y: -180, radius: 35, heightShade: 0.95 },

  // Mid ring (4 rocks offset from cardinal axes to create sweeping S-curve drift corridors)
  { id: 'rock-mid-e', x: 445, y: -95, radius: 46, heightShade: 1.0 },
  { id: 'rock-mid-s', x: 110, y: 450, radius: 44, heightShade: 0.9 },
  { id: 'rock-mid-w', x: -455, y: 105, radius: 48, heightShade: 1.05 },
  { id: 'rock-mid-n', x: -105, y: -440, radius: 42, heightShade: 0.88 },

  // Outer ring (4 large mesas near the outer perimeter)
  { id: 'rock-outer-ne', x: 610, y: -310, radius: 52, heightShade: 1.1 },
  { id: 'rock-outer-se', x: 320, y: 600, radius: 50, heightShade: 0.95 },
  { id: 'rock-outer-sw', x: -600, y: 315, radius: 54, heightShade: 1.0 },
  { id: 'rock-outer-nw', x: -310, y: -610, radius: 48, heightShade: 0.92 },
];

export const FALLBACK_INNER_SPAWN: RelicSpawnPoint = {
  id: 'fallback-inner',
  x: 0,
  y: -165,
  ring: 'inner',
};

export const AUTHORED_RELIC_SPAWNS: RelicSpawnPoint[] = [
  { id: 'relic-mid-ne', x: 330, y: -260, ring: 'mid' },
  { id: 'relic-outer-sw', x: -395, y: 395, ring: 'outer' },
  { id: 'relic-mid-nw', x: -340, y: -250, ring: 'mid' },
  { id: 'relic-outer-se', x: 520, y: 215, ring: 'outer' },
  { id: 'relic-inner-n', x: 0, y: -210, ring: 'inner' },
  { id: 'relic-mid-s', x: -95, y: 375, ring: 'mid' },
  { id: 'relic-outer-n', x: 75, y: -555, ring: 'outer' },
  { id: 'relic-inner-e', x: 215, y: 0, ring: 'inner' },
  { id: 'relic-mid-sw', x: -330, y: 265, ring: 'mid' },
  { id: 'relic-outer-ne', x: 400, y: -395, ring: 'outer' },
  { id: 'relic-inner-s', x: 0, y: 220, ring: 'inner' },
  { id: 'relic-mid-n', x: 95, y: -370, ring: 'mid' },
  { id: 'relic-outer-s', x: -75, y: 560, ring: 'outer' },
  { id: 'relic-inner-w', x: -215, y: 0, ring: 'inner' },
  { id: 'relic-mid-se', x: 340, y: 250, ring: 'mid' },
  { id: 'relic-outer-nw', x: -520, y: -215, ring: 'outer' },
];

export function isSpawnPointValid(
  point: Vec2,
  safeZoneRadius: number,
  rocks: readonly RockObstacle[],
  oasis: OasisZone,
  config: GameConfig = DEFAULT_CONFIG
): boolean {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(safeZoneRadius)
  ) {
    return false;
  }

  const distFromCenter = Math.hypot(point.x, point.y);
  const maxAllowedRadius =
    Math.min(config.arenaRadius, safeZoneRadius) - config.relicSafeZoneMargin;
  if (distFromCenter > maxAllowedRadius) {
    return false;
  }

  const distFromOasis = Math.hypot(point.x - oasis.x, point.y - oasis.y);
  if (distFromOasis < oasis.radius + config.relicOasisMargin) {
    return false;
  }

  for (const rock of rocks) {
    const distFromRock = Math.hypot(point.x - rock.x, point.y - rock.y);
    if (distFromRock < rock.radius + config.relicRockMargin) {
      return false;
    }
  }

  return true;
}

function findCandidateForSafeRadius(
  safeRadius: number,
  startCursor: number,
  previousId: string | null,
  rocks: readonly RockObstacle[],
  oasis: OasisZone,
  config: GameConfig,
  spawns: readonly RelicSpawnPoint[]
): ActiveRelic | null {
  const count = spawns.length;
  let fallbackSameIdCandidate: { point: RelicSpawnPoint; index: number } | null =
    null;

  for (let offset = 0; offset < count; offset++) {
    const index = (startCursor + offset) % count;
    const candidate = spawns[index];
    if (isSpawnPointValid(candidate, safeRadius, rocks, oasis, config)) {
      if (candidate.id !== previousId) {
        return {
          id: candidate.id,
          x: candidate.x,
          y: candidate.y,
          pickupRadius: config.relicPickupRadius,
          spawnIndex: index,
          pulsePhase: 0,
        };
      }
      if (!fallbackSameIdCandidate) {
        fallbackSameIdCandidate = { point: candidate, index };
      }
    }
  }

  if (fallbackSameIdCandidate) {
    return {
      id: fallbackSameIdCandidate.point.id,
      x: fallbackSameIdCandidate.point.x,
      y: fallbackSameIdCandidate.point.y,
      pickupRadius: config.relicPickupRadius,
      spawnIndex: fallbackSameIdCandidate.index,
      pulsePhase: 0,
    };
  }

  return null;
}

export function selectNextRelicSpawn(
  state: Pick<
    SimulationState,
    'safeZoneRadius' | 'rocks' | 'oasis' | 'nextSpawnCursor' | 'activeRelic'
  >,
  config: GameConfig = DEFAULT_CONFIG,
  spawns: readonly RelicSpawnPoint[] = AUTHORED_RELIC_SPAWNS
): ActiveRelic {
  const count = spawns.length;
  const startCursor =
    count > 0
      ? ((Math.floor(state.nextSpawnCursor) % count) + count) % count
      : 0;
  const previousId = state.activeRelic?.id ?? null;

  // Compute extra early/mid-game safety buffer so newly spawned relics won't be overtaken by the storm right away
  const shrinkSpan = Math.max(
    1,
    config.initialSafeZoneRadius - config.minSafeZoneRadius
  );
  const shrinkRatio = Math.max(
    0,
    Math.min(
      1,
      (state.safeZoneRadius - config.minSafeZoneRadius) / shrinkSpan
    )
  );
  const bufferedSafeRadius =
    state.safeZoneRadius - (config.earlySpawnExtraMargin ?? 0) * shrinkRatio;

  const bufferedMatch = findCandidateForSafeRadius(
    bufferedSafeRadius,
    startCursor,
    previousId,
    state.rocks,
    state.oasis,
    config,
    spawns
  );
  if (bufferedMatch) {
    return bufferedMatch;
  }

  const standardMatch = findCandidateForSafeRadius(
    state.safeZoneRadius,
    startCursor,
    previousId,
    state.rocks,
    state.oasis,
    config,
    spawns
  );
  if (standardMatch) {
    return standardMatch;
  }

  if (
    isSpawnPointValid(
      FALLBACK_INNER_SPAWN,
      state.safeZoneRadius,
      state.rocks,
      state.oasis,
      config
    )
  ) {
    return {
      id: FALLBACK_INNER_SPAWN.id,
      x: FALLBACK_INNER_SPAWN.x,
      y: FALLBACK_INNER_SPAWN.y,
      pickupRadius: config.relicPickupRadius,
      spawnIndex: startCursor,
      pulsePhase: 0,
    };
  }

  // Emergency deterministic scan along the inner ring if custom obstacles cover FALLBACK_INNER_SPAWN
  const innerRadius = Math.max(
    state.oasis.radius + config.relicOasisMargin + 2,
    Math.min(
      165,
      Math.min(config.arenaRadius, state.safeZoneRadius) -
        config.relicSafeZoneMargin -
        2
    )
  );
  for (let step = 0; step < 36; step++) {
    const angle = -Math.PI / 2 + (step * Math.PI * 2) / 36;
    const candidate: Vec2 = {
      x: Math.round(Math.cos(angle) * innerRadius),
      y: Math.round(Math.sin(angle) * innerRadius),
    };
    if (
      isSpawnPointValid(
        candidate,
        state.safeZoneRadius,
        state.rocks,
        state.oasis,
        config
      )
    ) {
      return {
        id: FALLBACK_INNER_SPAWN.id,
        x: candidate.x,
        y: candidate.y,
        pickupRadius: config.relicPickupRadius,
        spawnIndex: startCursor,
        pulsePhase: 0,
      };
    }
  }

  return {
    id: FALLBACK_INNER_SPAWN.id,
    x: FALLBACK_INNER_SPAWN.x,
    y: FALLBACK_INNER_SPAWN.y,
    pickupRadius: config.relicPickupRadius,
    spawnIndex: startCursor,
    pulsePhase: 0,
  };
}
