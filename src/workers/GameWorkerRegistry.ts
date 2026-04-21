/**
 * All non–road-segment-transport worker state and logic: HQ-spawned road workers,
 * builders, tool delivery, returning legs, and building production animation actors.
 * Game keeps transport relay + economy orchestration; this module keeps worker maps consistent.
 *
 * Camp-first spawn rules (e.g. well operator): `.claude/WORKER_SPAWN.md`.
 */

import { Entity } from '@/core/Entity';
import { TileMap } from '@/map/TileMap';
import { PathFinder } from '@/pathfinding/AStar';
import { RenderSystem } from '@/systems/RenderSystem';
import { Position } from '@/components/Position';
import { Movable } from '@/components/Movable';
import { Worker } from '@/components/Worker';
import { Building } from '@/components/Building';
import { Production } from '@/components/Production';
import { dataManager } from '@/data/DataManager';
import { roadSegmentManager, RoadSegment } from '@/economics/RoadSegmentManager';
import { transportManager } from '@/economics/TransportManager';
import { createWorker } from '@/entities/EntityFactory';

type GatherAnimState = {
  kind: 'gather';
  buildingEntityId: number;
  phase: 'to_target' | 'chopping' | 'returning';
  targetTile: { x: number; y: number };
  terrainModified: boolean;
  entranceTile: { x: number; y: number };
};

type WellOperatorAnimState = {
  kind: 'well_operator';
  buildingEntityId: number;
  phase: 'idle_left' | 'to_entrance' | 'waiting_at_well' | 'drawing' | 'to_idle';
  idleTile: { x: number; y: number };
  workTile: { x: number; y: number };
  lastProductionTimer: number;
};

type PlantTreeAnimState = {
  kind: 'plant_tree';
  buildingEntityId: number;
  phase: 'to_site' | 'digging' | 'returning';
  plantTile: { x: number; y: number };
  workTile: { x: number; y: number };
  entranceTile: { x: number; y: number };
  digUntilMs: number;
  planted: boolean;
};

type AnimationWorkerState = GatherAnimState | WellOperatorAnimState | PlantTreeAnimState;

export interface WorkerWorldAccess {
  getEntities(): Entity[];
  getBaseCampEntity(): Entity | null;
  getTileMap(): TileMap;
  getPathFinder(): PathFinder;
  addEntity(entity: Entity): void;
  removeEntity(entity: Entity): void;
  getRenderSystem(): Pick<RenderSystem, 'updateMinimapTiles'>;
  getBaseCampConnectedRoads(): Set<string>;
  /** Peasant slots not yet assigned to road segments or any worker tracked by this registry. */
  getAvailablePeasantSlotCount(): number;
}

export class GameWorkerRegistry {
  private readonly returningWorkers = new Set<number>();
  private readonly builderWorkers = new Map<number, number>();
  private readonly returningBuilders = new Set<number>();
  private readonly toolWorkers = new Map<number, number>();
  private readonly animationWorkers = new Map<number, AnimationWorkerState>();
  private readonly reservedTreeTiles = new Set<string>();

  constructor(private readonly world: WorkerWorldAccess) {}

  getReservedPopulationCount(): number {
    return (
      this.returningWorkers.size +
      this.builderWorkers.size +
      this.returningBuilders.size +
      this.toolWorkers.size +
      this.animationWorkers.size
    );
  }

  isRoadWorkerReturning(workerEntityId: number): boolean {
    return this.returningWorkers.has(workerEntityId);
  }

  getRoadSegmentCallbacks() {
    return {
      spawnWorker: (seg: RoadSegment) => this.spawnSegmentWorker(seg),
      freeWorker: (id: number) => this.freeSegmentWorker(id),
      moveWorker: (id: number, seg: RoadSegment) => this.moveSegmentWorker(id, seg),
    };
  }

  rerouteReturningWorkers(): void {
    if (this.returningWorkers.size === 0) return;
    const spawnTile = this.findBaseCampSpawnTile();
    const entities = [...this.world.getEntities()];
    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();

    for (const workerId of this.returningWorkers) {
      const entity = entities.find(e => e.id === workerId && e.active);
      if (!entity) {
        this.returningWorkers.delete(workerId);
        continue;
      }

      const pos = entity.getComponent(Position);
      const movable = entity.getComponent(Movable);
      const worker = entity.getComponent(Worker);
      if (!pos || !movable || !worker) {
        this.world.removeEntity(entity);
        this.returningWorkers.delete(workerId);
        continue;
      }

      if (!spawnTile) {
        this.world.removeEntity(entity);
        this.returningWorkers.delete(workerId);
        continue;
      }

      const path = pathFinder.findPath(
        new Position(Math.floor(pos.x), Math.floor(pos.y)),
        new Position(spawnTile.x, spawnTile.y),
        tileMap
      );

      if (path.length > 0) {
        movable.setPath(path);
        worker.setState('walking');
      } else {
        this.world.removeEntity(entity);
        this.returningWorkers.delete(workerId);
      }
    }
  }

  tickReturnLegs(): void {
    const entities = [...this.world.getEntities()];
    if (this.returningWorkers.size > 0) {
      for (const workerId of this.returningWorkers) {
        const entity = entities.find(e => e.id === workerId && e.active);
        if (!entity) {
          this.returningWorkers.delete(workerId);
          continue;
        }
        const movable = entity.getComponent(Movable);
        if (movable && !movable.isMoving) {
          this.world.removeEntity(entity);
          this.returningWorkers.delete(workerId);
        }
      }
    }

    if (this.returningBuilders.size > 0) {
      for (const builderId of this.returningBuilders) {
        const entity = entities.find(e => e.id === builderId && e.active);
        if (!entity) {
          this.returningBuilders.delete(builderId);
          continue;
        }
        const movable = entity.getComponent(Movable);
        if (movable && !movable.isMoving) {
          this.world.removeEntity(entity);
          this.returningBuilders.delete(builderId);
        }
      }
    }
  }

