/**
 * Simple noise generator for procedural terrain
 * Using a seeded pseudo-random noise function
 */

export class NoiseGenerator {
  private seed: number;

  constructor(seed: number = Math.random() * 10000) {
    this.seed = seed;
  }

  // Simple hash function for seeded randomness
  private hash(x: number, y: number): number {
    let h = this.seed + x * 374761393 + y * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }

  // Smooth interpolation
  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private smoothstep(t: number): number {
    return t * t * (3 - 2 * t);
  }

  // 2D noise function (similar to Perlin noise)
  noise(x: number, y: number, scale: number = 1): number {
    x *= scale;
    y *= scale;

    const x0 = Math.floor(x);
    const x1 = x0 + 1;
    const y0 = Math.floor(y);
    const y1 = y0 + 1;

    const sx = x - x0;
    const sy = y - y0;

    const n0 = this.hash(x0, y0);
    const n1 = this.hash(x1, y0);
    const n2 = this.hash(x0, y1);
    const n3 = this.hash(x1, y1);

    const ix0 = this.lerp(n0, n1, this.smoothstep(sx));
    const ix1 = this.lerp(n2, n3, this.smoothstep(sx));

    return this.lerp(ix0, ix1, this.smoothstep(sy));
  }

  // Layered noise (multiple octaves for more detail)
  fractalNoise(x: number, y: number, octaves: number = 4): number {
    let value = 0;
    let amplitude = 1;
    let frequency = 0.01;
    let maxValue = 0;

    for (let i = 0; i < octaves; i++) {
      value += this.noise(x, y, frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }

    return value / maxValue;
  }
}
