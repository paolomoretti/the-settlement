import { System } from '@/core/System';
import { Entity } from '@/core/Entity';
import { eventBus } from '@/core/EventBus';
import { Building } from '@/components/Building';
import { Production } from '@/components/Production';
import { Storage } from '@/components/Storage';
import { resourceManager } from '@/economics/ResourceManager';
import { dataManager } from '@/data/DataManager';
import { ResourceType } from '@/types/GameData';

/**
 * One full production tick: consume inputs, buffer outputs, emit events, re-check buffer full.
 * Does not change `production.timer` (caller adjusts after a timer-based tick).
 */
export function applyProductionCycleOutputs(entity: Entity): void {
  const building = entity.getComponent(Building);
  const production = entity.getComponent(Production);
  const storage = entity.getComponent(Storage);
  if (!building || !production) return;

  const useLocalStorage = storage?.isProductionStorage;

  if (useLocalStorage) {
    for (const [res, amount] of Object.entries(production.inputs)) {
      storage!.removeItem(res, amount);
    }
    for (const [res, amount] of Object.entries(production.outputs)) {
      if (amount <= 0) continue;
      if (dataManager.getResource(res as ResourceType)?.virtualOutput) continue;
      storage!.items[res] = (storage!.items[res] || 0) + amount;
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
    for (const [resource, amount] of Object.entries(production.outputs)) {
      if (amount <= 0) continue;
      if (dataManager.getResource(resource as ResourceType)?.virtualOutput) continue;
      production.addToBuffer(resource, amount);
      resourceManager.requestPickup(entity.id, resource, amount);
    }
  }

  eventBus.emit('production:complete', {
    entityId: entity.id,
    outputs: { ...production.outputs },
  });

  if (!production.continuous) {
    production.status = 'idle';
    production.timer = 0;
  }

  if (useLocalStorage) {
    const nextOutputTotal = Object.values(production.outputs).reduce((s, n) => s + n, 0);
    if (storage!.getFreeSpace() < nextOutputTotal) {
      production.status = 'stopped_full';
      eventBus.emit('production:stopped', {
        entityId: entity.id,
        reason: 'buffer_full',
      });
    }
  } else {
    if (!production.hasBufferSpace()) {
      production.status = 'stopped_full';
      eventBus.emit('production:stopped', {
        entityId: entity.id,
        reason: 'buffer_full',
      });
    }
  }
}

export class ProductionSystem extends System {
  shouldProcessEntity(entity: Entity): boolean {
    return entity.hasComponent(Production) && entity.hasComponent(Building);
  }

  update(deltaTime: number): void {
    for (const entity of this.entities) {
      if (!entity.active) continue;

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
      const mapLinkedGather =
        buildingDef?.animation?.type === 'gather' &&
        (building.buildingType === 'lumberjack' ||
          building.buildingType === 'quarry' ||
          building.buildingType === 'fisher');
      const storage = entity.getComponent(Storage);
      const useLocalStorage = storage?.isProductionStorage;
      const rockDepletionGather =
        buildingDef?.animation?.type === 'gather' &&
        buildingDef.animation.gatherMode === 'rock_depletion';
      const waterDepletionGather =
        buildingDef?.animation?.type === 'gather' &&
        buildingDef.animation.gatherMode === 'water_depletion';
      const resourceDepletionGather = rockDepletionGather || waterDepletionGather;

      // Check buffer/storage space for outputs (skip if cycle already in progress)
      if (production.timer === 0) {
        if (useLocalStorage) {
          const outputTotal = Object.values(production.outputs).reduce((s, n) => s + n, 0);
          if (storage!.getFreeSpace() < outputTotal) {
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
          if (!production.hasBufferSpace()) {
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
        !resourceManager.hasAvailableInputsForProduction(production.inputs)
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

      if (production.status !== 'producing') {
        building.outOfMapResources = false;
        production.status = 'producing';
        eventBus.emit('production:resumed', { entityId: entity.id });
      }

      // Forester / quarry rock: hold the production clock until the field animation worker finishes
      const foresterPlanting =
        building.buildingType === 'forester' && building.animationWorkerId != null;
      const depletionGatherPausing = resourceDepletionGather && building.animationWorkerId != null;
      const mapGatherSourceBlocked =
        mapLinkedGather && building.outOfMapResources;
      if (!foresterPlanting && !depletionGatherPausing && !mapGatherSourceBlocked) {
        production.timer += deltaTime;
      }

      if (!resourceDepletionGather && production.timer >= production.productionTime) {
        production.timer -= production.productionTime;
        applyProductionCycleOutputs(entity);
      }
    }
  }
}
