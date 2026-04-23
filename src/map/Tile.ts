/**
 * Individual tile in the game map
 */

import type { CellMinerals } from './CellMinerals';

export type TerrainType = 'grass' | 'water' | 'mountain' | 'forest' | 'desert' | 'hill' | 'tree';

export class Tile {
  public occupiedBy?: number; // Entity ID occupying this tile
  public hasRoad: boolean = false;
  public walkable: boolean = true;
  public explored: boolean = false; // Fog of war - has player seen this tile?
  public waterDepth: number = 0;
  public forestDepth: number = 0;
  /** Remaining quarry harvests on this rock tile before `terrainTransition` clears it (lazy-init). */
  public rockHarvestsRemaining?: number;
  /** Remaining fish catches this water tile can yield (fisher); undefined = full capacity; `0` = depleted. */
  public waterFishRemaining?: number;
  /** Lazy-assigned underground ores (10 units total across coal / iron_ore / gold_ore / granite). */
  public cellMinerals?: CellMinerals;
  /**
   * Lazy underground water for a well on this cell: set when a well completes construction;
   * reduced by each water production cycle. `0` means this cell cannot supply a well again.
   */
  public cellWellWaterRemaining?: number;

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
