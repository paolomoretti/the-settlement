import { Entity } from '@/core/Entity';
import { eventBus } from '@/core/EventBus';
import { Position } from '@/components/Position';
import { Building } from '@/components/Building';
import { Storage } from '@/components/Storage';
import { Production } from '@/components/Production';
import { TransportQueue, TransportRequest } from './TransportRequest';
import { Inventory } from '@/types/GameData';

export class ResourceManager {
  private static instance: ResourceManager;
  public transportQueue: TransportQueue = new TransportQueue();
  private entityGetter: (() => Entity[]) | null = null;

  static getInstance(): ResourceManager {
    if (!ResourceManager.instance) {
      ResourceManager.instance = new ResourceManager();
    }
    return ResourceManager.instance;
  }

  setEntityGetter(getter: () => Entity[]): void {
    this.entityGetter = getter;
  }

  private getEntities(): Entity[] {
    return this.entityGetter ? this.entityGetter() : [];
  }

  getGlobalInventory(): Inventory {
    const inventory: Inventory = {};
    for (const entity of this.getEntities()) {
      if (!entity.active) continue;
      const storage = entity.getComponent(Storage);
      if (!storage) continue;
      for (const [resource, amount] of Object.entries(storage.items)) {
        inventory[resource] = (inventory[resource] || 0) + amount;
      }
    }
    return inventory;
  }

  getGlobalAmount(resourceType: string): number {
    let total = 0;
    for (const entity of this.getEntities()) {
      if (!entity.active) continue;
      const storage = entity.getComponent(Storage);
      if (!storage) continue;
      total += storage.getAmount(resourceType);
    }
    return total;
  }

  getAvailableAmount(resourceType: string): number {
    return this.getGlobalAmount(resourceType) -
      this.transportQueue.getInTransitAmount(resourceType);
  }

  canAfford(costs: Record<string, number>): boolean {
    const inventory = this.getGlobalInventory();
    for (const [resource, amount] of Object.entries(costs)) {
      if ((inventory[resource] || 0) < amount) return false;
    }
    return true;
  }

  deductResources(costs: Record<string, number>): boolean {
    if (!this.canAfford(costs)) return false;

    for (const [resource, amount] of Object.entries(costs)) {
      let remaining = amount;
      for (const entity of this.getEntities()) {
        if (remaining <= 0) break;
        if (!entity.active) continue;
        const storage = entity.getComponent(Storage);
        if (!storage) continue;
        remaining -= storage.removeItem(resource, remaining);
      }
    }

    eventBus.emit('resource:updated');
    return true;
  }

  consumeInputsForProduction(inputs: Record<string, number>): boolean {
    if (!this.canAfford(inputs)) return false;
    return this.deductResources(inputs);
  }

  requestPickup(sourceEntityId: number, resourceType: string, amount: number): TransportRequest {
    const request = this.transportQueue.createRequest(sourceEntityId, resourceType, amount);
    eventBus.emit('transport:pickup_available', {
      requestId: request.id,
      sourceEntityId,
      resourceType,
      amount,
    });
    return request;
  }

  completeDelivery(requestId: number, resourceType: string, amount: number): boolean {
    const headquarters = this.findHeadquarters();
    if (!headquarters) return false;

    const storage = headquarters.getComponent(Storage);
    if (!storage) return false;

    storage.addItem(resourceType, amount);
    this.transportQueue.markDelivered(requestId);

    eventBus.emit('resource:updated');
    eventBus.emit('resource:delivered', { resourceType, amount });
    return true;
  }

  deliverToNearestStorage(resourceType: string, amount: number, fromX: number, fromY: number): number {
    const storageEntities = this.getStorageBuildings();
    if (storageEntities.length === 0) return 0;

    let bestEntity: Entity | null = null;
    let bestDist = Infinity;

    for (const entity of storageEntities) {
      const storage = entity.getComponent(Storage);
      const pos = entity.getComponent(Position);
      if (!storage || !pos || !storage.canAccept(resourceType)) continue;

      const dist = Math.abs(pos.x - fromX) + Math.abs(pos.y - fromY);
      if (dist < bestDist) {
        bestDist = dist;
        bestEntity = entity;
      }
    }

    if (!bestEntity) return 0;
    const storage = bestEntity.getComponent(Storage);
    if (!storage) return 0;

    const added = storage.addItem(resourceType, amount);
    if (added > 0) {
      eventBus.emit('resource:updated');
    }
    return added;
  }

  findHeadquarters(): Entity | null {
    for (const entity of this.getEntities()) {
      if (!entity.active) continue;
      const storage = entity.getComponent(Storage);
      if (storage?.isHeadquarters) return entity;
    }
    return null;
  }

  getStorageBuildings(): Entity[] {
    return this.getEntities().filter(entity => {
      if (!entity.active) return false;
      const storage = entity.getComponent(Storage);
      const building = entity.getComponent(Building);
      return storage && building && building.isComplete();
    });
  }

  findNearestStorage(fromX: number, fromY: number, resourceType?: string): Entity | null {
    const storageEntities = this.getStorageBuildings();
    let bestEntity: Entity | null = null;
    let bestDist = Infinity;

    for (const entity of storageEntities) {
      const storage = entity.getComponent(Storage);
      const pos = entity.getComponent(Position);
      if (!storage || !pos) continue;
      if (resourceType && !storage.canAccept(resourceType)) continue;

      const dist = Math.abs(pos.x - fromX) + Math.abs(pos.y - fromY);
      if (dist < bestDist) {
        bestDist = dist;
        bestEntity = entity;
      }
    }

    return bestEntity;
  }

  getProductionBuildings(): Entity[] {
    return this.getEntities().filter(entity => {
      if (!entity.active) return false;
      return entity.hasComponent(Production) && entity.hasComponent(Building);
    });
  }

  onBuildingDestroyed(entityId: number): void {
    this.transportQueue.cancelBySource(entityId);
  }

  reset(): void {
    this.transportQueue.clear();
  }

  serialize(): object {
    return {
      transportQueue: this.transportQueue.serialize(),
    };
  }

  deserialize(data: any): void {
    if (data.transportQueue) {
      this.transportQueue.deserialize(data.transportQueue);
    }
  }
}

export const resourceManager = ResourceManager.getInstance();
