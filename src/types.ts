export type GamePhase = 'title' | 'playing' | 'paused' | 'results';

export type EndReason = 'none' | 'time_expired' | 'hull_depleted';

export interface Vec2 {
  x: number;
  y: number;
}

export interface InputState {
  /** Longitudinal input in [-1, 1]: positive = forward throttle, negative = reverse */
  throttle: number;
  /** Steering input in [-1, 1]: negative = left (counter-clockwise in screen-top-down), positive = right (clockwise) */
  steer: number;
  /** Optional screen-relative horizontal direction in [-1, 1]: -1 = left, +1 = right */
  moveX?: number;
  /** Optional screen-relative vertical direction in [-1, 1]: -1 = up, +1 = down */
  moveY?: number;
  /** Handbrake / drift engagement */
  brake: boolean;
  /** Boost activation */
  boost: boolean;
}

export interface RockObstacle {
  id: string;
  x: number;
  y: number;
  radius: number;
  heightShade?: number;
}

export interface OasisZone {
  x: number;
  y: number;
  radius: number;
}

export interface RelicSpawnPoint {
  id: string;
  x: number;
  y: number;
  ring: 'inner' | 'mid' | 'outer';
}

export interface ActiveRelic {
  id: string;
  x: number;
  y: number;
  pickupRadius: number;
  spawnIndex: number;
  pulsePhase: number;
}

export interface BuggyState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angularVelocity: number;
  radius: number;
  speed: number;
  lateralSpeed: number;
  isBoosting: boolean;
  isDrifting: boolean;
}

export interface CollisionEvent {
  x: number;
  y: number;
  normalX: number;
  normalY: number;
  impactSpeed: number;
  damage: number;
  time: number;
}

export interface PickupEvent {
  id: string;
  x: number;
  y: number;
  time: number;
}

export interface DeliveryEvent {
  x: number;
  y: number;
  score: number;
  deliveries: number;
  time: number;
}

export interface BrandPaletteConfig {
  sandLight: string;
  sandMid: string;
  sandDeep: string;
  duneShadow: string;
  oasisWater: string;
  oasisShallow: string;
  oasisFoliage: string;
  relicCore: string;
  relicGlow: string;
  buggyPrimary: string;
  buggyAccent: string;
  boostFlame: string;
  stormWall: string;
  stormDanger: string;
  uiBg: string;
  uiBorder: string;
  uiText: string;
  uiAccent: string;
}

export interface BrandThemeConfig {
  title: string;
  eyebrow: string;
  subtitle: string;
  relicName: string;
  baseName: string;
  palette: BrandPaletteConfig;
}

export interface GameConfig {
  arenaRadius: number;
  roundDurationSeconds: number;
  fixedDt: number;
  maxCatchUpSeconds: number;
  oasisRadius: number;
  maxDeliverySpeed: number;
  deliveryScore: number;
  buggyRadius: number;
  relicPickupRadius: number;
  maxSpeed: number;
  maxReverseSpeed: number;
  maxBoostSpeed: number;
  forwardAccel: number;
  reverseAccel: number;
  boostAccel: number;
  brakeDecel: number;
  longitudinalDrag: number;
  normalLateralGrip: number;
  driftLateralGrip: number;
  steerRate: number;
  driftSteerMultiplier: number;
  stationarySteerAuthority: number;
  maxBoost: number;
  boostDrainPerSecond: number;
  boostRegenPerSecond: number;
  maxHull: number;
  minImpactDamageSpeed: number;
  impactDamageScale: number;
  minImpactDamage: number;
  maxImpactDamage: number;
  collisionCooldownSeconds: number;
  initialSafeZoneRadius: number;
  minSafeZoneRadius: number;
  stormDrainPerSecond: number;
  relicSafeZoneMargin: number;
  earlySpawnExtraMargin: number;
  relicOasisMargin: number;
  relicRockMargin: number;
}

export interface SimulationState {
  phase: GamePhase;
  endReason: EndReason;
  elapsedSeconds: number;
  remainingSeconds: number;
  accumulator: number;
  tickCount: number;
  score: number;
  bestScore: number;
  deliveries: number;
  hull: number;
  boost: number;
  carryingRelic: boolean;
  showSlowDownPrompt: boolean;
  inStorm: boolean;
  safeZoneRadius: number;
  rockCollisionCooldown: number;
  buggy: BuggyState;
  oasis: OasisZone;
  rocks: RockObstacle[];
  activeRelic: ActiveRelic | null;
  nextSpawnCursor: number;
  lastCollision: CollisionEvent | null;
  lastPickup: PickupEvent | null;
  lastDelivery: DeliveryEvent | null;
  objectiveTarget: Vec2;
}
