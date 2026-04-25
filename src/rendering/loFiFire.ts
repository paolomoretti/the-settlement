/**
 * Self-contained retro fire + smoke effect for Canvas 2D games.
 * Coordinates are building-local or screen/world-space pixels, with x/y as the
 * bottom-center of the fire source.
 */
export interface LoFiFireOptions {
  x: number;
  y: number;
  width?: number;
  height?: number;
  density?: number;
  duration?: number;
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

interface FlameParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  startSize: number;
  size: number;
  alpha: number;
  maxAlpha: number;
  seed: number;
  colorPick: number;
}

interface SmokeParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  startSize: number;
  endSize: number;
  size: number;
  alpha: number;
  maxAlpha: number;
}

interface EmberParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  alpha: number;
  maxAlpha: number;
}

const rand = (min: number, max: number): number => min + Math.random() * (max - min);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeIn = (t: number): number => t * t;

export function createLoFiFire(options: LoFiFireOptions): LoFiFire {
  const flames: FlameParticle[] = [];
  const smoke: SmokeParticle[] = [];
  const embers: EmberParticle[] = [];
  let flameAcc = 0;
  let smokeAcc = 0;
  let emberAcc = 0;

  const fire: LoFiFire = {
    x: options.x,
    y: options.y,
    width: options.width ?? 48,
    height: options.height ?? 64,
    density: options.density ?? 1,
    duration: options.duration ?? Infinity,
    elapsed: 0,
    emitting: true,

    update(dt: number) {
      this.elapsed += dt;
      if (this.elapsed >= this.duration) this.emitting = false;

      const density = clamp(this.density, 0, 4);
      const areaScale = clamp((this.width * this.height) / (48 * 64), 0.35, 5);
      const scale = Math.sqrt(areaScale);

      const flameRate = 18 * density * scale;
      const smokeRate = 5.2 * density * scale;
      const emberRate = 1.2 * density * scale;

      const maxFlames = Math.ceil(48 * density * scale);
      const maxSmoke = Math.ceil(26 * density * scale);
      const maxEmbers = Math.ceil(5 * density * scale);

      if (this.emitting && density > 0) {
        flameAcc += dt * flameRate;
        while (flameAcc >= 1) {
          flameAcc--;
          emitFlame(this, flames, maxFlames);
        }

        smokeAcc += dt * smokeRate;
        while (smokeAcc >= 1) {
          smokeAcc--;
          emitSmoke(this, smoke, maxSmoke);
        }

        emberAcc += dt * emberRate;
        while (emberAcc >= 1) {
          emberAcc--;
          emitEmber(this, embers, maxEmbers);
        }
      }

      updateFlames(this, flames, dt);
      updateSmoke(smoke, dt);
      updateEmbers(embers, dt);
      removeDeadParticles(flames, smoke, embers);
    },

    draw(ctx: CanvasRenderingContext2D) {
      for (const s of smoke) drawSmoke(ctx, s);
      for (const p of flames) drawFlame(ctx, p);
      for (const e of embers) drawEmber(ctx, e);
    },

    stop() {
      this.emitting = false;
    },

    isFinished(): boolean {
      return !this.emitting && flames.length === 0 && smoke.length === 0 && embers.length === 0;
    },

    setPosition(x: number, y: number) {
      this.x = x;
      this.y = y;
    },

    setSize(width: number, height: number) {
      this.width = width;
      this.height = height;
    },

    setDensity(density: number) {
      this.density = density;
    },
  };

  return fire;
}

function emitFlame(emitter: LoFiFire, flames: FlameParticle[], maxFlames: number): void {
  if (flames.length >= maxFlames) return;

  const baseHalf = emitter.width * 0.5;
  const offset = rand(-baseHalf, baseHalf);
  const edge = Math.abs(offset) / Math.max(1, baseHalf);
  const heightFactor = lerp(1, 0.55, edge);
  const heightScale = clamp(emitter.height / 64, 0.7, 1.6);
  const widthScale = clamp(emitter.width / 48, 0.65, 1.8);

  flames.push({
    x: emitter.x + offset,
    y: emitter.y + rand(-3, 3),
    vx: rand(-5, 5) * (0.35 + edge),
    vy: -emitter.height * rand(0.42, 0.68),
    age: 0,
    life: rand(0.85, 1.45) * heightFactor * heightScale,
    startSize: rand(8, 15) * widthScale,
    size: 6,
    alpha: 0,
    maxAlpha: rand(0.5, 0.78),
    seed: rand(0, 100),
    colorPick: Math.random(),
  });
}

function emitSmoke(emitter: LoFiFire, smoke: SmokeParticle[], maxSmoke: number): void {
  if (smoke.length >= maxSmoke) return;

  const widthScale = clamp(emitter.width / 48, 0.7, 1.7);

  smoke.push({
    x: emitter.x + rand(-emitter.width * 0.34, emitter.width * 0.34),
    y: emitter.y - rand(emitter.height * 0.35, emitter.height * 0.72),
    vx: rand(-3, 4),
    vy: -rand(6, 12),
    age: 0,
    life: rand(2.6, 4.2),
    startSize: rand(7, 12) * widthScale,
    endSize: rand(24, 40) * widthScale,
    size: 6,
    alpha: 0,
    maxAlpha: rand(0.18, 0.32),
  });
}

