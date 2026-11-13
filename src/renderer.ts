import type {
  GameConfig,
  SimulationState,
  BuggyState,
  ActiveRelic,
  RockObstacle,
  OasisZone,
} from './types';

export interface Renderer {
  /** Draws one frame. `frameDeltaSeconds` only drives visual smoothing/effects, never gameplay. */
  render: (state: SimulationState, frameDeltaSeconds: number) => void;
  /** Marks the backing store for re-measurement on the next frame. */
  resize: () => void;
  /** Overrides the OS reduced-motion preference (`null` = follow the OS). */
  setReducedMotion: (override: boolean | null) => void;
  /** Removes listeners and releases the offscreen world cache. */
  destroy: () => void;
}

/** Static arena art is cached in an offscreen canvas covering world -950..+950. */
const CACHE_HALF = 950;
const CACHE_SIZE = CACHE_HALF * 2;
const MAX_BACKING_PIXELS = 2_200_000;

const TAU = Math.PI * 2;
const MAX_PARTICLES = 80;
const MAX_SKIDS = 128;

// Sun sits up-and-left, so every shadow is thrown down-and-right.
const SHADOW_ANGLE = 0.72;
const SHADOW_X = Math.cos(SHADOW_ANGLE);
const SHADOW_Y = Math.sin(SHADOW_ANGLE);
const LIGHT_X = -SHADOW_X;
const LIGHT_Y = -SHADOW_Y;

const SHADOW_COLOR = 'rgba(78, 38, 14, 0.30)';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function hash2(ix: number, iy: number, seed = 0): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1103515245);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/** Fills a tapered capsule from (x,y) thrown along the sun's shadow direction. */
function traceShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  baseRadius: number,
  length: number,
  endRadius: number,
): void {
  const ex = x + SHADOW_X * length;
  const ey = y + SHADOW_Y * length;
  const up = SHADOW_ANGLE + Math.PI / 2;
  const down = SHADOW_ANGLE - Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(x + Math.cos(up) * baseRadius, y + Math.sin(up) * baseRadius);
  ctx.lineTo(ex + Math.cos(up) * endRadius, ey + Math.sin(up) * endRadius);
  ctx.arc(ex, ey, endRadius, up, down, true);
  ctx.lineTo(x + Math.cos(down) * baseRadius, y + Math.sin(down) * baseRadius);
  ctx.arc(x, y, baseRadius, down, down - Math.PI, true);
  ctx.closePath();
}

function drawShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  baseRadius: number,
  length: number,
  endRadius: number,
  color: string = SHADOW_COLOR,
): void {
  traceShadow(ctx, x, y, baseRadius, length, endRadius);
  ctx.fillStyle = color;
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Effect pools (fixed size, never grow)
// ---------------------------------------------------------------------------

interface Particle {
  active: boolean;
  /** 0 = dust, 1 = rock spark, 2 = boost ember */
  kind: 0 | 1 | 2;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
}

interface SkidMark {
  seq: number;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  age: number;
  strength: number;
  link: boolean;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function createRenderer(canvas: HTMLCanvasElement, config: GameConfig): Renderer {
  const maybeCtx = canvas.getContext('2d');
  if (!maybeCtx) {
    throw new Error('Canvas 2D context is unavailable');
  }
  const mainCtx: CanvasRenderingContext2D = maybeCtx;
  // All draw helpers use `ctx`. While the static world cache is being built it is
  // temporarily pointed at the offscreen context, then always restored.
  let ctx: CanvasRenderingContext2D = mainCtx;

  // --- size / dpr ---
  let cssW = 1;
  let cssH = 1;
  let dpr = 1;
  let sizeDirty = true;
  const onResize = (): void => {
    sizeDirty = true;
  };
  window.addEventListener('resize', onResize);

  /** Large viewports get a lower DPR cap; total backing pixels are capped too. */
  function pickDpr(w: number, h: number): number {
    const cap = w * h > 1280 * 800 ? 1.5 : 2;
    const byPixels = Math.sqrt(MAX_BACKING_PIXELS / (w * h));
    return Math.max(0.5, Math.min(window.devicePixelRatio || 1, cap, byPixels));
  }

  function applySize(): void {
    const nextW = Math.max(1, window.innerWidth || canvas.clientWidth || 1);
    const nextH = Math.max(1, window.innerHeight || canvas.clientHeight || 1);
    const nextDpr = pickDpr(nextW, nextH);
    if (!sizeDirty && nextDpr === dpr && nextW === cssW && nextH === cssH) return;
    sizeDirty = false;
    dpr = nextDpr;
    cssW = nextW;
    cssH = nextH;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  // --- reduced motion ---
  let osReducedMotion = false;
  let reducedMotionOverride: boolean | null = null;
  let motionQuery: MediaQueryList | null = null;
  const onMotionChange = (event: MediaQueryListEvent): void => {
    osReducedMotion = event.matches;
  };
  try {
    if (typeof window.matchMedia === 'function') {
      motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      osReducedMotion = motionQuery.matches;
      motionQuery.addEventListener('change', onMotionChange);
    }
  } catch {
    motionQuery = null;
  }
  const reducedMotion = (): boolean =>
    reducedMotionOverride !== null ? reducedMotionOverride : osReducedMotion;

  // --- animation clock ---
  let time = 0;

  // --- camera ---
  let camX = 0;
  let camY = 0;
  let camInit = false;
  let zoomBlend = 0;
  let shake = 0;

  // --- deterministic visual randomness (renderer only) ---
  let rngState = 0x2f6e2b1;
  function rand(): number {
    rngState ^= rngState << 13;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5;
    return ((rngState >>> 0) % 100000) / 100000;
  }

  // --- particles ---
  const particles: Particle[] = [];
  for (let i = 0; i < MAX_PARTICLES; i++) {
    particles.push({ active: false, kind: 0, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 1 });
  }
  let particleCursor = 0;
  let dustAccumulator = 0;
  let emberAccumulator = 0;

  function spawnParticle(
    kind: 0 | 1 | 2,
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    size: number,
  ): void {
    particleCursor = (particleCursor + 1) % MAX_PARTICLES;
    const p = particles[particleCursor];
    p.active = true;
    p.kind = kind;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.life = life;
    p.maxLife = life;
    p.size = size;
  }

  // --- skid marks ---
  const skids: SkidMark[] = [];
  for (let i = 0; i < MAX_SKIDS; i++) {
    skids.push({ seq: -1, lx: 0, ly: 0, rx: 0, ry: 0, age: 99, strength: 0, link: false });
  }
  let skidCursor = 0;
  let skidSeq = 0;
  let skidLastX = 0;
  let skidLastY = 0;
  let skidChain = false;
  const SKID_LIFE = 2.4;

  // --- bookkeeping for transitions ---
  let lastTick = -1;
  let seenCollisionKey = '';
  let stormIntensity = 0;

  // --- pickup / delivery celebrations (ages advance with the animation clock) ---
  const PICKUP_FX_SECONDS = 0.55;
  const DELIVERY_FX_SECONDS = 0.85;
  let seenPickupTime: number | null = null;
  let seenDeliveryTime: number | null = null;
  let pickupFx = { active: false, x: 0, y: 0, age: 0 };
  let deliveryFx = { active: false, x: 0, y: 0, age: 0, score: 0 };

  const rockShapes = new Map<string, number[]>();
  function rockShape(rock: RockObstacle): number[] {
    let shape = rockShapes.get(rock.id);
    if (!shape) {
      const seed = strHash(rock.id);
      shape = [];
      const count = 11;
      for (let i = 0; i < count; i++) {
        shape.push(0.93 + 0.07 * hash2(i, seed));
      }
      rockShapes.set(rock.id, shape);
    }
    return shape;
  }

  function collisionKey(state: SimulationState): string {
    const c = state.lastCollision;
    return c ? `${c.time.toFixed(4)}:${c.x.toFixed(2)}:${c.y.toFixed(2)}` : '';
  }

  function resetEffects(state: SimulationState): void {
    for (const p of particles) p.active = false;
    for (const s of skids) {
      s.seq = -1;
      s.age = 99;
    }
    skidChain = false;
    dustAccumulator = 0;
    emberAccumulator = 0;
    shake = 0;
    stormIntensity = 0;
    camInit = false;
    seenCollisionKey = collisionKey(state);
    seenPickupTime = state.lastPickup ? state.lastPickup.time : null;
    seenDeliveryTime = state.lastDelivery ? state.lastDelivery.time : null;
    pickupFx.active = false;
    deliveryFx.active = false;
  }

  /** Starts a celebration the first time a new pickup / delivery event is seen. */
  function detectCelebrations(state: SimulationState): void {
    const pk = state.lastPickup;
    if (!pk) {
      seenPickupTime = null;
    } else if (pk.time !== seenPickupTime) {
      seenPickupTime = pk.time;
      pickupFx = { active: true, x: pk.x, y: pk.y, age: 0 };
    }
    const dl = state.lastDelivery;
    if (!dl) {
      seenDeliveryTime = null;
    } else if (dl.time !== seenDeliveryTime) {
      seenDeliveryTime = dl.time;
      deliveryFx = { active: true, x: dl.x, y: dl.y, age: 0, score: config.deliveryScore };
    }
  }

  // -------------------------------------------------------------------------
  // Effects update
  // -------------------------------------------------------------------------

  function updateEffects(state: SimulationState, dt: number, emit: boolean): void {
    // Age / integrate live particles
    for (const p of particles) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = p.kind === 1 ? 2.2 : 3.2;
      const k = Math.exp(-drag * dt);
      p.vx *= k;
      p.vy *= k;
    }
    for (const s of skids) {
      if (s.seq >= 0) {
        s.age += dt;
        if (s.age > SKID_LIFE) s.seq = -1;
      }
    }
    shake *= Math.exp(-dt * 9);

    if (!emit) return;

    const b = state.buggy;
    const fx = Math.cos(b.angle);
    const fy = Math.sin(b.angle);
    const lx = -fy;
    const ly = fx;
    const speed = Math.hypot(b.vx, b.vy);

    // Dust trail
    let rate = speed > 45 ? (speed / config.maxSpeed) * 26 : 0;
    if (b.isDrifting) rate += 22;
    if (b.isBoosting) rate += 16;
    // Decorative dust is cut by 75% under reduced motion; gameplay cues stay.
    const decor = reducedMotion() ? 0.25 : 1;
    dustAccumulator += rate * decor * dt;
    while (dustAccumulator >= 1) {
      dustAccumulator -= 1;
      const side = (rand() - 0.5) * 20;
      const back = 14 + rand() * 6;
      const outward = b.isDrifting ? Math.sign(b.lateralSpeed || 1) * -26 : 0;
      spawnParticle(
        0,
        b.x - fx * back + lx * side,
        b.y - fy * back + ly * side,
        b.vx * 0.12 - fx * 18 + lx * (outward + (rand() - 0.5) * 30) + (rand() - 0.5) * 16,
        b.vy * 0.12 - fy * 18 + ly * (outward + (rand() - 0.5) * 30) + (rand() - 0.5) * 16,
        0.55 + rand() * 0.45,
        4 + rand() * 4,
      );
    }

    // Boost embers
    if (b.isBoosting) {
      emberAccumulator += 28 * (reducedMotion() ? 0.25 : 1) * dt;
      while (emberAccumulator >= 1) {
        emberAccumulator -= 1;
        const side = (rand() - 0.5) * 26;
        spawnParticle(
          2,
          b.x - fx * 26 + lx * side,
          b.y - fy * 26 + ly * side,
          b.vx * 0.3 - fx * 150 + (rand() - 0.5) * 40,
          b.vy * 0.3 - fy * 150 + (rand() - 0.5) * 40,
          0.22 + rand() * 0.16,
          2 + rand() * 1.8,
        );
      }
    } else {
      emberAccumulator = 0;
    }

    // Skid ribbons
    const sliding = (b.isDrifting || Math.abs(b.lateralSpeed) > 70) && speed > 40;
    if (sliding) {
      const moved = Math.hypot(b.x - skidLastX, b.y - skidLastY);
      if (!skidChain || moved >= 6) {
        const s = skids[skidCursor];
        skidCursor = (skidCursor + 1) % MAX_SKIDS;
        s.seq = ++skidSeq;
        s.lx = b.x - fx * 16 + lx * 13;
        s.ly = b.y - fy * 16 + ly * 13;
        s.rx = b.x - fx * 16 - lx * 13;
        s.ry = b.y - fy * 16 - ly * 13;
        s.age = 0;
        s.strength = clamp(0.35 + Math.abs(b.lateralSpeed) / 220, 0.35, 0.9);
        s.link = skidChain;
        skidChain = true;
        skidLastX = b.x;
        skidLastY = b.y;
      }
    } else {
      skidChain = false;
    }

    // Rock impact sparks
    const key = collisionKey(state);
    if (key !== seenCollisionKey) {
      seenCollisionKey = key;
      const c = state.lastCollision;
      if (c) {
        const baseAngle = Math.atan2(c.normalY, c.normalX);
        for (let i = 0; i < 14; i++) {
          const a = baseAngle + (rand() - 0.5) * 2.4;
          const v = 120 + rand() * 240;
          spawnParticle(1, c.x, c.y, Math.cos(a) * v, Math.sin(a) * v, 0.3 + rand() * 0.3, 1.6 + rand() * 1.4);
        }
        for (let i = 0; i < 6; i++) {
          const a = baseAngle + (rand() - 0.5) * 3;
          const v = 30 + rand() * 80;
          spawnParticle(0, c.x, c.y, Math.cos(a) * v, Math.sin(a) * v, 0.5 + rand() * 0.4, 5 + rand() * 5);
        }
        shake = reducedMotion() ? 0 : Math.min(1, 0.35 + c.impactSpeed / 400);
      }
    }
  }

  // -------------------------------------------------------------------------
  // World layers
  // -------------------------------------------------------------------------

  /** Static sand, dunes, grid, strata, speckle and basin rim. Always drawn for the whole arena. */
  function drawGroundStatic(): void {
    const R = config.arenaRadius;
    const camX = 0;
    const camY = 0;
    const viewHalfW = CACHE_HALF;
    const viewHalfH = CACHE_HALF;
    const scale = 1;

    // Sand disc
    const sand = ctx.createRadialGradient(-80, -100, 40, 0, 0, R);
    sand.addColorStop(0, '#f0cf8a');
    sand.addColorStop(0.55, '#e3b970');
    sand.addColorStop(1, '#cf9a55');
    ctx.fillStyle = sand;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.clip();

    const diag = Math.hypot(viewHalfW, viewHalfH) + 120;

    // Dune ridges: wavy contour bands rotated off-axis, with a shaded lee side.
    const theta = -0.34;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const cu = camX * ct + camY * st;
    const cv = -camX * st + camY * ct;
    const spacing = 96;
    const kMin = Math.floor((cv - diag) / spacing);
    const kMax = Math.ceil((cv + diag) / spacing);
    const step = 56;
    const uStart = Math.floor((cu - diag) / step) * step;
    const uEnd = cu + diag;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 3; pass++) {
      ctx.beginPath();
      for (let k = kMin; k <= kMax; k++) {
        const amp = 20 + 14 * hash2(k, 7);
        const ph = hash2(k, 3) * TAU;
        let first = true;
        for (let u = uStart; u <= uEnd; u += step) {
          let v = k * spacing + amp * Math.sin(u * 0.0105 + ph) + amp * 0.45 * Math.sin(u * 0.027 + ph * 2.3);
          if (pass === 0) {
            v += 7; // lee-side shade offset
          } else if (pass === 1) {
            v += 2;
          }
          const wx = u * ct - v * st;
          const wy = u * st + v * ct;
          if (first) {
            ctx.moveTo(wx, wy);
            first = false;
          } else {
            ctx.lineTo(wx, wy);
          }
        }
      }
      if (pass === 0) {
        ctx.strokeStyle = 'rgba(150, 88, 38, 0.20)';
        ctx.lineWidth = 15;
      } else if (pass === 1) {
        ctx.strokeStyle = 'rgba(176, 108, 48, 0.28)';
        ctx.lineWidth = 3;
      } else {
        ctx.strokeStyle = 'rgba(255, 240, 200, 0.42)';
        ctx.lineWidth = 2.2;
      }
      ctx.stroke();
    }

    // Faint survey grid
    const gridStep = 150;
    ctx.beginPath();
    const gx0 = Math.floor((camX - viewHalfW) / gridStep) * gridStep;
    const gx1 = camX + viewHalfW;
    const gy0 = Math.floor((camY - viewHalfH) / gridStep) * gridStep;
    const gy1 = camY + viewHalfH;
    for (let x = gx0; x <= gx1; x += gridStep) {
      ctx.moveTo(x, camY - viewHalfH);
      ctx.lineTo(x, camY + viewHalfH);
    }
    for (let y = gy0; y <= gy1; y += gridStep) {
      ctx.moveTo(camX - viewHalfW, y);
      ctx.lineTo(camX + viewHalfW, y);
    }
    ctx.strokeStyle = 'rgba(112, 62, 24, 0.09)';
    ctx.lineWidth = 1.5 / scale;
    ctx.stroke();

    // Strata rings
    ctx.lineDashOffset = 0;
    ctx.setLineDash([8, 26]);
    ctx.strokeStyle = 'rgba(112, 62, 24, 0.16)';
    ctx.lineWidth = 2;
    for (const r of [260, 460, 660]) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Sand speckle
    const cell = 46;
    const ix0 = Math.floor((camX - viewHalfW) / cell);
    const ix1 = Math.ceil((camX + viewHalfW) / cell);
    const iy0 = Math.floor((camY - viewHalfH) / cell);
    const iy1 = Math.ceil((camY + viewHalfH) / cell);
    for (let layer = 0; layer < 2; layer++) {
      ctx.beginPath();
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const h = hash2(ix, iy, 11 + layer);
          if (h > 0.62) continue;
          const px = (ix + hash2(ix, iy, 21)) * cell;
          const py = (iy + hash2(ix, iy, 31)) * cell;
          const sz = 1.6 + hash2(ix, iy, 41) * 2.6;
          ctx.rect(px, py, sz, sz * (layer === 0 ? 0.8 : 1));
        }
      }
      ctx.fillStyle = layer === 0 ? 'rgba(120, 70, 30, 0.30)' : 'rgba(255, 242, 205, 0.45)';
      ctx.fill();
    }

    ctx.restore();

    // Basin rim
    ctx.beginPath();
    ctx.arc(0, 0, R + 16, 0, TAU);
    ctx.strokeStyle = 'rgba(88, 48, 22, 0.95)';
    ctx.lineWidth = 34;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, R - 2, 0, TAU);
    ctx.strokeStyle = 'rgba(255, 226, 164, 0.55)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, R + 36, 0, TAU);
    ctx.strokeStyle = 'rgba(54, 28, 12, 0.55)';
    ctx.lineWidth = 22;
    ctx.stroke();
  }

  function drawSkids(): void {
    ctx.lineCap = 'round';
    ctx.lineWidth = 3.2;
    for (let i = 0; i < MAX_SKIDS; i++) {
      const s = skids[i];
      if (s.seq < 0 || !s.link) continue;
      const prev = skids[(i - 1 + MAX_SKIDS) % MAX_SKIDS];
      if (prev.seq !== s.seq - 1) continue;
      const fade = 1 - s.age / SKID_LIFE;
      ctx.strokeStyle = `rgba(92, 50, 22, ${(0.5 * s.strength * fade).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(prev.lx, prev.ly);
      ctx.lineTo(s.lx, s.ly);
      ctx.moveTo(prev.rx, prev.ry);
      ctx.lineTo(s.rx, s.ry);
      ctx.stroke();
    }
  }

  /** Static oasis art: wet-sand halo, shoreline bushes and the pool base. */
  function drawOasisStatic(o: OasisZone): void {
    const R = o.radius;
    ctx.save();
    ctx.translate(o.x, o.y);

    // Palm / shoreline definitions (relative to oasis radius)
    const poolR = R * 0.5;

    // Wet-sand halo
    const wet = ctx.createRadialGradient(0, 0, poolR * 0.9, 0, 0, R * 0.98);
    wet.addColorStop(0, 'rgba(142, 102, 58, 0.85)');
    wet.addColorStop(0.55, 'rgba(190, 144, 82, 0.55)');
    wet.addColorStop(1, 'rgba(214, 170, 100, 0)');
    ctx.fillStyle = wet;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.98, 0, TAU);
    ctx.fill();

    // Shoreline vegetation ring
    const blobs = 26;
    for (let i = 0; i < blobs; i++) {
      const a = (i / blobs) * TAU + hash2(i, 5) * 0.2;
      const r = R * 0.6 + (hash2(i, 9) - 0.5) * R * 0.14;
      const size = 7 + hash2(i, 13) * 6;
      const bx = Math.cos(a) * r;
      const by = Math.sin(a) * r;
      drawShadow(ctx, bx, by, size * 0.6, 12, size * 0.5, 'rgba(40, 40, 12, 0.22)');
      ctx.fillStyle = '#35602a';
      ctx.beginPath();
      ctx.arc(bx, by, size, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#5e8f38';
      ctx.beginPath();
      ctx.arc(bx + LIGHT_X * size * 0.3, by + LIGHT_Y * size * 0.3, size * 0.62, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(176, 214, 96, 0.6)';
      ctx.beginPath();
      ctx.arc(bx + LIGHT_X * size * 0.45, by + LIGHT_Y * size * 0.45, size * 0.26, 0, TAU);
      ctx.fill();
    }

    // Pool
    const water = ctx.createRadialGradient(-poolR * 0.25, -poolR * 0.3, 2, 0, 0, poolR);
    water.addColorStop(0, '#0b3550');
    water.addColorStop(0.6, '#12617b');
    water.addColorStop(1, '#36a3a4');
    ctx.fillStyle = water;
    ctx.beginPath();
    ctx.arc(0, 0, poolR, 0, TAU);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(214, 240, 220, 0.55)';
    ctx.stroke();

    ctx.restore();
  }

  /** Animated oasis layers: pool ripples + glints and the delivery-zone perimeter. */
  function drawOasisDynamic(state: SimulationState): void {
    const o = state.oasis;
    const R = o.radius;
    const poolR = R * 0.5;
    ctx.save();
    ctx.translate(o.x, o.y);

    // Ripples
    ctx.lineWidth = 1.5;
    for (let k = 0; k < 3; k++) {
      const phase = (time * 0.22 + k / 3) % 1;
      const rr = poolR * (0.12 + phase * 0.8);
      ctx.strokeStyle = `rgba(190, 240, 240, ${(0.5 * (1 - phase)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(Math.sin(k * 2.1) * poolR * 0.15, Math.cos(k * 2.1) * poolR * 0.15, rr, 0, TAU);
      ctx.stroke();
    }
    // Glints
    ctx.fillStyle = 'rgba(230, 255, 250, 0.55)';
    for (let i = 0; i < 4; i++) {
      const g = 0.5 + 0.5 * Math.sin(time * 2 + i * 1.9);
      const ga = i * 1.6 + 0.4;
      ctx.beginPath();
      ctx.arc(Math.cos(ga) * poolR * 0.55, Math.sin(ga) * poolR * 0.55, 1.2 + g * 1.4, 0, TAU);
      ctx.fill();
    }

    // Delivery zone perimeter
    const pulse = 0.5 + 0.5 * Math.sin(time * 5);
    if (state.carryingRelic) {
      const glow = ctx.createRadialGradient(0, 0, R * 0.55, 0, 0, R);
      glow.addColorStop(0, 'rgba(255, 220, 110, 0)');
      glow.addColorStop(1, `rgba(255, 214, 90, ${(0.18 + 0.16 * pulse).toFixed(3)})`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, TAU);
      ctx.fill();
      ctx.setLineDash([18, 10]);
      ctx.lineDashOffset = -time * 30;
      ctx.lineWidth = 5 + 3 * pulse;
      ctx.strokeStyle = `rgba(255, 210, 70, ${(0.7 + 0.3 * pulse).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(150, 255, 150, ${(0.35 + 0.35 * pulse).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(0, 0, R - 9, 0, TAU);
      ctx.stroke();
    } else {
      ctx.setLineDash([14, 14]);
      ctx.lineDashOffset = -time * 12;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 246, 218, 0.5)';
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  function drawPalms(state: SimulationState): void {
    const o = state.oasis;
    const palmCount = 5;
    for (let i = 0; i < palmCount; i++) {
      const a = 0.5 + i * (TAU / palmCount);
      const px = o.x + Math.cos(a) * o.radius * 0.72;
      const py = o.y + Math.sin(a) * o.radius * 0.72;
      // Long trunk shadow plus canopy blob at its tip
      drawShadow(ctx, px, py, 2.6, 62, 3.4);
      ctx.fillStyle = SHADOW_COLOR;
      ctx.beginPath();
      ctx.ellipse(px + SHADOW_X * 64, py + SHADOW_Y * 64, 22, 12, SHADOW_ANGLE, 0, TAU);
      ctx.fill();
    }
  }

  function drawPalmTops(state: SimulationState): void {
    const o = state.oasis;
    const palmCount = 5;
    for (let i = 0; i < palmCount; i++) {
      const a = 0.5 + i * (TAU / palmCount);
      const px = o.x + Math.cos(a) * o.radius * 0.72;
      const py = o.y + Math.sin(a) * o.radius * 0.72;
      const sway = Math.sin(time * 1.2 + i) * 0.05;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(sway);
      for (let f = 0; f < 8; f++) {
        const fa = (f / 8) * TAU + i * 0.4;
        const len = 26 + hash2(i, f, 2) * 6;
        const ca = Math.cos(fa);
        const sa = Math.sin(fa);
        const lit = 0.5 + 0.5 * (ca * LIGHT_X + sa * LIGHT_Y);
        ctx.fillStyle = lit > 0.55 ? '#6ea03a' : '#3f7230';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(ca * len * 0.55 - sa * 6, sa * len * 0.55 + ca * 6, ca * len, sa * len);
        ctx.quadraticCurveTo(ca * len * 0.55 + sa * 6, sa * len * 0.55 - ca * 6, 0, 0);
        ctx.fill();
      }
      ctx.fillStyle = '#6b4a22';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#a77a3a';
      ctx.beginPath();
      ctx.arc(LIGHT_X, LIGHT_Y, 2, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawRockShadows(rocks: RockObstacle[]): void {
    for (const r of rocks) {
      drawShadow(ctx, r.x, r.y, r.radius * 0.96, r.radius * 1.9 + 28, r.radius * 0.55);
    }
  }

  function drawRocks(rocks: RockObstacle[]): void {
    for (const r of rocks) {
      const shape = rockShape(r);
      const n = shape.length;
      const shade = r.heightShade ?? 0.5;
      const px: number[] = [];
      const py: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        px.push(r.x + Math.cos(a) * r.radius * shape[i]);
        py.push(r.y + Math.sin(a) * r.radius * shape[i]);
      }
      // Peak shifted toward the sun
      const cx = r.x + LIGHT_X * r.radius * 0.18;
      const cy = r.y + LIGHT_Y * r.radius * 0.18;

      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const mx = (px[i] + px[j]) / 2 - r.x;
        const my = (py[i] + py[j]) / 2 - r.y;
        const ml = Math.hypot(mx, my) || 1;
        const lit = (mx / ml) * LIGHT_X + (my / ml) * LIGHT_Y; // -1..1
        const t = clamp(0.5 + lit * 0.5, 0, 1);
        const rr = Math.round(116 + t * 100 + shade * 14);
        const gg = Math.round(70 + t * 68 + shade * 10);
        const bb = Math.round(40 + t * 40);
        ctx.fillStyle = `rgb(${rr}, ${gg}, ${bb})`;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(px[i], py[i]);
        ctx.lineTo(px[j], py[j]);
        ctx.closePath();
        ctx.fill();
      }

      // Facet seams
      ctx.strokeStyle = 'rgba(70, 36, 16, 0.35)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < n; i += 2) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(px[i], py[i]);
      }
      ctx.stroke();

      // Outline + sun-side highlight
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (i === 0) ctx.moveTo(px[i], py[i]);
        else ctx.lineTo(px[i], py[i]);
      }
      ctx.closePath();
      ctx.strokeStyle = 'rgba(58, 28, 12, 0.7)';
      ctx.lineWidth = 2.4;
      ctx.stroke();

      ctx.beginPath();
      const hl = Math.atan2(LIGHT_Y, LIGHT_X);
      ctx.arc(r.x, r.y, r.radius * 0.88, hl - 0.7, hl + 0.7);
      ctx.strokeStyle = 'rgba(255, 232, 178, 0.6)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Sun glint
      ctx.fillStyle = 'rgba(255, 244, 214, 0.45)';
      ctx.beginPath();
      ctx.ellipse(cx + LIGHT_X * r.radius * 0.28, cy + LIGHT_Y * r.radius * 0.28, r.radius * 0.2, r.radius * 0.1, hl + 0.5, 0, TAU);
      ctx.fill();
    }
  }

  function drawRelic(relic: ActiveRelic): void {
    const pulse = 0.5 + 0.5 * Math.sin(time * 3 + relic.pulsePhase);
    const x = relic.x;
    const y = relic.y;

    // Aura
    const auraR = 64 + 18 * pulse;
    const aura = ctx.createRadialGradient(x, y, 4, x, y, auraR);
    aura.addColorStop(0, `rgba(80, 255, 232, ${(0.55 + 0.2 * pulse).toFixed(3)})`);
    aura.addColorStop(0.45, 'rgba(40, 214, 204, 0.22)');
    aura.addColorStop(1, 'rgba(40, 214, 204, 0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(x, y, auraR, 0, TAU);
    ctx.fill();

    // Pickup radius ring (centre distance at which the buggy collects the relic)
    const pr = config.buggyRadius + relic.pickupRadius;
    ctx.setLineDash([9, 7]);
    ctx.lineDashOffset = -time * 24;
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = `rgba(8, 128, 128, ${(0.6 + 0.3 * pulse).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, pr, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    const ping = (time * 0.6 + relic.pulsePhase) % 1;
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(90, 255, 235, ${(0.6 * (1 - ping)).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, pr + ping * 46, 0, TAU);
    ctx.stroke();

    // Shadow
    drawShadow(ctx, x, y, 9, 34, 4);

    // Crystal
    const bob = Math.sin(time * 2 + relic.pulsePhase) * 3;
    drawCrystal(x, y - 6 + bob, 17, time * 0.8, pulse);

    // Orbiting sparkles
    ctx.fillStyle = 'rgba(240, 255, 252, 0.9)';
    for (let i = 0; i < 4; i++) {
      const a = time * 1.6 + (i * TAU) / 4;
      const sr = pr * 0.78 + Math.sin(time * 3 + i) * 3;
      drawSparkle(x + Math.cos(a) * sr, y + Math.sin(a) * sr, 2.5 + pulse * 1.6);
    }
  }

  function drawSparkle(x: number, y: number, s: number): void {
    ctx.beginPath();
    ctx.moveTo(x, y - s * 1.8);
    ctx.lineTo(x + s * 0.5, y - s * 0.5);
    ctx.lineTo(x + s * 1.8, y);
    ctx.lineTo(x + s * 0.5, y + s * 0.5);
    ctx.lineTo(x, y + s * 1.8);
    ctx.lineTo(x - s * 0.5, y + s * 0.5);
    ctx.lineTo(x - s * 1.8, y);
    ctx.lineTo(x - s * 0.5, y - s * 0.5);
    ctx.closePath();
    ctx.fill();
  }

  function drawCrystal(x: number, y: number, radius: number, rot: number, pulse: number): void {
    const sides = 6;
    const colors = ['#9bfff0', '#2fd4c8', '#12a3a4', '#c8fff7', '#22bdb6', '#0d8d92'];
    for (let i = 0; i < sides; i++) {
      const a0 = rot + (i / sides) * TAU;
      const a1 = rot + ((i + 1) / sides) * TAU;
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a0) * radius, y + Math.sin(a0) * radius * 0.9);
      ctx.lineTo(x + Math.cos(a1) * radius, y + Math.sin(a1) * radius * 0.9);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(6, 80, 84, 0.85)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * TAU;
      const vx = x + Math.cos(a) * radius;
      const vy = y + Math.sin(a) * radius * 0.9;
      if (i === 0) ctx.moveTo(vx, vy);
      else ctx.lineTo(vx, vy);
    }
    ctx.closePath();
    ctx.stroke();
    // inner core
    const core = ctx.createRadialGradient(x, y, 0, x, y, radius * 0.6);
    core.addColorStop(0, 'rgba(255, 255, 255, 1)');
    core.addColorStop(0.5, `rgba(190, 255, 246, ${(0.7 + 0.3 * pulse).toFixed(3)})`);
    core.addColorStop(1, 'rgba(120, 255, 236, 0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.6, 0, TAU);
    ctx.fill();
  }

  function traceChassis(): void {
    ctx.beginPath();
    ctx.moveTo(28, 0);
    ctx.lineTo(19, -8);
    ctx.lineTo(8, -12);
    ctx.lineTo(-12, -14);
    ctx.lineTo(-22, -11);
    ctx.lineTo(-25, -5);
    ctx.lineTo(-25, 5);
    ctx.lineTo(-22, 11);
    ctx.lineTo(-12, 14);
    ctx.lineTo(8, 12);
    ctx.lineTo(19, 8);
    ctx.closePath();
  }

  const BUGGY_K = 0.85;

  function drawBuggyShadow(b: BuggyState): void {
    const hover = 12;
    ctx.save();
    ctx.translate(b.x + SHADOW_X * hover, b.y + SHADOW_Y * hover);
    ctx.rotate(b.angle);
    ctx.scale(BUGGY_K, BUGGY_K);
    traceChassis();
    ctx.fillStyle = 'rgba(70, 34, 12, 0.30)';
    ctx.fill();
    ctx.restore();
    // Tight contact shadow right under the hover skirt
    ctx.save();
    ctx.translate(b.x + SHADOW_X * 3, b.y + SHADOW_Y * 3);
    ctx.rotate(b.angle);
    ctx.scale(BUGGY_K * 0.95, BUGGY_K * 0.9);
    traceChassis();
    ctx.fillStyle = 'rgba(70, 34, 12, 0.22)';
    ctx.fill();
    ctx.restore();
  }

  function drawPlume(originX: number, originY: number, length: number, width: number): void {
    const g = ctx.createLinearGradient(originX, originY, originX - length, originY);
    g.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    g.addColorStop(0.22, 'rgba(120, 236, 255, 0.9)');
    g.addColorStop(0.6, 'rgba(255, 152, 44, 0.7)');
    g.addColorStop(1, 'rgba(255, 92, 20, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(originX, originY - width);
    ctx.quadraticCurveTo(originX - length * 0.55, originY - width * 0.65, originX - length, originY);
    ctx.quadraticCurveTo(originX - length * 0.55, originY + width * 0.65, originX, originY + width);
    ctx.closePath();
    ctx.fill();
  }

  function drawBuggy(state: SimulationState): void {
    const b = state.buggy;
    const bob = 1 + Math.sin(time * 9) * 0.012;

    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    ctx.scale(BUGGY_K * bob, BUGGY_K * bob);

    // Hover glow on the sand
    const glow = ctx.createRadialGradient(0, 0, 6, 0, 0, 34);
    glow.addColorStop(0, 'rgba(120, 230, 240, 0.28)');
    glow.addColorStop(1, 'rgba(120, 230, 240, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(-2, 0, 34, 24, 0, 0, TAU);
    ctx.fill();

    // Boost plumes
    if (b.isBoosting) {
      const flick = 0.5 + 0.5 * Math.sin(time * 70) * 0.6 + 0.2 * Math.sin(time * 33);
      const prev = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter';
      drawPlume(-26, 15, 30 + 18 * flick, 4.5);
      drawPlume(-26, -15, 30 + 18 * flick, 4.5);
      drawPlume(-25, 0, 22 + 12 * flick, 5.5);
      ctx.globalCompositeOperation = prev;
    }

    // Side pods
    for (const side of [-1, 1]) {
      ctx.fillStyle = '#5b3818';
      ctx.beginPath();
      ctx.roundRect(-27, side * 15 - 4.5, 26, 9, 4);
      ctx.fill();
      ctx.fillStyle = '#9a6733';
      ctx.beginPath();
      ctx.roundRect(-25, side * 15 - 3.5, 20, 3.2, 1.6);
      ctx.fill();
      // thruster nozzle
      ctx.fillStyle = b.isBoosting ? '#ffd9a0' : '#8fe6f0';
      ctx.beginPath();
      ctx.arc(-27, side * 15, b.isBoosting ? 4.2 : 3, 0, TAU);
      ctx.fill();
      // strut
      ctx.strokeStyle = '#4a2c12';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(-12, side * 10);
      ctx.lineTo(-12, side * 14);
      ctx.stroke();
    }

    // Chassis
    traceChassis();
    const body = ctx.createLinearGradient(0, -14, 0, 14);
    body.addColorStop(0, '#e6aa68');
    body.addColorStop(0.5, '#c18040');
    body.addColorStop(1, '#8a5424');
    ctx.fillStyle = body;
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = '#47260e';
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Hood stripe + nose cap
    ctx.fillStyle = '#f3d49a';
    ctx.beginPath();
    ctx.moveTo(27, 0);
    ctx.lineTo(14, -2.4);
    ctx.lineTo(14, 2.4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 232, 178, 0.75)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(12, -6.5);
    ctx.lineTo(-18, -8);
    ctx.moveTo(12, 6.5);
    ctx.lineTo(-18, 8);
    ctx.stroke();

    // Canopy
    const glass = ctx.createLinearGradient(-6, -7, 8, 7);
    glass.addColorStop(0, '#53b9c1');
    glass.addColorStop(1, '#0e3a46');
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.ellipse(2, 0, 9.5, 6.4, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#2d1a0a';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.beginPath();
    ctx.ellipse(4, -2.4, 4, 1.4, -0.2, 0, TAU);
    ctx.fill();

    // Headlamps
    ctx.fillStyle = '#fff2c4';
    ctx.beginPath();
    ctx.arc(21, -4.2, 1.7, 0, TAU);
    ctx.arc(21, 4.2, 1.7, 0, TAU);
    ctx.fill();

    // Relic on the rear deck while carrying
    if (state.carryingRelic) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 6);
      const auraG = ctx.createRadialGradient(-12, 0, 1, -12, 0, 20);
      auraG.addColorStop(0, `rgba(120, 255, 238, ${(0.6 + 0.3 * pulse).toFixed(3)})`);
      auraG.addColorStop(1, 'rgba(60, 230, 214, 0)');
      ctx.fillStyle = auraG;
      ctx.beginPath();
      ctx.arc(-12, 0, 20, 0, TAU);
      ctx.fill();
      drawCrystal(-12, 0, 7, -b.angle + time * 1.4, pulse);
    }

    ctx.restore();
  }

  function drawParticles(kinds: 'dust' | 'bright'): void {
    if (kinds === 'dust') {
      for (const p of particles) {
        if (!p.active || p.kind !== 0) continue;
        const t = 1 - p.life / p.maxLife;
        const a = 0.42 * Math.pow(1 - t, 1.3);
        ctx.fillStyle = `rgba(236, 206, 150, ${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 + 1.8 * t), 0, TAU);
        ctx.fill();
      }
      return;
    }
    ctx.lineCap = 'round';
    for (const p of particles) {
      if (!p.active || p.kind === 0) continue;
      const t = p.life / p.maxLife;
      if (p.kind === 1) {
        ctx.strokeStyle = `rgba(255, ${Math.round(150 + 90 * t)}, 80, ${t.toFixed(3)})`;
        ctx.lineWidth = p.size;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(255, ${Math.round(120 + 100 * t)}, 60, ${(0.8 * t).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * t + 0.6, 0, TAU);
        ctx.fill();
      }
    }
  }

  function drawStormBand(innerR: number, outerR: number, style: string): void {
    // Thick ring stroke = filled annulus, without clip regions or full-screen gradients.
    ctx.strokeStyle = style;
    ctx.lineWidth = outerR - innerR;
    ctx.beginPath();
    ctx.arc(0, 0, (innerR + outerR) / 2, 0, TAU);
    ctx.stroke();
  }

  function drawStorm(state: SimulationState): void {
    const safeR = Math.max(1, state.safeZoneRadius);
    const farR = config.arenaRadius + 600;

    // Layered dust wall: each ring reaches outward past the arena, so alpha accumulates with depth.
    ctx.setLineDash([]);
    drawStormBand(safeR, farR, 'rgba(226, 156, 60, 0.34)');
    drawStormBand(safeR + 80, farR, 'rgba(184, 108, 38, 0.34)');
    drawStormBand(safeR + 220, farR, 'rgba(118, 64, 26, 0.40)');

    // Swirling dust streaks
    ctx.lineCap = 'round';
    const streaks = 40;
    for (let i = 0; i < streaks; i++) {
      const offset = 22 + hash2(i, 1) * 270;
      const rad = safeR + offset;
      const speed = (0.22 + hash2(i, 2) * 0.3) * (260 / rad) * 2.4;
      const ang = hash2(i, 3) * TAU + time * speed;
      const len = (50 + hash2(i, 4) * 190) / rad;
      const warm = hash2(i, 5) > 0.5;
      ctx.strokeStyle = warm
        ? `rgba(255, 206, 120, ${(0.14 + 0.16 * hash2(i, 6)).toFixed(3)})`
        : `rgba(250, 232, 190, ${(0.10 + 0.14 * hash2(i, 7)).toFixed(3)})`;
      ctx.lineWidth = 5 + hash2(i, 8) * 18;
      ctx.beginPath();
      ctx.arc(0, 0, rad, ang, ang + len);
      ctx.stroke();
    }
    // Boundary ring
    const b = state.buggy;
    const toEdge = safeR - Math.hypot(b.x, b.y);
    const danger = state.inStorm ? 1 : clamp(1 - toEdge / 140, 0, 1);
    const pulse = 0.5 + 0.5 * Math.sin(time * (3 + danger * 6));

    ctx.setLineDash([]);
    ctx.lineWidth = 22;
    ctx.strokeStyle = `rgba(255, ${Math.round(190 - 80 * danger)}, 70, ${(0.10 + 0.10 * danger).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(0, 0, safeR, 0, TAU);
    ctx.stroke();

    ctx.setLineDash([26, 14]);
    ctx.lineDashOffset = -time * 40;
    ctx.lineWidth = 5;
    ctx.strokeStyle = `rgba(255, ${Math.round(214 - 100 * danger)}, ${Math.round(110 - 50 * danger)}, ${(0.65 + 0.3 * pulse).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(0, 0, safeR, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawCompass(state: SimulationState): void {
    const b = state.buggy;
    const tx = state.objectiveTarget.x - b.x;
    const ty = state.objectiveTarget.y - b.y;
    const dist = Math.hypot(tx, ty);
    const fade = clamp((dist - 90) / 90, 0, 1);
    if (fade <= 0.01) return;
    const ang = Math.atan2(ty, tx);
    const carrying = state.carryingRelic;
    const main = carrying ? '#ffd24a' : '#3ff0dc';
    const glow = carrying ? 'rgba(160, 255, 140, 0.9)' : 'rgba(210, 255, 250, 0.9)';
    const pulse = 0.5 + 0.5 * Math.sin(time * 6);

    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(ang);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < 3; i++) {
      const d = 56 + i * 15 + pulse * 3;
      const a = fade * (1 - i * 0.24);
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.moveTo(d - 7, -10);
      ctx.lineTo(d + 5, 0);
      ctx.lineTo(d - 7, 10);
      ctx.strokeStyle = 'rgba(52, 26, 8, 0.85)';
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = i === 0 ? glow : main;
      ctx.lineWidth = 3.6;
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------
  // Screen-space overlays
  // -------------------------------------------------------------------------

  function drawScreenOverlays(state: SimulationState, dt: number): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Warm baseline vignette
    const vig = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.45, cssW / 2, cssH / 2, Math.hypot(cssW, cssH) * 0.55);
    vig.addColorStop(0, 'rgba(60, 24, 6, 0)');
    vig.addColorStop(1, 'rgba(60, 24, 6, 0.32)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, cssW, cssH);

    const target = state.inStorm && state.phase === 'playing' ? 1 : state.inStorm ? stormIntensity : 0;
    stormIntensity += (target - stormIntensity) * (1 - Math.exp(-dt * 4));
    if (stormIntensity < 0.01) return;
    const si = stormIntensity;
    const pulse = 0.85 + 0.15 * Math.sin(time * 6);
    const storm = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.28, cssW / 2, cssH / 2, Math.hypot(cssW, cssH) * 0.55);
    storm.addColorStop(0, 'rgba(210, 130, 40, 0)');
    storm.addColorStop(0.55, `rgba(196, 112, 34, ${(0.12 * si).toFixed(3)})`);
    storm.addColorStop(1, `rgba(150, 66, 18, ${(0.7 * si * pulse).toFixed(3)})`);
    ctx.fillStyle = storm;
    ctx.fillRect(0, 0, cssW, cssH);

    // Wind streaks (skipped under reduced motion)
    if (reducedMotion()) return;
    ctx.lineCap = 'round';
    ctx.lineWidth = 2;
    for (let i = 0; i < 20; i++) {
      const speed = 420 + hash2(i, 1) * 520;
      const len = 90 + hash2(i, 2) * 200;
      const x = ((hash2(i, 3) * (cssW + 400) + time * speed) % (cssW + 400)) - 200;
      const y = hash2(i, 4) * cssH;
      ctx.strokeStyle = `rgba(255, 224, 168, ${(0.2 * si * (0.4 + hash2(i, 5))).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - len, y - len * 0.12);
      ctx.stroke();
    }
  }

  // -------------------------------------------------------------------------
  // Celebrations
  // -------------------------------------------------------------------------

  function drawCelebrations(state: SimulationState): void {
    if (pickupFx.active) {
      const t = clamp(pickupFx.age / PICKUP_FX_SECONDS, 0, 1);
      const e = 1 - Math.pow(1 - t, 3);
      const fade = 1 - t;
      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(70, 240, 222, ${(0.9 * fade).toFixed(3)})`;
      ctx.lineWidth = 1.5 + 5 * fade;
      ctx.beginPath();
      ctx.arc(pickupFx.x, pickupFx.y, 18 + 92 * e, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = `rgba(220, 255, 250, ${(0.7 * fade).toFixed(3)})`;
      ctx.lineWidth = 1 + 2 * fade;
      ctx.beginPath();
      ctx.arc(pickupFx.x, pickupFx.y, 10 + 58 * e, 0, TAU);
      ctx.stroke();
      if (!reducedMotion()) {
        ctx.fillStyle = `rgba(214, 255, 248, ${fade.toFixed(3)})`;
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * TAU + 0.3;
          const r = 24 + 76 * e;
          drawSparkle(pickupFx.x + Math.cos(a) * r, pickupFx.y + Math.sin(a) * r, 1 + 2.4 * fade);
        }
      }
    }

    if (deliveryFx.active) {
      const o = state.oasis;
      const t = clamp(deliveryFx.age / DELIVERY_FX_SECONDS, 0, 1);
      const e = 1 - Math.pow(1 - t, 3);
      const t2 = clamp((deliveryFx.age - 0.1) / (DELIVERY_FX_SECONDS - 0.1), 0, 1);
      const e2 = 1 - Math.pow(1 - t2, 3);
      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(255, 214, 80, ${(0.95 * (1 - t)).toFixed(3)})`;
      ctx.lineWidth = 2 + 8 * (1 - t);
      ctx.beginPath();
      ctx.arc(o.x, o.y, 30 + (o.radius * 1.5 - 30) * e, 0, TAU);
      ctx.stroke();
      if (t2 < 1) {
        ctx.strokeStyle = `rgba(90, 232, 150, ${(0.9 * (1 - t2)).toFixed(3)})`;
        ctx.lineWidth = 2 + 6 * (1 - t2);
        ctx.beginPath();
        ctx.arc(o.x, o.y, 20 + (o.radius * 1.25 - 20) * e2, 0, TAU);
        ctx.stroke();
      }

      const textAlpha = t < 0.7 ? 1 : (1 - t) / 0.3;
      ctx.save();
      ctx.globalAlpha = clamp(textAlpha, 0, 1);
      ctx.font = 'bold 36px Bahnschrift, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      const label = `+${deliveryFx.score}`;
      const ty = deliveryFx.y - 34 - 70 * e;
      ctx.strokeStyle = 'rgba(48, 24, 6, 0.9)';
      ctx.lineWidth = 6;
      ctx.strokeText(label, deliveryFx.x, ty);
      ctx.fillStyle = '#ffd84a';
      ctx.fillText(label, deliveryFx.x, ty);
      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // Static world cache
  // -------------------------------------------------------------------------

  let staticCanvas: HTMLCanvasElement | null = null;
  let staticScale = 0;
  let staticSignature = '';
  let staticFailed = false;
  let cachedRocksRef: RockObstacle[] | null = null;
  let cachedOasisRef: OasisZone | null = null;

  function drawStaticWorldContents(rocks: RockObstacle[], oasis: OasisZone): void {
    drawGroundStatic();
    drawOasisStatic(oasis);
    drawRockShadows(rocks);
    drawRocks(rocks);
  }

  function worldSignature(state: SimulationState): string {
    const o = state.oasis;
    let sig = `${o.x},${o.y},${o.radius}|${config.arenaRadius}`;
    for (const r of state.rocks) {
      sig += `|${r.id}:${r.x},${r.y},${r.radius},${r.heightShade ?? ''}`;
    }
    return sig;
  }

  /** Builds (or reuses) the offscreen static arena. Returns false if unavailable. */
  function ensureStaticWorld(state: SimulationState): boolean {
    if (staticFailed) return false;
    const k = cssW * cssH > 700 * 700 ? 1.5 : 1;
    if (
      staticCanvas &&
      k === staticScale &&
      state.rocks === cachedRocksRef &&
      state.oasis === cachedOasisRef
    ) {
      return true;
    }
    // New object references (e.g. after a restart) usually describe the identical map.
    const sig = worldSignature(state);
    if (staticCanvas && k === staticScale && sig === staticSignature) {
      cachedRocksRef = state.rocks;
      cachedOasisRef = state.oasis;
      return true;
    }
    try {
      const c = staticCanvas ?? document.createElement('canvas');
      c.width = Math.round(CACHE_SIZE * k);
      c.height = Math.round(CACHE_SIZE * k);
      const sctx = c.getContext('2d');
      if (!sctx) throw new Error('offscreen 2D context unavailable');
      ctx = sctx;
      try {
        ctx.setTransform(k, 0, 0, k, CACHE_HALF * k, CACHE_HALF * k);
        drawStaticWorldContents(state.rocks, state.oasis);
      } finally {
        ctx = mainCtx;
      }
      staticCanvas = c;
      staticScale = k;
      staticSignature = sig;
      cachedRocksRef = state.rocks;
      cachedOasisRef = state.oasis;
      return true;
    } catch {
      ctx = mainCtx;
      staticCanvas = null;
      staticFailed = true;
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Main render
  // -------------------------------------------------------------------------

  function render(state: SimulationState, frameDeltaSeconds: number): void {
    applySize();
    const dt = clamp(Number.isFinite(frameDeltaSeconds) ? frameDeltaSeconds : 0, 0, 0.05);
    const paused = state.phase === 'paused';

    // New run detection (tick counter went backwards)
    if (state.tickCount < lastTick) resetEffects(state);
    lastTick = state.tickCount;
    if (!paused) detectCelebrations(state);

    if (!paused) time += dt;
    if (!paused) updateEffects(state, dt, state.phase === 'playing');
    if (!paused) {
      if (pickupFx.active) {
        pickupFx.age += dt;
        if (pickupFx.age >= PICKUP_FX_SECONDS) pickupFx.active = false;
      }
      if (deliveryFx.active) {
        deliveryFx.age += dt;
        if (deliveryFx.age >= DELIVERY_FX_SECONDS) deliveryFx.active = false;
      }
    }

    // Camera ------------------------------------------------------------
    const b = state.buggy;
    const baseScale = Math.max(0.55, Math.min(cssW, cssH) / 720);
    const speed = Math.hypot(b.vx, b.vy);
    zoomBlend += (clamp(speed / config.maxBoostSpeed, 0, 1) - zoomBlend) * (1 - Math.exp(-dt * 2));
    const scale = baseScale * (1 - 0.09 * zoomBlend);

    const lookX = clamp(b.vx * 0.28, -150, 150);
    const lookY = clamp(b.vy * 0.28, -150, 150);
    const tx = b.x + lookX;
    const ty = b.y + lookY;
    if (!camInit || Math.hypot(tx - camX, ty - camY) > 500) {
      camX = tx;
      camY = ty;
      camInit = true;
    } else if (!paused) {
      const k = 1 - Math.exp(-dt * 5.5);
      camX += (tx - camX) * k;
      camY += (ty - camY) * k;
    }
    const shakeOn = shake > 0.01 && !reducedMotion();
    const shakeX = shakeOn ? Math.sin(time * 91) * shake * 7 : 0;
    const shakeY = shakeOn ? Math.cos(time * 77) * shake * 7 : 0;

    // Background beyond the basin
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#3e2412';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // World transform
    const s = dpr * scale;
    ctx.setTransform(
      s,
      0,
      0,
      s,
      dpr * (cssW / 2 - (camX + shakeX) * scale),
      dpr * (cssH / 2 - (camY + shakeY) * scale),
    );

    if (ensureStaticWorld(state)) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(staticCanvas as HTMLCanvasElement, -CACHE_HALF, -CACHE_HALF, CACHE_SIZE, CACHE_SIZE);
    } else {
      // Offscreen cache unavailable: draw the static art directly (slower, same picture).
      drawStaticWorldContents(state.rocks, state.oasis);
    }
    drawSkids();
    drawOasisDynamic(state);
    drawPalms(state);
    if (state.activeRelic && !state.carryingRelic) drawRelic(state.activeRelic);
    drawBuggyShadow(b);
    drawPalmTops(state);
    drawParticles('dust');
    drawStorm(state);
    if (state.phase === 'playing' || state.phase === 'paused') drawCompass(state);
    drawBuggy(state);
    drawParticles('bright');
    drawCelebrations(state);
    drawScreenOverlays(state, dt);
  }

  return {
    render,
    resize: onResize,
    setReducedMotion: (override: boolean | null) => {
      reducedMotionOverride = override;
    },
    destroy: () => {
      window.removeEventListener('resize', onResize);
      if (motionQuery) motionQuery.removeEventListener('change', onMotionChange);
      if (staticCanvas) {
        staticCanvas.width = 0;
        staticCanvas.height = 0;
        staticCanvas = null;
      }
    },
  };
}
