/**
 * Canvas-only gradient fire/smoke particle effect.
 *
 * Adapted from a mouse-following gas/flame demo into a reusable emitter:
 * no globals, no Stage/dat.GUI dependency, and no pointer target. Coordinates
 * are world/canvas pixels with `x/y` as the bottom-center of the fire source.
 */
export interface LoFiFireOptions {
  x: number;
  y: number;
  /** Approximate base width of the fire in pixels. */
  width?: number;
  /** Approximate rise height in pixels; controls upward velocity. */
  height?: number;
  /** Relative spawn intensity. Usually 0.5 to 3. */
  density?: number;
  /** Optional seconds before the emitter stops creating new particles. */
  duration?: number;
  /** Direction in degrees. 0 is upward, 90 is right. */
  direction?: number;
  /** Spread in degrees around `direction`. */
  directionSpread?: number;
}

export interface LoFiFire {
  x: number;
  y: number;
  width: number;
  height: number;
  density: number;
  duration: number;
  elapsed: number;
  emitting: boolean;
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D): void;
  stop(): void;
  isFinished(): boolean;
  setPosition(x: number, y: number): void;
  setSize(width: number, height: number): void;
  setDensity(density: number): void;
}

type GradientStop = {
  radius: number;
  r: number;
  g: number;
  b: number;
  a: number;
};

type GradientKeyframe = {
  position: number;
  start: Partial<GradientStop> & Pick<GradientStop, 'radius'>;
  middle?: Partial<GradientStop> & Pick<GradientStop, 'radius'>;
  end: Partial<GradientStop> & Pick<GradientStop, 'radius'>;
};

type ExpandedKeyframe = {
  position: number;
  start: GradientStop;
  middle: GradientStop;
  end: GradientStop;
};

interface GasParticle {
  remove: boolean;
  x: number;
  y: number;
  size: number;
  speedX: number;
  speedY: number;
  lifespan: number;
  age: number;
}

const TO_RAD = Math.PI / 180;
const FRAME_MS = 1000 / 60;
const GRADIENT_FRAME_COUNT = 120;
const DEFAULT_SPAWN_DELAY_MS = 30;
const DEFAULT_VELOCITY_SPREAD = 0.65;
const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
const lerp = (a: number, b: number, t: number): number => (b - a) * t + a;

export function createLoFiFire(options: LoFiFireOptions): LoFiFire {
  const gas: GasParticle[] = [];
  const gasPool: GasParticle[] = [];

  let spawnCounterMs = 0;
  let gasRadius = computeGasRadius(options.width ?? 48, options.height ?? 64);
  let gradientSprites = generateFlameGradientSprites(gasRadius);
  let direction = options.direction ?? 0;
  let directionSpread = options.directionSpread ?? 92;

  const fire: LoFiFire = {
    x: options.x,
    y: options.y,
    width: options.width ?? 48,
    height: options.height ?? Math.max(64, (options.width ?? 48) * 1.2),
    density: options.density ?? 1,
    duration: options.duration ?? Infinity,
    elapsed: 0,
    emitting: true,

    update(dt: number) {
      const dtMs = Math.max(0, dt * 1000);
      const simSpeed = dtMs / FRAME_MS;
      this.elapsed += dt;
      if (this.elapsed >= this.duration) this.emitting = false;

      if (this.emitting && this.density > 0) {
        spawnCounterMs += dtMs;
        while (spawnCounterMs >= DEFAULT_SPAWN_DELAY_MS) {
          spawnCounterMs -= DEFAULT_SPAWN_DELAY_MS;
          emitGasBatch(this, gas, gasPool, gasRadius, direction, directionSpread);
        }
      }

      updateGas(gas, gasPool, simSpeed, dtMs);
    },

    draw(ctx: CanvasRenderingContext2D) {
      ctx.save();
      for (let i = gas.length - 1; i >= 0; i--) {
        const g = gas[i]!;
        const life = clamp(g.age / g.lifespan, 0, 1);
        const spriteIndex = Math.floor(life * (gradientSprites.length - 1));
        const sprite = gradientSprites[spriteIndex] ?? gradientSprites[gradientSprites.length - 1];
        if (!sprite) continue;
        ctx.drawImage(sprite, g.x - g.size, g.y - g.size, g.size * 2, g.size * 2);
      }
      ctx.restore();
    },

    stop() {
      this.emitting = false;
    },

    isFinished(): boolean {
      return !this.emitting && gas.length === 0;
    },

    setPosition(x: number, y: number) {
      this.x = x;
      this.y = y;
    },

    setSize(width: number, height: number) {
      this.width = width;
      this.height = height;
      const nextRadius = computeGasRadius(width, height);
      if (Math.abs(nextRadius - gasRadius) >= 1) {
        gasRadius = nextRadius;
        gradientSprites = generateFlameGradientSprites(gasRadius);
        for (const g of gas) g.size = gasRadius;
      }
    },

    setDensity(density: number) {
      this.density = density;
    },
  };

  return fire;
}

