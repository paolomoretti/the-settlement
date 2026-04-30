/**
 * Lightweight retro chimney smoke for Canvas 2D (building-local coordinates).
 *
 * Shade scale 1–5:
 *   1 = white / steam
 *   2 = light grey
 *   3 = medium grey  (default — matches the old fixed colour)
 *   4 = dark grey
 *   5 = near-black / sooty coal smoke
 *
 * Each emitted particle also receives a random ±22 brightness offset so
 * the smoke column looks textured rather than uniformly flat.
 */

export interface ChimneySmokeOptions {
  x: number;
  y: number;
  density?: number;
  duration?: number;
  /**
   * Smoke colour shade, 1 (white/steam) → 5 (black/sooty). Default 3.
   */
  shade?: number;
}

export interface ChimneySmoke {
  x: number;
  y: number;
  density: number;
  duration: number;
  elapsed: number;
  emitting: boolean;
  /** Colour shade 1–5 (1 = white, 5 = black). Can be changed at runtime. */
  shade: number;
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D): void;
  stop(): void;
  start(): void;
  isFinished(): boolean;
  setPosition(x: number, y: number): void;
  setDensity(density: number): void;
  setShade(shade: number): void;
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
  /**
   * Per-particle base grey value (0–255), derived from the emitter shade plus
   * a random ±22 brightness jitter baked in at emit time.
   */
  baseGray: number;
  /**
   * Peak alpha multiplier — core puffs are more opaque than edge wisps.
   */
  maxAlpha: number;
}

const rand = (min: number, max: number): number => min + Math.random() * (max - min);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeIn = (t: number): number => t * t;

/**
 * Convert shade (1–5) to a base grey luminance value (0–255).
 * Shade 3 → ~120, matching the old hardcoded colour.
 */
function shadeToGray(shade: number): number {
  // shade 1 → 210 (near white), shade 5 → 25 (near black)
  return Math.round(lerp(210, 25, clamp((shade - 1) / 4, 0, 1)));
}

export function createChimneySmoke(options: ChimneySmokeOptions): ChimneySmoke {
  const particles: SmokeParticle[] = [];
  let acc = 0;

  const smoke: ChimneySmoke = {
    x: options.x,
    y: options.y,
    density: options.density ?? 1,
    duration: options.duration ?? Infinity,
    elapsed: 0,
    emitting: true,
    shade: clamp(options.shade ?? 3, 1, 5),

    start() {
      this.emitting = true;
      this.elapsed = 0;
    },

    update(dt: number) {
      this.elapsed += dt;

      if (this.elapsed >= this.duration) {
        this.emitting = false;
      }

      const density = clamp(this.density, 0, 3);
      const rate = 2.6 * density;
      // Room for both core puffs and edge wisps, which live slightly longer.
      const maxParticles = Math.ceil(22 * density);

      if (this.emitting && density > 0) {
        acc += dt * rate;

        while (acc >= 1) {
          acc--;
          emitCluster(this, maxParticles);
        }
      }

      for (const p of particles) {
        p.age += dt;
        const t = clamp(p.age / p.life, 0, 1);

        p.x += p.vx * dt;
        p.y += p.vy * dt;

        p.vx += 3 * dt;
        p.vy -= 0.8 * dt;

        p.size = lerp(p.startSize, p.endSize, easeOut(t));

        const fadeIn = clamp(t / 0.16, 0, 1);
        const fadeOut = 1 - easeIn(clamp((t - 0.34) / 0.66, 0, 1));
        p.alpha = fadeIn * fadeOut * p.maxAlpha;
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        if (particles[i]!.age >= particles[i]!.life) {
          particles.splice(i, 1);
        }
      }
    },

    draw(ctx: CanvasRenderingContext2D) {
      for (const p of particles) {
        drawLoFiSmokePuff(ctx, p);
      }
    },

    stop() {
      this.emitting = false;
    },

    isFinished(): boolean {
      return !this.emitting && particles.length === 0;
    },

    setPosition(x: number, y: number) {
      this.x = x;
      this.y = y;
    },

    setDensity(density: number) {
      this.density = density;
    },

    setShade(shade: number) {
      this.shade = clamp(shade, 1, 5);
    },
  };

  function emitCluster(emitter: ChimneySmoke, maxParticles: number): void {
    const count = Math.random() < 0.08 ? 2 : 1;
    for (let i = 0; i < count; i++) emit(emitter, maxParticles);
  }

  function emit(emitter: ChimneySmoke, maxParticles: number): void {
    if (particles.length >= maxParticles) return;

    const densityScale = clamp(emitter.density, 0.35, 3);
    // Bake per-particle brightness jitter so each puff is slightly
    // lighter or darker, breaking up visual uniformity.
    const baseGray = clamp(shadeToGray(emitter.shade) + rand(-22, 22), 5, 250);

    if (Math.random() < 0.38) {
      // ── Wisp particle (≈40%) ────────────────────────────────────────────
      // Spawns wider from the chimney mouth, rises slower, stays small.
      // Creates the spreading "edge columns" that flank the tight core.
      particles.push({
        x: emitter.x + rand(-5.5, 5.5),
        y: emitter.y + rand(-4, 1),
        vx: rand(-3.5, 4.5),
        vy: -15 + rand(-2, 3),
        age: 0,
        life: 4.8 * rand(0.8, 1.25),
        startSize: rand(1.5, 2.8),
        endSize: rand(7, 14) * Math.min(1.1, densityScale),
        size: 2,
        alpha: 0,
        baseGray,
        maxAlpha: 0.4,
      });
    } else {
      // ── Core puff (≈60%) ────────────────────────────────────────────────
      // Tight spawn near the chimney centre, rises fast, billows large.
      // Forms the dense main column.
      particles.push({
        x: emitter.x + rand(-1.5, 1.5),
        y: emitter.y + rand(-3, 1),
        vx: rand(-1.2, 2.2),
        vy: -24 + rand(-3, 2),
        age: 0,
        life: 3.8 * rand(0.85, 1.2),
        startSize: rand(3, 5) * Math.min(1.15, densityScale),
        endSize: rand(16, 26) * Math.min(1.2, densityScale),
        size: 5,
        alpha: 0,
        baseGray,
        maxAlpha: 0.56,
      });
    }
  }

  return smoke;
}

function drawLoFiSmokePuff(ctx: CanvasRenderingContext2D, p: SmokeParticle): void {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  const s = Math.round(p.size);
  const g = Math.round(p.baseGray);
  // Highlight sub-puff is up to 30 units brighter, capped at 250.
  const gh = Math.min(250, g + 30);

  ctx.save();

  ctx.globalAlpha = p.alpha * 0.62;
  ctx.fillStyle = `rgb(${g},${g},${g})`;
  ctx.beginPath();
  ctx.arc(x, y, s, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = p.alpha * 0.36;
  ctx.beginPath();
  ctx.arc(x + s * 0.4, y + s * 0.2, s * 0.7, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = p.alpha * 0.24;
  ctx.fillStyle = `rgb(${gh},${gh},${gh})`;
  ctx.beginPath();
  ctx.arc(x - s * 0.3, y - s * 0.2, s * 0.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}
