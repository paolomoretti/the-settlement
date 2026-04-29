import { System } from '@/core/System';
import { Entity } from '@/core/Entity';
import { eventBus } from '@/core/EventBus';
import { Building } from '@/components/Building';
import { Production } from '@/components/Production';
import { Position } from '@/components/Position';
import { Storage } from '@/components/Storage';
import { isPlayerOwned } from '@/components/ownerUtils';
import { resourceManager } from '@/economics/ResourceManager';
import { dataManager } from '@/data/DataManager';
import { getSimulationNowMs } from '@/core/simulationClock';
import { rollWellAquiferCapacity } from '@/map/wellAquifer';
import type { TileMap } from '@/map/TileMap';
import type { PathFinder } from '@/pathfinding/AStar';
import { fisherHasReachableFish } from '@/map/fisherFishProbe';
import type { WildlifeCoordinator } from '@/wildlife/WildlifeCoordinator';
import { BuildingType, ResourceType } from '@/types/GameData';
import type { ProductionPriorityState } from '@/components/Production';

/**
 * One full production tick: consume inputs, buffer outputs, emit events, re-check buffer full.
 * Does not change `production.timer` (caller adjusts after a timer-based tick).
 */
export function applyProductionCycleOutputs(
  entity: Entity,
  opts?: {
    getTileMap?: () => TileMap;
    getProductionPriorities?: () => ProductionPriorityState;
    suppressPickup?: boolean;
  }
): void {
  const building = entity.getComponent(Building);
  const production = entity.getComponent(Production);
  const storage = entity.getComponent(Storage);
  if (!building || !production) return;

  const buildingType = building.buildingType as BuildingType;
  const useLocalStorage = storage?.isProductionStorage;
  const effectiveOutputs = production.getEffectiveOutputs(
    buildingType,
    opts?.getProductionPriorities?.()
  );

  if (useLocalStorage) {
    for (const [res, amount] of Object.entries(production.inputs)) {
      storage!.removeItem(res, amount);
    }
    for (const group of production.inputsAny) {
      let remaining = group.amount;
      for (const t of group.resourceTypes) {
        if (remaining <= 0) break;
        const have = storage!.getAmount(t);
        if (have <= 0) continue;
        const take = Math.min(remaining, have);
        storage!.removeItem(t, take);
        remaining -= take;
      }
    }
    for (const [res, amount] of Object.entries(effectiveOutputs)) {
      if (amount <= 0) continue;
      if (dataManager.getResource(res as ResourceType)?.virtualOutput) continue;
      production.addToBuffer(res, amount);
      if (!opts?.suppressPickup) resourceManager.requestPickup(entity.id, res, amount);
    }
    if (buildingType === 'armory') {
      production.armoryNextOutput = production.armoryNextOutput === 'sword' ? 'shield' : 'sword';
    }
  } else {
    if (production.hasInputs()) {
      if (!resourceManager.hasAvailableInputsForProduction(production.inputs)) {
        production.status = 'stopped_no_inputs';
        production.timer = 0;
        eventBus.emit('production:stopped', {
          entityId: entity.id,
          reason: 'no_inputs',
        });
        return;
      }
      const consumed = resourceManager.consumeInputsForProduction(production.inputs);
      if (!consumed) {
        production.status = 'stopped_no_inputs';
        production.timer = 0;
        eventBus.emit('production:stopped', {
          entityId: entity.id,
          reason: 'no_inputs',
        });
        return;
      }
    }
    for (const [resource, amount] of Object.entries(effectiveOutputs)) {
      if (amount <= 0) continue;
      if (dataManager.getResource(resource as ResourceType)?.virtualOutput) continue;
      production.addToBuffer(resource, amount);
      if (!opts?.suppressPickup) resourceManager.requestPickup(entity.id, resource, amount);
    }
  }

  eventBus.emit('production:complete', {
    entityId: entity.id,
    outputs: { ...effectiveOutputs },
  });
  production.clearCycleOutputs();

  if (building.buildingType === 'well' && opts?.getTileMap) {
    const pos = entity.getComponent(Position);
    const tile = pos ? opts.getTileMap().getTile(Math.floor(pos.x), Math.floor(pos.y)) : null;
    if (tile) {
      let waterOut = 0;
      for (const [res, amount] of Object.entries(production.outputs)) {
        if (res === 'water' && amount > 0) waterOut += amount;
      }
      if (waterOut > 0) {
        if (tile.cellWellWaterRemaining === undefined) {
          tile.cellWellWaterRemaining = rollWellAquiferCapacity();
        }
        const prev = tile.cellWellWaterRemaining;
        tile.cellWellWaterRemaining = Math.max(0, prev - waterOut);
        if (prev > 0 && tile.cellWellWaterRemaining <= 0) {
          building.outOfMapResources = true;
          eventBus.emit('well:aquifer_depleted', { entityId: entity.id });
        }
      }
    }
  }

  if (!production.continuous) {
    production.status = 'idle';
    production.timer = 0;
  }

  if (useLocalStorage) {
    if (!production.hasBufferSpaceForBuilding(buildingType)) {
      production.status = 'stopped_full';
      eventBus.emit('production:stopped', {
        entityId: entity.id,
        reason: 'buffer_full',
      });
    }
  } else {
    if (!production.hasBufferSpaceForBuilding(buildingType)) {
      production.status = 'stopped_full';
      eventBus.emit('production:stopped', {
        entityId: entity.id,
        reason: 'buffer_full',
      });
    }
  }
}

