/**
 * Individual tile in the game map
 */

export type TerrainType = 'grass' | 'water' | 'mountain' | 'forest' | 'desert' | 'hill' | 'tree';

export class Tile {
  public occupiedBy?: number; // Entity ID occupying this tile
  public hasRoad: boolean = false;
  public walkable: boolean = true;
  public explored: boolean = false; // Fog of war - has player seen this tile?
  public waterDepth: number = 0;
  public forestDepth: number = 0;

  constructor(
    public x: number,
    public y: number,
    public terrain: TerrainType = 'grass',
    public height: number = 0 // For future elevation support
  ) {
    // Set walkability based on terrain
    if (terrain === 'water' || terrain === 'mountain') {
      this.walkable = false;
    }
  }

  explore(): void {
    this.explored = true;
  }

  isExplored(): boolean {
    return this.explored;
  }

  isOccupied(): boolean {
    return this.occupiedBy !== undefined;
  }

  isWalkable(): boolean {
    // Roads are always walkable, even if occupied
    if (this.hasRoad) {
      return this.walkable;
    }
    return this.walkable && !this.isOccupied();
  }

  occupy(entityId: number): void {
    this.occupiedBy = entityId;
  }

  release(): void {
    this.occupiedBy = undefined;
  }
}
