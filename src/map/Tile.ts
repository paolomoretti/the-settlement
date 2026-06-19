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
  /**
   * Legacy per-tile fish fields (saves before lake clusters); cleared once a lake cluster is built.
   * @see waterClusterId
   */
  public waterFishSchoolMax?: number;
  public waterFishRemaining?: number;
  /** Orthogonal water body this tile belongs to for shared fish stock (assigned lazily). */
  public waterClusterId?: number;
  /** Lazy-assigned underground deposits (10 units total across coal / iron_ore / gold_ore / stone). */
  public cellMinerals?: CellMinerals;
  /**
   * Lazy underground water for a well on this cell: set when a well completes construction;
   * reduced by each water production cycle. `0` means this cell cannot supply a well again.
   */
  public cellWellWaterRemaining?: number;
  /**
   * Vegan-mode mushroom regrow timer (sim-time epoch ms). When set and in the future, the tile
   * is currently "picked" and hides its mushroom decor / is not pickable until `simNowMs` passes.
   * Undefined means mushrooms are present whenever the deterministic predicate says so.
   */
  public mushroomPickedUntilMs?: number;

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
