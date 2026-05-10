import { GameWorkerRegistry, type WorkerWorldAccess } from '@/workers/GameWorkerRegistry';
import { Entity } from '@/core/Entity';
import { TileMap } from '@/map/TileMap';
import { PathFinder } from '@/pathfinding/AStar';
import type { RenderSystem } from '@/systems/RenderSystem';
import type { WildlifeCoordinator } from '@/wildlife/WildlifeCoordinator';
import { createBaseCamp } from '@/entities/EntityFactory';
import { Position } from '@/components/Position';
import { Building } from '@/components/Building';
import { getSimulationNowMs, setSimulationNowMs as setGlobalSimulationNowMs } from '@/core/simulationClock';

const minimapStub = { updateMinimapTiles: (_tiles: { x: number; y: number }[]) => {} };
const wildlifeStub = {} as WildlifeCoordinator;

export type RoadReturnTestContext = {
  world: WorkerWorldAccess;
  registry: GameWorkerRegistry;
  tileMap: TileMap;
  pathFinder: PathFinder;
  hqEntity: Entity;
  entities: Entity[];
  /** Mutable set returned by {@link WorkerWorldAccess.getBaseCampConnectedRoads} for this stub. */
  hqConnectedRoads: Set<string>;
  /** HQ entrance tile (occupied + hasRoad). */
  entrance: { x: number; y: number };
  populationCap: number;
  setSimulationNowMs(ms: number): void;
  /** Same peasant-slot math as {@link Game.getAvailablePopulation} minus specialists (none here). */
  effectiveAvailablePeasantSlots(): number;
};

/**
 * HQ at (5,5), entrance road (9,7), open HQ road strip (10,7)–(16,7) for pathfinding / segment tests.
 */
export function createRoadReturnTestContext(): RoadReturnTestContext {
  const width = 40;
  const height = 40;
  const tileMap = TileMap.deserialize({
    width,
    height,
    seed: 1,
    terrain: `${width * height}g`,
    roads: '',
  });

  const hqEntity = createBaseCamp(5, 5);
  const building = hqEntity.getComponent(Building);
  const pos = hqEntity.getComponent(Position);
  if (!building || !pos) throw new Error('HQ missing components');
  const off = building.getEntranceOffset();
  if (!off) throw new Error('HQ entrance expected');
  const entranceX = pos.x + off.dx;
  const entranceY = pos.y + off.dy;
  const entrance = { x: entranceX, y: entranceY };

  const entTile = tileMap.getTile(entranceX, entranceY);
  if (!entTile) throw new Error('entrance OOB');
  entTile.hasRoad = true;
  entTile.occupiedBy = hqEntity.id;

  const openRoadCoords: { x: number; y: number }[] = [];
  for (let x = 10; x <= 16; x++) {
    openRoadCoords.push({ x, y: 7 });
    const t = tileMap.getTile(x, 7);
    if (t) t.hasRoad = true;
  }

  const hqConnectedRoads = new Set<string>();
  hqConnectedRoads.add(`${entranceX},${entranceY}`);
  for (const c of openRoadCoords) {
    hqConnectedRoads.add(`${c.x},${c.y}`);
  }

  const pathFinder = new PathFinder();
  const entities: Entity[] = [hqEntity];
  const populationCap = 20;
  const ctxHolder: { registry: GameWorkerRegistry | null } = { registry: null };

  const world: WorkerWorldAccess = {
    getEntities: () => entities,
    getBaseCampEntity: () => hqEntity,
    getTileMap: () => tileMap,
    getPathFinder: () => pathFinder,
    addEntity: (e: Entity) => {
      entities.push(e);
    },
    removeEntity: (e: Entity) => {
      const i = entities.indexOf(e);
      if (i !== -1) entities.splice(i, 1);
      e.destroy();
    },
    getRenderSystem: () => minimapStub as Pick<RenderSystem, 'updateMinimapTiles'>,
    getBaseCampConnectedRoads: () => hqConnectedRoads,
    getAvailablePeasantSlotCount: () => {
      const r = ctxHolder.registry;
      if (!r) return populationCap;
      return (
        populationCap -
        r.getPlayerRoadSegmentWorkerCount() -
        r.getReservedPopulationCount()
      );
    },
    getConstructionPriority: () => 0,
    getWildlife: () => wildlifeStub,
    claimToolSpecialistForDispatch: () => false,
    returnToolSpecialistToHq: () => {},
    onMilitarySpecialistReturnedToHq: () => {},
    onDonkeyReturnedToHq: () => {},
    isEntitySimulationActive: () => true,
    getSimulationNowMs: () => getSimulationNowMs(),
    getPlayerHqEntities: () => [hqEntity],
  };

  const registry = new GameWorkerRegistry(world);
  ctxHolder.registry = registry;

  return {
    world,
    registry,
    tileMap,
    pathFinder,
    hqEntity,
    entities,
    hqConnectedRoads,
    entrance,
    populationCap,
    setSimulationNowMs(ms: number) {
      setGlobalSimulationNowMs(ms);
    },
    effectiveAvailablePeasantSlots() {
      return (
        populationCap -
        registry.getPlayerRoadSegmentWorkerCount() -
        registry.getReservedPopulationCount()
      );
    },
  };
}