function computeGasRadius(width: number, height: number): number {
  return clamp(Math.min(width * 0.18, height * 0.62), 8, 42);
}

function computeVelocity(height: number): number {
  return clamp(height / 22, 1.4, 6);
}

function emitGasBatch(
  emitter: LoFiFire,
  gas: GasParticle[],
  gasPool: GasParticle[],
  gasRadius: number,
  direction: number,
  directionSpread: number
): void {
  const density = clamp(emitter.density, 0, 4);
  const gasCount = Math.max(2, Math.round(6 * density));
  const baseAngle = (direction - directionSpread / 2) * TO_RAD;
  const rotateIncrement = (directionSpread * TO_RAD) / gasCount;
  const speed = computeVelocity(emitter.height);
  const maxParticles = Math.ceil(120 * Math.max(0.4, density) * clamp(emitter.width / 48, 0.6, 3));
  const baseHalf = Math.max(1, emitter.width * 0.5);
  const sideLift = Math.max(4, Math.min(18, emitter.height * 0.32));
  const baseJitterY = Math.max(2, gasRadius * 0.18);

  for (let i = 0; i < gasCount && gas.length < maxParticles; i++) {
    const subAngle = baseAngle + rotateIncrement * i + Math.random() * rotateIncrement;
    const rand = Math.random();
    const subSpeed = speed * (1 - (1 - rand * rand) * DEFAULT_VELOCITY_SPREAD);
    const spreadX = (Math.random() - 0.5) * emitter.width;
    const edge = Math.abs(spreadX) / baseHalf;
    const isoBaseY = emitter.y - edge * sideLift;
    const baseY = isoBaseY + (Math.random() - 0.5) * baseJitterY;
    const inwardPull = -Math.sign(spreadX) * edge * speed * 0.18;

    gas.push(
      newGasParticle(gasPool, {
        x: emitter.x + spreadX,
        y: baseY,
        size: gasRadius * (0.78 + Math.random() * 0.34),
        speedX: Math.sin(subAngle) * subSpeed + inwardPull,
        speedY: -Math.cos(subAngle) * subSpeed,
      })
    );
  }
}

function newGasParticle(
  gasPool: GasParticle[],
  init: { x: number; y: number; size: number; speedX: number; speedY: number }
): GasParticle {
  const g = gasPool.pop() ?? {
    remove: false,
    x: 0,
    y: 0,
    size: 0,
    speedX: 0,
    speedY: 0,
    lifespan: 0,
    age: 0,
  };

  g.remove = false;
  g.age = 0;
  g.lifespan = Math.floor(Math.random() * 420 + 760);
  g.size = init.size;
  g.x = init.x;
  g.y = init.y;
  g.speedX = init.speedX;
  g.speedY = init.speedY;
  return g;
}

function updateGas(
  gas: GasParticle[],
  gasPool: GasParticle[],
  simSpeed: number,
  dtMs: number
): void {
  const damp = Math.max(0, 1 - 0.04 * simSpeed);
  const gravity = 0.14;

  for (let i = gas.length - 1; i >= 0; i--) {
    const g = gas[i]!;
    g.age += dtMs;
    g.x += g.speedX * simSpeed;
    g.y += g.speedY * simSpeed;
    g.speedX += Math.sin((g.age + g.y) * 0.012) * 0.012 * simSpeed;
    g.speedX *= damp;
    g.speedY = g.speedY * damp - gravity * simSpeed;

    if (g.age >= g.lifespan) {
      gas.splice(i, 1);
      recycleGasParticle(gasPool, g);
    }
  }
}

function recycleGasParticle(gasPool: GasParticle[], g: GasParticle): void {
  g.remove = false;
  gasPool.push(g);
}

