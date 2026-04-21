/**
 * Movement System - handles entity movement along paths
 */

import { System } from '@/core/System';
import { Entity } from '@/core/Entity';
import { Position } from '@/components/Position';
import { Movable } from '@/components/Movable';
import { Worker } from '@/components/Worker';

export class MovementSystem extends System {
  shouldProcessEntity(entity: Entity): boolean {
    return entity.hasComponent(Position) && entity.hasComponent(Movable);
  }

  update(deltaTime: number): void {
    this.entities.forEach(entity => {
      const position = entity.getComponent(Position)!;
      const movable = entity.getComponent(Movable)!;

      if (!movable.isMoving) return;

      const target = movable.getCurrentTarget();
      if (!target) {
        movable.clearPath();

        // Update worker state to idle when done moving
        if (entity.hasComponent(Worker)) {
          const worker = entity.getComponent(Worker)!;
          if (worker.state === 'walking') {
            if (
              worker.hammerConstructionEnabled &&
              worker.visualActivity === 'construct' &&
              worker.carryingResource === 'hammer'
            ) {
              worker.setState('working');
              worker.buildIdleUntil = Date.now() + 1600 + Math.random() * 1400;
            } else {
              worker.setState(worker.carryingResource ? 'carrying' : 'idle');
            }
          }
        }
        return;
      }

      // Initialize segment start on first update (progress = 0)
      if (movable.progress === 0) {
        if (movable.currentPathIndex === 0) {
          // First segment - start from current position
          movable.segmentStartX = position.x;
          movable.segmentStartY = position.y;
        } else {
          // Subsequent segments - start from previous waypoint
          const prevWaypoint = movable.path[movable.currentPathIndex - 1];
          movable.segmentStartX = prevWaypoint.x;
          movable.segmentStartY = prevWaypoint.y;
        }
      }

      // Move towards target
      movable.progress += movable.speed * deltaTime;

      if (movable.progress >= 1) {
        // Reached the target tile
        position.set(target.x, target.y);
        movable.currentPathIndex++;
        movable.progress = 0;

        // Check if path is complete
        if (movable.currentPathIndex >= movable.path.length) {
          movable.clearPath();

          // Update worker state
          if (entity.hasComponent(Worker)) {
            const worker = entity.getComponent(Worker)!;
            if (worker.state === 'walking') {
              if (
                worker.hammerConstructionEnabled &&
                worker.visualActivity === 'construct' &&
                worker.carryingResource === 'hammer'
              ) {
                worker.setState('working');
                worker.buildIdleUntil = Date.now() + 1600 + Math.random() * 1400;
              } else {
                worker.setState(worker.carryingResource ? 'carrying' : 'idle');
              }
            }
          }
        }
      } else {
        // Interpolate between segment start and target
        position.x = movable.segmentStartX + (target.x - movable.segmentStartX) * movable.progress;
        position.y = movable.segmentStartY + (target.y - movable.segmentStartY) * movable.progress;
      }
    });
  }
}