  updateConstructionDelivery(): void {
    const entities = [...this.world.getEntities()];
    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();

    for (const [builderId, buildingId] of this.builderWorkers) {
      const builderEntity = entities.find(e => e.id === builderId && e.active);
      if (!builderEntity) {
        this.builderWorkers.delete(builderId);
        continue;
      }

      const movable = builderEntity.getComponent(Movable);
      if (movable && !movable.isMoving) {
        const buildingEntity = entities.find(e => e.id === buildingId && e.active);
        if (!buildingEntity) {
          this.world.removeEntity(builderEntity);
          this.builderWorkers.delete(builderId);
          continue;
        }

        const targetTile = this.findBuildingAdjacentRoadTile(buildingEntity);
        const builderPos = builderEntity.getComponent(Position);

        if (
          targetTile &&
          builderPos &&
          Math.floor(builderPos.x) === targetTile.x &&
          Math.floor(builderPos.y) === targetTile.y
        ) {
          const building = buildingEntity.getComponent(Building);
          if (building) building.builderArrived = true;
          this.builderWorkers.delete(builderId);
        } else if (targetTile && builderPos) {
          const path = pathFinder.findPath(
            new Position(Math.floor(builderPos.x), Math.floor(builderPos.y)),
            new Position(targetTile.x, targetTile.y),
            tileMap
          );
          if (path.length > 0) {
            movable.setPath(path);
            const workerComp = builderEntity.getComponent(Worker);
            if (workerComp) workerComp.setState('walking');
          }
        }
      }
    }

    for (const entity of entities) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (!building || building.state !== 'awaiting_materials') continue;

      if (building.canStartConstruction()) {
        const builderEntityId = building.builderEntityId;
        building.beginConstruction();
        if (builderEntityId != null) {
          const builderEntity = entities.find(e => e.id === builderEntityId && e.active);
          const w = builderEntity?.getComponent(Worker);
          if (w) {
            w.hammerConstructionEnabled = true;
            w.setState('working');
            w.buildIdleUntil = Date.now() + 1200 + Math.random() * 800;
          }
        }
        continue;
      }

      if (building.builderEntityId === null && building.isActive) {
        this.spawnBuilder(entity);
      }
    }

    for (const [workerId, buildingId] of this.toolWorkers) {
      const workerEntity = entities.find(e => e.id === workerId && e.active);
      if (!workerEntity) {
        this.toolWorkers.delete(workerId);
        continue;
      }

      const movable = workerEntity.getComponent(Movable);
      if (movable && !movable.isMoving) {
        const buildingEntity = entities.find(e => e.id === buildingId && e.active);
        if (!buildingEntity) {
          this.world.removeEntity(workerEntity);
          this.toolWorkers.delete(workerId);
          continue;
        }

        const targetTile = this.findBuildingAdjacentRoadTile(buildingEntity);
        const workerPos = workerEntity.getComponent(Position);

        if (
          targetTile &&
          workerPos &&
          Math.floor(workerPos.x) === targetTile.x &&
          Math.floor(workerPos.y) === targetTile.y
        ) {
          const building = buildingEntity.getComponent(Building);
          if (building) building.hasOperator = true;
          this.world.removeEntity(workerEntity);
          this.toolWorkers.delete(workerId);
        } else if (targetTile && workerPos) {
          const path = pathFinder.findPath(
            new Position(Math.floor(workerPos.x), Math.floor(workerPos.y)),
            new Position(targetTile.x, targetTile.y),
            tileMap
          );
          if (path.length > 0) {
            movable.setPath(path);
            const wc = workerEntity.getComponent(Worker);
            if (wc) wc.setState('walking');
          }
        }
      }
    }

    for (const entity of entities) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (!building || !building.isComplete() || building.hasOperator) continue;
      if (!building.isActive) continue;

      let hasToolWorker = false;
      for (const [, bId] of this.toolWorkers) {
        if (bId === entity.id) {
          hasToolWorker = true;
          break;
        }
      }
      if (hasToolWorker) continue;

