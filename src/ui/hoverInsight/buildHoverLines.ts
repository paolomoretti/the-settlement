/**
 * Pure copy for delayed hover tooltips — mirrors BuildingPopover semantics without DOM.
 * Extend with new `buildXHoverLines` as more hover targets are added.
 */

import { Entity } from '@/core/Entity';
import { Building } from '@/components/Building';
import { Production } from '@/components/Production';
import { Storage } from '@/components/Storage';
import { Tile } from '@/map/Tile';
import { dataManager } from '@/data/DataManager';
import { resourceManager } from '@/economics/ResourceManager';
import { BuildingType, ResourceType } from '@/types/GameData';

const QUARRY_ROCK_TERRAINS = new Set(['mountain', 'hill']);

export function isInsightRockTile(tile: Tile): boolean {
  return QUARRY_ROCK_TERRAINS.has(tile.terrain);
}

export function getQuarryStonesPerRockTile(): number {
  return dataManager.getBuilding('quarry' as BuildingType)?.production?.stonesPerRockTile ?? 10;
}

export function getFisherFishPerWaterTile(): number {
  return dataManager.getBuilding('fisher' as BuildingType)?.production?.fishPerWaterTile ?? 15;
}

const INVENTORY_CATEGORIES = ['raw', 'refined', 'food', 'tool', 'weapon'] as const;

function buildHeadquartersInventoryTooltip(): { title: string; lines: string[] } {
  const inv = resourceManager.getGlobalInventory();
  const lines: string[] = [];
  for (const category of INVENTORY_CATEGORIES) {
    for (const res of dataManager.getResourcesByCategory(category)) {
      const n = inv[res.id] || 0;
      if (n > 0) lines.push(`${res.name}: ${n}`);
    }
  }
  const total = Object.values(inv).reduce((s, v) => s + v, 0);
  const title = total === 0 ? 'Settlement inventory' : `Settlement inventory (${total})`;
  if (lines.length === 0) {
    lines.push('No goods in stock.');
  }
  return { title, lines };
}

export function buildBuildingHoverLines(entity: Entity): { title: string; lines: string[] } | null {
  const building = entity.getComponent(Building);
  if (!building) return null;

  const def = dataManager.getBuilding(building.buildingType as BuildingType);
  const title = def?.name ?? building.buildingType;
  const lines: string[] = [];

  const pushDescriptionAndGatherHint = (production: Production | null): void => {
    if (def?.description) {
      lines.push(def.description);
    }
    const mapGather =
      building.buildingType === 'lumberjack' ||
      building.buildingType === 'quarry' ||
      building.buildingType === 'fisher';
    if (
      mapGather &&
      building.outOfMapResources &&
      production?.status === 'producing'
    ) {
      lines.push('Nothing to gather within reach of this building.');
    }
    if (
      building.buildingType === 'well' &&
      building.outOfMapResources &&
      production?.status === 'producing'
    ) {
      lines.push('Underground water here is exhausted — this well will be abandoned.');
    }
  };

  if (building.state === 'awaiting_materials' && building.constructionMaterials) {
    pushDescriptionAndGatherHint(entity.getComponent(Production) ?? null);
    lines.push('Awaiting construction materials.');
    for (const [res, required] of Object.entries(building.constructionMaterials)) {
      const delivered = building.materialsDelivered[res] || 0;
      const resName = dataManager.getResource(res as ResourceType)?.name ?? res;
      lines.push(`${resName}: ${delivered}/${required}${delivered >= required ? ' ✓' : ''}`);
    }
    lines.push(building.builderArrived ? 'Builder: on site ✓' : 'Builder: en route…');
    return { title, lines };
  }

  if (building.state === 'under_construction') {
    pushDescriptionAndGatherHint(entity.getComponent(Production) ?? null);
    const pct = Math.floor(building.constructionProgress * 100);
    lines.push(`Under construction — ${pct}% complete.`);
    return { title, lines };
  }

  if (building.state === 'complete') {
    const production = entity.getComponent(Production);

    if (def?.isHeadquarters) {
      const hq = buildHeadquartersInventoryTooltip();
      if (def.description) {
        hq.lines.unshift(def.description);
      }
      return hq;
    }

    pushDescriptionAndGatherHint(production ?? null);

    if (building.requiresRoad && !building.isActive) {
      lines.push('No road connection — workers and goods cannot reach this building.');
    }

    if (!building.hasOperator && def?.requiredTool) {
      const toolName = dataManager.getResource(def.requiredTool as ResourceType)?.name ?? def.requiredTool;
      lines.push(`Waiting for the ${toolName} worker to arrive.`);
    }

    if (def?.production && production && building.isComplete()) {
      if (building.animationWorkerId != null && def.animation?.type === 'gather') {
        lines.push('A worker is out gathering resources…');
      }

      if (building.hasOperator) {
        if (production.status === 'producing') {
          const p = Math.round(production.getProgress() * 100);
          const remaining = Math.max(
            0,
            Math.ceil(def.production.productionTime * (1 - production.getProgress()))
          );
          lines.push(`Producing — ${p}% (${remaining}s left this cycle).`);
        } else if (production.status === 'idle') {
          lines.push('Idle — starting the next production cycle.');
        } else if (production.status === 'stopped_full') {
          lines.push('Production paused — outside pickup queue is full.');
        } else if (production.status === 'stopped_no_inputs') {
          lines.push('Production paused — missing required inputs.');
        } else if (production.status === 'stopped_no_road') {
          lines.push('Production paused — needs a road link to headquarters.');
        }
      }

      const storage = entity.getComponent(Storage);
      if (storage?.isProductionStorage) {
        const total = storage.getTotalStored();
        const cap = storage.capacity;
        const pct = cap > 0 ? Math.round((total / cap) * 100) : 0;
        const parts = Object.entries(storage.items)
          .filter(([, n]) => n > 0)
          .map(([id, n]) => {
            const name = dataManager.getResource(id as ResourceType)?.name ?? id;
            return `${n} ${name}`;
          });
        const detail = parts.length ? ` (${parts.join(', ')})` : '';
        lines.push(`On-site ingredients: ${total}/${cap} (${pct}% full)${detail}.`);
        const buf = production.getTotalBuffered();
        if (buf > 0 && production.maxOutputBuffer > 0) {
          const bufCap = production.maxOutputBuffer;
          const bufPct = bufCap > 0 ? Math.round((buf / bufCap) * 100) : 0;
          const bufParts = Object.entries(production.outputBuffer)
            .filter(([, n]) => n > 0)
            .map(([id, n]) => {
              const name = dataManager.getResource(id as ResourceType)?.name ?? id;
              return `${n} ${name}`;
            });
          const bufDetail = bufParts.length ? ` (${bufParts.join(', ')})` : '';
          lines.push(`Awaiting pickup: ${buf}/${bufCap} (${bufPct}% full)${bufDetail}.`);
        }
      } else if (production.maxOutputBuffer > 0) {
        const buf = production.getTotalBuffered();
        const cap = production.maxOutputBuffer;
        const pct = cap > 0 ? Math.round((buf / cap) * 100) : 0;
        const parts = Object.entries(production.outputBuffer)
          .filter(([, n]) => n > 0)
          .map(([id, n]) => {
            const name = dataManager.getResource(id as ResourceType)?.name ?? id;
            return `${n} ${name}`;
          });
        const detail = parts.length ? ` (${parts.join(', ')})` : '';
        lines.push(`Output buffer: ${buf}/${cap} (${pct}% full)${detail}.`);
      }
    } else if (!def?.production && def?.storage) {
      const storage = entity.getComponent(Storage);
      if (storage) {
        const total = storage.getTotalStored();
        lines.push(`Storage in use: ${total}/${storage.capacity} slots.`);
      }
    }

    if (lines.length === 0) {
      lines.push('Operational.');
    }
  }

  return { title, lines };
}