function generateFlameGradientSprites(gasRadius: number): HTMLCanvasElement[] {
  const expanded = expandKeyframes(buildGradientKeyframes());
  const sprites: HTMLCanvasElement[] = [];

  for (let i = 1; i < expanded.length; i++) {
    const lastFrame = expanded[i - 1]!;
    const thisFrame = expanded[i]!;
    const frameBatchSize = Math.max(
      1,
      Math.floor((thisFrame.position - lastFrame.position) * GRADIENT_FRAME_COUNT)
    );

    for (let j = 1; j <= frameBatchSize; j++) {
      const t = j / frameBatchSize;
      sprites.push(
        renderGradientSprite(gasRadius, {
          start: interpolateStop(lastFrame.start, thisFrame.start, t),
          middle: interpolateStop(lastFrame.middle, thisFrame.middle, t),
          end: interpolateStop(lastFrame.end, thisFrame.end, t),
        })
      );
    }
  }

  return sprites;
}

function buildGradientKeyframes(): GradientKeyframe[] {
  return [
    {
      position: 0,
      start: { radius: 0.2, r: 1, g: 0.72, b: 0.16, a: 0.55 },
      end: { radius: 0.56, a: 0 },
    },
    {
      position: 0.08,
      start: { radius: 0.4, r: 1, g: 0.62, b: 0.02, a: 0.5 },
      end: { radius: 1, a: 0 },
    },
    {
      position: 0.25,
      start: { radius: 0.2, r: 1, g: 0.48, b: 0, a: 0.52 },
      middle: { radius: 0.6, r: 0.95, g: 0.22, b: 0, a: 0.48 },
      end: { radius: 1, a: 0 },
    },
    {
      position: 0.4,
      start: { radius: 0.6, r: 0.82, g: 0.12, b: 0, a: 0.55 },
      end: { radius: 1, a: 0 },
    },
    {
      position: 0.5,
      start: { radius: 0, r: 0.12, g: 0.1, b: 0.08, a: 0.5 },
      middle: { radius: 0.8, r: 0.72, g: 0.1, b: 0, a: 0.5 },
      end: { radius: 1, a: 0 },
    },
    {
      position: 0.7,
      start: { radius: 0.4, r: 0.15, g: 0.15, b: 0.15, a: 0.5 },
      end: { radius: 1, a: 0 },
    },
    {
      position: 1,
      start: { radius: 0.4, r: 0.15, g: 0.15, b: 0.15, a: 0.2 },
      end: { radius: 1, a: 0 },
    },
  ];
}

function expandKeyframes(keyframes: GradientKeyframe[]): ExpandedKeyframe[] {
  return keyframes.map(k => {
    const start = completeStop(k.start, {
      radius: 0,
      r: 1,
      g: 1,
      b: 1,
      a: 1,
    });
    const middleSource = k.middle ? k.middle : { ...k.start, radius: k.start.radius };
    const middle = completeStop(middleSource, start);
    const end = completeStop(k.end, middle);

    if (!k.middle) {
      start.radius = 0;
    }

    return {
      position: k.position,
      start,
      middle,
      end,
    };
  });
}

function completeStop(
  partial: Partial<GradientStop> & Pick<GradientStop, 'radius'>,
  fallback: GradientStop
): GradientStop {
  return {
    radius: partial.radius,
    r: partial.r ?? fallback.r,
    g: partial.g ?? fallback.g,
    b: partial.b ?? fallback.b,
    a: partial.a ?? fallback.a,
  };
}

function interpolateStop(a: GradientStop, b: GradientStop, t: number): GradientStop {
  return {
    radius: lerp(a.radius, b.radius, t),
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t),
    a: lerp(a.a, b.a, t),
  };
}

function renderGradientSprite(
  gasRadius: number,
  frame: { start: GradientStop; middle: GradientStop; end: GradientStop }
): HTMLCanvasElement {
  const size = Math.ceil(gasRadius * 2);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const center = size / 2;
  const gradient = ctx.createRadialGradient(center, size * 0.7, 0, center, center, center);

  gradient.addColorStop(clamp(frame.start.radius, 0, 1), rgba(frame.start));
  gradient.addColorStop(clamp(frame.middle.radius, 0, 1), rgba(frame.middle));
  gradient.addColorStop(clamp(frame.end.radius, 0, 1), rgba(frame.end));

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

function rgba(c: GradientStop): string {
  return `rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},${c.a})`;
}