      const buildingDef = dataManager.getBuilding(building.buildingType);
      if (buildingDef?.requiredTool) {
        this.spawnToolWorker(entity, buildingDef.requiredTool as string);
      }
    }
  }

  updateBuilderPatrol(): void {
    const entities = [...this.world.getEntities()];

    for (const entity of entities) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (!building) continue;
      if (building.state !== 'under_construction') continue;
      if (building.builderEntityId === null) continue;

      const builderEntity = entities.find(e => e.id === building.builderEntityId && e.active);
      if (!builderEntity) continue;

      const movable = builderEntity.getComponent(Movable);
      if (!movable || movable.isMoving) continue;

      const patrolWorker = builderEntity.getComponent(Worker);
      if (patrolWorker && patrolWorker.buildIdleUntil > Date.now()) continue;

      const builderPos = builderEntity.getComponent(Position);
      if (!builderPos) continue;

      const pos = entity.getComponent(Position);
      if (!pos) continue;

      const bx = Math.floor(pos.x);
      const by = Math.floor(pos.y);
      const perimeterTiles = this.getBuildingPerimeterTiles(bx, by, building.width, building.height);
      if (perimeterTiles.length === 0) continue;

      const bottomFaceTiles = this.getBuildingBottomFacePerimeterTiles(bx, by, building.width, building.height);

      const cx = Math.floor(builderPos.x);
      const cy = Math.floor(builderPos.y);
      const manhattan1 = (t: { x: number; y: number }) => Math.abs(t.x - cx) + Math.abs(t.y - cy) === 1;

      const adjacentBottom = bottomFaceTiles.filter(manhattan1);
      const adjacentFull = perimeterTiles.filter(manhattan1);

      if (adjacentFull.length > 0) {
        const edgeAdjacent = adjacentFull.filter(t => {
          for (let ix = bx; ix < bx + building.width; ix++) {
            for (let iy = by; iy < by + building.height; iy++) {
              if (Math.abs(t.x - ix) + Math.abs(t.y - iy) === 1) return true;
            }
          }
          return false;
        });
        const candidates =
          adjacentBottom.length > 0
            ? adjacentBottom
            : edgeAdjacent.length > 0
              ? edgeAdjacent
              : adjacentFull;
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        movable.speed = 0.9;
        movable.setPath([new Position(target.x, target.y)]);
        const worker = builderEntity.getComponent(Worker);
        if (worker) {
          worker.setState('walking');
          worker.buildIdleUntil = 0;
        }
      }
    }
  }

  updateAnimationWorkers(): void {
    const entities = [...this.world.getEntities()];
    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();
    const render = this.world.getRenderSystem();

    for (const [workerId, state] of this.animationWorkers) {
      const workerEntity = entities.find(e => e.id === workerId && e.active);
      if (!workerEntity) {
        this.cleanupAnimationWorker(workerId, state);
        continue;
      }

      if (state.kind === 'well_operator') {
        const movable = workerEntity.getComponent(Movable);
        const workerComp = workerEntity.getComponent(Worker);
        const workerPos = workerEntity.getComponent(Position);
        if (!workerComp || !workerPos) continue;

        const buildingEntity = entities.find(e => e.id === state.buildingEntityId && e.active);
        const building = buildingEntity?.getComponent(Building);
        const production = buildingEntity?.getComponent(Production);
        const buildingDef = building ? dataManager.getBuilding(building.buildingType) : null;
        const animCfg = buildingDef?.animation;

        if (!buildingEntity || !building || !production || animCfg?.type !== 'well_operator') {
          this.world.removeEntity(workerEntity);
          this.cleanupAnimationWorker(workerId, state);
          continue;
        }

        const speed = animCfg.workerSpeed;
        const drawingPhaseSec = animCfg.drawingPhaseSec;
        const walkLeadSec = animCfg.walkLeadSec ?? 5;
        const prodTime = production.productionTime;
        const timer = production.timer;
        const startWalk = Math.max(0, prodTime - drawingPhaseSec - walkLeadSec);
        const startDraw = Math.max(0, prodTime - drawingPhaseSec);

        const pathToIdle = (): Position[] =>
          pathFinder.findOffRoadPath(
            new Position(Math.floor(workerPos.x), Math.floor(workerPos.y)),
            new Position(state.idleTile.x, state.idleTile.y),
            tileMap
          );

        const pathToWork = (): Position[] =>
          pathFinder.findOffRoadPath(
            new Position(Math.floor(workerPos.x), Math.floor(workerPos.y)),
            new Position(state.workTile.x, state.workTile.y),
            tileMap
          );

        if (timer < state.lastProductionTimer - 0.05 && state.lastProductionTimer > 1) {
          if (state.phase === 'drawing') {
            workerComp.dropResource();
            workerComp.visualActivity = 'general';
            const ret = pathToIdle();
            if (ret.length > 0 && movable) {
              movable.speed = speed;
              movable.setPath(ret);
              workerComp.setState('walking');
              state.phase = 'to_idle';
            } else {
              state.phase = 'idle_left';
              workerComp.setState('idle');
            }
          } else if (state.phase !== 'to_idle' && state.phase !== 'to_entrance') {
            state.phase = 'idle_left';
            workerComp.visualActivity = 'general';
            workerComp.setState('idle');
          }
          state.lastProductionTimer = timer;
          continue;
        }
        state.lastProductionTimer = timer;

        if (state.phase === 'to_idle' && movable && !movable.isMoving) {
          state.phase = 'idle_left';
          workerComp.setState('idle');
          workerComp.visualActivity = 'general';
          continue;
        }

        if (movable?.isMoving) continue;

        if (production.status !== 'producing') {
          if (state.phase === 'drawing' || state.phase === 'to_entrance' || state.phase === 'waiting_at_well') {
            workerComp.dropResource();
            workerComp.visualActivity = 'general';
            const ret = pathToIdle();
            if (ret.length > 0 && movable) {
              movable.speed = speed;
              movable.setPath(ret);
              workerComp.setState('walking');
              state.phase = 'to_idle';
            } else {
              state.phase = 'idle_left';
              workerComp.setState('idle');
            }
          }
          continue;
        }

        if (state.phase === 'to_entrance') {
          if (timer >= startDraw) {
            state.phase = 'drawing';
            workerComp.pickUpResource('water', 'overhead');
            workerComp.visualActivity = 'production_well';
            workerComp.setState('working');
          } else {
            state.phase = 'waiting_at_well';
            workerComp.setState('idle');
            workerComp.visualActivity = 'general';
          }
          continue;
        }

        if (state.phase === 'waiting_at_well') {
          const onWork =
            Math.floor(workerPos.x) === state.workTile.x && Math.floor(workerPos.y) === state.workTile.y;
          if (!onWork) {
            const wpath = pathToWork();
            if (wpath.length > 0 && movable) {
              movable.speed = speed;
              movable.setPath(wpath);
              workerComp.setState('walking');
            }
            continue;
          }
          if (timer >= startDraw) {
            state.phase = 'drawing';
            workerComp.pickUpResource('water', 'overhead');
            workerComp.visualActivity = 'production_well';
            workerComp.setState('working');
          }
          continue;
        }

        if (state.phase === 'drawing') {
          continue;
        }

        if (state.phase === 'idle_left') {
          const onIdle =
            Math.floor(workerPos.x) === state.idleTile.x && Math.floor(workerPos.y) === state.idleTile.y;
          if (!onIdle) {
            const ret = pathToIdle();
            if (ret.length > 0 && movable) {
              movable.speed = speed;
              movable.setPath(ret);
              workerComp.setState('walking');
            }
            continue;
          }
          if (timer >= startWalk && timer < prodTime) {
            const wpath = pathToWork();
            if (wpath.length > 0 && movable) {
              movable.speed = speed;
              movable.setPath(wpath);
              workerComp.setState('walking');
              state.phase = 'to_entrance';
            }
          }
        }

        continue;
      }

      if (state.kind === 'plant_tree') {
        const plant = state;
        const movable = workerEntity.getComponent(Movable);
        const workerComp = workerEntity.getComponent(Worker);
        const workerPos = workerEntity.getComponent(Position);
        if (!movable || !workerComp || !workerPos) continue;

        const buildingEntity = entities.find(e => e.id === plant.buildingEntityId && e.active);
        const building = buildingEntity?.getComponent(Building);
        const production = buildingEntity?.getComponent(Production);
        const buildingDef = building ? dataManager.getBuilding(building.buildingType) : undefined;
        const animCfg = buildingDef?.animation;

        if (
          !buildingEntity ||
          !building ||
          !production ||
          !buildingDef ||
          animCfg?.type !== 'plant_tree'
        ) {
          this.world.removeEntity(workerEntity);
          this.cleanupAnimationWorker(workerId, plant);
          continue;
        }

        if (production.status !== 'producing') {
          this.world.removeEntity(workerEntity);
          this.cleanupAnimationWorker(workerId, plant);
          continue;
        }

        const speed = animCfg.workerSpeed;
        const nowMs = Date.now();

        if (plant.phase === 'to_site') {
          if (movable.isMoving) continue;
          plant.phase = 'digging';
          plant.digUntilMs = nowMs + animCfg.digAtSiteSec * 1000;
          workerComp.pickUpResource((buildingDef.requiredTool as string) || 'shovel');
          workerComp.visualActivity = 'production_plant';
          workerComp.setState('working');
          continue;
        }

        if (plant.phase === 'digging') {
          if (nowMs < plant.digUntilMs) continue;
          if (!plant.planted) {
            const t = tileMap.getTile(plant.plantTile.x, plant.plantTile.y);
            if (t && t.terrain === 'grass' && !t.hasRoad && !t.isOccupied()) {
              tileMap.setTerrain(plant.plantTile.x, plant.plantTile.y, 'tree');
              render.updateMinimapTiles([{ x: plant.plantTile.x, y: plant.plantTile.y }]);
            }
            plant.planted = true;
            const ret = pathFinder.findOffRoadPath(
              new Position(Math.floor(workerPos.x), Math.floor(workerPos.y)),
              new Position(plant.entranceTile.x, plant.entranceTile.y),
              tileMap
            );
            if (ret.length > 0) {
              movable.speed = speed;
              movable.setPath(ret);
              workerComp.setState('walking');
              workerComp.visualActivity = 'general';
              plant.phase = 'returning';
            } else {
              this.world.removeEntity(workerEntity);
              this.cleanupAnimationWorker(workerId, plant);
            }
          }
          continue;
        }

        if (plant.phase === 'returning') {
          if (movable.isMoving) continue;
          this.world.removeEntity(workerEntity);
          this.cleanupAnimationWorker(workerId, plant);
        }
        continue;
      }

      const gather = state;
      const movable = workerEntity.getComponent(Movable);
      if (!movable || movable.isMoving) continue;

      const workerComp = workerEntity.getComponent(Worker);
      const workerPos = workerEntity.getComponent(Position);
      if (!workerComp || !workerPos) continue;

      const buildingEntity = entities.find(e => e.id === gather.buildingEntityId && e.active);

      switch (gather.phase) {
        case 'to_target': {
          gather.phase = 'chopping';
          workerComp.setState('working');
          break;
        }
        case 'chopping': {
          if (!buildingEntity) {
            this.world.removeEntity(workerEntity);
            this.cleanupAnimationWorker(workerId, gather);
            continue;
          }

          const production = buildingEntity.getComponent(Production);
          if (production && production.getProgress() >= 0.9 && !gather.terrainModified) {
            const bldg = buildingEntity.getComponent(Building);
            const buildingDef = bldg ? dataManager.getBuilding(bldg.buildingType) : null;
            const anim = buildingDef?.animation;
            if (anim && anim.type === 'gather') {
              const tile = tileMap.getTile(gather.targetTile.x, gather.targetTile.y);
              if (tile) {
                const newTerrain = anim.terrainTransition[tile.terrain];
                if (newTerrain) {
                  tileMap.setTerrain(gather.targetTile.x, gather.targetTile.y, newTerrain as never);
                  render.updateMinimapTiles([{ x: gather.targetTile.x, y: gather.targetTile.y }]);
                }
              }
            }
            gather.terrainModified = true;
            workerComp.pickUpResource('wood_log', 'overhead');
            workerComp.setState('carrying');

            const gAnim = buildingDef?.animation;
            const spd = gAnim?.type === 'gather' ? gAnim.workerSpeed : 1.2;
            const returnPath = pathFinder.findOffRoadPath(
              new Position(Math.floor(workerPos.x), Math.floor(workerPos.y)),
              new Position(gather.entranceTile.x, gather.entranceTile.y),
              tileMap
            );
            if (returnPath.length > 0) {
              movable.speed = spd;
              movable.setPath(returnPath);
            }
            gather.phase = 'returning';
          } else {
            const tx = gather.targetTile.x;
            const ty = gather.targetTile.y;
            const cx = Math.floor(workerPos.x);
            const cy = Math.floor(workerPos.y);
            const dirs = [
              [-1, 0],
              [1, 0],
              [0, -1],
              [0, 1],
            ];
            const walkable = dirs
              .map(([dx, dy]) => ({ x: tx + dx, y: ty + dy }))
              .filter(p => {
                if (p.x === cx && p.y === cy) return false;
                const t = tileMap.getTile(p.x, p.y);
                return !!(t && t.walkable && !t.isOccupied());
              });
            if (walkable.length > 0) {
              const target = walkable[Math.floor(Math.random() * walkable.length)];
              movable.speed = 0.6;
              movable.setPath([new Position(target.x, target.y)]);
              workerComp.setState('working');
            }
          }
          break;
        }
        case 'returning': {
          this.world.removeEntity(workerEntity);
          if (buildingEntity) {
            const building = buildingEntity.getComponent(Building);
            if (building) building.animationWorkerId = null;
          }
          this.reservedTreeTiles.delete(`${gather.targetTile.x},${gather.targetTile.y}`);
          this.animationWorkers.delete(workerId);
          continue;
        }
      }
    }

    for (const entity of entities) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      const production = entity.getComponent(Production);
      if (!building || !production) continue;
      if (!building.isComplete() || !building.isActive) continue;
      if (building.animationWorkerId != null) continue;

      const buildingDef = dataManager.getBuilding(building.buildingType);
      if (!buildingDef?.animation) continue;

      if (buildingDef.animation.type === 'well_operator') {
        this.spawnWellOperator(entity);
        continue;
      }

      if (buildingDef.animation.type === 'plant_tree') {
        if (production.status !== 'producing') continue;
        this.spawnPlantTreeWorker(entity);
        continue;
      }

      if (production.status !== 'producing') continue;
      this.spawnGatherAnimationWorker(entity);
    }
  }

  returnBuilder(buildingEntity: Entity): void {
    const building = buildingEntity.getComponent(Building);
    if (!building || building.builderEntityId === null) return;

    const entities = [...this.world.getEntities()];
    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();

    const builderEntity = entities.find(e => e.id === building.builderEntityId && e.active);
    if (!builderEntity) {
      building.builderEntityId = null;
      return;
    }

    const bPos = builderEntity.getComponent(Position);
    if (!bPos) {
      this.world.removeEntity(builderEntity);
      building.builderEntityId = null;
      return;
    }

    const spawnTile = this.findBaseCampSpawnTile();
    if (!spawnTile) {
      this.world.removeEntity(builderEntity);
      building.builderEntityId = null;
      return;
    }

    const builderX = Math.floor(bPos.x);
    const builderY = Math.floor(bPos.y);
    const currentTile = tileMap.getTile(builderX, builderY);

    let prefixPath: Position[] = [];
    let pathStartX = builderX;
    let pathStartY = builderY;

    if (!currentTile || !currentTile.hasRoad) {
      const roadTile = this.findBuildingAdjacentRoadTile(buildingEntity);
      if (!roadTile) {
        this.world.removeEntity(builderEntity);
        building.builderEntityId = null;
        return;
      }

      const pos = buildingEntity.getComponent(Position);
      if (pos) {
        const bx = Math.floor(pos.x);
        const by = Math.floor(pos.y);
        const perimeterTiles = this.getBuildingPerimeterTiles(bx, by, building.width, building.height);
        prefixPath = this.findPerimeterPath(builderX, builderY, roadTile.x, roadTile.y, perimeterTiles);
      }

      if (prefixPath.length === 0) {
        prefixPath = [new Position(roadTile.x, roadTile.y)];
      }

      pathStartX = roadTile.x;
      pathStartY = roadTile.y;
    }

    const path = pathFinder.findPath(
      new Position(pathStartX, pathStartY),
      new Position(spawnTile.x, spawnTile.y),
      tileMap
    );

    if (path.length > 0) {
      const fullPath = [...prefixPath, ...path];
      const movable = builderEntity.getComponent(Movable);
      const worker = builderEntity.getComponent(Worker);
      if (movable && worker) {
        movable.speed = 1.8;
        movable.setPath(fullPath);
        worker.setState('walking');
        worker.visualActivity = 'general';
        worker.hammerConstructionEnabled = false;
        worker.buildIdleUntil = 0;
        this.returningBuilders.add(builderEntity.id);
      }
    } else {
      this.world.removeEntity(builderEntity);
    }

    building.builderEntityId = null;
  }

  /** Remove attached worker entities and clear registry entries when a building is destroyed. */
  detachWorkersForDestroyedBuilding(entity: Entity): void {
    const building = entity.getComponent(Building);
    if (!building) return;

    const entities = [...this.world.getEntities()];

    if (building.builderEntityId != null) {
      const builderEntity = entities.find(e => e.id === building.builderEntityId && e.active);
      if (builderEntity) this.world.removeEntity(builderEntity);
      this.builderWorkers.delete(building.builderEntityId);
      this.returningBuilders.delete(building.builderEntityId);
    }

    if (building.animationWorkerId != null) {
      const animWorker = entities.find(e => e.id === building.animationWorkerId && e.active);
      if (animWorker) this.world.removeEntity(animWorker);
      const animState = this.animationWorkers.get(building.animationWorkerId);
      if (animState) {
        if (animState.kind === 'gather') {
          this.reservedTreeTiles.delete(`${animState.targetTile.x},${animState.targetTile.y}`);
        } else if (animState.kind === 'plant_tree') {
          this.reservedTreeTiles.delete(`${animState.plantTile.x},${animState.plantTile.y}`);
        }
        this.animationWorkers.delete(building.animationWorkerId);
      }
    }

    for (const [workerId, buildingId] of this.toolWorkers) {
      if (buildingId === entity.id) {
        const workerEntity = entities.find(e => e.id === workerId && e.active);
        if (workerEntity) this.world.removeEntity(workerEntity);
        this.toolWorkers.delete(workerId);
        break;
      }
    }
  }

  spawnBuilderForPlacedBuilding(buildingEntity: Entity): void {
    this.spawnBuilder(buildingEntity);
  }

  /** HQ entrance road tile (or entrance cell); shared with construction dispatch and rescue. */
  getBaseCampSpawnTile(): { x: number; y: number } | null {
    return this.findBaseCampSpawnTile();
  }

  resetState(): void {
    this.returningWorkers.clear();
    this.builderWorkers.clear();
    this.returningBuilders.clear();
    this.toolWorkers.clear();
    this.animationWorkers.clear();
    this.reservedTreeTiles.clear();
  }

  private spawnSegmentWorker(segment: RoadSegment): number | null {
    if (this.world.getAvailablePeasantSlotCount() <= 0) {
      console.warn('No available population for road worker');
      return null;
    }

    const connectedRoads = this.world.getBaseCampConnectedRoads();
    const isConnected = segment.tiles.some(t => connectedRoads.has(`${t.x},${t.y}`));
    if (!isConnected) {
      return null;
    }

    const spawnTile = this.findBaseCampSpawnTile();
    const center = roadSegmentManager.getCenterTile(segment);
    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();

    const spawnX = spawnTile?.x ?? center.x;
    const spawnY = spawnTile?.y ?? center.y;

    const worker = createWorker(spawnX, spawnY);
    this.world.addEntity(worker);

    if (spawnTile && (spawnX !== center.x || spawnY !== center.y)) {
      const path = pathFinder.findPath(new Position(spawnX, spawnY), new Position(center.x, center.y), tileMap);
      if (path.length > 0) {
        const movable = worker.getComponent(Movable);
        const workerComp = worker.getComponent(Worker);
        if (movable && workerComp) {
          movable.setPath(path);
          workerComp.setState('walking');
        }
      }
    }

    console.log(`Road worker spawned for segment #${segment.id} at (${spawnX},${spawnY}) → center (${center.x},${center.y})`);
    return worker.id;
  }

  private freeSegmentWorker(workerId: number): void {
    const entities = [...this.world.getEntities()];
    const entity = entities.find(e => e.id === workerId && e.active);
    if (!entity) return;

    const workerComp = entity.getComponent(Worker);
    if (workerComp?.transportTask) {
      const task = workerComp.transportTask;
      if (workerComp.carryingResource) {
        const p = entity.getComponent(Position);
        if (p) {
          const dest = task.destEntityId ?? null;
          transportManager.addJunctionItem(Math.floor(p.x), Math.floor(p.y), workerComp.carryingResource, dest);
        }
        workerComp.carryingResource = undefined;
      } else if (task.phase === 'to_pickup' && task.sourceEntityId === null) {
        transportManager.addJunctionItem(task.pickupPos.x, task.pickupPos.y, task.resourceType, task.destEntityId);
      }
      workerComp.transportTask = null;
    }

    const pos = entity.getComponent(Position);
    if (!pos) {
      this.world.removeEntity(entity);
      return;
    }

    const spawnTile = this.findBaseCampSpawnTile();
    if (!spawnTile) {
      this.world.removeEntity(entity);
      return;
    }

    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();
    const path = pathFinder.findPath(
      new Position(Math.floor(pos.x), Math.floor(pos.y)),
      new Position(spawnTile.x, spawnTile.y),
      tileMap
    );

    if (path.length > 0) {
      const movable = entity.getComponent(Movable);
      const worker = entity.getComponent(Worker);
      if (movable && worker) {
        movable.setPath(path);
        worker.setState('walking');
        this.returningWorkers.add(workerId);
        return;
      }
    }

    this.world.removeEntity(entity);
  }

  private moveSegmentWorker(workerId: number, segment: RoadSegment): void {
    const entities = [...this.world.getEntities()];
    const entity = entities.find(e => e.id === workerId && e.active);
    if (!entity) return;

    const pos = entity.getComponent(Position);
    if (!pos) return;

    const center = roadSegmentManager.getCenterTile(segment);
    if (Math.floor(pos.x) === center.x && Math.floor(pos.y) === center.y) return;

    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();
    const path = pathFinder.findPath(
      new Position(Math.floor(pos.x), Math.floor(pos.y)),
      new Position(center.x, center.y),
      tileMap
    );

    if (path.length > 0) {
      const movable = entity.getComponent(Movable);
      const workerComp = entity.getComponent(Worker);
      if (movable && workerComp) {
        movable.setPath(path);
        workerComp.setState('walking');
      }
    } else {
      pos.set(center.x, center.y);
    }
  }

  /**
   * Cardinal neighbor of `(ox, oy)` that is on the HQ road network (see `Game.hasBuildingConnectedRoad`).
   * Must match how we decide `building.isActive`, otherwise we pick a disconnected `hasRoad` fragment,
   * `findPath` returns empty, and tool/builder workers never spawn.
   */
  private findAdjacentNetworkRoadTile(
    ox: number,
    oy: number,
    tileMap: TileMap,
    connected: Set<string>
  ): { x: number; y: number } | null {
    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const;
    for (const [dx, dy] of dirs) {
      const tx = ox + dx;
      const ty = oy + dy;
      if (!connected.has(`${tx},${ty}`)) continue;
      const tile = tileMap.getTile(tx, ty);
      if (!tile || !tile.hasRoad || tile.isOccupied()) continue;
      return { x: tx, y: ty };
    }
    for (const [dx, dy] of dirs) {
      const tx = ox + dx;
      const ty = oy + dy;
      if (!connected.has(`${tx},${ty}`)) continue;
      const tile = tileMap.getTile(tx, ty);
      if (!tile || !tile.hasRoad) continue;
      return { x: tx, y: ty };
    }
    return null;
  }

  private findBaseCampSpawnTile(): { x: number; y: number } | null {
    const baseCampEntity = this.world.getBaseCampEntity();
    if (!baseCampEntity) return null;
    const pos = baseCampEntity.getComponent(Position);
    const building = baseCampEntity.getComponent(Building);
    if (!pos || !building) return null;

    const entrance = building.getEntranceOffset();
    if (!entrance) return null;

    const ex = pos.x + entrance.dx;
    const ey = pos.y + entrance.dy;
    const tileMap = this.world.getTileMap();
    const connected = this.world.getBaseCampConnectedRoads();

    const adjacent = this.findAdjacentNetworkRoadTile(ex, ey, tileMap, connected);
    if (adjacent) return adjacent;

    return { x: ex, y: ey };
  }

  private findBuildingAdjacentRoadTile(buildingEntity: Entity): { x: number; y: number } | null {
    const pos = buildingEntity.getComponent(Position);
    const building = buildingEntity.getComponent(Building);
    if (!pos || !building) return null;

    const tileMap = this.world.getTileMap();
    const connected = this.world.getBaseCampConnectedRoads();
    const entrance = building.getEntranceOffset();
    if (entrance) {
      const ex = pos.x + entrance.dx;
      const ey = pos.y + entrance.dy;
      const adjacent = this.findAdjacentNetworkRoadTile(ex, ey, tileMap, connected);
      if (adjacent) return adjacent;
      return { x: ex, y: ey };
    }

    return this.findAdjacentNetworkRoadTile(pos.x, pos.y, tileMap, connected);
  }

  private spawnBuilder(buildingEntity: Entity): void {
    const building = buildingEntity.getComponent(Building);
    if (!building || building.builderEntityId != null) return;
    if (this.world.getAvailablePeasantSlotCount() <= 0) return;

    const spawnTile = this.findBaseCampSpawnTile();
    if (!spawnTile) return;

    const targetTile = this.findBuildingAdjacentRoadTile(buildingEntity);
    if (!targetTile) return;

    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();
    const path = pathFinder.findPath(
      new Position(spawnTile.x, spawnTile.y),
      new Position(targetTile.x, targetTile.y),
      tileMap
    );
    if (path.length === 0) return;

    const builder = createWorker(spawnTile.x, spawnTile.y);
    this.world.addEntity(builder);

    const workerComp = builder.getComponent(Worker);
    if (workerComp) {
      workerComp.pickUpResource('hammer');
      workerComp.visualActivity = 'construct';
      workerComp.hammerConstructionEnabled = false;
      workerComp.buildIdleUntil = 0;
    }

    building.builderEntityId = builder.id;
    this.builderWorkers.set(builder.id, buildingEntity.id);

    const movable = builder.getComponent(Movable);
    if (movable && workerComp) {
      movable.setPath(path);
      workerComp.setState('walking');
    }
  }

  private spawnToolWorker(buildingEntity: Entity, tool: string): void {
    if (this.world.getAvailablePeasantSlotCount() <= 0) return;

    const spawnTile = this.findBaseCampSpawnTile();
    if (!spawnTile) return;

    const targetTile = this.findBuildingAdjacentRoadTile(buildingEntity);
    if (!targetTile) return;

    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();
    const path = pathFinder.findPath(
      new Position(spawnTile.x, spawnTile.y),
      new Position(targetTile.x, targetTile.y),
      tileMap
    );
    if (path.length === 0) return;

    const worker = createWorker(spawnTile.x, spawnTile.y);
    this.world.addEntity(worker);

    const workerComp = worker.getComponent(Worker);
    if (workerComp) {
      workerComp.pickUpResource(tool);
      workerComp.visualActivity = 'deliver_tool';
    }

    this.toolWorkers.set(worker.id, buildingEntity.id);

    const movable = worker.getComponent(Movable);
    if (movable && workerComp) {
      movable.setPath(path);
      workerComp.setState('walking');
    }
  }

  private computeWellOperatorTiles(
    buildingEntity: Entity
  ): { idle: { x: number; y: number }; work: { x: number; y: number } } | null {
    const pos = buildingEntity.getComponent(Position);
    const building = buildingEntity.getComponent(Building);
    if (!pos || !building || building.width !== 1 || building.height !== 1) return null;

    const bx = pos.x;
    const by = pos.y;
    const tileMap = this.world.getTileMap();
    const okTile = (x: number, y: number): boolean => {
      const t = tileMap.getTile(x, y);
      return !!(t && t.walkable && !t.isOccupied());
    };

    let idleTile: { x: number; y: number } | null = null;
    if (okTile(bx - 1, by)) {
      idleTile = { x: bx - 1, y: by };
    } else {
      const order: [number, number][] = [
        [1, 0],
        [0, 1],
        [0, -1],
        [-1, 0],
      ];
      for (const [dx, dy] of order) {
        const x = bx + dx;
        const y = by + dy;
        if (okTile(x, y)) {
          idleTile = { x, y };
          break;
        }
      }
    }
    if (!idleTile) return null;

    const preferWork: [number, number][] = [
      [0, 1],
      [1, 0],
      [-1, 0],
      [0, -1],
    ];
    let workTile: { x: number; y: number } | null = null;
    for (const [dx, dy] of preferWork) {
      const x = bx + dx;
      const y = by + dy;
      if ((x === idleTile.x && y === idleTile.y) || !okTile(x, y)) continue;
      workTile = { x, y };
      break;
    }
    if (!workTile) return null;

    return { idle: idleTile, work: workTile };
  }

  private spawnWellOperator(buildingEntity: Entity): void {
    const building = buildingEntity.getComponent(Building);
    const pos = buildingEntity.getComponent(Position);
    const production = buildingEntity.getComponent(Production);
    if (!building || !pos || !production) return;
    if (building.animationWorkerId != null) return;
    if (this.world.getAvailablePeasantSlotCount() <= 0) return;

    const buildingDef = dataManager.getBuilding(building.buildingType);
    if (buildingDef?.animation?.type !== 'well_operator') return;

    const tiles = this.computeWellOperatorTiles(buildingEntity);
    if (!tiles) return;

    const spawnTile = this.findBaseCampSpawnTile();
    if (!spawnTile) return;

    const roadNearWell = this.findBuildingAdjacentRoadTile(buildingEntity);
    if (!roadNearWell) return;

    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();
    const path = pathFinder.findPath(
      new Position(spawnTile.x, spawnTile.y),
      new Position(roadNearWell.x, roadNearWell.y),
      tileMap
    );
    if (path.length === 0) return;

    const anim = buildingDef.animation;
    const speed = anim.type === 'well_operator' ? anim.workerSpeed : 1.2;

    const worker = createWorker(spawnTile.x, spawnTile.y);
    this.world.addEntity(worker);

    const workerComp = worker.getComponent(Worker);
    const movable = worker.getComponent(Movable);
    if (workerComp) {
      workerComp.visualActivity = 'general';
      workerComp.setState('walking');
    }
    if (movable) {
      movable.speed = speed;
      movable.setPath(path);
    }

    building.animationWorkerId = worker.id;
    this.animationWorkers.set(worker.id, {
      kind: 'well_operator',
      buildingEntityId: buildingEntity.id,
      phase: 'idle_left',
      idleTile: tiles.idle,
      workTile: tiles.work,
      lastProductionTimer: production.timer,
    });
  }

  private spawnGatherAnimationWorker(buildingEntity: Entity): void {
    const building = buildingEntity.getComponent(Building);
    const pos = buildingEntity.getComponent(Position);
    if (!building || !pos) return;
    if (building.animationWorkerId != null) return;
    if (this.world.getAvailablePeasantSlotCount() <= 0) return;

    const buildingDef = dataManager.getBuilding(building.buildingType);
    if (!buildingDef?.animation || buildingDef.animation.type !== 'gather') return;
    const anim = buildingDef.animation;

    const entrance = building.getEntranceOffset();
    const entranceX = entrance ? pos.x + entrance.dx : pos.x;
    const entranceY = entrance ? pos.y + entrance.dy : pos.y;

    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();

    const treeTile = tileMap.findNearbyTerrain(
      entranceX,
      entranceY,
      anim.searchRadius,
      anim.targetTerrain,
      this.reservedTreeTiles
    );
    if (!treeTile) return;

    const path = pathFinder.findOffRoadPath(
      new Position(entranceX, entranceY),
      new Position(treeTile.x, treeTile.y),
      tileMap
    );
    if (path.length === 0) return;

    this.reservedTreeTiles.add(`${treeTile.x},${treeTile.y}`);

    const worker = createWorker(entranceX, entranceY);
    this.world.addEntity(worker);

    const workerComp = worker.getComponent(Worker);
    if (workerComp) {
      workerComp.pickUpResource((buildingDef.requiredTool as string) || 'axe');
      workerComp.visualActivity = 'production_gather';
    }

    const movable = worker.getComponent(Movable);
    if (movable) {
      movable.speed = anim.workerSpeed;
      movable.setPath(path);
      if (workerComp) workerComp.setState('walking');
    }

    building.animationWorkerId = worker.id;
    this.animationWorkers.set(worker.id, {
      kind: 'gather',
      buildingEntityId: buildingEntity.id,
      phase: 'to_target',
      targetTile: treeTile,
      terrainModified: false,
      entranceTile: { x: entranceX, y: entranceY },
    });
  }

  /**
   * Tile next to `plantTile` the worker can stand on while digging, with a path from the building entrance.
   */
  private findForesterWorkTileAdjacentToPlant(
    entranceX: number,
    entranceY: number,
    plantX: number,
    plantY: number,
    tileMap: TileMap,
    pathFinder: PathFinder
  ): { x: number; y: number } | null {
    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const;
    const candidates: { x: number; y: number; d: number }[] = [];
    for (const [dx, dy] of dirs) {
      const wx = plantX + dx;
      const wy = plantY + dy;
      const tile = tileMap.getTile(wx, wy);
      if (!tile || !tile.walkable || tile.isOccupied()) continue;
      const d = Math.abs(wx - entranceX) + Math.abs(wy - entranceY);
      candidates.push({ x: wx, y: wy, d });
    }
    candidates.sort((a, b) => a.d - b.d);
    for (const c of candidates) {
      const path = pathFinder.findOffRoadPath(
        new Position(entranceX, entranceY),
        new Position(c.x, c.y),
        tileMap
      );
      if (path.length > 0) return { x: c.x, y: c.y };
    }
    return null;
  }

  private spawnPlantTreeWorker(buildingEntity: Entity): void {
    const building = buildingEntity.getComponent(Building);
    const pos = buildingEntity.getComponent(Position);
    const production = buildingEntity.getComponent(Production);
    if (!building || !pos || !production) return;
    if (building.animationWorkerId != null) return;
    if (this.world.getAvailablePeasantSlotCount() <= 0) return;

    const buildingDef = dataManager.getBuilding(building.buildingType);
    const anim = buildingDef?.animation;
    if (!anim || anim.type !== 'plant_tree') return;
    if (production.status !== 'producing') return;

    const prodTime = production.productionTime;
    const departBuffer = anim.walkLeadSec + anim.digAtSiteSec;
    if (production.timer < prodTime - departBuffer) return;

    const entrance = building.getEntranceOffset();
    const entranceX = entrance ? pos.x + entrance.dx : pos.x;
    const entranceY = entrance ? pos.y + entrance.dy : pos.y;

    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();

    const exclude = new Set(this.reservedTreeTiles);
    for (let dy = 0; dy < building.height; dy++) {
      for (let dx = 0; dx < building.width; dx++) {
        exclude.add(`${pos.x + dx},${pos.y + dy}`);
      }
    }

    const plantSpot = tileMap.findNearbyTerrain(
      entranceX,
      entranceY,
      anim.searchRadius,
      ['grass'],
      exclude
    );
    if (!plantSpot) return;

    const workTile = this.findForesterWorkTileAdjacentToPlant(
      entranceX,
      entranceY,
      plantSpot.x,
      plantSpot.y,
      tileMap,
      pathFinder
    );
    if (!workTile) return;

    const path = pathFinder.findOffRoadPath(
      new Position(entranceX, entranceY),
      new Position(workTile.x, workTile.y),
      tileMap
    );
    if (path.length === 0) return;

    this.reservedTreeTiles.add(`${plantSpot.x},${plantSpot.y}`);

    const worker = createWorker(entranceX, entranceY);
    this.world.addEntity(worker);

    const workerComp = worker.getComponent(Worker);
    const movable = worker.getComponent(Movable);
    if (workerComp && movable) {
      workerComp.pickUpResource((buildingDef.requiredTool as string) || 'shovel');
      workerComp.visualActivity = 'general';
      workerComp.setState('walking');
      movable.speed = anim.workerSpeed;
      movable.setPath(path);
    }

    building.animationWorkerId = worker.id;
    this.animationWorkers.set(worker.id, {
      kind: 'plant_tree',
      buildingEntityId: buildingEntity.id,
      phase: 'to_site',
      plantTile: { x: plantSpot.x, y: plantSpot.y },
      workTile,
      entranceTile: { x: entranceX, y: entranceY },
      digUntilMs: 0,
      planted: false,
    });
  }

  private cleanupAnimationWorker(workerId: number, state: AnimationWorkerState): void {
    if (state.kind === 'gather') {
      this.reservedTreeTiles.delete(`${state.targetTile.x},${state.targetTile.y}`);
    }
    if (state.kind === 'plant_tree') {
      this.reservedTreeTiles.delete(`${state.plantTile.x},${state.plantTile.y}`);
    }
    this.animationWorkers.delete(workerId);
    const entities = [...this.world.getEntities()];
    const buildingEntity = entities.find(e => e.id === state.buildingEntityId && e.active);
    if (buildingEntity) {
      const building = buildingEntity.getComponent(Building);
      if (building) building.animationWorkerId = null;
    }
  }

  private getBuildingPerimeterTiles(bx: number, by: number, w: number, h: number): { x: number; y: number }[] {
    const tiles: { x: number; y: number }[] = [];
    const tileMap = this.world.getTileMap();
    for (let x = bx - 1; x <= bx + w; x++) {
      for (let y = by - 1; y <= by + h; y++) {
        if (x >= bx && x < bx + w && y >= by && y < by + h) continue;
        const tile = tileMap.getTile(x, y);
        if (tile && tile.isWalkable()) {
          tiles.push({ x, y });
        }
      }
    }
    return tiles;
  }

  private getBuildingBottomFacePerimeterTiles(
    bx: number,
    by: number,
    w: number,
    h: number
  ): { x: number; y: number }[] {
    const all = this.getBuildingPerimeterTiles(bx, by, w, h);
    const base = all.filter(t => {
      for (let ix = bx; ix < bx + w; ix++) {
        for (let iy = by; iy < by + h; iy++) {
          if (Math.abs(t.x - ix) + Math.abs(t.y - iy) !== 1) continue;
          const southFace = iy === by + h - 1 && t.y === by + h && t.x === ix;
          const eastFace = ix === bx + w - 1 && t.x === bx + w && t.y === iy;
          if (southFace || eastFace) return true;
        }
      }
      return false;
    });
    const hook = all.find(t => t.x === bx + w && t.y === by + h);
    if (hook && !base.some(t => t.x === hook.x && t.y === hook.y)) {
      return [...base, hook];
    }
    return base;
  }

  private findPerimeterPath(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    perimeterTiles: { x: number; y: number }[]
  ): Position[] {
    const key = (x: number, y: number) => `${x},${y}`;
    const tileSet = new Set(perimeterTiles.map(t => key(t.x, t.y)));
    tileSet.add(key(endX, endY));

    const visited = new Set<string>();
    const queue: { x: number; y: number; path: Position[] }[] = [{ x: startX, y: startY, path: [] }];
    visited.add(key(startX, startY));

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.x === endX && current.y === endY) {
        return current.path;
      }

      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const nx = current.x + dx;
        const ny = current.y + dy;
        const nk = key(nx, ny);
        if (!visited.has(nk) && tileSet.has(nk)) {
          visited.add(nk);
          queue.push({ x: nx, y: ny, path: [...current.path, new Position(nx, ny)] });
        }
      }
    }

    return [];
  }
}
