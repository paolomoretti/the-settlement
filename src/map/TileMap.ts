/**
 * TileMap - manages the game world grid
 */

import { Tile, TerrainType } from './Tile';
import { NoiseGenerator } from '@/utils/NoiseGenerator';

export class TileMap {
  private tiles: Tile[][] = [];
  public readonly width: number;
  public readonly height: number;
  private seed: number; // Store seed for save/load

  constructor(width: number, height: number, seed?: number) {
    this.width = width;
    this.height = height;
    this.seed = seed || Date.now();
    this.initialize();
  }

  public getSeed(): number {
    return this.seed;
  }

  private initialize(): void {
    const noise = new NoiseGenerator(this.seed);

    for (let y = 0; y < this.height; y++) {
      this.tiles[y] = [];
      for (let x = 0; x < this.width; x++) {
        const terrain = this.generateTerrain(x, y, noise);
        this.tiles[y][x] = new Tile(x, y, terrain);
      }
    }

    this.generateRivers(noise);
    this.removeIsolatedWater();
    this.clearBaseCampArea();
  }

  private generateTerrain(x: number, y: number, noise: NoiseGenerator): TerrainType {
    const elevation = noise.fractalNoise(x, y, 4);
    const moisture = noise.fractalNoise(x + 1000, y + 1000, 3);
    const treeNoise = noise.fractalNoise(x + 2000, y + 2000, 2);

    // Large water bodies from low elevation
    if (elevation < 0.15) {
      return 'water';
    }

    // Small scattered lakes and ponds (higher frequency noise)
    const lakeNoise = noise.noise(x + 3000, y + 3000, 0.08) * 0.6
                    + noise.noise(x + 3500, y + 3500, 0.15) * 0.4;
    // Regional wetness: some areas have more lakes than others
    const wetness = noise.noise(x + 4000, y + 4000, 0.004);
    const lakeThreshold = 0.08 + Math.max(0, wetness - 0.4) * 0.2;
    if (lakeNoise < lakeThreshold && elevation < 0.40) {
      return 'water';
    }

    if (elevation > 0.75) return 'mountain';
    if (elevation > 0.6) return 'hill';
    if (moisture > 0.6 && treeNoise > 0.5) return 'forest';
    if (treeNoise > 0.75) return 'tree';
    return 'grass';
  }

  private generateRivers(noise: NoiseGenerator): void {
    const numRivers = Math.floor(Math.random() * 2) + 2;

    for (let r = 0; r < numRivers; r++) {
      const startX = Math.floor(Math.random() * this.width);
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
    const radius = 20;

    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        const tile = this.getTile(x, y);
        if (tile && tile.terrain === 'water') {
          tile.terrain = 'grass';
          tile.walkable = true;
        }
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

  isInBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  buildRoad(x: number, y: number): boolean {
    const tile = this.getTile(x, y);
    // Don't build roads on water, mountains, or occupied tiles
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
      [-1, 0], [1, 0], [0, -1], [0, 1], // Cardinal
      [-1, -1], [-1, 1], [1, -1], [1, 1] // Diagonal
    ];

    for (const [dx, dy] of directions) {
      const tile = this.getTile(x + dx, y + dy);
      if (tile) {
        neighbors.push(tile);
      }
    }

    return neighbors;
  }

  // Serialize for saving - COMPRESSED FORMAT
  serialize(): any {
    // Only save: seed, dimensions, roads, explored tiles, occupied tiles
    const roads: string[] = [];
    const explored: string[] = [];
    const occupied: { x: number; y: number; id: number }[] = [];

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
      }
    }

    return {
      seed: this.seed,
      width: this.width,
      height: this.height,
      roads: roads.join(';'),
      explored: explored.join(';'),
      occupied
    };
  }

  // Deserialize from saved data - regenerate terrain from seed
  static deserialize(data: any): TileMap {
    // Recreate map with same seed (regenerates same terrain)
    const map = new TileMap(data.width, data.height, data.seed);

    // Restore roads
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

    // Restore explored state
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

    // Restore occupied tiles
    if (data.occupied) {
      data.occupied.forEach((occ: { x: number; y: number; id: number }) => {
        const tile = map.getTile(occ.x, occ.y);
        if (tile) {
          tile.occupiedBy = occ.id;
        }
      });
    }

    return map;
  }
}
