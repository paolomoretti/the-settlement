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

    // Add rivers
    this.generateRivers(noise);
  }

  private generateTerrain(x: number, y: number, noise: NoiseGenerator): TerrainType {
    // Multiple noise layers for different features
    const elevation = noise.fractalNoise(x, y, 4);
    const moisture = noise.fractalNoise(x + 1000, y + 1000, 3);
    const treeNoise = noise.fractalNoise(x + 2000, y + 2000, 2);

    // Water (small lakes only) - very low elevation
    if (elevation < 0.15) {
      return 'water';
    }

    // Mountains - high elevation
    if (elevation > 0.75) {
      return 'mountain';
    }

    // Hills - medium-high elevation
    if (elevation > 0.6) {
      return 'hill';
    }

    // Forests - cluster based on moisture and tree noise
    if (moisture > 0.6 && treeNoise > 0.5) {
      return 'forest';
    }

    // Scattered trees
    if (treeNoise > 0.75) {
      return 'tree';
    }

    // Default to grass
    return 'grass';
  }

  private generateRivers(noise: NoiseGenerator): void {
    // Create 2-3 rivers across the map
    const numRivers = Math.floor(Math.random() * 2) + 2;

    for (let r = 0; r < numRivers; r++) {
      const startX = Math.floor(Math.random() * this.width);
      const startY = 0;

      let x = startX;
      let y = startY;

      // River flows downward with some meandering
      while (y < this.height) {
        // Set current position to water
        const tile = this.getTile(x, y);
        if (tile && tile.terrain !== 'mountain') {
          tile.terrain = 'water';
          tile.walkable = false;
        }

        // Meander (move left or right occasionally)
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