export function buildWaterFishHoverLines(tile: Tile): { title: string; lines: string[] } | null {
  if (tile.terrain !== 'water') return null;

  const fishPer = getFisherFishPerWaterTile();
  const remaining = tile.waterFishRemaining ?? fishPer;
  const used = Math.max(0, fishPer - remaining);
  const remainingPct = fishPer > 0 ? Math.round((remaining / fishPer) * 100) : 0;

  const title = 'Water';
  const lines: string[] = [
    `A fisher can catch up to ${fishPer} fish from a single water tile.`,
    `Fish remaining: ${remaining} (${remainingPct}% of the school).`,
  ];
  if (used > 0) {
    lines.push(`${used} catch${used === 1 ? '' : 'es'} already taken from this tile.`);
  }
  return { title, lines };
}

export function buildRockTileHoverLines(tile: Tile): { title: string; lines: string[] } | null {
  if (!QUARRY_ROCK_TERRAINS.has(tile.terrain)) return null;

  const stonesPer = getQuarryStonesPerRockTile();
  const remaining = tile.rockHarvestsRemaining ?? stonesPer;
  const used = Math.max(0, stonesPer - remaining);
  const remainingPct = stonesPer > 0 ? Math.round((remaining / stonesPer) * 100) : 0;

  const title = tile.terrain === 'hill' ? 'Rocky hill' : 'Rock';
  const lines: string[] = [
    `A stonemason at a quarry can harvest up to ${stonesPer} loads of stone from a tile like this.`,
    `Harvests remaining: ${remaining} (${remainingPct}% of the deposit).`,
  ];
  if (used > 0) {
    lines.push(`${used} load${used === 1 ? '' : 's'} already taken from this tile.`);
  }
  return { title, lines };
}

export function getHoverTargetKey(game: {
  tileMap: { getTile: (x: number, y: number) => Tile | null };
  getBuildingEntityAtGrid: (x: number, y: number) => Entity | null;
}, gx: number, gy: number): string | null {
  const building = game.getBuildingEntityAtGrid(gx, gy);
  if (building) return `b:${building.id}`;
  const tile = game.tileMap.getTile(gx, gy);
  if (!tile) return null;
  if (buildRockTileHoverLines(tile)) return `r:${gx},${gy}`;
  if (buildWaterFishHoverLines(tile)) return `f:${gx},${gy}`;
  return null;
}
