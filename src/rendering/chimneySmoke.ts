/**
 * Lightweight retro chimney smoke for Canvas 2D (building-local coordinates).
 */

export interface ChimneySmokeOptions {
  x: number;
  y: number;
  density?: number;
  duration?: number;
}

export interface ChimneySmoke {
  x: number;
  y: number;
  density: number;
  duration: number;
  elapsed: number;
  emitting: boolean;
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D): void;
  stop(): void;
  start(): void;
  isFinished(): boolean;
  setPosition(x: number, y: number): void;
  setDensity(density: number): void;
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
}

const rand = (min: number, max: number): number => min + Math.random() * (max - min);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeIn = (t: number): number => t * t;

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
      const maxParticles = Math.ceil(16 * density);

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
        p.alpha = fadeIn * fadeOut * 0.56;
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
  };

  function emitCluster(emitter: ChimneySmoke, maxParticles: number): void {
    const count = Math.random() < 0.08 ? 2 : 1;
    for (let i = 0; i < count; i++) emit(emitter, maxParticles);
  }

  function emit(emitter: ChimneySmoke, maxParticles: number): void {
    if (particles.length >= maxParticles) return;

    const densityScale = clamp(emitter.density, 0.35, 3);

    particles.push({
      x: emitter.x + rand(-2, 2),
      y: emitter.y + rand(-3, 2),
      vx: rand(-1.5, 2.8),
      vy: -24 + rand(-3, 2),
      age: 0,
      life: 3.8 * rand(0.85, 1.2),
      startSize: rand(3, 5) * Math.min(1.15, densityScale),
      endSize: rand(17, 26) * Math.min(1.2, densityScale),
      size: 5,
      alpha: 0,
    });
  }

  return smoke;
}

function drawLoFiSmokePuff(ctx: CanvasRenderingContext2D, p: SmokeParticle): void {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  const s = Math.round(p.size);

  ctx.save();

  ctx.globalAlpha = p.alpha * 0.62;
  ctx.fillStyle = 'rgb(120,120,120)';
  ctx.beginPath();
  ctx.arc(x, y, s, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = p.alpha * 0.36;
  ctx.beginPath();
  ctx.arc(x + s * 0.4, y + s * 0.2, s * 0.7, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = p.alpha * 0.24;
  ctx.fillStyle = 'rgb(150,150,150)';
  ctx.beginPath();
  ctx.arc(x - s * 0.3, y - s * 0.2, s * 0.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}
