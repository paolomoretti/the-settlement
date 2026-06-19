/**
 * TileMap - manages the game world grid
 */

import { Tile, TerrainType } from './Tile';
import { cellMineralTotal } from './CellMinerals';
import { NoiseGenerator } from '@/utils/NoiseGenerator';
import { rollWaterFishSchoolMax } from './waterFishSchool';
import { dataManager } from '@/data/DataManager';

/** Orthogonal flood-fill cap (avoids runaway work on pathological maps). */
const WATER_FISH_CLUSTER_BFS_CAP = 262144;
/** Cap for HQ→mainland tunnel BFS (same order as map area). */
const HQ_MAINLAND_BRIDGE_BFS_CAP = 1_000_000;
const WATER_CARDINALS: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export type WaterFishClusterState = {
  remaining: number;
  max: number;
  cellCount: number;
};

const TERRAIN_CODES: Record<TerrainType, string> = {
  grass: 'g',
  water: 'w',
  mountain: 'm',
  forest: 'f',
  tree: 't',
  hill: 'h',
  desert: 'd',
};
const CODE_TO_TERRAIN: Record<string, TerrainType> = {};
for (const [terrain, code] of Object.entries(TERRAIN_CODES)) {
  CODE_TO_TERRAIN[code] = terrain as TerrainType;
}

export class TileMap {
  private tiles: Tile[][] = [];
  public readonly width: number;
  public readonly height: number;
  private seed: number;
  /** Cached from `GAME_CONFIG` at the start of each full generate pass. */
  private terrainGen: {
    forestDensityMin: number;
    forestTreePlacementMin: number;
    scatteredTreePlacementMin: number;
  } = {
    forestDensityMin: 0.38,
    forestTreePlacementMin: 0.17,
    scatteredTreePlacementMin: 0.42,
  };
  /**
   * Shared fish stock per orthogonal water body. Populated lazily via {@link ensureWaterFishClusterAt}.
   * Public so {@link TileMap.deserialize} can attach state when using `Object.create` (no constructor run).
   */
  public waterFishClusterById = new Map<number, WaterFishClusterState>();
  public nextWaterFishClusterId = 1;

  constructor(width: number, height: number, seed?: number) {
    this.width = width;
    this.height = height;
    this.seed = seed || Date.now();
    this.generate();
  }

  public getSeed(): number {
    return this.seed;
  }

  private generate(): void {
    const t = dataManager.getGameConfig().world.terrain;
    this.terrainGen = {
      forestDensityMin: t.forestDensityMin,
      forestTreePlacementMin: t.forestTreePlacementMin,
      scatteredTreePlacementMin: t.scatteredTreePlacementMin,
    };

    const noise = new NoiseGenerator(this.seed);

    for (let y = 0; y < this.height; y++) {
      this.tiles[y] = [];
      for (let x = 0; x < this.width; x++) {
        const terrain = this.generateTerrain(x, y, noise);
        this.tiles[y][x] = new Tile(x, y, terrain);
      }
    }

    this.generateRivers(noise);
    this.generateMountainRanges(noise);
    this.generateRockFormations(noise);
    this.removeIsolatedWater();
    this.clearBaseCampArea();
    this.ensureHqMainlandBridge();
    this.removeIslands();
    this.enforceMaxLakeSize();
    this.ensureStarterTreesNearHq();
    this.computeWaterDepth();
    this.computeForestDepth();
  }

  private initEmpty(): void {
    for (let y = 0; y < this.height; y++) {
      this.tiles[y] = [];
      for (let x = 0; x < this.width; x++) {
        this.tiles[y][x] = new Tile(x, y, 'grass');
      }
    }
  }

  private generateTerrain(x: number, y: number, noise: NoiseGenerator): TerrainType {
    const elevation = noise.fractalNoise(x, y, 4);

    if (elevation < 0.17) {
      return 'water';
    }

    const lakeNoise =
      noise.noise(x + 3000, y + 3000, 0.1) * 0.5 +
      noise.noise(x + 3500, y + 3500, 0.22) * 0.3 +
      noise.noise(x + 3800, y + 3800, 0.38) * 0.2;
    const wetness = noise.noise(x + 4000, y + 4000, 0.005);
    const lakeThreshold = 0.16 + Math.max(0, wetness - 0.32) * 0.32;
    if (lakeNoise < lakeThreshold && elevation < 0.45) {
      return 'water';
    }

    // Forest clusters + scattered trees: thresholds from `GAME_CONFIG.world.terrain`.
    const forestDensity = noise.noise(x + 5000, y + 5000, 0.008);
    const treePlacement =
      noise.noise(x + 6000, y + 6000, 0.1) * 0.5 +
      noise.noise(x + 6500, y + 6500, 0.2) * 0.3 +
      noise.noise(x + 7000, y + 7000, 0.4) * 0.2;

    if (forestDensity > this.terrainGen.forestDensityMin && treePlacement > this.terrainGen.forestTreePlacementMin) {
      return 'forest';
    }
    if (treePlacement > this.terrainGen.scatteredTreePlacementMin) {
      return 'tree';
    }

    return 'grass';
  }

