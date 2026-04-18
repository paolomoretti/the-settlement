/**
 * Entity Factory - creates common entity types
 */

import { Entity } from '@/core/Entity';
import { Position } from '@/components/Position';
import { Renderable } from '@/components/Renderable';
import { Movable } from '@/components/Movable';
import { Worker } from '@/components/Worker';
import { Building, BuildingType } from '@/components/Building';
import { dataManager } from '@/data/DataManager';

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

  // Get building definition from data manager
  const buildingDef = dataManager.getBuilding(buildingType);

  if (!buildingDef) {
    console.error(`Unknown building type: ${buildingType}`);
    const color = '#8b7355';
    const width = 2;
    const depth = 2;
    const height = 50;

    entity.addComponent(new Renderable(
      'rectangle',
      color,
      { width: width * 32, height: depth * 32 },
      0,
      undefined,
      0
    ));

    entity.addComponent(new Building(buildingType, width, depth, height));

    return entity;
  }

  // Use data from building definition
  const { size, visual } = buildingDef;

  const SPRITE_PATHS: Record<string, string> = {
    base_camp: '/assets/buildings/base_camp.png',
    warehouse: '/assets/buildings/warehouse.png',
    lumberjack: '/assets/buildings/lumberjack.png',
    sawmill: '/assets/buildings/sawmill.png',
  };
  const spritePath = SPRITE_PATHS[buildingType];

  entity.addComponent(new Renderable(
    spritePath ? 'sprite' : 'rectangle',
    visual.color,
    { width: size.width * 32, height: size.height * 32 },
    0,
    spritePath,
    0
  ));

  const buildingComp = new Building(
    buildingType,
    size.width,
    size.height,
    visual.buildingHeight,
    false,
    buildingDef.requiresRoad
  );

  if (buildingDef.buildTime > 0) {
    buildingComp.startConstruction(buildingDef.buildTime);
  }

  entity.addComponent(buildingComp);

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