export class ProductionSystem extends System {
  constructor(
    private readonly getTileMap: () => TileMap,
    private readonly getPathFinder: () => PathFinder,
    private readonly getWildlife?: () => WildlifeCoordinator,
    private readonly getProductionPriorities?: () => ProductionPriorityState,
    private readonly shouldSimulateEntity: (entity: Entity) => boolean = () => true
  ) {
    super();
  }

  shouldProcessEntity(entity: Entity): boolean {
    return entity.hasComponent(Production) && entity.hasComponent(Building);
  }

  update(deltaTime: number): void {
    for (const entity of this.entities) {
      if (!entity.active) continue;
      if (!this.shouldSimulateEntity(entity)) continue;
      const playerOwned = isPlayerOwned(entity);

      const building = entity.getComponent(Building);
      const production = entity.getComponent(Production);
      if (!building || !production) continue;

      if (!building.isComplete()) continue;
      if (!building.hasOperator) continue;

      if (!building.isActive) {
        building.outOfMapResources = false;
        if (production.status !== 'stopped_no_road') {
          production.status = 'stopped_no_road';
          production.timer = 0;
          eventBus.emit('production:stopped', {
            entityId: entity.id,
            reason: 'no_road',
          });
        }
        continue;
      }

      const buildingDef = dataManager.getBuilding(building.buildingType);
      const buildingType = building.buildingType as BuildingType;
      const mapLinkedGather = buildingDef?.animation?.type === 'gather';
      const storage = entity.getComponent(Storage);
      const useLocalStorage = storage?.isProductionStorage;
      const rockDepletionGather =
        buildingDef?.animation?.type === 'gather' &&
        buildingDef.animation.gatherMode === 'rock_depletion';
      const waterDepletionGather =
        buildingDef?.animation?.type === 'gather' &&
        buildingDef.animation.gatherMode === 'water_depletion';
      const resourceDepletionGather = rockDepletionGather || waterDepletionGather;
      const mineSiteGather =
        buildingDef?.animation?.type === 'gather' &&
        buildingDef.animation.gatherMode === 'mine_site';
      const wildHuntGather =
        buildingDef?.animation?.type === 'gather' &&
        buildingDef.animation.gatherMode === 'wild_hunt';

      // Check buffer/storage space for outputs (skip if cycle already in progress)
      if (production.timer === 0) {
        if (useLocalStorage) {
          if (!production.hasBufferSpaceForBuilding(buildingType)) {
            if (production.status !== 'stopped_full') {
              production.status = 'stopped_full';
              eventBus.emit('production:stopped', {
                entityId: entity.id,
                reason: 'buffer_full',
              });
            }
            building.outOfMapResources = false;
            continue;
          }
        } else {
          if (!production.hasBufferSpaceForBuilding(buildingType)) {
            if (production.status !== 'stopped_full') {
              production.status = 'stopped_full';
              eventBus.emit('production:stopped', {
                entityId: entity.id,
                reason: 'buffer_full',
              });
            }
            building.outOfMapResources = false;
            continue;
          }
        }
      }

      // Check inputs availability
      if (useLocalStorage) {
        let hasInputs = true;
        for (const [res, amount] of Object.entries(production.inputs)) {
          if (storage!.getAmount(res) < amount) {
            hasInputs = false;
            break;
          }
        }
        if (hasInputs) {
          for (const group of production.inputsAny) {
            const sum = group.resourceTypes.reduce((s, t) => s + storage!.getAmount(t), 0);
            if (sum < group.amount) {
              hasInputs = false;
              break;
            }
          }
        }
        if (!hasInputs) {
          if (production.status !== 'stopped_no_inputs') {
            production.status = 'stopped_no_inputs';
            eventBus.emit('production:stopped', {
              entityId: entity.id,
              reason: 'no_inputs',
            });
          }
          building.outOfMapResources = false;
          continue;
        }
      } else if (
        production.hasInputs() &&
        (!playerOwned || !resourceManager.hasAvailableInputsForProduction(production.inputs))
      ) {
        if (production.status !== 'stopped_no_inputs') {
          production.status = 'stopped_no_inputs';
          eventBus.emit('production:stopped', {
            entityId: entity.id,
            reason: 'no_inputs',
          });
        }
        building.outOfMapResources = false;
        continue;
      }

      const pos = entity.getComponent(Position);
      const wellTile =
        building.buildingType === 'well' && pos
          ? this.getTileMap().getTile(Math.floor(pos.x), Math.floor(pos.y))
          : null;
      const wellAquiferDry =
        building.buildingType === 'well' &&
        wellTile != null &&
        wellTile.cellWellWaterRemaining !== undefined &&
        wellTile.cellWellWaterRemaining <= 0;

      if (
        waterDepletionGather &&
        building.buildingType === 'fisher' &&
        pos &&
        building.animationWorkerId == null
      ) {
        const now = getSimulationNowMs();
        if (now - building.lastWaterFishProbeAt >= 500) {
          building.lastWaterFishProbeAt = now;
          const foot = new Set<string>();
          for (let dy = 0; dy < building.height; dy++) {
            for (let dx = 0; dx < building.width; dx++) {
              foot.add(`${pos.x + dx},${pos.y + dy}`);
            }
          }
          const entrance = building.getEntranceOffset();
          const entranceX = entrance ? pos.x + entrance.dx : pos.x;
          const entranceY = entrance ? pos.y + entrance.dy : pos.y;
          const gatherAnim =
            buildingDef.animation?.type === 'gather' ? buildingDef.animation : null;
          const animSearch = gatherAnim?.searchRadius ?? 7;
          const gatherRadius = buildingDef.production?.maxGatherRadius ?? animSearch;
          const maxWalkCells =
            buildingDef.production?.maxGatherWalkCells ??
            buildingDef.production?.maxGatherRadius ??
            animSearch ??
            gatherRadius;
          const ok = fisherHasReachableFish(
            this.getTileMap(),
            this.getPathFinder(),
            entranceX,
            entranceY,
            gatherRadius,
            maxWalkCells,
            foot
          );
          building.outOfMapResources = !ok;
        }
      }

      if (
        wildHuntGather &&
        building.buildingType === 'hunter' &&
        pos &&
        building.animationWorkerId == null &&
        this.getWildlife
      ) {
        const now = getSimulationNowMs();
        if (now - building.lastHuntRabbitProbeAt >= 500) {
          building.lastHuntRabbitProbeAt = now;
          const foot = new Set<string>();
          for (let dy = 0; dy < building.height; dy++) {
            for (let dx = 0; dx < building.width; dx++) {
              foot.add(`${pos.x + dx},${pos.y + dy}`);
            }
          }
          const entrance = building.getEntranceOffset();
          const entranceX = entrance ? pos.x + entrance.dx : pos.x;
          const entranceY = entrance ? pos.y + entrance.dy : pos.y;
          const gatherAnim =
            buildingDef.animation?.type === 'gather' ? buildingDef.animation : null;
          const animSearch = gatherAnim?.searchRadius ?? 10;
          const gatherRadius = buildingDef.production?.maxGatherRadius ?? animSearch;
          const maxWalkCells =
            buildingDef.production?.maxGatherWalkCells ??
            buildingDef.production?.maxGatherRadius ??
            animSearch ??
            gatherRadius;
          const ok = this.getWildlife()!.hasReachableRabbit(
            this.getTileMap(),
            this.getPathFinder(),
            entranceX,
            entranceY,
            gatherRadius,
            maxWalkCells,
            foot
          );
          building.outOfMapResources = !ok;
        }
      }

      if (production.status !== 'producing') {
        if (!(building.buildingType === 'well' && wellAquiferDry)) {
          building.outOfMapResources = false;
        }
        production.status = 'producing';
        eventBus.emit('production:resumed', { entityId: entity.id });
      }

      const wellAquiferBlocked = wellAquiferDry;
      const mapGatherSourceBlocked = mapLinkedGather && building.outOfMapResources;

      if (!production.currentCycleOutputs && !mapGatherSourceBlocked && !wellAquiferBlocked) {
        production.prepareCycleOutputs(buildingType, this.getProductionPriorities?.());
      }

      // Forester / quarry & fisher depletion / underground mine: hold the production clock while the field worker is out
      const foresterPlanting =
        building.buildingType === 'forester' && building.animationWorkerId != null;
      const fieldGatherPausing =
        building.animationWorkerId != null &&
        (resourceDepletionGather || mineSiteGather || wildHuntGather);
      if (
        !foresterPlanting &&
        !fieldGatherPausing &&
        !mapGatherSourceBlocked &&
        !wellAquiferBlocked
      ) {
        production.timer += deltaTime;
      }

      if (
        !resourceDepletionGather &&
        !mineSiteGather &&
        !wildHuntGather &&
        production.timer >= production.productionTime
      ) {
        production.timer -= production.productionTime;
        applyProductionCycleOutputs(entity, {
          getTileMap: this.getTileMap,
          getProductionPriorities: this.getProductionPriorities,
          suppressPickup: !playerOwned,
        });
      }
    }
  }
}
