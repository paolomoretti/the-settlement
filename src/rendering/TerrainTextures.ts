import { NoiseGenerator } from '@/utils/NoiseGenerator';

const TILE_W = 64;
const TILE_H = 32;
const ATLAS_GRID = 16;
const ATLAS_W = ATLAS_GRID * TILE_W;
const ATLAS_H = ATLAS_GRID * TILE_H;
const P = ATLAS_GRID;

interface RGB { r: number; g: number; b: number }

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const DIAMOND_MASK: boolean[] = new Array(TILE_W * TILE_H);
for (let py = 0; py < TILE_H; py++) {
  for (let px = 0; px < TILE_W; px++) {
    const dx = Math.abs(px + 0.5 - TILE_W / 2) / (TILE_W / 2);
    const dy = Math.abs(py + 0.5 - TILE_H / 2) / (TILE_H / 2);
    DIAMOND_MASK[py * TILE_W + px] = dx + dy <= 1.06;
  }
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Grid-space coordinates: continuous across tiles, period = ATLAS_GRID
function toGridCoords(gx: number, gy: number, px: number, py: number): { gfx: number; gfy: number } {
  return {
    gfx: gx + px / TILE_W,
    gfy: gy + py / TILE_H,
  };
}

// Seamlessly tileable noise using 4-sample bilinear blend.
// The blend weights guarantee identical values at the wrap boundary (period P).
function tileNoise(noise: NoiseGenerator, x: number, y: number, scale: number, ox: number = 0, oy: number = 0): number {
  const nx = ((x % P) + P) % P;
  const ny = ((y % P) + P) % P;
  const s00 = noise.noise(nx + ox, ny + oy, scale);
  const s10 = noise.noise(nx - P + ox, ny + oy, scale);
  const s01 = noise.noise(nx + ox, ny - P + oy, scale);
  const s11 = noise.noise(nx - P + ox, ny - P + oy, scale);
  return (
    s00 * (P - nx) * (P - ny) +
    s10 * nx * (P - ny) +
    s01 * (P - nx) * ny +
    s11 * nx * ny
  ) / (P * P);
}

type GenFn = (gfx: number, gfy: number, noise: NoiseGenerator, r: Float64Array, g: Float64Array, b: Float64Array, i: number) => void;

const GRASS = hexToRgb('#7cb342');
const WATER = hexToRgb('#3a7bd5');
const MOUNTAIN = hexToRgb('#7a6e63');
const FOREST = hexToRgb('#2d5016');
const HILL = hexToRgb('#8bb34a');
const DESERT = hexToRgb('#d4b96a');
const ROAD = hexToRgb('#c4a572');

function genGrass(x: number, y: number, n: NoiseGenerator, r: Float64Array, g: Float64Array, b: Float64Array, i: number): void {
  const n1 = tileNoise(n, x, y, 0.8);
  const n2 = tileNoise(n, x, y, 2.2, 37, 53);
  const n3 = tileNoise(n, x, y, 5.5, 73, 91);
  const v = (n1 - 0.5) * 40 + (n2 - 0.5) * 20 + (n3 - 0.5) * 10;
  r[i] = GRASS.r + v * 0.3;
  g[i] = GRASS.g + v;
  b[i] = GRASS.b + v * 0.2;
  if (n2 > 0.72) { r[i] -= 12; g[i] -= 4; b[i] -= 8; }
  if (n3 > 0.88) {
    const ft = tileNoise(n, x, y, 11, 120, 140);
    if (ft > 0.5) { r[i] += 70; g[i] -= 15; b[i] -= 15; }
    else { r[i] += 50; g[i] += 40; b[i] -= 25; }
  }
}

function genWater(x: number, y: number, n: NoiseGenerator, r: Float64Array, g: Float64Array, b: Float64Array, i: number): void {
  const n1 = tileNoise(n, x, y, 0.7);
  const n2 = tileNoise(n, x, y, 1.8, 37, 53);
  const n3 = tileNoise(n, x, y, 4.5, 73, 91);
  const w = (n1 - 0.5) * 30 + (n2 - 0.5) * 15;
  r[i] = WATER.r + w * 0.4;
  g[i] = WATER.g + w * 0.6;
  b[i] = WATER.b + w;
  if (n3 > 0.72) {
    const h = (n3 - 0.72) * 180;
    r[i] += h * 0.5; g[i] += h * 0.6; b[i] += h;
  }
}

function genMountain(x: number, y: number, n: NoiseGenerator, r: Float64Array, g: Float64Array, b: Float64Array, i: number): void {
  const n1 = tileNoise(n, x, y, 1.0);
  const n2 = tileNoise(n, x, y, 2.5, 37, 53);
  const n3 = tileNoise(n, x, y, 5.0, 73, 91);
  const t = (n1 - 0.5) * 35 + (n2 - 0.5) * 20;
  r[i] = MOUNTAIN.r + t;
  g[i] = MOUNTAIN.g + t * 0.9;
  b[i] = MOUNTAIN.b + t * 0.8;
  if (n3 > 0.65) { const s = (n3 - 0.65) * 250; r[i] += s; g[i] += s; b[i] += s; }
  if (n2 < 0.25) { const d = (0.25 - n2) * 60; r[i] -= d; g[i] -= d; b[i] -= d; }
}

function genForest(x: number, y: number, n: NoiseGenerator, r: Float64Array, g: Float64Array, b: Float64Array, i: number): void {
  const n1 = tileNoise(n, x, y, 0.8);
  const n2 = tileNoise(n, x, y, 2.2, 37, 53);
  const n3 = tileNoise(n, x, y, 5.5, 73, 91);
  const v = (n1 - 0.5) * 30 + (n2 - 0.5) * 15;
  r[i] = FOREST.r + v * 0.4;
  g[i] = FOREST.g + v;
  b[i] = FOREST.b + v * 0.3;
  if (n3 > 0.55) { const c = (n3 - 0.55) * 50; r[i] -= c * 0.4; g[i] += c * 0.4; b[i] -= c * 0.3; }
  if (n2 > 0.82 && n3 < 0.4) { r[i] += 25; g[i] += 8; b[i] -= 5; }
}

function genHill(x: number, y: number, n: NoiseGenerator, r: Float64Array, g: Float64Array, b: Float64Array, i: number): void {
  const n1 = tileNoise(n, x, y, 0.8);
  const n2 = tileNoise(n, x, y, 2.0, 37, 53);
  const v = (n1 - 0.5) * 35 + (n2 - 0.5) * 18;
  r[i] = HILL.r + v * 0.4;
  g[i] = HILL.g + v;
  b[i] = HILL.b + v * 0.2;
  if (n2 > 0.7) { r[i] += 12; g[i] -= 4; b[i] += 4; }
}

function genDesert(x: number, y: number, n: NoiseGenerator, r: Float64Array, g: Float64Array, b: Float64Array, i: number): void {
  const n1 = tileNoise(n, x, y, 0.7);
  const n2 = tileNoise(n, x, y, 1.8, 37, 53);
  const n3 = tileNoise(n, x, y, 4.5, 73, 91);
  const v = (n1 - 0.5) * 25 + (n2 - 0.5) * 12;
  r[i] = DESERT.r + v;
  g[i] = DESERT.g + v * 0.8;
  b[i] = DESERT.b + v * 0.5;
  const rip = Math.sin((x * 3.5 + y * 1.8) + n1 * 4) * 8;
  r[i] += rip; g[i] += rip * 0.8; b[i] += rip * 0.5;
  if (n3 > 0.85) { r[i] -= 18; g[i] -= 13; b[i] -= 8; }
}

function genTree(x: number, y: number, n: NoiseGenerator, r: Float64Array, g: Float64Array, b: Float64Array, i: number): void {
  genGrass(x, y, n, r, g, b, i);
  const cn = tileNoise(n, x, y, 3.5, 200, 210);
  if (cn > 0.5) {
    const mix = (cn - 0.5) * 1.2;
    r[i] = r[i] * (1 - mix) + 42 * mix;
    g[i] = g[i] * (1 - mix) + 110 * mix;
    b[i] = b[i] * (1 - mix) + 26 * mix;
  }
  const tn = tileNoise(n, x, y, 8.5, 300, 310);
  if (tn > 0.88 && cn > 0.55) { r[i] = 93; g[i] = 64; b[i] = 55; }
}

function genFog(x: number, y: number, n: NoiseGenerator, r: Float64Array, g: Float64Array, b: Float64Array, i: number): void {
  const v = 35 + (tileNoise(n, x, y, 0.6) - 0.5) * 15;
  r[i] = v; g[i] = v; b[i] = v + 3;
}

const GENERATORS: Record<string, GenFn> = {
  grass: genGrass, water: genWater, mountain: genMountain,
  forest: genForest, hill: genHill, desert: genDesert,
  tree: genTree, fog: genFog,
};

// --- Road overlay atlas (16 connection configs in a 4x4 grid) ---

const ROAD_COLS = 4;
const ROAD_ROWS = 4;
const ROAD_ATLAS_W = ROAD_COLS * TILE_W;
const ROAD_ATLAS_H = ROAD_ROWS * TILE_H;
const TRACK_HALF = 4;

const EDGE_MID = [
  { x: 16, y: 8 },   // NW
  { x: 48, y: 8 },   // NE
  { x: 48, y: 24 },  // SE
  { x: 16, y: 24 },  // SW
];
const CENTER = { x: 32, y: 16 };

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function buildRoadAtlas(noise: NoiseGenerator): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ROAD_ATLAS_W;
  canvas.height = ROAD_ATLAS_H;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(ROAD_ATLAS_W, ROAD_ATLAS_H);
  const data = imageData.data;

  for (let config = 0; config < 16; config++) {
    const col = config % ROAD_COLS;
    const row = Math.floor(config / ROAD_COLS);

    const connections: number[] = [];
    for (let bit = 0; bit < 4; bit++) {
      if (config & (1 << bit)) connections.push(bit);
    }

    const junctionRadius = connections.length >= 3 ? TRACK_HALF + 2 : TRACK_HALF;

    for (let py = 0; py < TILE_H; py++) {
      for (let px = 0; px < TILE_W; px++) {
        if (!DIAMOND_MASK[py * TILE_W + px]) continue;

        const cpx = px + 0.5;
        const cpy = py + 0.5;

        let minDist = Infinity;
        for (const bit of connections) {
          const d = distToSegment(cpx, cpy, CENTER.x, CENTER.y, EDGE_MID[bit].x, EDGE_MID[bit].y);
          if (d < minDist) minDist = d;
        }

        const centerDist = Math.hypot(cpx - CENTER.x, cpy - CENTER.y);
        if (connections.length > 0 && centerDist < junctionRadius) {
          minDist = Math.min(minDist, centerDist);
        }

        if (connections.length === 0) {
          minDist = centerDist;
        }

        if (minDist > TRACK_HALF + 1.5) continue;

        const nv = noise.noise(px * 3 + config * 97, py * 3 + config * 53, 0.12);
        const variation = (nv - 0.5) * 22;

        let rv = ROAD.r + variation;
        let gv = ROAD.g + variation * 0.8;
        let bv = ROAD.b + variation * 0.5;

        if (minDist > TRACK_HALF - 1.5) {
          const edge = (minDist - (TRACK_HALF - 1.5)) / 2.5;
          const darken = edge * 25;
          rv -= darken; gv -= darken; bv -= darken;
        }

        const pebble = noise.noise(px * 7 + config * 200, py * 7, 0.2);
        if (pebble > 0.82) { rv -= 14; gv -= 11; bv -= 7; }

        let alpha = 255;
        if (minDist > TRACK_HALF) {
          alpha = Math.round(255 * Math.max(0, 1 - (minDist - TRACK_HALF) / 1.5));
        }

        const ax = col * TILE_W + px;
        const ay = row * TILE_H + py;
        const idx = (ay * ROAD_ATLAS_W + ax) * 4;
        data[idx] = clamp(Math.round(rv));
        data[idx + 1] = clamp(Math.round(gv));
        data[idx + 2] = clamp(Math.round(bv));
        data[idx + 3] = alpha;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function buildAtlas(gen: GenFn, noise: NoiseGenerator): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(ATLAS_W, ATLAS_H);
  const data = imageData.data;

  const rBuf = new Float64Array(1);
  const gBuf = new Float64Array(1);
  const bBuf = new Float64Array(1);

  for (let gy = 0; gy < ATLAS_GRID; gy++) {
    for (let gx = 0; gx < ATLAS_GRID; gx++) {
      for (let py = 0; py < TILE_H; py++) {
        for (let px = 0; px < TILE_W; px++) {
          if (!DIAMOND_MASK[py * TILE_W + px]) continue;

          const { gfx, gfy } = toGridCoords(gx, gy, px, py);
          gen(gfx, gfy, noise, rBuf, gBuf, bBuf, 0);

          const ax = gx * TILE_W + px;
          const ay = gy * TILE_H + py;
          const idx = (ay * ATLAS_W + ax) * 4;
          data[idx] = clamp(Math.round(rBuf[0]));
          data[idx + 1] = clamp(Math.round(gBuf[0]));
          data[idx + 2] = clamp(Math.round(bBuf[0]));
          data[idx + 3] = 255;
        }
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export class TerrainTextures {
  private atlases = new Map<string, HTMLCanvasElement>();
  private roadAtlas: HTMLCanvasElement;

  constructor(seed: number = 42) {
    const noise = new NoiseGenerator(seed);
    for (const terrain of Object.keys(GENERATORS)) {
      this.atlases.set(terrain, buildAtlas(GENERATORS[terrain], noise));
    }
    this.roadAtlas = buildRoadAtlas(noise);
  }

  drawTile(ctx: CanvasRenderingContext2D, terrain: string, tileX: number, tileY: number, screenCenterX: number, screenCenterY: number): void {
    const atlas = this.atlases.get(terrain);
    if (!atlas) return;

    const gx = ((tileX % ATLAS_GRID) + ATLAS_GRID) % ATLAS_GRID;
    const gy = ((tileY % ATLAS_GRID) + ATLAS_GRID) % ATLAS_GRID;

    ctx.drawImage(
      atlas,
      gx * TILE_W, gy * TILE_H, TILE_W, TILE_H,
      screenCenterX - TILE_W / 2, screenCenterY - TILE_H / 2, TILE_W, TILE_H
    );
  }

  drawRoad(ctx: CanvasRenderingContext2D, config: number, screenCenterX: number, screenCenterY: number): void {
    const col = config % ROAD_COLS;
    const row = Math.floor(config / ROAD_COLS);

    ctx.drawImage(
      this.roadAtlas,
      col * TILE_W, row * TILE_H, TILE_W, TILE_H,
      screenCenterX - TILE_W / 2, screenCenterY - TILE_H / 2, TILE_W, TILE_H
    );
  }
}