  private generateRivers(noise: NoiseGenerator): void {
    const numRivers = 2 + Math.floor(noise.noise(10000, 10000, 0.1) * 2);

    for (let r = 0; r < numRivers; r++) {
      const startX = Math.floor(noise.noise(10000 + r * 199, 10001, 0.1) * this.width);
      let x = startX;
      let y = 0;

      while (y < this.height) {
        for (let dx = -1; dx <= 1; dx++) {
          const tile = this.getTile(x + dx, y);
          if (tile && tile.terrain !== 'mountain') {
            tile.terrain = 'water';
            tile.walkable = false;
          }
        }

        const direction = noise.noise(x, y, 0.5);
        if (direction > 0.6) {
          x = Math.min(x + 1, this.width - 1);
        } else if (direction < 0.4) {
          x = Math.max(x - 1, 0);
        }

        y++;
      }
    }
  }

  private generateMountainRanges(noise: NoiseGenerator): void {
    const numRanges = 8 + Math.floor(noise.noise(100, 100, 0.1) * 8);

    for (let r = 0; r < numRanges; r++) {
      const startX = Math.floor(
        noise.noise(r * 137, 7919, 0.1) * this.width * 0.8 + this.width * 0.1
      );
      const startY = Math.floor(
        noise.noise(7919, r * 137, 0.1) * this.height * 0.8 + this.height * 0.1
      );
      const rangeWidth = 60 + Math.floor(noise.noise(r * 53, 3571, 0.1) * 200);
      const baseHeight = 6 + Math.floor(noise.noise(r * 53, 4571, 0.1) * 12);

      for (let dx = 0; dx < rangeWidth; dx++) {
        const localHeight = Math.max(
          2,
          Math.floor(baseHeight * (0.4 + noise.noise(startX + dx, startY + 1000, 0.04) * 0.8))
        );
        const yOffset = Math.floor((noise.noise(startX + dx, startY + 2000, 0.025) - 0.5) * 8);

        for (let dy = -Math.floor(localHeight / 2); dy <= Math.floor(localHeight / 2); dy++) {
          const tx = startX + dx;
          const ty = startY + dy + yOffset;
          const tile = this.getTile(tx, ty);
          if (tile) {
            tile.terrain = 'mountain';
            tile.walkable = false;
          }
        }
      }
    }
  }

  private generateRockFormations(noise: NoiseGenerator): void {
    const numRocks = 300 + Math.floor(noise.noise(200, 200, 0.1) * 200);
    const cx = Math.floor(this.width / 2);
    const cy = Math.floor(this.height / 2);

    for (let r = 0; r < numRocks; r++) {
      let rx: number, ry: number;

      if (r < 30) {
        const angle = noise.noise(r * 97 + 777, 6001, 0.1) * Math.PI * 2;
        const dist = 20 + noise.noise(6001, r * 97 + 777, 0.1) * 60;
        rx = Math.floor(cx + Math.cos(angle) * dist);
        ry = Math.floor(cy + Math.sin(angle) * dist);
      } else {
        rx = Math.floor(noise.noise(r * 73 + 111, 3001, 0.1) * this.width);
        ry = Math.floor(noise.noise(3001, r * 73 + 111, 0.1) * this.height);
      }

      const size = 1 + Math.floor(noise.noise(r * 37 + 222, 4001, 0.1) * 5);

      for (let i = 0; i < size; i++) {
        const dx = Math.floor((noise.noise(r * 11 + i + 333, 5001, 0.1) - 0.5) * 4);
        const dy = Math.floor((noise.noise(5001, r * 11 + i + 333, 0.1) - 0.5) * 4);
        const tile = this.getTile(rx + dx, ry + dy);
        if (tile && tile.terrain !== 'water') {
          tile.terrain = 'mountain';
          tile.walkable = false;
        }
      }
    }
  }

  private removeIsolatedWater(): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const tile = this.tiles[y][x];
        if (tile.terrain !== 'water') continue;

        let waterNeighbors = 0;
        const dirs = [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ];
        for (const [dx, dy] of dirs) {
          const n = this.getTile(x + dx, y + dy);
          if (n && n.terrain === 'water') waterNeighbors++;
        }

