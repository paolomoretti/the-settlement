/**
 * Settlement territory: union of Chebyshev disks from HQ and completed military posts.
 * Fog lifts for the union plus a preview band; only the interior (not the cordon frontier)
 * may receive roads and buildings, including military posts that expand vision when complete.
 *
 * @see `.claude/TERRITORY_VISION.md`
 */

import type { Entity } from '@/core/Entity';
import { Position } from '@/components/Position';
import { Building } from '@/components/Building';
import type { TileMap } from '@/map/TileMap';
import type { RenderSystem } from '@/systems/RenderSystem';
import { dataManager } from '@/data/DataManager';

/** Visible fog lift beyond the hard territory union (preview ring). */
export const TERRITORY_PREVIEW_BAND_CELLS = 5;

/** Sample a pole every N cells on the cordon (stride 2 avoids long diagonals with no poles). */
export const CORDON_POLE_STRIDE_CELLS = 2;

export function territoryKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function chebyshevDist(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

type DiskSource = { cx: number; cy: number; r: number };

export class TerritoryCoordinator {
  private sources: DiskSource[] = [];
  private unionU = new Set<string>();
  private frontier = new Set<string>();
  private interior = new Set<string>();

  constructor(private readonly tileMap: TileMap) {}

  /** Recompute disks and derived sets from the current entity list. */
  rebuildFrom(entities: readonly Entity[], baseCampEntity: Entity | null): void {
    this.sources = [];
    if (baseCampEntity?.active) {
      const pos = baseCampEntity.getComponent(Position);
      const b = baseCampEntity.getComponent(Building);
      if (pos && b?.isComplete()) {
        const cx = pos.x + Math.floor(b.width / 2);
        const cy = pos.y + Math.floor(b.height / 2);
        const r = dataManager.getGameConfig().starting.exploration.initialRadius;
        this.sources.push({ cx, cy, r });
      }
    }

    for (const e of entities) {
      if (!e.active) continue;
      const pos = e.getComponent(Position);
      const b = e.getComponent(Building);
      if (!pos || !b || !b.isComplete()) continue;
      if (b.buildingType === 'base_camp') continue;
      const def = dataManager.getBuilding(b.buildingType);
      const tr = def?.military?.territoryVisionRadius;
      const soldierCap = def?.military?.soldierCapacity;
      const needsGarrisonForDisk =
        typeof soldierCap === 'number' && soldierCap > 0 ? b.hasMilitaryTerritoryContributor() : true;
      if (typeof tr === 'number' && tr > 0 && needsGarrisonForDisk) {
        const cx = pos.x + Math.floor(b.width / 2);
        const cy = pos.y + Math.floor(b.height / 2);
        this.sources.push({ cx, cy, r: tr });
      }
    }

    this.recomputeUnionAndLayers();
  }

  private cellInUnionU(x: number, y: number): boolean {
    for (const s of this.sources) {
      if (chebyshevDist(x, y, s.cx, s.cy) <= s.r) return true;
    }
    return false;
  }

  private recomputeUnionAndLayers(): void {
    this.unionU.clear();
    this.frontier.clear();
    this.interior.clear();

    if (this.sources.length === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of this.sources) {
      minX = Math.min(minX, s.cx - s.r);
      maxX = Math.max(maxX, s.cx + s.r);
      minY = Math.min(minY, s.cy - s.r);
      maxY = Math.max(maxY, s.cy + s.r);
    }

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!this.tileMap.isInBounds(x, y)) continue;
        if (!this.cellInUnionU(x, y)) continue;
        this.unionU.add(territoryKey(x, y));
      }
    }

    const cardinals: readonly [number, number][] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];

    for (const k of this.unionU) {
      const [xStr, yStr] = k.split(',');
      const x = Number(xStr);
      const y = Number(yStr);
      let onEdge = false;
      for (const [dx, dy] of cardinals) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.tileMap.isInBounds(nx, ny) || !this.unionU.has(territoryKey(nx, ny))) {
          onEdge = true;
          break;
        }
      }
      if (onEdge) this.frontier.add(k);
      else this.interior.add(k);
    }
  }

  /**
   * Lift fog for the union of (each source disk expanded by the preview band).
   * Once explored, tiles stay visible even if the buildable union later shrinks.
   */
  applyFogReveal(renderSystem: RenderSystem | null): void {
    if (this.sources.length === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of this.sources) {
      minX = Math.min(minX, s.cx - s.r - TERRITORY_PREVIEW_BAND_CELLS);
      maxX = Math.max(maxX, s.cx + s.r + TERRITORY_PREVIEW_BAND_CELLS);
      minY = Math.min(minY, s.cy - s.r - TERRITORY_PREVIEW_BAND_CELLS);
      maxY = Math.max(maxY, s.cy + s.r + TERRITORY_PREVIEW_BAND_CELLS);
    }

    const newly: { x: number; y: number }[] = [];

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!this.tileMap.isInBounds(x, y)) continue;
        let margin = Infinity;
        for (const s of this.sources) {
          margin = Math.min(margin, chebyshevDist(x, y, s.cx, s.cy) - s.r);
        }
        if (margin > TERRITORY_PREVIEW_BAND_CELLS) continue;

        const tile = this.tileMap.getTile(x, y);
        if (!tile || tile.isExplored()) continue;
        tile.explore();
        newly.push({ x, y });
      }
    }

    if (newly.length > 0 && renderSystem) {
      renderSystem.updateMinimapTiles(newly);
    }
  }

  /**
   * Future: scouts / spies that reveal fog without expanding the settlement disk union.
   * Intentionally empty — call sites can mark tiles explored and refresh the minimap.
   */
  revealCellsWithoutTerritory(_cells: ReadonlyArray<{ x: number; y: number }>): void {
    void _cells;
  }

  getUnionU(): ReadonlySet<string> {
    return this.unionU;
  }

  getFrontier(): ReadonlySet<string> {
    return this.frontier;
  }

  isInteriorCell(x: number, y: number): boolean {
    return this.interior.has(territoryKey(x, y));
  }

  isInteriorFootprint(x: number, y: number, width: number, height: number): boolean {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        if (!this.isInteriorCell(x + dx, y + dy)) return false;
      }
    }
    return true;
  }

}