function emitEmber(emitter: LoFiFire, embers: EmberParticle[], maxEmbers: number): void {
  if (embers.length >= maxEmbers) return;

  embers.push({
    x: emitter.x + rand(-emitter.width * 0.25, emitter.width * 0.25),
    y: emitter.y - rand(10, emitter.height * 0.45),
    vx: rand(-10, 14),
    vy: -rand(9, 18),
    age: 0,
    life: rand(1.0, 1.8),
    size: rand(1.5, 3),
    alpha: 0,
    maxAlpha: rand(0.45, 0.85),
  });
}

function updateFlames(emitter: LoFiFire, flames: FlameParticle[], dt: number): void {
  for (const p of flames) {
    p.age += dt;
    const t = clamp(p.age / p.life, 0, 1);

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const centrePull = (emitter.x - p.x) * 0.9 * dt;
    p.vx += centrePull;
    p.vx += Math.sin((p.seed + p.age) * 5.5) * 1.8 * dt;
    p.vy -= 3.5 * dt;

    const grow = clamp(t / 0.28, 0, 1);
    const shrink = clamp((t - 0.48) / 0.52, 0, 1);
    const body = easeOut(grow) * (1 - shrink * 0.82);
    p.size = lerp(p.startSize * 0.45, p.startSize, body);

    const fadeIn = clamp(t / 0.22, 0, 1);
    const fadeOut = 1 - easeIn(clamp((t - 0.62) / 0.38, 0, 1));
    p.alpha = fadeIn * fadeOut * p.maxAlpha;
  }
}

function updateSmoke(smoke: SmokeParticle[], dt: number): void {
  for (const s of smoke) {
    s.age += dt;
    const t = clamp(s.age / s.life, 0, 1);

    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vx += 2.6 * dt;
    s.vy -= 0.4 * dt;

    s.size = lerp(s.startSize, s.endSize, easeOut(t));

    const fadeIn = clamp(t / 0.2, 0, 1);
    const fadeOut = 1 - easeIn(clamp((t - 0.35) / 0.65, 0, 1));
    s.alpha = fadeIn * fadeOut * s.maxAlpha;
  }
}

function updateEmbers(embers: EmberParticle[], dt: number): void {
  for (const e of embers) {
    e.age += dt;
    const t = clamp(e.age / e.life, 0, 1);

    e.x += e.vx * dt;
    e.y += e.vy * dt;
    e.vy -= 1.4 * dt;
    e.alpha = (1 - t) * e.maxAlpha;
  }
}

function removeDeadParticles(
  flames: FlameParticle[],
  smoke: SmokeParticle[],
  embers: EmberParticle[]
): void {
  for (let i = flames.length - 1; i >= 0; i--) {
    if (flames[i]!.age >= flames[i]!.life) flames.splice(i, 1);
  }
  for (let i = smoke.length - 1; i >= 0; i--) {
    if (smoke[i]!.age >= smoke[i]!.life) smoke.splice(i, 1);
  }
  for (let i = embers.length - 1; i >= 0; i--) {
    if (embers[i]!.age >= embers[i]!.life) embers.splice(i, 1);
  }
}

function drawFlame(ctx: CanvasRenderingContext2D, p: FlameParticle): void {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  const s = Math.max(1, Math.round(p.size));

  ctx.save();
  ctx.globalAlpha = p.alpha;

  if (p.colorPick < 0.18) ctx.fillStyle = '#ffd35a';
  else if (p.colorPick < 0.68) ctx.fillStyle = '#f47a24';
  else ctx.fillStyle = '#b9321b';

  ctx.beginPath();
  ctx.moveTo(x, y - s * 1.45);
  ctx.lineTo(x + s * 0.8, y - s * 0.35);
  ctx.lineTo(x + s * 0.55, y + s * 0.75);
  ctx.lineTo(x, y + s);
  ctx.lineTo(x - s * 0.65, y + s * 0.55);
  ctx.lineTo(x - s * 0.85, y - s * 0.25);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function drawSmoke(ctx: CanvasRenderingContext2D, s: SmokeParticle): void {
  const x = Math.round(s.x);
  const y = Math.round(s.y);
  const r = Math.max(1, Math.round(s.size));

  ctx.save();

  ctx.globalAlpha = s.alpha;
  ctx.fillStyle = 'rgb(72,72,68)';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = s.alpha * 0.55;
  ctx.fillStyle = 'rgb(105,100,92)';
  ctx.beginPath();
  ctx.arc(x + r * 0.38, y + r * 0.18, r * 0.62, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawEmber(ctx: CanvasRenderingContext2D, e: EmberParticle): void {
  ctx.save();
  ctx.globalAlpha = e.alpha;
  ctx.fillStyle = '#ffd35a';
  ctx.fillRect(Math.round(e.x), Math.round(e.y), Math.ceil(e.size), Math.ceil(e.size));
  ctx.restore();
}
