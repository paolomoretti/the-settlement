/**
 * TileMap - manages the game world grid
 */

import { Tile, TerrainType } from './Tile';
import { NoiseGenerator } from '@/utils/NoiseGenerator';

const TERRAIN_CODES: Record<TerrainType, string> = {
  grass: 'g', water: 'w', mountain: 'm', forest: 'f', tree: 't', hill: 'h', desert: 'd'
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
    this.removeIslands();
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

    const lakeNoise = noise.noise(x + 3000, y + 3000, 0.12) * 0.5
                    + noise.noise(x + 3500, y + 3500, 0.25) * 0.3
                    + noise.noise(x + 3800, y + 3800, 0.4) * 0.2;
    const wetness = noise.noise(x + 4000, y + 4000, 0.005);
    const lakeThreshold = 0.12 + Math.max(0, wetness - 0.35) * 0.25;
    if (lakeNoise < lakeThreshold && elevation < 0.45) {
      return 'water';
    }

    const forestDensity = noise.noise(x + 5000, y + 5000, 0.008);
    const treePlacement = noise.noise(x + 6000, y + 6000, 0.1) * 0.5
                        + noise.noise(x + 6500, y + 6500, 0.2) * 0.3
                        + noise.noise(x + 7000, y + 7000, 0.4) * 0.2;

    if (forestDensity > 0.27 && treePlacement > 0.17) {
      return 'forest';
    }
    if (treePlacement > 0.32) {
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
      const startX = Math.floor(noise.noise(r * 137, 7919, 0.1) * this.width * 0.8 + this.width * 0.1);
      const startY = Math.floor(noise.noise(7919, r * 137, 0.1) * this.height * 0.8 + this.height * 0.1);
      const rangeWidth = 60 + Math.floor(noise.noise(r * 53, 3571, 0.1) * 200);
      const baseHeight = 6 + Math.floor(noise.noise(r * 53, 4571, 0.1) * 12);

      for (let dx = 0; dx < rangeWidth; dx++) {
        const localHeight = Math.max(2, Math.floor(baseHeight * (0.4 + noise.noise(startX + dx, startY + 1000, 0.04) * 0.8)));
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
        const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
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

      const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
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
              const nx = x + dx, ny = y + dy;
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
          const nx = x + dx, ny = y + dy;
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
              const nx = x + dx, ny = y + dy;
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
          const nx = x + dx, ny = y + dy;
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

  findNearbyTerrain(cx: number, cy: number, radius: number, types: string[], exclude?: Set<string>): { x: number; y: number } | null {
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

  isInBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  buildRoad(x: number, y: number): boolean {
    const tile = this.getTile(x, y);
    if (tile &&
        !tile.hasRoad &&
        tile.terrain !== 'water' &&
        tile.terrain !== 'mountain' &&
        !tile.isOccupied()) {
      tile.hasRoad = true;
      return true;
    }
    return false;
  }

  getNeighbors(x: number, y: number): Tile[] {
    const neighbors: Tile[] = [];
    const directions = [
      [-1, 0], [1, 0], [0, -1], [0, 1],
      [-1, -1], [-1, 1], [1, -1], [1, 1]
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
      }
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

    return map;
  }
}
