/**
 * Entity Factory - creates common entity types
 */

import { Entity } from '@/core/Entity';
import { Position } from '@/components/Position';
import { Renderable } from '@/components/Renderable';
import { Movable } from '@/components/Movable';
import { Worker, WorkerRole, WORKER_DEFS } from '@/components/Worker';
import { Building, BuildingType } from '@/components/Building';
import { Production } from '@/components/Production';
import { Storage } from '@/components/Storage';
import { dataManager } from '@/data/DataManager';
import { ResourceType } from '@/types/GameData';

export function createWorker(x: number, y: number, role: WorkerRole = 'peasant'): Entity {
  const entity = new Entity();
  const def = WORKER_DEFS[role];

  entity.addComponent(new Position(x, y));
  entity.addComponent(new Renderable(
    'worker',
    '#8b7355',
    { width: 12, height: 20 },
    0,
    undefined,
    0
  ));
  entity.addComponent(new Movable(def.speed));
  entity.addComponent(new Worker(def.role, role));

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
    storehouse: '/assets/buildings/warehouse.png',
    lumberjack: '/assets/buildings/lumberjack.png',
    sawmill: '/assets/buildings/sawmill.png',
    forester: '/assets/buildings/forester.png',
    quarry: '/assets/buildings/quarry.png',
    hut: '/assets/buildings/hut.png',
    house: '/assets/buildings/house.png',
    fisher: '/assets/buildings/fisher.png',
    well: '/assets/buildings/well.png',
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
    buildingComp.buildTimeSec = buildingDef.buildTime;
  } else {
    buildingComp.completedAt = Date.now();
  }

  entity.addComponent(buildingComp);

  if (buildingDef.production && Object.keys(buildingDef.production.outputs).length > 0) {
    entity.addComponent(new Production(
      buildingDef.production.productionTime,
      buildingDef.production.outputs,
      buildingDef.production.inputs || {},
      buildingDef.production.maxOutputBuffer || 10,
      buildingDef.production.continuous
    ));
  }

  if (buildingDef.storage) {
    const storage = new Storage(
      buildingDef.storage.capacity,
      buildingDef.isHeadquarters || false,
      buildingDef.storage.accepts as ResourceType[] | undefined
    );
    if (buildingDef.production && Object.keys(buildingDef.production.inputs || {}).length > 0) {
      storage.isProductionStorage = true;
    }
    entity.addComponent(storage);
  }

  return entity;
}

export function createBaseCamp(x: number, y: number): Entity {
  return createBuilding('base_camp', x, y);
}


export function createRoad(x: number, y: number): Entity {
  const entity = new Entity();

  entity.addComponent(new Position(x, y));
  entity.addComponent(new Building('road', 1, 1, 0, true));

  return entity;
}
