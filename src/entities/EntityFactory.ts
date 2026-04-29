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
import { Owner } from '@/components/Owner';
import { dataManager } from '@/data/DataManager';
import { getSimulationNowMs } from '@/core/simulationClock';
import { ResourceType } from '@/types/GameData';
import { BUILDING_FINAL_SPRITES } from '@/catalog/buildingSprites';

export function createWorker(x: number, y: number, role: WorkerRole = 'peasant'): Entity {
  const entity = new Entity();
  const def = WORKER_DEFS[role];

  entity.addComponent(new Position(x, y));
  entity.addComponent(new Owner('player'));
  entity.addComponent(new Renderable(
    'worker',
    '#8b7355',
    { width: 12, height: 20 },
    0,
    0,
    undefined,
    0
  ));
  entity.addComponent(new Movable(def.speed));
  entity.addComponent(new Worker(role === 'military' ? 'Soldier' : 'Peasant', role));

  return entity;
}

/** Assembled at HQ; `rank` is updated after gold promotions at the fort. */
export function createMilitaryWorker(x: number, y: number, rank: 1 | 2 | 3 = 1): Entity {
  const entity = createWorker(x, y, 'military');
  const w = entity.getComponent(Worker);
  if (w) w.applyMilitaryAppearance(rank);
  return entity;
}

export function createBuilding(
  buildingType: BuildingType,
  x: number,
  y: number
): Entity {
  const entity = new Entity();

  entity.addComponent(new Position(x, y));
  entity.addComponent(new Owner('player'));

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
      0,
      undefined,
      0
    ));

    entity.addComponent(new Building(buildingType, width, depth, height));

    return entity;
  }

  // Use data from building definition
  const { size, visual } = buildingDef;

  const spritePath = BUILDING_FINAL_SPRITES[buildingType];

  entity.addComponent(new Renderable(
    spritePath ? 'sprite' : 'rectangle',
    visual.color,
    { width: size.width * 32, height: size.height * 32 },
    visual.offsetX ?? 0,
    visual.offsetY ?? 0,
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
    buildingComp.completedAt = getSimulationNowMs();
    const cap = buildingDef.military?.soldierCapacity;
    if (typeof cap === 'number' && cap > 0) {
      buildingComp.initMilitaryGarrison(cap);
    }
  }

  entity.addComponent(buildingComp);

  if (buildingDef.production && Object.keys(buildingDef.production.outputs).length > 0) {
    const prod = buildingDef.production;
    const inputsAny = (prod.inputsAny ?? []).map(g => ({
      resourceTypes: g.resourceTypes as ResourceType[],
      amount: g.amount,
    }));
    entity.addComponent(
      new Production(
        prod.productionTime,
        prod.outputs,
        prod.inputs || {},
        prod.maxOutputBuffer || 10,
        prod.continuous,
        inputsAny,
        prod.outputMode ?? 'all'
      )
    );
  }

  if (buildingDef.storage) {
    const storage = new Storage(
      buildingDef.storage.capacity,
      buildingDef.isHeadquarters || false,
      buildingDef.storage.accepts as ResourceType[] | undefined
    );
    const prod = buildingDef.production;
    const hasLocalRecipeInputs =
      prod &&
      (Object.keys(prod.inputs || {}).length > 0 || (prod.inputsAny?.length ?? 0) > 0);
    if (hasLocalRecipeInputs) {
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
  entity.addComponent(new Owner('player'));
  entity.addComponent(new Building('road', 1, 1, 0, true));

  return entity;
}
