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
import { getEntityFaction, PLAYER_FACTION, type FactionId } from '@/components/ownerUtils';
import type { TileMap } from '@/map/TileMap';
import type { RenderSystem } from '@/systems/RenderSystem';
import { dataManager } from '@/data/DataManager';

/** Visible fog lift beyond the hard territory union (preview ring). */
export const TERRITORY_PREVIEW_BAND_CELLS = 5;

/** Sample a pole every N cells on the cordon (stride 2 avoids long diagonals with no poles). */
export const CORDON_POLE_STRIDE_CELLS = 2;
const ENEMY_MILITARY_TERRITORY_RADIUS = 5;
const MILITARY_CLAIM_STRENGTH_BONUS = 20;

export function territoryKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function chebyshevDist(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

type DiskSource = { cx: number; cy: number; r: number; kind: 'hq' | 'military' };

export type TerritoryLayer = {
  unionU: ReadonlySet<string>;
  frontier: ReadonlySet<string>;
  interior: ReadonlySet<string>;
};

type MutableTerritoryLayer = {
  unionU: Set<string>;
  frontier: Set<string>;
  interior: Set<string>;
};

type CellClaim = {
  factionId: FactionId;
  strength: number;
};

function createEmptyLayer(): MutableTerritoryLayer {
  return {
    unionU: new Set<string>(),
    frontier: new Set<string>(),
    interior: new Set<string>(),
  };
}

export class TerritoryCoordinator {
  private sourcesByFaction = new Map<FactionId, DiskSource[]>();
  private layersByFaction = new Map<FactionId, MutableTerritoryLayer>();

  constructor(private readonly tileMap: TileMap) {}

  /** Recompute disks and derived sets from the current entity list. */
  rebuildFrom(entities: readonly Entity[], baseCampEntity: Entity | null): void {
    this.sourcesByFaction.clear();
    if (baseCampEntity?.active) {
      const pos = baseCampEntity.getComponent(Position);
      const b = baseCampEntity.getComponent(Building);
      if (pos && b?.isComplete()) {
        const cx = pos.x + Math.floor(b.width / 2);
        const cy = pos.y + Math.floor(b.height / 2);
        const r = dataManager.getGameConfig().starting.exploration.initialRadius;
        this.addSource(PLAYER_FACTION, { cx, cy, r, kind: 'hq' });
      }
    }

    for (const e of entities) {
      if (!e.active) continue;
      const pos = e.getComponent(Position);
      const b = e.getComponent(Building);
      if (!pos || !b || !b.isComplete()) continue;
      const factionId = getEntityFaction(e);
      if (b.buildingType === 'base_camp') {
        if (e !== baseCampEntity) {
          const cx = pos.x + Math.floor(b.width / 2);
          const cy = pos.y + Math.floor(b.height / 2);
          const r = dataManager.getGameConfig().starting.exploration.initialRadius;
          this.addSource(factionId, { cx, cy, r, kind: 'hq' });
        }
        continue;
      }
      const def = dataManager.getBuilding(b.buildingType);
      const tr = def?.military?.territoryVisionRadius;
      const soldierCap = def?.military?.soldierCapacity;
      const needsGarrisonForDisk =
        typeof soldierCap === 'number' && soldierCap > 0 ? b.hasMilitaryTerritoryContributor() : true;
      if (typeof tr === 'number' && tr > 0 && needsGarrisonForDisk) {
        const cx = pos.x + Math.floor(b.width / 2);
        const cy = pos.y + Math.floor(b.height / 2);
        const r = factionId === PLAYER_FACTION ? tr : Math.min(tr, ENEMY_MILITARY_TERRITORY_RADIUS);
        this.addSource(factionId, { cx, cy, r, kind: 'military' });
      }
    }

    this.recomputeUnionAndLayersByFaction();
  }

  private addSource(factionId: FactionId, source: DiskSource): void {
    const sources = this.sourcesByFaction.get(factionId);
    if (sources) sources.push(source);
    else this.sourcesByFaction.set(factionId, [source]);
  }

  private recomputeUnionAndLayersByFaction(): void {
    this.layersByFaction.clear();

    const factionIds = Array.from(this.sourcesByFaction.keys());
    for (const factionId of factionIds) {
      this.layersByFaction.set(factionId, createEmptyLayer());
    }

    const ownership = this.computeExclusiveOwnership();
    for (const [cellKey, claims] of ownership) {
      for (const claim of claims) {
        const layer = this.layersByFaction.get(claim.factionId);
        if (!layer) continue;
        layer.unionU.add(cellKey);
      }
    }

    this.recomputeFrontierAndInteriorFromExclusiveOwnership(ownership);
  }

  private getSourceStrengthAt(x: number, y: number, source: DiskSource): number | null {
    const dist = chebyshevDist(x, y, source.cx, source.cy);
    if (dist > source.r) return null;
    return source.r - dist + (source.kind === 'military' ? MILITARY_CLAIM_STRENGTH_BONUS : 0);
  }

  private computeExclusiveOwnership(): Map<string, CellClaim[]> {
    const ownership = new Map<string, CellClaim[]>();
    const allSources = Array.from(this.sourcesByFaction.values()).flat();
    if (allSources.length === 0) return ownership;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const source of allSources) {
      minX = Math.min(minX, source.cx - source.r);
      maxX = Math.max(maxX, source.cx + source.r);
      minY = Math.min(minY, source.cy - source.r);
      maxY = Math.max(maxY, source.cy + source.r);
    }

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!this.tileMap.isInBounds(x, y)) continue;

        let bestStrength = -Infinity;
        const strengthByFaction = new Map<FactionId, number>();
        for (const [factionId, sources] of this.sourcesByFaction) {
          let factionStrength = -Infinity;
          for (const source of sources) {
            const strength = this.getSourceStrengthAt(x, y, source);
            if (strength === null) continue;
            factionStrength = Math.max(factionStrength, strength);
          }
          if (factionStrength === -Infinity) continue;
          strengthByFaction.set(factionId, factionStrength);
          bestStrength = Math.max(bestStrength, factionStrength);
        }

        if (bestStrength === -Infinity) continue;
        let winningClaim: CellClaim | null = null;
        for (const [factionId, strength] of strengthByFaction) {
          if (strength !== bestStrength) continue;
          if (
            !winningClaim ||
            (factionId === PLAYER_FACTION && winningClaim.factionId !== PLAYER_FACTION)
          ) {
            winningClaim = { factionId, strength };
          }
        }
        if (winningClaim) ownership.set(territoryKey(x, y), [winningClaim]);
      }
    }

    return ownership;
  }

  private recomputeFrontierAndInteriorFromExclusiveOwnership(ownership: ReadonlyMap<string, readonly CellClaim[]>): void {
    const cardinals: readonly [number, number][] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];

    for (const [cellKey, claims] of ownership) {
      if (claims.length !== 1) continue;
      const claim = claims[0]!;
      const layer = this.layersByFaction.get(claim.factionId);
      if (!layer) continue;

      const [xStr, yStr] = cellKey.split(',');
      const x = Number(xStr);
      const y = Number(yStr);
      let onEdge = false;
      for (const [dx, dy] of cardinals) {
        const nx = x + dx;
        const ny = y + dy;
        const neighborClaims = ownership.get(territoryKey(nx, ny));
        if (
          !this.tileMap.isInBounds(nx, ny) ||
          !neighborClaims ||
          neighborClaims.length !== 1 ||
          neighborClaims[0]!.factionId !== claim.factionId
        ) {
          onEdge = true;
          break;
        }
      }

      if (onEdge) layer.frontier.add(cellKey);
      else layer.interior.add(cellKey);
    }
  }

  /**
   * Lift fog for the union of (each source disk expanded by the preview band).
   * Once explored, tiles stay visible even if the buildable union later shrinks.
   */
  applyFogReveal(renderSystem: RenderSystem | null): void {
    const sources = this.sourcesByFaction.get(PLAYER_FACTION) ?? [];
    if (sources.length === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of sources) {
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
        for (const s of sources) {
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
    return this.getLayer(PLAYER_FACTION).unionU;
  }

  getFrontier(): ReadonlySet<string> {
    return this.getLayer(PLAYER_FACTION).frontier;
  }

  getLayer(factionId: FactionId = PLAYER_FACTION): TerritoryLayer {
    return this.layersByFaction.get(factionId) ?? createEmptyLayer();
  }

  getFactionIds(): FactionId[] {
    return Array.from(this.layersByFaction.keys());
  }

  isInteriorCell(x: number, y: number, factionId: FactionId = PLAYER_FACTION): boolean {
    return this.getLayer(factionId).interior.has(territoryKey(x, y));
  }

  isInteriorFootprint(
    x: number,
    y: number,
    width: number,
    height: number,
    factionId: FactionId = PLAYER_FACTION
  ): boolean {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        if (!this.isInteriorCell(x + dx, y + dy, factionId)) return false;
      }
    }
    return true;
  }

}
