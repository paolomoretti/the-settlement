/**
 * Simple Entity-Component System
 * Entities are containers for components
 */

import { Component } from './Component';

let nextEntityId = 0;

export class Entity {
  public readonly id: number;
  private components: Map<string, Component> = new Map();
  public active: boolean = true;

  constructor() {
    this.id = nextEntityId++;
  }

  addComponent(component: Component): this {
    this.components.set(component.constructor.name, component);
    component.entity = this;
    return this;
  }

  getComponent<T extends Component>(componentClass: new (...args: any[]) => T): T | undefined {
    return this.components.get(componentClass.name) as T;
  }

  hasComponent<T extends Component>(componentClass: new (...args: any[]) => T): boolean {
    return this.components.has(componentClass.name);
  }

  removeComponent<T extends Component>(componentClass: new (...args: any[]) => T): void {
    this.components.delete(componentClass.name);
  }

  getAllComponents(): Component[] {
    return Array.from(this.components.values());
  }

  destroy(): void {
    this.active = false;
    this.components.clear();
  }
}
