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
  genGrass(x, y, n, r, g, b, i);
  const cn = tileNoise(n, x, y, 2.5, 37, 53);
  if (cn > 0.5) {
    const mix = (cn - 0.5) * 0.2;
    r[i] = r[i] * (1 - mix) + MOUNTAIN.r * mix;
    g[i] = g[i] * (1 - mix) + MOUNTAIN.g * mix;
    b[i] = b[i] * (1 - mix) + MOUNTAIN.b * mix;
  }
}

function genForest(x: number, y: number, n: NoiseGenerator, r: Float64Array, g: Float64Array, b: Float64Array, i: number): void {
  genGrass(x, y, n, r, g, b, i);
  const cn = tileNoise(n, x, y, 2.2, 37, 53);
  if (cn > 0.5) {
    const mix = (cn - 0.5) * 0.25;
    r[i] = r[i] * (1 - mix) + FOREST.r * mix;
    g[i] = g[i] * (1 - mix) + FOREST.g * mix;
    b[i] = b[i] * (1 - mix) + FOREST.b * mix;
  }
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
    const mix = (cn - 0.5) * 0.25;
    r[i] = r[i] * (1 - mix) + 42 * mix;
    g[i] = g[i] * (1 - mix) + 110 * mix;
    b[i] = b[i] * (1 - mix) + 26 * mix;
  }
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

// --- Water shore overlay atlas ---
// 16 shore configs (4x4) + 4 deep water variants (row 5) = 4x5 grid

const WATER_COLS = 16;
const WATER_ROWS = 17;
const WATER_ATLAS_W = WATER_COLS * TILE_W;
const WATER_ATLAS_H = WATER_ROWS * TILE_H;
const DEEP_WATER_OFFSET = 256;

const CORNERS = [
  { x: 32, y: 0 },
  { x: 64, y: 16 },
  { x: 32, y: 32 },
  { x: 0, y: 16 },
];
const CORNER_PAIRS = [3, 6, 12, 9];
const CORNER_R = 18;

