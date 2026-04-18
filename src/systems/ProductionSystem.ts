import { System } from '@/core/System';
import { Entity } from '@/core/Entity';
import { eventBus } from '@/core/EventBus';
import { Building } from '@/components/Building';
import { Production } from '@/components/Production';
import { resourceManager } from '@/economics/ResourceManager';

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

      if (!building.isActive) {
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

      if (!production.hasBufferSpace()) {
        if (production.status !== 'stopped_full') {
          production.status = 'stopped_full';
          eventBus.emit('production:stopped', {
            entityId: entity.id,
            reason: 'buffer_full',
          });
        }
        continue;
      }

      if (production.hasInputs() && !resourceManager.canAfford(production.inputs)) {
        if (production.status !== 'stopped_no_inputs') {
          production.status = 'stopped_no_inputs';
          eventBus.emit('production:stopped', {
            entityId: entity.id,
            reason: 'no_inputs',
          });
        }
        continue;
      }

      if (production.status !== 'producing') {
        production.status = 'producing';
        eventBus.emit('production:resumed', { entityId: entity.id });
      }

      production.timer += deltaTime;

      if (production.timer >= production.productionTime) {
        production.timer -= production.productionTime;

        if (production.hasInputs()) {
          const consumed = resourceManager.consumeInputsForProduction(production.inputs);
          if (!consumed) {
            production.status = 'stopped_no_inputs';
            production.timer = 0;
            eventBus.emit('production:stopped', {
              entityId: entity.id,
              reason: 'no_inputs',
            });
            continue;
          }
        }

        for (const [resource, amount] of Object.entries(production.outputs)) {
          if (amount <= 0) continue;
          production.addToBuffer(resource, amount);

          resourceManager.requestPickup(entity.id, resource, amount);
        }

        eventBus.emit('production:complete', {
          entityId: entity.id,
          outputs: { ...production.outputs },
        });

        if (!production.continuous) {
          production.status = 'idle';
          production.timer = 0;
        }

        if (!production.hasBufferSpace()) {
          production.status = 'stopped_full';
          eventBus.emit('production:stopped', {
            entityId: entity.id,
            reason: 'buffer_full',
          });
        }
      }
    }
  }
}
