/**
 * Entity Factory - creates common entity types
 */

import { Entity } from '@/core/Entity';
import { Position } from '@/components/Position';
import { Renderable } from '@/components/Renderable';
import { Movable } from '@/components/Movable';
import { Worker } from '@/components/Worker';
import { Building, BuildingType } from '@/components/Building';

export function createWorker(x: number, y: number): Entity {
  const entity = new Entity();

  entity.addComponent(new Position(x, y));
  entity.addComponent(new Renderable(
    'circle',
    '#ff6b6b',
    { width: 16, height: 16 },
    0,
    undefined,
    0 // No layers - using isometric sorting
  ));
  entity.addComponent(new Movable(3)); // 3 tiles per second
  entity.addComponent(new Worker('Settler'));

  return entity;
}

export function createBuilding(
  buildingType: BuildingType,
  x: number,
  y: number
): Entity {
  const entity = new Entity();

  entity.addComponent(new Position(x, y));

  // Different colors, sizes, and 3D properties for different buildings
  let color = '#8b7355';
  let width = 2; // tiles
  let depth = 2; // tiles
  let height = 50; // 3D height in pixels

  switch (buildingType) {
    case 'base_camp':
      color = '#8b1a1a'; // Dark red
      width = 6;
      depth = 6;
      height = 120;
      break;
    case 'warehouse':
      color = '#d4a574';
      width = 3;
      depth = 3;
      height = 80;
      break;
    case 'lumberjack':
      color = '#8b4513';
      width = 2;
      depth = 2;
      height = 60;
      break;
    case 'sawmill':
      color = '#cd853f';
      width = 2;
      depth = 2;
      height = 65;
      break;
    case 'quarry':
      color = '#696969';
      width = 2;
      depth = 2;
      height = 55;
      break;
    case 'farm':
      color = '#f0e68c';
      width = 3;
      depth = 2;
      height = 45;
      break;
  }

  entity.addComponent(new Renderable(
    'rectangle',
    color,
    { width: width * 32, height: depth * 32 },
    0,
    undefined,
    0 // Layer 0 (below workers)
  ));

  entity.addComponent(new Building(buildingType, width, depth, height));

  return entity;
}

export function createBaseCamp(x: number, y: number): Entity {
  return createBuilding('base_camp', x, y);
}

export function createWarehouse(x: number, y: number): Entity {
  return createBuilding('warehouse', x, y);
}

export function createRoad(x: number, y: number): Entity {
  const entity = new Entity();

  entity.addComponent(new Position(x, y));
  entity.addComponent(new Building('road', 1, 1, 0, true));

  return entity;
}
