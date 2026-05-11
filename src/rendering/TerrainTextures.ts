import { NoiseGenerator } from '@/utils/NoiseGenerator';
import { ROAD_RENDERING_MODE } from '@/debug/debugFlags';

const TILE_W = 64;
const TILE_H = 32;
const ATLAS_GRID = 16;
const ATLAS_W = ATLAS_GRID * TILE_W;
const ATLAS_H = ATLAS_GRID * TILE_H;
const P = ATLAS_GRID;
const WATER_FILL_PATTERN_SCALE = 0.45;

interface RGB {
  r: number;
  g: number;
  b: number;
}

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
function toGridCoords(
  gx: number,
  gy: number,
  px: number,
  py: number
): { gfx: number; gfy: number } {
  return {
    gfx: gx + px / TILE_W,
    gfy: gy + py / TILE_H,
  };
}

// Seamlessly tileable noise using 4-sample bilinear blend.
// The blend weights guarantee identical values at the wrap boundary (period P).
function tileNoise(
  noise: NoiseGenerator,
  x: number,
  y: number,
  scale: number,
  ox: number = 0,
  oy: number = 0
): number {
  const nx = ((x % P) + P) % P;
  const ny = ((y % P) + P) % P;
  const s00 = noise.noise(nx + ox, ny + oy, scale);
  const s10 = noise.noise(nx - P + ox, ny + oy, scale);
  const s01 = noise.noise(nx + ox, ny - P + oy, scale);
  const s11 = noise.noise(nx - P + ox, ny - P + oy, scale);
  return (
    (s00 * (P - nx) * (P - ny) + s10 * nx * (P - ny) + s01 * (P - nx) * ny + s11 * nx * ny) /
    (P * P)
  );
}

type GenFn = (
  gfx: number,
  gfy: number,
  noise: NoiseGenerator,
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  i: number
) => void;

/** Slightly warmer, less flat base; variation added in `genGrass` (atlas build only — no runtime cost). */
const GRASS = hexToRgb('#73ae4a');
const WATER = hexToRgb('#3a7bd5');
const MOUNTAIN = hexToRgb('#7a6e63');
const FOREST = hexToRgb('#2d5016');
const HILL = hexToRgb('#8bb34a');
const DESERT = hexToRgb('#d4b96a');
const ROAD = hexToRgb('#c4a572');

function genGrass(
  x: number,
  y: number,
  n: NoiseGenerator,
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  i: number
): void {
  const n1 = tileNoise(n, x, y, 0.8);
  const n2 = tileNoise(n, x, y, 2.2, 37, 53);
  const n3 = tileNoise(n, x, y, 5.5, 73, 91);
  const nFine = tileNoise(n, x, y, 13, 101, 117);

  const v = (n1 - 0.5) * 36 + (n2 - 0.5) * 18 + (n3 - 0.5) * 8;
  r[i] = GRASS.r + v * 0.32;
  g[i] = GRASS.g + v * 0.98;
  b[i] = GRASS.b + v * 0.22;

  const fine = (nFine - 0.5) * 10;
  r[i] += fine * 0.4;
  g[i] += fine * 0.55;
  b[i] += fine * 0.35;

  const tau = (2 * Math.PI) / P;
  const blade = Math.sin(tau * (x * 5 + y * 3));
  const blade2 = Math.cos(tau * (x * 2 - y * 7)) * 0.55;
  const blade3 = Math.sin(tau * (x * -4 + y * 6)) * 0.35;
  r[i] += blade * 2.4 + blade2 * 1.8 + blade3 * 1.2;
  g[i] += blade * 3.2 + blade2 * 2.2 + blade3 * 1.4;
  b[i] += blade * 1.6 + blade2 * 1.1 + blade3 * 0.8;

  if (n2 > 0.72) {
    const sh = (n2 - 0.72) / 0.28;
    r[i] -= 10 * sh;
    g[i] -= 3.5 * sh;
    b[i] -= 6.5 * sh;
  }

  if (n3 > 0.88) {
    const ft = tileNoise(n, x, y, 11, 120, 140);
    const w = Math.min(1, (n3 - 0.88) / 0.12);
    if (ft > 0.52) {
      r[i] += 68 * w;
      g[i] -= 14 * w;
      b[i] -= 14 * w;
    } else {
      r[i] += 48 * w;
      g[i] += 38 * w;
      b[i] -= 22 * w;
    }
  }

  r[i] = clamp(r[i]);
  g[i] = clamp(g[i]);
  b[i] = clamp(b[i]);
}

function genWater(
  x: number,
  y: number,
  n: NoiseGenerator,
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  i: number
): void {
  const n1 = tileNoise(n, x, y, 0.7);
  const n2 = tileNoise(n, x, y, 1.8, 37, 53);
  const n3 = tileNoise(n, x, y, 4.5, 73, 91);
  const w = (n1 - 0.5) * 30 + (n2 - 0.5) * 15;
  r[i] = WATER.r + w * 0.4;
  g[i] = WATER.g + w * 0.6;
  b[i] = WATER.b + w;
  if (n3 > 0.72) {
    const h = (n3 - 0.72) * 180;
    r[i] += h * 0.5;
    g[i] += h * 0.6;
    b[i] += h;
  }
}