        if (waterNeighbors < 2) {
          tile.terrain = 'grass';
          tile.walkable = true;
        }
      }
    }
  }

  private clearBaseCampArea(): void {
    const cx = Math.floor(this.width / 2);
    const cy = Math.floor(this.height / 2);
    const margin = 4;

    for (let y = cy - margin; y < cy + 6 + margin; y++) {
      for (let x = cx - margin; x < cx + 6 + margin; x++) {
        const tile = this.getTile(x, y);
        if (tile && (tile.terrain === 'water' || tile.terrain === 'mountain')) {
          tile.terrain = 'grass';
          tile.walkable = true;
        }
      }
    }
  }

  private static isWaterOrMountainTerrain(t: TerrainType): boolean {
    return t === 'water' || t === 'mountain';
  }

  /**
   * If the HQ walkable blob is not the largest landmass (e.g. camp was cleared inside a lake),
   * carve an orthogonal land bridge by converting water/mountain along a shortest path to the
   * largest component. Runs after `clearBaseCampArea` and before `removeIslands` so the latter
   * does not turn the entire mainland into water while leaving HQ on a pond island.
   */
  private ensureHqMainlandBridge(): void {
    const W = this.width;
    const H = this.height;
    const cx = Math.floor(W / 2);
    const cy = Math.floor(H / 2);
    const hqIdx = cy * W + cx;
    const hqTile = this.tiles[cy][cx];
    if (TileMap.isWaterOrMountainTerrain(hqTile.terrain)) {
      console.warn(
        `[TileMap] HQ mainland bridge skipped: HQ tile (${cx},${cy}) is still ${hqTile.terrain} after clearBaseCampArea.`
      );
      return;
    }

    const comp = new Int32Array(W * H);
    comp.fill(-1);
    const compSizes: number[] = [];
    const dirs = WATER_CARDINALS;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (comp[i] >= 0) continue;
        const t = this.tiles[y][x].terrain;
        if (TileMap.isWaterOrMountainTerrain(t)) continue;

        const id = compSizes.length;
        let size = 0;
        const q: number[] = [x, y];
        comp[i] = id;
        let head = 0;
        while (head < q.length) {
          const qx = q[head++];
          const qy = q[head++];
          size++;
          for (const [dx, dy] of dirs) {
            const nx = qx + dx;
            const ny = qy + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ni = ny * W + nx;
            if (comp[ni] >= 0) continue;
            const nt = this.tiles[ny][nx].terrain;
            if (TileMap.isWaterOrMountainTerrain(nt)) continue;
            comp[ni] = id;
            q.push(nx, ny);
          }
        }
        compSizes.push(size);
      }
    }

    const hqComp = comp[hqIdx];
    if (hqComp < 0) {
      console.warn(`[TileMap] HQ mainland bridge skipped: HQ tile not in any walkable component.`);
      return;
    }

    let maxSize = -1;
    let targetComp = -1;
    for (let id = 0; id < compSizes.length; id++) {
      if (compSizes[id] > maxSize) {
        maxSize = compSizes[id];
        targetComp = id;
      }
    }

    if (targetComp < 0 || compSizes[hqComp] >= maxSize) {
      return;
    }

    const parent = new Int32Array(W * H);
    parent.fill(-1);
    const seen = new Uint8Array(W * H);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (comp[i] === hqComp) {
          seen[i] = 1;
        }
      }
    }

    const q: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (comp[i] !== hqComp) continue;
        for (const [dx, dy] of dirs) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ni = ny * W + nx;
          if (seen[ni]) continue;
          const nt = this.tiles[ny][nx].terrain;
          if (!TileMap.isWaterOrMountainTerrain(nt)) continue;
          seen[ni] = 1;
          parent[ni] = i;
          q.push(nx, ny);
        }
      }
    }

    let head = 0;
    let dequeues = 0;
    while (head < q.length) {
      if (dequeues++ > HQ_MAINLAND_BRIDGE_BFS_CAP) {
        console.warn('[TileMap] HQ mainland bridge: BFS cap reached; giving up.');
        return;
      }
      const x = q[head++];
      const y = q[head++];
      const i = y * W + x;

      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        const nt = this.tiles[ny][nx].terrain;

        if (!TileMap.isWaterOrMountainTerrain(nt)) {
          if (comp[ni] === targetComp) {
            this.carveHqMainlandBridge(parent, comp, hqComp, i);
            return;
          }
          continue;
        }

        if (!seen[ni]) {
          seen[ni] = 1;
          parent[ni] = i;
          q.push(nx, ny);
        }
      }
    }

    console.warn(
      `[TileMap] HQ mainland bridge: no water/mountain path from HQ component (${compSizes[hqComp]} cells) to largest (${maxSize} cells).`
    );
  }

  private carveHqMainlandBridge(
    parent: Int32Array,
    comp: Int32Array,
    hqComp: number,
    startIdx: number
  ): void {
    const W = this.width;
    let cur = startIdx;
    for (let guard = 0; guard < W * this.height; guard++) {
      const x = cur % W;
      const y = Math.floor(cur / W);
      const tile = this.tiles[y][x];
      if (TileMap.isWaterOrMountainTerrain(tile.terrain)) {
        tile.terrain = 'grass';
        tile.walkable = true;
      }
      const p = parent[cur];
      if (p < 0) break;
      const px = p % W;
      const py = Math.floor(p / W);
      const pt = this.tiles[py][px];
      if (comp[p] === hqComp && !TileMap.isWaterOrMountainTerrain(pt.terrain)) {
        break;
      }
      cur = p;
    }
  }

  /**
   * New worlds: if procedural noise left too few trees near HQ, convert nearby grass to `forest`
   * until `GAME_CONFIG.world.terrain.hqMinTreeCellsNearHq` tree/forest cells exist within Chebyshev
   * `hqStarterForestSearchRadius` of HQ center (excluding the HQ footprint). Runs after
   * `removeIslands` so tiles stay mainland-reachable.
   */
  private ensureStarterTreesNearHq(): void {
    const { hqMinTreeCellsNearHq, hqStarterForestSearchRadius } = dataManager.getGameConfig().world.terrain;
    const cx = Math.floor(this.width / 2);
    const cy = Math.floor(this.height / 2);
    const hqDef = dataManager.getBuilding('base_camp');
    const hqW = hqDef?.size.width ?? 5;
    const hqH = hqDef?.size.height ?? 5;
    const centerX = cx + Math.floor((hqW - 1) / 2);
    const centerY = cy + Math.floor((hqH - 1) / 2);

    const inHqFootprint = (x: number, y: number) =>
      x >= cx && x < cx + hqW && y >= cy && y < cy + hqH;

    const isTreeTerrain = (t: TerrainType) => t === 'forest' || t === 'tree';
    const chebFromCenter = (x: number, y: number) =>
      Math.max(Math.abs(x - centerX), Math.abs(y - centerY));

    let nearTreeCells = 0;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (inHqFootprint(x, y)) continue;
        if (chebFromCenter(x, y) > hqStarterForestSearchRadius) continue;
        const tile = this.tiles[y][x];
        if (tile && isTreeTerrain(tile.terrain)) nearTreeCells++;
      }
    }

    if (nearTreeCells >= hqMinTreeCellsNearHq) return;

    type Cand = { x: number; y: number; d: number };
    const candidates: Cand[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (inHqFootprint(x, y)) continue;
        const d = chebFromCenter(x, y);
        if (d === 0 || d > hqStarterForestSearchRadius) continue;
        const tile = this.tiles[y][x];
        if (!tile || tile.terrain !== 'grass' || !tile.walkable) continue;
        candidates.push({ x, y, d });
      }
    }
    candidates.sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);

    const need = hqMinTreeCellsNearHq - nearTreeCells;
    let placed = 0;
    for (const c of candidates) {
      if (placed >= need) break;
      const tile = this.tiles[c.y][c.x];
      tile.terrain = 'forest';
      tile.walkable = true;
      placed++;
    }

    if (placed < need) {
      console.warn(
        `[TileMap] HQ starter forest: needed ${need} cells but only placed ${placed} (${candidates.length} grass candidates in Chebyshev radius ${hqStarterForestSearchRadius}).`
      );
    }
  }

  private removeIslands(): void {
    const cx = Math.floor(this.width / 2);
    const cy = Math.floor(this.height / 2);
    const visited = new Uint8Array(this.width * this.height);

    const queue: number[] = [cx, cy];
    visited[cy * this.width + cx] = 1;
    let head = 0;

    while (head < queue.length) {
      const x = queue[head++];
      const y = queue[head++];

      const dirs = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ];
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
        const idx = ny * this.width + nx;
        if (visited[idx]) continue;
        const tile = this.tiles[ny][nx];
        if (tile.terrain === 'water' || tile.terrain === 'mountain') continue;
        visited[idx] = 1;
        queue.push(nx, ny);
      }
    }

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (visited[y * this.width + x]) continue;
        const tile = this.tiles[y][x];
        if (tile.walkable) {
          tile.terrain = 'water';
          tile.walkable = false;
        }
      }
    }
  }

  private enforceMaxLakeSize(): void {
    const W = this.width;
    const H = this.height;
    const visited = new Uint8Array(W * H);
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (visited[i]) continue;
        if (this.tiles[y][x].terrain !== 'water') continue;

        const q: number[] = [x, y];
        const lake: number[] = [];
        visited[i] = 1;
        let head = 0;

        while (head < q.length) {
          const cx = q[head++];
          const cy = q[head++];
          lake.push(cx, cy);

          for (const [dx, dy] of dirs) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ni = ny * W + nx;
            if (visited[ni]) continue;
            if (this.tiles[ny][nx].terrain !== 'water') continue;
            
            visited[ni] = 1;
            q.push(nx, ny);
          }
        }

        const lakeSize = lake.length / 2;
        if (lakeSize > 750) {
          for (let j = 750 * 2; j < lake.length; j += 2) {
            const lx = lake[j];
            const ly = lake[j+1];
            this.tiles[ly][lx].terrain = 'grass';
            this.tiles[ly][lx].walkable = true;
          }
        }
      }
    }
  }

  private computeWaterDepth(): void {
    const queue: number[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const tile = this.tiles[y][x];
        if (tile.terrain !== 'water') {
          tile.waterDepth = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx,
                ny = y + dy;
              if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
                const n = this.tiles[ny][nx];
                if (n.terrain === 'water' && n.waterDepth === 0) {
                  n.waterDepth = 1;
                  queue.push(nx, ny);
                }
              }
            }
          }
        }
      }
    }
    let head = 0;
    while (head < queue.length) {
      const x = queue[head++];
      const y = queue[head++];
      const d = this.tiles[y][x].waterDepth;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx,
            ny = y + dy;
          if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
            const n = this.tiles[ny][nx];
            if (n.terrain === 'water' && n.waterDepth === 0) {
              n.waterDepth = d + 1;
              queue.push(nx, ny);
            }
          }
        }
      }
    }
  }

  private computeForestDepth(): void {
    const isForest = (t: Tile) => t.terrain === 'forest' || t.terrain === 'tree';
    const queue: number[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const tile = this.tiles[y][x];
        if (!isForest(tile)) {
          tile.forestDepth = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx,
                ny = y + dy;
              if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
                const n = this.tiles[ny][nx];
                if (isForest(n) && n.forestDepth === 0) {
                  n.forestDepth = 1;
                  queue.push(nx, ny);
                }
              }
            }
          }
        }
      }
    }
    let head = 0;
    while (head < queue.length) {
      const x = queue[head++];
      const y = queue[head++];
      const d = this.tiles[y][x].forestDepth;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx,
            ny = y + dy;
          if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
            const n = this.tiles[ny][nx];
            if (isForest(n) && n.forestDepth === 0) {
              n.forestDepth = d + 1;
              queue.push(nx, ny);
            }
          }
        }
      }
    }
  }

  // RLE encode terrain: "500g20w30f" = 500 grass, 20 water, 30 forest
  private encodeTerrain(): string {
    const parts: string[] = [];
    let prev = TERRAIN_CODES[this.tiles[0][0].terrain];
    let count = 1;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (y === 0 && x === 0) continue;
        const code = TERRAIN_CODES[this.tiles[y][x].terrain];
        if (code === prev) {
          count++;
        } else {
          parts.push(`${count}${prev}`);
          prev = code;
          count = 1;
        }
      }
    }
    parts.push(`${count}${prev}`);
    return parts.join('');
  }

  // Decode RLE terrain string and apply to tiles
  private decodeTerrain(encoded: string): void {
    const matches = encoded.match(/(\d+)([a-z])/g);
    if (!matches) return;

    let idx = 0;
    for (const match of matches) {
      const count = parseInt(match.slice(0, -1));
      const code = match.slice(-1);
      const terrain = CODE_TO_TERRAIN[code];
      if (!terrain) continue;

      for (let i = 0; i < count && idx < this.width * this.height; i++, idx++) {
        const y = Math.floor(idx / this.width);
        const x = idx % this.width;
        const tile = this.tiles[y][x];
        tile.terrain = terrain;
        tile.walkable = terrain !== 'water' && terrain !== 'mountain';
      }
    }
  }

  getTile(x: number, y: number): Tile | null {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return null;
    }
    return this.tiles[y][x];
  }

  isWalkable(x: number, y: number): boolean {
    const tile = this.getTile(x, y);
    return tile ? tile.isWalkable() : false;
  }

  setTerrain(x: number, y: number, terrain: TerrainType): void {
    const tile = this.getTile(x, y);
    if (!tile) return;
    tile.terrain = terrain;
    tile.walkable = terrain !== 'water' && terrain !== 'mountain';
  }

  /** All orthogonally connected water cells from (sx, sy), capped for safety. */
  private collectOrthogonalWaterCells(sx: number, sy: number): { x: number; y: number }[] {
    const start = this.getTile(sx, sy);
    if (!start || start.terrain !== 'water') return [];

    const out: { x: number; y: number }[] = [];
    const seen = new Set<string>();
    const q: { x: number; y: number }[] = [{ x: sx, y: sy }];
    seen.add(`${sx},${sy}`);

    while (q.length > 0 && out.length < WATER_FISH_CLUSTER_BFS_CAP) {
      const cur = q.shift()!;
      const tile = this.getTile(cur.x, cur.y);
      if (!tile || tile.terrain !== 'water') continue;
      out.push(cur);
      for (const [dx, dy] of WATER_CARDINALS) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (!this.isInBounds(nx, ny)) continue;
        const k = `${nx},${ny}`;
        if (seen.has(k)) continue;
        const nt = this.getTile(nx, ny);
        if (!nt || nt.terrain !== 'water') continue;
        seen.add(k);
        q.push({ x: nx, y: ny });
      }
    }
    return out;
  }

  /**
   * Lazily builds one fish stock for the whole orthogonal water body containing (wx, wy).
   * Fishing from any shore cell shares this pool.
   */
  ensureWaterFishClusterAt(wx: number, wy: number): void {
    const tile = this.getTile(wx, wy);
    if (!tile || tile.terrain !== 'water') return;
    if (tile.waterClusterId !== undefined) return;

    const cells = this.collectOrthogonalWaterCells(wx, wy);
    if (cells.length === 0) return;

    const mapSeed = this.seed;
    let sumMax = 0;
    let sumRem = 0;

    for (const { x, y } of cells) {
      const t = this.tiles[y][x];
      const legacyM = t.waterFishSchoolMax;
      const legacyR = t.waterFishRemaining;
      const hasLegacy = legacyM !== undefined || legacyR !== undefined;
      const cellMax = hasLegacy
        ? (legacyM ?? rollWaterFishSchoolMax(mapSeed, x, y))
        : rollWaterFishSchoolMax(mapSeed, x, y);
      const cellRem = legacyR !== undefined ? Math.min(cellMax, Math.max(0, legacyR)) : cellMax;
      sumMax += cellMax;
      sumRem += cellRem;
    }

    const clusterRemaining = Math.min(sumMax, sumRem);
    const id = this.nextWaterFishClusterId++;
    this.waterFishClusterById.set(id, {
      remaining: clusterRemaining,
      max: sumMax,
      cellCount: cells.length,
    });

    for (const { x, y } of cells) {
      const t = this.tiles[y][x];
      t.waterClusterId = id;
      delete t.waterFishSchoolMax;
      delete t.waterFishRemaining;
    }
  }

  getWaterFishRemainingAt(x: number, y: number): number {
    const tile = this.getTile(x, y);
    if (!tile || tile.terrain !== 'water') return 0;
    this.ensureWaterFishClusterAt(x, y);
    const id = tile.waterClusterId;
    if (id === undefined) return 0;
    return this.waterFishClusterById.get(id)?.remaining ?? 0;
  }

  getWaterFishClusterMaxAt(x: number, y: number): number {
    const tile = this.getTile(x, y);
    if (!tile || tile.terrain !== 'water') return 0;
    this.ensureWaterFishClusterAt(x, y);
    const id = tile.waterClusterId;
    if (id === undefined) return 0;
    return this.waterFishClusterById.get(id)?.max ?? 0;
  }

  /** Returns false if the lake cluster has no fish left for this water cell. */
  takeOneWaterFishAt(x: number, y: number): boolean {
    const tile = this.getTile(x, y);
    if (!tile || tile.terrain !== 'water') return false;
    this.ensureWaterFishClusterAt(x, y);
    const id = tile.waterClusterId;
    if (id === undefined) return false;
    const st = this.waterFishClusterById.get(id);
    if (!st || st.remaining <= 0) return false;
    st.remaining--;
    return true;
  }

  findNearbyTerrain(
    cx: number,
    cy: number,
    radius: number,
    types: string[],
    exclude?: Set<string>
  ): { x: number; y: number } | null {
    let best: { x: number; y: number; dist: number } | null = null;

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const tile = this.getTile(x, y);
        if (!tile) continue;
        if (!types.includes(tile.terrain)) continue;
        if (tile.hasRoad || tile.isOccupied()) continue;
        if (exclude && exclude.has(`${x},${y}`)) continue;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (!best || dist < best.dist) {
          best = { x, y, dist };
        }
      }
    }

    return best ? { x: best.x, y: best.y } : null;
  }

  /**
   * Nearest rock tile still yielding harvests (closest Manhattan distance first).
   */
  findNearestHarvestableRock(
    cx: number,
    cy: number,
    radius: number,
    types: string[],
    stonesPerFull: number,
    exclude?: Set<string>
  ): { x: number; y: number } | null {
    let best: { x: number; y: number; dist: number } | null = null;

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const tile = this.getTile(x, y);
        if (!tile) continue;
        if (!types.includes(tile.terrain)) continue;
        if (tile.hasRoad || tile.isOccupied()) continue;
        if (exclude && exclude.has(`${x},${y}`)) continue;
        const remaining = tile.rockHarvestsRemaining ?? stonesPerFull;
        if (remaining <= 0) continue;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (!best || dist < best.dist) {
          best = { x, y, dist };
        }
      }
    }

    return best ? { x: best.x, y: best.y } : null;
  }

  /**
   * Nearest water tile still yielding fish (closest Manhattan distance first).
   */
  findNearestHarvestableWater(
    cx: number,
    cy: number,
    radius: number,
    _fishPerFull: number,
    exclude?: Set<string>
  ): { x: number; y: number } | null {
    let best: { x: number; y: number; dist: number } | null = null;

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const tile = this.getTile(x, y);
        if (!tile) continue;
        if (tile.terrain !== 'water') continue;
        if (tile.hasRoad || tile.isOccupied()) continue;
        if (exclude && exclude.has(`${x},${y}`)) continue;
        if (this.getWaterFishRemainingAt(x, y) <= 0) continue;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (!best || dist < best.dist) {
          best = { x, y, dist };
        }
      }
    }

    return best ? { x: best.x, y: best.y } : null;
  }

  /**
   * All matching terrain tiles in the radius box, sorted by Manhattan distance from (cx, cy).
   * Used to pick a gather target that also satisfies a max path length.
   */
  listNearbyTerrainSorted(
    cx: number,
    cy: number,
    radius: number,
    types: string[],
    exclude?: Set<string>
  ): { x: number; y: number }[] {
    const found: { x: number; y: number; d: number }[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const tile = this.getTile(x, y);
        if (!tile) continue;
        if (!types.includes(tile.terrain)) continue;
        if (tile.hasRoad || tile.isOccupied()) continue;
        if (exclude && exclude.has(`${x},${y}`)) continue;
        const d = Math.abs(dx) + Math.abs(dy);
        found.push({ x, y, d });
      }
    }
    found.sort((a, b) => a.d - b.d);
    return found.map(({ x, y }) => ({ x, y }));
  }

  listHarvestableRocksSorted(
    cx: number,
    cy: number,
    radius: number,
    types: string[],
    stonesPerFull: number,
    exclude?: Set<string>
  ): { x: number; y: number }[] {
    const found: { x: number; y: number; d: number }[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const tile = this.getTile(x, y);
        if (!tile) continue;
        if (!types.includes(tile.terrain)) continue;
        if (tile.hasRoad || tile.isOccupied()) continue;
        if (exclude && exclude.has(`${x},${y}`)) continue;
        const remaining = tile.rockHarvestsRemaining ?? stonesPerFull;
        if (remaining <= 0) continue;
        const d = Math.abs(dx) + Math.abs(dy);
        found.push({ x, y, d });
      }
    }
    found.sort((a, b) => a.d - b.d);
    return found.map(({ x, y }) => ({ x, y }));
  }

  listHarvestableWaterSorted(
    cx: number,
    cy: number,
    radius: number,
    _fishPerFull: number,
    exclude?: Set<string>
  ): { x: number; y: number }[] {
    const found: { x: number; y: number; d: number }[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const tile = this.getTile(x, y);
        if (!tile) continue;
        if (tile.terrain !== 'water') continue;
        if (tile.hasRoad || tile.isOccupied()) continue;
        if (exclude && exclude.has(`${x},${y}`)) continue;
        if (this.getWaterFishRemainingAt(x, y) <= 0) continue;
        const d = Math.abs(dx) + Math.abs(dy);
        found.push({ x, y, d });
      }
    }
    found.sort((a, b) => a.d - b.d);
    return found.map(({ x, y }) => ({ x, y }));
  }

  /**
   * Every ~2h of in-game time: each initialized lake cluster gains +1 fish per water cell in that body
   * (capped at the cluster max), matching the old per-tile regen rate across the whole pond.
   */
  applyWaterFishPopulationRegen(): void {
    for (const st of this.waterFishClusterById.values()) {
      st.remaining = Math.min(st.max, st.remaining + st.cellCount);
    }
  }

  isInBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  buildRoad(x: number, y: number): boolean {
    const tile = this.getTile(x, y);
    if (
      tile &&
      !tile.hasRoad &&
      tile.terrain !== 'water' &&
      tile.terrain !== 'mountain' &&
      !tile.isOccupied()
    ) {
      tile.hasRoad = true;
      return true;
    }
    return false;
  }

  getNeighbors(x: number, y: number): Tile[] {
    const neighbors: Tile[] = [];
    const directions = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ];

    for (const [dx, dy] of directions) {
      const tile = this.getTile(x + dx, y + dy);
      if (tile) {
        neighbors.push(tile);
      }
    }

    return neighbors;
  }

  serialize(): any {
    const roads: string[] = [];
    const explored: string[] = [];
    const occupied: { x: number; y: number; id: number }[] = [];

    const rockHarvests: { x: number; y: number; r: number }[] = [];
    const waterFish: { x: number; y: number; r: number; m: number }[] = [];
    const waterFishClusters: { r: number; m: number; cells: string[] }[] = [];
    const cellMinerals: { x: number; y: number; c: number; i: number; g: number; r: number }[] = [];
    const wellWater: { x: number; y: number; w: number }[] = [];
    const mushroomPicked: { x: number; y: number; u: number }[] = [];

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const tile = this.tiles[y][x];

        if (tile.hasRoad) {
          roads.push(`${x},${y}`);
        }

        if (tile.explored) {
          explored.push(`${x},${y}`);
        }

        if (tile.occupiedBy !== undefined) {
          occupied.push({ x, y, id: tile.occupiedBy });
        }

        if (tile.rockHarvestsRemaining !== undefined) {
          rockHarvests.push({ x, y, r: tile.rockHarvestsRemaining });
        }

        if (
          (tile.waterFishSchoolMax !== undefined || tile.waterFishRemaining !== undefined) &&
          tile.waterClusterId === undefined
        ) {
          const m = tile.waterFishSchoolMax ?? 15;
          const r = tile.waterFishRemaining ?? m;
          waterFish.push({ x, y, r, m });
        }

        if (tile.cellMinerals && cellMineralTotal(tile.cellMinerals) > 0) {
          const m = tile.cellMinerals;
          cellMinerals.push({ x, y, c: m.coal, i: m.iron_ore, g: m.gold_ore, r: m.stone });
        }

        if (tile.cellWellWaterRemaining !== undefined) {
          wellWater.push({ x, y, w: tile.cellWellWaterRemaining });
        }

        if (tile.mushroomPickedUntilMs !== undefined) {
          mushroomPicked.push({ x, y, u: tile.mushroomPickedUntilMs });
        }
      }
    }

    const cellsByClusterId = new Map<number, string[]>();
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const tile = this.tiles[y][x];
        if (tile.waterClusterId === undefined) continue;
        const id = tile.waterClusterId;
        if (!cellsByClusterId.has(id)) cellsByClusterId.set(id, []);
        cellsByClusterId.get(id)!.push(`${x},${y}`);
      }
    }
    const sortedClusterIds = Array.from(cellsByClusterId.keys()).sort((a, b) => a - b);
    for (const id of sortedClusterIds) {
      const st = this.waterFishClusterById.get(id);
      const cells = cellsByClusterId.get(id);
      if (!st || !cells) continue;
      const sortedCells = [...cells].sort();
      waterFishClusters.push({ r: st.remaining, m: st.max, cells: sortedCells });
    }

    return {
      seed: this.seed,
      width: this.width,
      height: this.height,
      terrain: this.encodeTerrain(),
      roads: roads.join(';'),
      explored: explored.join(';'),
      occupied,
      rockHarvests,
      waterFish,
      waterFishClusters,
      cellMinerals,
      wellWater,
      mushroomPicked,
    };
  }

  static deserialize(data: any): TileMap {
    const map = Object.create(TileMap.prototype) as TileMap;
    (map as any).width = data.width;
    (map as any).height = data.height;
    (map as any).seed = data.seed;
    (map as any).tiles = [];

    if (data.terrain) {
      map.initEmpty();
      map.decodeTerrain(data.terrain);
    } else {
      map.generate();
    }
    map.computeWaterDepth();
    map.computeForestDepth();

    if (data.roads) {
      const roadCoords = data.roads.split(';').filter((s: string) => s);
      roadCoords.forEach((coord: string) => {
        const [x, y] = coord.split(',').map(Number);
        const tile = map.getTile(x, y);
        if (tile) {
          tile.hasRoad = true;
        }
      });
    }

    if (data.explored) {
      const exploredCoords = data.explored.split(';').filter((s: string) => s);
      exploredCoords.forEach((coord: string) => {
        const [x, y] = coord.split(',').map(Number);
        const tile = map.getTile(x, y);
        if (tile) {
          tile.explored = true;
        }
      });
    }

    if (data.occupied) {
      data.occupied.forEach((occ: { x: number; y: number; id: number }) => {
        const tile = map.getTile(occ.x, occ.y);
        if (tile) {
          tile.occupiedBy = occ.id;
        }
      });
    }

    if (data.rockHarvests && Array.isArray(data.rockHarvests)) {
      for (const entry of data.rockHarvests as { x: number; y: number; r: number }[]) {
        const tile = map.getTile(entry.x, entry.y);
        if (tile) {
          tile.rockHarvestsRemaining = entry.r;
        }
      }
    }

    map.waterFishClusterById = new Map();
    map.nextWaterFishClusterId = 1;

    if (data.waterFishClusters && Array.isArray(data.waterFishClusters)) {
      for (const entry of data.waterFishClusters as { r: number; m: number; cells: string[] }[]) {
        const max = Math.max(entry.m, entry.r, 0);
        const remaining = Math.min(max, Math.max(0, entry.r));
        const cellKeys = Array.isArray(entry.cells) ? entry.cells : [];
        const memberTiles: Tile[] = [];
        for (const key of cellKeys) {
          const parts = key.split(',').map(Number);
          const x = parts[0]!;
          const y = parts[1]!;
          const tile = map.getTile(x, y);
          if (tile && tile.terrain === 'water') {
            memberTiles.push(tile);
          }
        }
        if (memberTiles.length === 0) continue;
        const id = map.nextWaterFishClusterId++;
        for (const t of memberTiles) {
          t.waterClusterId = id;
          delete t.waterFishSchoolMax;
          delete t.waterFishRemaining;
        }
        map.waterFishClusterById.set(id, {
          remaining,
          max,
          cellCount: memberTiles.length,
        });
      }
    } else if (data.waterFish && Array.isArray(data.waterFish)) {
      for (const entry of data.waterFish as {
        x: number;
        y: number;
        f?: number;
        r?: number;
        m?: number;
      }[]) {
        const tile = map.getTile(entry.x, entry.y);
        if (tile) {
          const r = entry.r ?? entry.f ?? 0;
          const m = entry.m ?? 15;
          tile.waterFishSchoolMax = m;
          tile.waterFishRemaining = r;
        }
      }
    }

    if (data.cellMinerals && Array.isArray(data.cellMinerals)) {
      for (const entry of data.cellMinerals as {
        x: number;
        y: number;
        c: number;
        i: number;
        g: number;
        r: number;
      }[]) {
        const tile = map.getTile(entry.x, entry.y);
        if (tile) {
          tile.cellMinerals = {
            coal: entry.c,
            iron_ore: entry.i,
            gold_ore: entry.g,
            stone: entry.r,
          };
        }
      }
    }

    if (data.wellWater && Array.isArray(data.wellWater)) {
      for (const entry of data.wellWater as { x: number; y: number; w: number }[]) {
        const tile = map.getTile(entry.x, entry.y);
        if (tile) {
          tile.cellWellWaterRemaining = entry.w;
        }
      }
    }

    if (data.mushroomPicked && Array.isArray(data.mushroomPicked)) {
      for (const entry of data.mushroomPicked as { x: number; y: number; u: number }[]) {
        const tile = map.getTile(entry.x, entry.y);
        if (tile) {
          tile.mushroomPickedUntilMs = entry.u;
        }
      }
    }

    return map;
  }
}