function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function renderWaterCell(
  data: Uint8ClampedArray, noise: NoiseGenerator,
  cellIndex: number, config: number, noiseOx: number, noiseOy: number
): void {
  const col = cellIndex % WATER_COLS;
  const row = Math.floor(cellIndex / WATER_COLS);

  const cardinals = config & 0xF;
  const diagonals = (config >> 4) & 0xF;

  for (let py = 0; py < TILE_H; py++) {
    for (let px = 0; px < TILE_W; px++) {
      if (!DIAMOND_MASK[py * TILE_W + px]) continue;

      const cpx = px + 0.5;
      const cpy = py + 0.5;

      const fNW = (cpx - 32 + 2 * cpy) / 32;
      const fNE = (32 - cpx + 2 * cpy) / 32;
      const fSE = (96 - cpx - 2 * cpy) / 32;
      const fSW = (cpx + 32 - 2 * cpy) / 32;

      const eFNW = (cardinals & 1) ? 99 : fNW;
      const eFNE = (cardinals & 2) ? 99 : fNE;
      const eFSE = (cardinals & 4) ? 99 : fSE;
      const eFSW = (cardinals & 8) ? 99 : fSW;

      const shoreNoise = noise.noise(cpx * 2.5 + noiseOx, cpy * 2.5 + noiseOy, 0.18);
      const shoreNoise2 = noise.noise(cpx * 5 + noiseOx + 200, cpy * 5 + noiseOy + 200, 0.25);
      const noiseOffset = (shoreNoise - 0.5) * 0.18 + (shoreNoise2 - 0.5) * 0.08;

      const k = 0.55;
      let minF = smin(smin(eFNW, eFNE, k), smin(eFSE, eFSW, k), k);

      for (let c = 0; c < 4; c++) {
        if ((cardinals & CORNER_PAIRS[c]) === CORNER_PAIRS[c] && !(diagonals & (1 << c))) {
          const dx = cpx - CORNERS[c].x;
          const dy = cpy - CORNERS[c].y;
          const fCorner = Math.sqrt(dx * dx + dy * dy) / CORNER_R;
          minF = smin(minF, fCorner, k);
        }
      }

      minF += noiseOffset;

      if (minF <= 0.13) continue;

      const n1 = noise.noise(cpx * 1.5 + noiseOx + 30, cpy * 1.5 + noiseOy + 30, 0.12);
      const n2 = noise.noise(cpx * 3 + noiseOx + 80, cpy * 3 + noiseOy + 80, 0.2);
      const stoneNoise = noise.noise(cpx * 7 + noiseOx + 150, cpy * 7 + noiseOy + 150, 0.25);
      const variation = (n1 - 0.5) * 18;

      let rv: number, gv: number, bv: number, alpha: number;

      if (minF > 0.5) {
        // Deep water
        rv = WATER.r + variation * 0.4;
        gv = WATER.g + variation * 0.6;
        bv = WATER.b + variation;
        if (n2 > 0.72) {
          const h = (n2 - 0.72) * 150;
          rv += h * 0.5; gv += h * 0.6; bv += h;
        }
        alpha = 255;
      } else if (minF > 0.35) {
        // Shallow water
        const t = (minF - 0.35) / 0.15;
        rv = WATER.r + 20 + variation * 0.3;
        gv = WATER.g + 28 + variation * 0.4;
        bv = WATER.b + 14 + variation * 0.5;
        alpha = Math.round(200 + 55 * t);
        // Foam near shore
        if (n2 > 0.76 && minF < 0.42) {
          const foam = (n2 - 0.76) * 250;
          rv += foam; gv += foam; bv += foam * 0.8;
        }
      } else if (minF > 0.22) {
        // Stony shore
        const t = (minF - 0.22) / 0.13;
        // Base: grey-brown stone
        rv = 135 + variation * 0.3;
        gv = 128 + variation * 0.25;
        bv = 115 + variation * 0.2;
        // Scatter stones
        if (stoneNoise > 0.72) {
          rv -= 28; gv -= 24; bv -= 18;
        } else if (stoneNoise > 0.6) {
          rv += 18; gv += 15; bv += 10;
        } else if (stoneNoise < 0.3) {
          rv -= 10; gv -= 5; bv -= 3;
        }
        // Wet area near water edge
        if (minF > 0.28) {
          const wet = (minF - 0.28) / 0.07;
          rv -= wet * 22; gv -= wet * 16; bv += wet * 12;
        }
        alpha = Math.round(180 + 70 * t);
      } else {
        // Grassy edge transition
        const t = (minF - 0.13) / 0.09;
        rv = 100 + variation * 0.2;
        gv = 125 + variation * 0.3;
        bv = 65 + variation * 0.15;
        if (stoneNoise > 0.75) {
          rv += 20; gv -= 10; bv -= 5;
        }
        alpha = Math.round(130 * t);
      }

      const ax = col * TILE_W + px;
      const ay = row * TILE_H + py;
      const idx = (ay * WATER_ATLAS_W + ax) * 4;
      data[idx] = clamp(Math.round(rv));
      data[idx + 1] = clamp(Math.round(gv));
      data[idx + 2] = clamp(Math.round(bv));
      data[idx + 3] = clamp(Math.round(alpha));
    }
  }
}

function buildWaterAtlas(noise: NoiseGenerator): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = WATER_ATLAS_W;
  canvas.height = WATER_ATLAS_H;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(WATER_ATLAS_W, WATER_ATLAS_H);
  const data = imageData.data;

  // 256 shore configurations (4 cardinal + 4 diagonal bits)
  for (let config = 0; config < 256; config++) {
    renderWaterCell(data, noise, config, config, config * 97, config * 53);
  }

  // 4 deep water variants (all neighbors water, different noise offsets)
  for (let v = 0; v < 4; v++) {
    renderWaterCell(data, noise, DEEP_WATER_OFFSET + v, 255, v * 211 + 500, v * 173 + 700);
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
  private waterAtlas: HTMLCanvasElement;

  constructor(seed: number = 42) {
    const noise = new NoiseGenerator(seed);
    for (const terrain of Object.keys(GENERATORS)) {
      this.atlases.set(terrain, buildAtlas(GENERATORS[terrain], noise));
    }
    this.roadAtlas = buildRoadAtlas(noise);
    this.waterAtlas = buildWaterAtlas(noise);
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

  drawWater(ctx: CanvasRenderingContext2D, config: number, tileX: number, tileY: number, screenCenterX: number, screenCenterY: number): void {
    let cell: number;
    if (config === 255) {
      cell = DEEP_WATER_OFFSET + ((tileX + tileY) & 3);
    } else {
      cell = config;
    }
    const col = cell % WATER_COLS;
    const row = Math.floor(cell / WATER_COLS);

    ctx.drawImage(
      this.waterAtlas,
      col * TILE_W, row * TILE_H, TILE_W, TILE_H,
      screenCenterX - TILE_W / 2, screenCenterY - TILE_H / 2, TILE_W, TILE_H
    );
  }

}