function genMountain(
  x: number,
  y: number,
  n: NoiseGenerator,
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  i: number
): void {
  genGrass(x, y, n, r, g, b, i);
  const cn = tileNoise(n, x, y, 2.5, 37, 53);
  if (cn > 0.5) {
    const mix = (cn - 0.5) * 0.2;
    r[i] = r[i] * (1 - mix) + MOUNTAIN.r * mix;
    g[i] = g[i] * (1 - mix) + MOUNTAIN.g * mix;
    b[i] = b[i] * (1 - mix) + MOUNTAIN.b * mix;
  }
}

function genForest(
  x: number,
  y: number,
  n: NoiseGenerator,
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  i: number
): void {
  genGrass(x, y, n, r, g, b, i);
  const cn = tileNoise(n, x, y, 2.2, 37, 53);
  if (cn > 0.5) {
    const mix = (cn - 0.5) * 0.25;
    r[i] = r[i] * (1 - mix) + FOREST.r * mix;
    g[i] = g[i] * (1 - mix) + FOREST.g * mix;
    b[i] = b[i] * (1 - mix) + FOREST.b * mix;
  }
}

function genHill(
  x: number,
  y: number,
  n: NoiseGenerator,
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  i: number
): void {
  const n1 = tileNoise(n, x, y, 0.8);
  const n2 = tileNoise(n, x, y, 2.0, 37, 53);
  const v = (n1 - 0.5) * 35 + (n2 - 0.5) * 18;
  r[i] = HILL.r + v * 0.4;
  g[i] = HILL.g + v;
  b[i] = HILL.b + v * 0.2;
  if (n2 > 0.7) {
    r[i] += 12;
    g[i] -= 4;
    b[i] += 4;
  }
}

function genDesert(
  x: number,
  y: number,
  n: NoiseGenerator,
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  i: number
): void {
  const n1 = tileNoise(n, x, y, 0.7);
  const n2 = tileNoise(n, x, y, 1.8, 37, 53);
  const n3 = tileNoise(n, x, y, 4.5, 73, 91);
  const v = (n1 - 0.5) * 25 + (n2 - 0.5) * 12;
  r[i] = DESERT.r + v;
  g[i] = DESERT.g + v * 0.8;
  b[i] = DESERT.b + v * 0.5;
  const rip = Math.sin(x * 3.5 + y * 1.8 + n1 * 4) * 8;
  r[i] += rip;
  g[i] += rip * 0.8;
  b[i] += rip * 0.5;
  if (n3 > 0.85) {
    r[i] -= 18;
    g[i] -= 13;
    b[i] -= 8;
  }
}

function genTree(
  x: number,
  y: number,
  n: NoiseGenerator,
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  i: number
): void {
  genGrass(x, y, n, r, g, b, i);
  const cn = tileNoise(n, x, y, 3.5, 200, 210);
  if (cn > 0.5) {
    const mix = (cn - 0.5) * 0.25;
    r[i] = r[i] * (1 - mix) + 42 * mix;
    g[i] = g[i] * (1 - mix) + 110 * mix;
    b[i] = b[i] * (1 - mix) + 26 * mix;
  }
}

function genFog(
  x: number,
  y: number,
  n: NoiseGenerator,
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  i: number
): void {
  const v = 35 + (tileNoise(n, x, y, 0.6) - 0.5) * 15;
  r[i] = v;
  g[i] = v;
  b[i] = v + 3;
}

const GENERATORS: Record<string, GenFn> = {
  grass: genGrass,
  water: genWater,
  mountain: genMountain,
  forest: genForest,
  hill: genHill,
  desert: genDesert,
  tree: genTree,
  fog: genFog,
};

// --- Road overlay atlas (16 connection configs in a 4x4 grid) ---

const ROAD_COLS = 4;
const ROAD_ROWS = 4;
const ROAD_ATLAS_W = ROAD_COLS * TILE_W;
const ROAD_ATLAS_H = ROAD_ROWS * TILE_H;
const TRACK_HALF = 4;

const EDGE_MID = [
  { x: 16, y: 8 }, // NW
  { x: 48, y: 8 }, // NE
  { x: 48, y: 24 }, // SE
  { x: 16, y: 24 }, // SW
];
const CENTER = { x: 32, y: 16 };

function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
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
          rv -= darken;
          gv -= darken;
          bv -= darken;
        }

        const pebble = noise.noise(px * 7 + config * 200, py * 7, 0.2);
        if (pebble > 0.82) {
          rv -= 14;
          gv -= 11;
          bv -= 7;
        }

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
// 256 base shore configs + 256 linearized (straight-run) variants + 4 deep water

