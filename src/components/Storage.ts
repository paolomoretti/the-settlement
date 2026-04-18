import { Component } from '@/core/Component';
import { ResourceType } from '@/types/GameData';

export class Storage extends Component {
  public items: Record<string, number> = {};
  public capacity: number;
  public accepts?: ResourceType[];
  public isHeadquarters: boolean;

  constructor(
    capacity: number,
    isHeadquarters: boolean = false,
    accepts?: ResourceType[]
  ) {
    super();
    this.capacity = capacity;
    this.isHeadquarters = isHeadquarters;
    this.accepts = accepts;
  }

  getTotalStored(): number {
    let total = 0;
    for (const amount of Object.values(this.items)) {
      total += amount;
    }
    return total;
  }

  getFreeSpace(): number {
    return Math.max(0, this.capacity - this.getTotalStored());
  }

  isFull(): boolean {
    return this.getTotalStored() >= this.capacity;
  }

  canAccept(resourceType: string): boolean {
    if (this.isFull()) return false;
    if (!this.accepts) return true;
    return this.accepts.includes(resourceType as ResourceType);
  }

  addItem(resourceType: string, amount: number): number {
    if (!this.canAccept(resourceType)) return 0;
    const space = this.getFreeSpace();
    const added = Math.min(amount, space);
    this.items[resourceType] = (this.items[resourceType] || 0) + added;
    return added;
  }

  removeItem(resourceType: string, amount: number): number {
    const available = this.items[resourceType] || 0;
    const removed = Math.min(available, amount);
    this.items[resourceType] = available - removed;
    if (this.items[resourceType] <= 0) {
      delete this.items[resourceType];
    }
    return removed;
  }

  getAmount(resourceType: string): number {
    return this.items[resourceType] || 0;
  }

  serialize(): object {
    return {
      items: { ...this.items },
    };
  }

  deserialize(data: any): void {
    if (data.items) this.items = { ...data.items };
  }
}