const WATER_COLS = 16;
const WATER_LINEARIZE_OFFSET = 256;
const DEEP_WATER_OFFSET = 512;
const WATER_CELL_COUNT = DEEP_WATER_OFFSET + 4;
const WATER_ROWS = Math.ceil(WATER_CELL_COUNT / WATER_COLS);
const WATER_ATLAS_W = WATER_COLS * TILE_W;
const WATER_ATLAS_H = WATER_ROWS * TILE_H;

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
  data: Uint8ClampedArray,
  noise: NoiseGenerator,
  cellIndex: number,
  config: number,
  noiseOx: number,
  noiseOy: number,
  linearizeShore: boolean = false
): void {
  const col = cellIndex % WATER_COLS;
  const row = Math.floor(cellIndex / WATER_COLS);

  const cardinals = config & 0xf;
  const diagonals = (config >> 4) & 0xf;

  for (let py = 0; py < TILE_H; py++) {
    for (let px = 0; px < TILE_W; px++) {
      if (!DIAMOND_MASK[py * TILE_W + px]) continue;

      const cpx = px + 0.5;
      const cpy = py + 0.5;

      const fNW = (cpx - 32 + 2 * cpy) / 32;
      const fNE = (32 - cpx + 2 * cpy) / 32;
      const fSE = (96 - cpx - 2 * cpy) / 32;
      const fSW = (cpx + 32 - 2 * cpy) / 32;

      const eFNW = cardinals & 1 ? 99 : fNW;
      const eFNE = cardinals & 2 ? 99 : fNE;
      const eFSE = cardinals & 4 ? 99 : fSE;
      const eFSW = cardinals & 8 ? 99 : fSW;

      const shoreNoise = noise.noise(cpx * 2.5 + noiseOx, cpy * 2.5 + noiseOy, 0.18);
      const shoreNoise2 = noise.noise(cpx * 5 + noiseOx + 200, cpy * 5 + noiseOy + 200, 0.25);
      let noiseOffset = (shoreNoise - 0.5) * 0.18 + (shoreNoise2 - 0.5) * 0.08;
      if (linearizeShore) noiseOffset *= 0.35;

      const k = 0.55;
      let minF: number;
      if (linearizeShore) {
        const active: number[] = [];
        if (!(cardinals & 1)) active.push(fNW);
        if (!(cardinals & 2)) active.push(fNE);
        if (!(cardinals & 4)) active.push(fSE);
        if (!(cardinals & 8)) active.push(fSW);
        if (active.length > 0) {
          minF = active[0];
          for (let i = 1; i < active.length; i++) {
            if (active[i] < minF) minF = active[i];
          }
        } else {
          minF = smin(smin(eFNW, eFNE, k), smin(eFSE, eFSW, k), k);
        }
      } else {
        minF = smin(smin(eFNW, eFNE, k), smin(eFSE, eFSW, k), k);
      }

      if (!linearizeShore) {
        for (let c = 0; c < 4; c++) {
          if ((cardinals & CORNER_PAIRS[c]) === CORNER_PAIRS[c] && !(diagonals & (1 << c))) {
            const dx = cpx - CORNERS[c].x;
            const dy = cpy - CORNERS[c].y;
            const fCorner = Math.sqrt(dx * dx + dy * dy) / CORNER_R;
            minF = smin(minF, fCorner, k);
          }
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
          rv += h * 0.5;
          gv += h * 0.6;
          bv += h;
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
          rv += foam;
          gv += foam;
          bv += foam * 0.8;
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
          rv -= 28;
          gv -= 24;
          bv -= 18;
        } else if (stoneNoise > 0.6) {
          rv += 18;
          gv += 15;
          bv += 10;
        } else if (stoneNoise < 0.3) {
          rv -= 10;
          gv -= 5;
          bv -= 3;
        }
        // Wet area near water edge
        if (minF > 0.28) {
          const wet = (minF - 0.28) / 0.07;
          rv -= wet * 22;
          gv -= wet * 16;
          bv += wet * 12;
        }
        alpha = Math.round(180 + 70 * t);
      } else {
        // Grassy edge transition
        const t = (minF - 0.13) / 0.09;
        rv = 100 + variation * 0.2;
        gv = 125 + variation * 0.3;
        bv = 65 + variation * 0.15;
        if (stoneNoise > 0.75) {
          rv += 20;
          gv -= 10;
          bv -= 5;
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
    renderWaterCell(data, noise, config, config, config * 97, config * 53, false);
    renderWaterCell(
      data,
      noise,
      WATER_LINEARIZE_OFFSET + config,
      config,
      config * 97,
      config * 53,
      true
    );
  }

  // 4 deep water variants (all neighbors water, different noise offsets)
  for (let v = 0; v < 4; v++) {
    renderWaterCell(data, noise, DEEP_WATER_OFFSET + v, 255, v * 211 + 500, v * 173 + 700, false);
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

function buildTextureFill(gen: GenFn, noise: NoiseGenerator): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(ATLAS_W, ATLAS_H);
  const data = imageData.data;
  const rBuf = new Float64Array(1);
  const gBuf = new Float64Array(1);
  const bBuf = new Float64Array(1);

  for (let py = 0; py < ATLAS_H; py++) {
    for (let px = 0; px < ATLAS_W; px++) {
      const { gfx, gfy } = toGridCoords(0, 0, px, py);
      gen(gfx, gfy, noise, rBuf, gBuf, bBuf, 0);
      const idx = (py * ATLAS_W + px) * 4;
      data[idx] = clamp(Math.round(rBuf[0]));
      data[idx + 1] = clamp(Math.round(gBuf[0]));
      data[idx + 2] = clamp(Math.round(bBuf[0]));
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

// ---- Grass micro-decoration helpers (baked into atlas at startup, zero runtime cost) ----

/**
 * Deterministic per-slot RNG from atlas coordinates.
 * Different `salt` values give independent streams for each decoration type.
 */
function slotRng(gx: number, gy: number, salt: number): () => number {
  let s = ((gx * 374761393) ^ (gy * 668265263) ^ (salt * 2246822519)) >>> 0;
  return (): number => {
    s = Math.imul(s ^ (s >>> 13), 1274126177);
    s = (s ^ (s >>> 16)) >>> 0;
    return s / 4294967296;
  };
}

type GrassDecoration = 'plain' | 'stone' | 'flower' | 'dirt' | 'tall';

/**
 * Pick decoration type for an atlas slot.
 * Uses two-octave tileable noise to create natural-looking patches across the atlas.
 * Proportions: ~53% plain, ~14% tall grass, ~12% stone, ~11% flower, ~10% dirt.
 */
function slotDecoration(noise: NoiseGenerator, gx: number, gy: number): GrassDecoration {
  const coarse = tileNoise(noise, gx, gy, 0.5, 200, 300);
  const med = tileNoise(noise, gx, gy, 1.8, 250, 350);
  const v = coarse * 0.65 + med * 0.35;
  if (v < 0.53) return 'plain';
  if (v < 0.67) return 'tall';
  if (v < 0.79) return 'stone';
  if (v < 0.9) return 'flower';
  return 'dirt';
}

/**
 * Convert fractional isometric tile-local coordinates (u, v) to atlas pixel position.
 * u, v ∈ [-0.5, 0.5] — fractional grid offsets from tile center.
 * cx, cy — tile center in atlas pixel space.
 */
function isoToAtlasPx(u: number, v: number, cx: number, cy: number): [number, number] {
  return [cx + (u - v) * (TILE_W / 2), cy + (u + v) * (TILE_H / 2)];
}

/** Draw 2–3 small stones on an atlas tile slot. */
function drawStonesOnSlot(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  gx: number,
  gy: number
): void {
  const rng = slotRng(gx, gy, 11);
  const count = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < count; i++) {
    const u = (rng() - 0.5) * 0.68;
    const v = (rng() - 0.5) * 0.68;
    const [px, py] = isoToAtlasPx(u, v, cx, cy);
    const rw = 3.2 + rng() * 2.8; // 3.2–6 px half-width
    const rh = rw * 0.52; // flattened for iso perspective
    const rot = (rng() - 0.5) * 0.5;

    // Drop shadow
    ctx.fillStyle = 'rgba(30, 22, 12, 0.40)';
    ctx.beginPath();
    ctx.ellipse(px + 1.3, py + 0.9, rw * 0.88, rh * 0.75, rot, 0, Math.PI * 2);
    ctx.fill();

    // Stone body — warm grey-brown
    const L = 118 + Math.floor(rng() * 48);
    ctx.fillStyle = `rgb(${L}, ${L - 11}, ${L - 23})`;
    ctx.beginPath();
    ctx.ellipse(px, py, rw, rh, rot, 0, Math.PI * 2);
    ctx.fill();

    // Specular highlight
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    ctx.beginPath();
    ctx.ellipse(px - rw * 0.2, py - rh * 0.22, rw * 0.44, rh * 0.38, rot - 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

const FLOWER_COLORS = ['#FFD700', '#F5F5F5', '#FFB6C1', '#B8E0F7', '#E8C5F5', '#FFA040'];

/** Draw 3–6 small flowers on an atlas tile slot. */
function drawFlowersOnSlot(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  gx: number,
  gy: number
): void {
  const rng = slotRng(gx, gy, 22);
  const count = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < count; i++) {
    const u = (rng() - 0.5) * 0.74;
    const v = (rng() - 0.5) * 0.74;
    const [px, py] = isoToAtlasPx(u, v, cx, cy);
    const color = FLOWER_COLORS[Math.floor(rng() * FLOWER_COLORS.length)];
    const r = 1.6 + rng() * 0.9; // 1.6–2.5 px petal radius

    // Stem — short downward stroke ("down" in iso = toward viewer = positive py)
    ctx.strokeStyle = '#4a7a1e';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(px, py + r);
    ctx.lineTo(px + (rng() - 0.5) * 0.8, py + r + 2.4);
    ctx.stroke();

    // Petal cluster
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();

    // Tiny yellow-orange center
    ctx.fillStyle = 'rgba(255, 160, 30, 0.88)';
    ctx.beginPath();
    ctx.arc(px, py, r * 0.42, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Draw a bare-soil patch on an atlas tile slot. */
function drawDirtOnSlot(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  gx: number,
  gy: number
): void {
  const rng = slotRng(gx, gy, 33);
  const du = (rng() - 0.5) * 0.32;
  const dv = (rng() - 0.5) * 0.32;
  const [px, py] = isoToAtlasPx(du, dv, cx, cy);
  const scale = 0.38 + rng() * 0.32; // 0.38–0.70 of tile half-size
  const rw = (TILE_W / 2) * scale;
  const rh = (TILE_H / 2) * scale;
  const rot = (rng() - 0.5) * 0.55;

  // Primary dirt oval
  ctx.fillStyle = 'rgba(126, 88, 46, 0.60)';
  ctx.beginPath();
  ctx.ellipse(px, py, rw, rh, rot, 0, Math.PI * 2);
  ctx.fill();

  // Secondary smaller blob for irregular edge
  const u2 = du + (rng() - 0.5) * 0.18;
  const v2 = dv + (rng() - 0.5) * 0.18;
  const [px2, py2] = isoToAtlasPx(u2, v2, cx, cy);
  ctx.fillStyle = 'rgba(108, 72, 36, 0.38)';
  ctx.beginPath();
  ctx.ellipse(px2, py2, rw * 0.6, rh * 0.6, rot + 0.38, 0, Math.PI * 2);
  ctx.fill();
}

/** Draw 3–5 clumps of taller, darker grass blades on an atlas tile slot. */
function drawTallGrassOnSlot(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  gx: number,
  gy: number
): void {
  const rng = slotRng(gx, gy, 44);
  const clumpCount = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < clumpCount; i++) {
    const u = (rng() - 0.5) * 0.72;
    const v = (rng() - 0.5) * 0.72;
    const [px, py] = isoToAtlasPx(u, v, cx, cy);
    const blades = 2 + Math.floor(rng() * 2);
    for (let b = 0; b < blades; b++) {
      const lean = (rng() - 0.5) * 3.2; // horizontal lean
      const len = 3.5 + rng() * 3.0; // 3.5–6.5 px blade length
      const gVal = 72 + Math.floor(rng() * 38); // darker green range
      ctx.strokeStyle = `rgb(24, ${gVal}, 10)`;
      ctx.lineWidth = 0.9 + rng() * 0.5;
      ctx.beginPath();
      ctx.moveTo(px + (rng() - 0.5) * 1.2, py);
      ctx.lineTo(px + lean, py - len * 0.88); // blades go upward in screen space
      ctx.stroke();
    }
  }
}

/**
 * Paint micro-decorations for all 256 atlas slots directly on the canvas,
 * before the diamond mask is applied (so masking clips them correctly).
 */
function addGrassDecorations(ctx: CanvasRenderingContext2D, noise: NoiseGenerator): void {
  ctx.save();
  for (let gy = 0; gy < ATLAS_GRID; gy++) {
    for (let gx = 0; gx < ATLAS_GRID; gx++) {
      const type = slotDecoration(noise, gx, gy);
      if (type === 'plain') continue;
      const cx = gx * TILE_W + TILE_W / 2;
      const cy = gy * TILE_H + TILE_H / 2;
      switch (type) {
        case 'stone':
          drawStonesOnSlot(ctx, cx, cy, gx, gy);
          break;
        case 'flower':
          drawFlowersOnSlot(ctx, cx, cy, gx, gy);
          break;
        case 'dirt':
          drawDirtOnSlot(ctx, cx, cy, gx, gy);
          break;
        case 'tall':
          drawTallGrassOnSlot(ctx, cx, cy, gx, gy);
          break;
      }
    }
  }
  ctx.restore();
}

const GRASS_TEXTURE_SRC = '/assets/terrain/grass-texture.png';

/**
 * Split the grass photo into an N×N grid; one full image spans N×N world grass cells.
 * Atlas slots cycle (gx mod N, gy mod N) so iso variation still tiles cleanly.
 */
const GRASS_TEXTURE_REPEAT = 3;

/** 0 at diamond perimeter → original grass; 1 at center → full tint (same metric as DIAMOND_MASK). */
function grassEdgeTintStrength(lx: number, ly: number): number {
  const dx = Math.abs(lx + 0.5 - TILE_W / 2) / (TILE_W / 2);
  const dy = Math.abs(ly + 0.5 - TILE_H / 2) / (TILE_H / 2);
  const w = dx + dy;
  if (w >= 1.06) return 0;
  const edge = w / 1.06;
  return Math.pow(Math.max(0, 1 - edge), 1.38);
}

function canvasFromImageData(id: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = id.width;
  canvas.height = id.height;
  canvas.getContext('2d')!.putImageData(id, 0, 0);
  return canvas;
}

/**
 * One GPU readback for the full grass atlas (no per-tile getImageData).
 * Forest / tree / mountain: tint fades toward original grass at each tile’s diamond edge.
 */
function buildGrassPhotoAtlases(
  img: HTMLImageElement,
  repeat: number,
  noise?: NoiseGenerator
): {
  grass: HTMLCanvasElement;
  forest: HTMLCanvasElement;
  tree: HTMLCanvasElement;
  mountain: HTMLCanvasElement;
} | null {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const r = Math.max(1, repeat);
  const cellW = iw / r;
  const cellH = ih / r;

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  for (let gy = 0; gy < ATLAS_GRID; gy++) {
    for (let gx = 0; gx < ATLAS_GRID; gx++) {
      const rx = ((gx % r) + r) % r;
      const ry = ((gy % r) + r) % r;
      const sx = rx * cellW;
      const sy = ry * cellH;
      ctx.drawImage(img, sx, sy, cellW, cellH, gx * TILE_W, gy * TILE_H, TILE_W, TILE_H);
    }
  }

  // Paint micro-decorations (stones, flowers, dirt, tall grass) before diamond mask clips them.
  if (noise) addGrassDecorations(ctx, noise);

  const baseId = ctx.getImageData(0, 0, ATLAS_W, ATLAS_H);
  const base = baseId.data;

  for (let ay = 0; ay < ATLAS_H; ay++) {
    for (let ax = 0; ax < ATLAS_W; ax++) {
      const lx = ax & (TILE_W - 1);
      const ly = ay & (TILE_H - 1);
      const ii = (ay * ATLAS_W + ax) * 4;
      if (!DIAMOND_MASK[ly * TILE_W + lx]) {
        base[ii + 3] = 0;
      }
    }
  }

  const forestMult: [number, number, number] = [0.78, 0.9, 0.72];
  const treeMult: [number, number, number] = [0.74, 0.86, 0.68];

  const makeTinted = (mult: [number, number, number]): ImageData => {
    const out = new Uint8ClampedArray(base.length);
    out.set(base);
    const mr = mult[0];
    const mg = mult[1];
    const mb = mult[2];
    for (let ay = 0; ay < ATLAS_H; ay++) {
      for (let ax = 0; ax < ATLAS_W; ax++) {
        const lx = ax & (TILE_W - 1);
        const ly = ay & (TILE_H - 1);
        const ii = (ay * ATLAS_W + ax) * 4;
        const a = base[ii + 3];
        if (a === 0) continue;
        const t = grassEdgeTintStrength(lx, ly);
        const o0 = base[ii];
        const o1 = base[ii + 1];
        const o2 = base[ii + 2];
        const dr = o0 * mr;
        const dg = o1 * mg;
        const db = o2 * mb;
        out[ii] = clamp(o0 + (dr - o0) * t);
        out[ii + 1] = clamp(o1 + (dg - o1) * t);
        out[ii + 2] = clamp(o2 + (db - o2) * t);
        out[ii + 3] = a;
      }
    }
    return new ImageData(out, ATLAS_W, ATLAS_H);
  };

  const makeMountainFromGrass = (): ImageData => {
    const out = new Uint8ClampedArray(base.length);
    out.set(base);
    const rockMix = 0.44;
    const mr = MOUNTAIN.r;
    const mg = MOUNTAIN.g;
    const mb = MOUNTAIN.b;
    for (let ay = 0; ay < ATLAS_H; ay++) {
      for (let ax = 0; ax < ATLAS_W; ax++) {
        const lx = ax & (TILE_W - 1);
        const ly = ay & (TILE_H - 1);
        const ii = (ay * ATLAS_W + ax) * 4;
        const a = base[ii + 3];
        if (a === 0) continue;
        const t = grassEdgeTintStrength(lx, ly);
        const o0 = base[ii];
        const o1 = base[ii + 1];
        const o2 = base[ii + 2];
        const rr = o0 * (1 - rockMix) + mr * rockMix;
        const gg = o1 * (1 - rockMix) + mg * rockMix;
        const bb = o2 * (1 - rockMix) + mb * rockMix;
        out[ii] = clamp(o0 + (rr - o0) * t);
        out[ii + 1] = clamp(o1 + (gg - o1) * t);
        out[ii + 2] = clamp(o2 + (bb - o2) * t);
        out[ii + 3] = a;
      }
    }
    return new ImageData(out, ATLAS_W, ATLAS_H);
  };

  return {
    grass: canvasFromImageData(baseId),
    forest: canvasFromImageData(makeTinted(forestMult)),
    tree: canvasFromImageData(makeTinted(treeMult)),
    mountain: canvasFromImageData(makeMountainFromGrass()),
  };
}

interface CachedRoad {
  path: Path2D;
  warm: boolean;
  pebblesDark: Path2D;
  pebblesLight: Path2D;
}

export class TerrainTextures {
  private atlases = new Map<string, HTMLCanvasElement>();
  private roadAtlas: HTMLCanvasElement;
  private waterAtlas: HTMLCanvasElement;
  private waterFillTexture: HTMLCanvasElement;
  private waterFillPattern: CanvasPattern | null = null;
  /** Stored for async grass photo atlas decoration pass. */
  private noise: NoiseGenerator;
  private cachedRoads = new Map<string, CachedRoad>();

  constructor(seed: number = 42) {
    const noise = new NoiseGenerator(seed);
    this.noise = noise;
    for (const terrain of Object.keys(GENERATORS)) {
      this.atlases.set(terrain, buildAtlas(GENERATORS[terrain], noise));
    }
    this.roadAtlas = buildRoadAtlas(noise);
    this.waterAtlas = buildWaterAtlas(noise);
    this.waterFillTexture = buildTextureFill(genWater, noise);
    this.loadGrassPhotoAtlas();
  }

  private loadGrassPhotoAtlas(): void {
    const img = new Image();
    img.decoding = 'async';
    const apply = (): void => {
      if (!img.naturalWidth) return;
      try {
        const built = buildGrassPhotoAtlases(img, GRASS_TEXTURE_REPEAT, this.noise);
        if (!built) return;
        this.atlases.set('grass', built.grass);
        this.atlases.set('forest', built.forest);
        this.atlases.set('tree', built.tree);
        this.atlases.set('mountain', built.mountain);
      } catch {
        /* keep procedural atlases */
      }
    };
    img.onload = apply;
    img.onerror = () => {
      /* procedural */
    };
    img.src = GRASS_TEXTURE_SRC;
    if (img.complete) apply();
  }

  drawTile(
    ctx: CanvasRenderingContext2D,
    terrain: string,
    tileX: number,
    tileY: number,
    screenCenterX: number,
    screenCenterY: number
  ): void {
    const atlas = this.atlases.get(terrain);
    if (!atlas) return;

    const gx = ((tileX % ATLAS_GRID) + ATLAS_GRID) % ATLAS_GRID;
    const gy = ((tileY % ATLAS_GRID) + ATLAS_GRID) % ATLAS_GRID;

    ctx.drawImage(
      atlas,
      gx * TILE_W,
      gy * TILE_H,
      TILE_W,
      TILE_H,
      screenCenterX - TILE_W / 2,
      screenCenterY - TILE_H / 2,
      TILE_W,
      TILE_H
    );
  }

  useWaterTextureFill(ctx: CanvasRenderingContext2D): boolean {
    if (!this.waterFillPattern) {
      this.waterFillPattern = ctx.createPattern(this.waterFillTexture, 'repeat');
      this.waterFillPattern?.setTransform(new DOMMatrix().scale(WATER_FILL_PATTERN_SCALE));
    }
    if (!this.waterFillPattern) return false;
    ctx.fillStyle = this.waterFillPattern;
    return true;
  }

  private roadHash(tileX: number, tileY: number, salt: number): number {
    let h = tileX * 374761393 + tileY * 668265263 + salt * 2246822519;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  private roadLocalPoint(bit: number): { x: number; y: number } {
    const p = EDGE_MID[bit] ?? CENTER;
    return { x: p.x - CENTER.x, y: p.y - CENTER.y };
  }

  private getRoadPath(
    connections: number[],
    tileX: number,
    tileY: number,
    linearizeCorner: boolean = false
  ): Path2D {
    const wobbleX = (this.roadHash(tileX, tileY, 1) - 0.5) * 4.5;
    const wobbleY = (this.roadHash(tileX, tileY, 2) - 0.5) * 2.5;
    const hub = { x: wobbleX, y: wobbleY };
    const path = new Path2D();

    if (
      linearizeCorner &&
      connections.length === 2 &&
      (connections[0]! + 2) % 4 !== connections[1]!
    ) {
      const a = this.roadLocalPoint(connections[0]!);
      const b = this.roadLocalPoint(connections[1]!);
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
      return path;
    }

    if (connections.length === 0) {
      path.ellipse(hub.x, hub.y, 8, 4.2, 0, 0, Math.PI * 2);
      return path;
    }

    if (connections.length === 1) {
      const end = this.roadLocalPoint(connections[0]!);
      path.moveTo(hub.x, hub.y);
      path.quadraticCurveTo(hub.x * 1.5, hub.y * 1.5, end.x, end.y);
      return path;
    }

    if (connections.length === 2) {
      const a = this.roadLocalPoint(connections[0]!);
      const b = this.roadLocalPoint(connections[1]!);
      const opposite = (connections[0]! + 2) % 4 === connections[1]!;
      const bend = opposite ? 0.75 : 1.25;
      path.moveTo(a.x, a.y);
      path.quadraticCurveTo(hub.x * bend, hub.y * bend, b.x, b.y);
      return path;
    }

    for (const bit of connections) {
      const end = this.roadLocalPoint(bit);
      path.moveTo(hub.x, hub.y);
      path.quadraticCurveTo(hub.x * 1.25, hub.y * 1.25, end.x, end.y);
    }
    
    return path;
  }

  private getRoadPebbles(
    connections: number[],
    tileX: number,
    tileY: number
  ): { dark: Path2D; light: Path2D } {
    const dark = new Path2D();
    const light = new Path2D();

    const count = 2 + Math.floor(this.roadHash(tileX, tileY, 20) * 4);
    const usableConnections =
      connections.length > 0 ? connections : [Math.floor(this.roadHash(tileX, tileY, 21) * 4)];
    for (let i = 0; i < count; i++) {
      const bit = usableConnections[i % usableConnections.length]!;
      const end = this.roadLocalPoint(bit);
      const t = 0.18 + this.roadHash(tileX, tileY, 30 + i) * 0.62;
      const side = this.roadHash(tileX, tileY, 40 + i) - 0.5;
      const len = Math.max(1, Math.hypot(end.x, end.y));
      const nx = -end.y / len;
      const ny = end.x / len;
      const x = end.x * t + nx * side * 5.5;
      const y = end.y * t + ny * side * 3.2;
      const r = 0.8 + this.roadHash(tileX, tileY, 50 + i) * 1.2;
      
      const isDark = this.roadHash(tileX, tileY, 60 + i) > 0.5;
      const target = isDark ? dark : light;
      
      target.moveTo(x + r * 1.35, y);
      target.ellipse(
        x,
        y,
        r * 1.35,
        r * 0.72,
        this.roadHash(tileX, tileY, 70 + i) * Math.PI,
        0,
        Math.PI * 2
      );
    }
    
    return { dark, light };
  }

  drawRoad(
    ctx: CanvasRenderingContext2D,
    config: number,
    screenCenterX: number,
    screenCenterY: number,
    tileX: number = 0,
    tileY: number = 0,
    linearizeCorner: boolean = false
  ): void {
    if (ROAD_RENDERING_MODE === 'classic') {
      const col = config % ROAD_COLS;
      const row = Math.floor(config / ROAD_COLS);
      ctx.drawImage(
        this.roadAtlas,
        col * TILE_W,
        row * TILE_H,
        TILE_W,
        TILE_H,
        screenCenterX - TILE_W / 2,
        screenCenterY - TILE_H / 2,
        TILE_W,
        TILE_H
      );
      return;
    }

    const connections: number[] = [];
    for (let bit = 0; bit < 4; bit++) {
      if (config & (1 << bit)) connections.push(bit);
    }

    ctx.save();
    ctx.translate(screenCenterX, screenCenterY);
    ctx.beginPath();
    ctx.moveTo(0, -TILE_H / 2);
    ctx.lineTo(TILE_W / 2, 0);
    ctx.lineTo(0, TILE_H / 2);
    ctx.lineTo(-TILE_W / 2, 0);
    ctx.closePath();
    ctx.clip();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const cacheKey = `${tileX},${tileY},${config},${linearizeCorner}`;
    let cached = this.cachedRoads.get(cacheKey);

    if (!cached) {
      cached = {
        path: this.getRoadPath(connections, tileX, tileY, linearizeCorner),
        warm: this.roadHash(tileX, tileY, 90) > 0.5,
        pebblesDark: this.getRoadPebbles(connections, tileX, tileY).dark,
        pebblesLight: this.getRoadPebbles(connections, tileX, tileY).light
      };
      this.cachedRoads.set(cacheKey, cached);
    }

    ctx.strokeStyle = 'rgba(78, 54, 31, 0.34)';
    ctx.lineWidth = 13;
    ctx.stroke(cached.path);

    ctx.strokeStyle = 'rgba(118, 82, 45, 0.74)';
    ctx.lineWidth = 10;
    ctx.stroke(cached.path);

    ctx.strokeStyle = cached.warm ? 'rgba(205, 171, 112, 0.96)' : 'rgba(190, 151, 96, 0.96)';
    ctx.lineWidth = 7;
    ctx.stroke(cached.path);

    ctx.strokeStyle = 'rgba(244, 222, 176, 0.23)';
    ctx.lineWidth = 2.2;
    ctx.stroke(cached.path);

    ctx.fillStyle = 'rgba(111, 82, 48, 0.38)';
    ctx.fill(cached.pebblesDark);
    ctx.fillStyle = 'rgba(235, 205, 155, 0.24)';
    ctx.fill(cached.pebblesLight);

    ctx.restore();
  }

  drawWater(
    ctx: CanvasRenderingContext2D,
    config: number,
    tileX: number,
    tileY: number,
    screenCenterX: number,
    screenCenterY: number,
    useLinearizedShore: boolean = false
  ): void {
    let cell: number;
    if (config === 255) {
      cell = DEEP_WATER_OFFSET + ((tileX + tileY) & 3);
    } else if (useLinearizedShore) {
      cell = WATER_LINEARIZE_OFFSET + config;
    } else {
      cell = config;
    }
    const col = cell % WATER_COLS;
    const row = Math.floor(cell / WATER_COLS);

    ctx.drawImage(
      this.waterAtlas,
      col * TILE_W,
      row * TILE_H,
      TILE_W,
      TILE_H,
      screenCenterX - TILE_W / 2,
      screenCenterY - TILE_H / 2,
      TILE_W,
      TILE_H
    );
  }
}
