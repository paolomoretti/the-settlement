/**
 * All non–road-segment-transport worker state and logic: HQ-spawned road workers,
 * builders, tool delivery, returning legs, and building production animation actors.
 * Game keeps transport relay + economy orchestration; this module keeps worker maps consistent.
 *
 * Camp-first spawn rules: `.claude/WORKER_SPAWN.md`.
 * Staffing modes (interior vs custom site animation, `operatorRole`): `.claude/BUILDING_WORKERS.md`.
 */

import { Entity } from '@/core/Entity';
import { eventBus } from '@/core/EventBus';
import { TileMap } from '@/map/TileMap';
import { pickRandomReachableWaterFishTarget } from '@/map/fisherFishProbe';
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
import { getSimulationNowMs } from '@/core/simulationClock';
import { applyProductionCycleOutputs } from '@/systems/ProductionSystem';
import { getEntityFaction, isPlayerOwned, setEntityFaction } from '@/components/ownerUtils';
import type { ResourceType, BuildingDefinition, AnimationConfig, BuildingType } from '@/types/GameData';
import type { WildlifeCoordinator } from '@/wildlife/WildlifeCoordinator';

const HQ_STREET_DISPATCH_SPACING_MS = 500;

type PendingHqStreetEntry = {
  entity: Entity;
  path: Position[];
  speed?: number;
  onRelease?: () => void;
  releaseAt: number;
};

/** Same facing convention as `RenderSystem.renderWorkerSprite` for movement vectors. */
function gridFacingTowardWater(dx: number, dy: number): number {
  if (dx > 0 && dy >= 0) return 0;
  if (dx <= 0 && dy > 0) return 1;
  if (dx < 0 && dy <= 0) return 2;
  return 3;
}

type GatherAnimState = {
  kind: 'gather';
  buildingEntityId: number;
  phase: 'to_target' | 'chopping' | 'returning';
  /** Work tile (tree / rock / mine foot); for fisher this is the **stand** tile on land. */
  targetTile: { x: number; y: number };
  /** Fisher only: water cell being fished (depletion / tooltips). */
  fisherWaterTile?: { x: number; y: number };
  terrainModified: boolean;
  entranceTile: { x: number; y: number };
  rockGather: boolean;
  waterGather: boolean;
  /** Underground mines: dig in front of entrance, no terrain harvest. */
  mineGather: boolean;
  /** Hunter: walk to a reserved wild rabbit, brief site action, return with ham. */
  wildHunt?: boolean;
  rabbitId?: number;
  digUntilMs?: number;
  /** Fisher: attempts to pick a non-empty water tile (handles races / depletion). */
  waterFishPickAttempts?: number;
};

type WellOperatorAnimState = {
  kind: 'well_operator';
  buildingEntityId: number;
  phase: 'idle_left' | 'to_entrance' | 'waiting_at_well' | 'drawing' | 'to_idle' | 'interior_inside';
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
  /** Higher priority construction sites receive builders first once materials are ready. */
  getConstructionPriority(entity: Entity): number;
  /** Wild rabbits for hunter gather + render hooks. */
  getWildlife(): WildlifeCoordinator;
  /** Reserve one tool specialist for dispatch (from HQ pool first, else consume peasant + tool resource). */
  claimToolSpecialistForDispatch(tool: string): boolean;
  /** Dispatch was cancelled; specialist returns to HQ ready pool. */
  returnToolSpecialistToHq(tool: string): void;
  /** A returning military specialist reached HQ and should be added to the persistent pool. */
  onMilitarySpecialistReturnedToHq(): void;
  /** A bred donkey reached HQ and should be added to the persistent transport pool. */
  onDonkeyReturnedToHq(): void;
  /** False for dormant computer villages; they should not spend per-frame work. */
  isEntitySimulationActive(entity: Entity): boolean;
}

export class GameWorkerRegistry {
  private readonly returningWorkers = new Set<number>();
  private readonly roadSegmentWorkers = new Set<number>();
  private readonly builderWorkers = new Map<number, number>();
  private readonly returningBuilders = new Set<number>();
  private readonly toolWorkers = new Map<number, { buildingId: number; tool: string }>();
  /** HQ-assembled soldier walking to a military building (`workerId` → `buildingEntityId`). */
  private readonly militaryDispatchWorkers = new Map<number, number>();
  private readonly animationWorkers = new Map<number, AnimationWorkerState>();
  private readonly reservedTreeTiles = new Set<string>();
  private readonly surveyorWorkers = new Set<number>();
  private readonly pendingHqStreetEntries: PendingHqStreetEntry[] = [];
  private nextHqStreetDispatchAtMs = 0;

  constructor(private readonly world: WorkerWorldAccess) {}

  /**
   * Effective map-worker animation for a building: explicit `animation` in JSON, or a synthesized
   * `interior_operator` when the building is staffed (`population.requires`) and has timed `production`
   * but no custom animation block (see `.claude/BUILDING_WORKERS.md`).
   */
  resolveStaffingAnimation(buildingDef: BuildingDefinition): AnimationConfig | null {
    if (buildingDef.animation) {
      if (buildingDef.requiredTool && buildingDef.animation.type === 'interior_operator') {
        return null;
      }
      return buildingDef.animation;
    }
    const req = buildingDef.population?.requires ?? 0;
    const prodTime = buildingDef.production?.productionTime;
    if (req < 1 || prodTime == null || prodTime <= 0) {
      return null;
    }
    // Tool-required buildings are staffed by their delivered tool specialist; do not add
    // a second visual indoor operator.
    if (buildingDef.requiredTool) {
      return null;
    }
    /** Outdoor / field jobs: keep no map worker until a bespoke `gather` (or similar) exists. */
    const deferInteriorUntilCustomAnimation = new Set<string>(['farm', 'pig_farm']);
    if (deferInteriorUntilCustomAnimation.has(buildingDef.id)) {
      return null;
    }
    const drawingPhaseSec = Math.min(18, Math.max(5, Math.floor(prodTime * 0.22)));
    const walkLeadSec = Math.min(8, Math.max(3, Math.floor(prodTime * 0.12)));
    return {
      type: 'interior_operator',
      operatorRole: buildingDef.id,
      workerSpeed: 1.2,
      drawingPhaseSec,
      walkLeadSec,
    };
  }

  getReservedPopulationCount(): number {
    return (
      this.countPlayerWorkerIds(this.returningWorkers) +
      this.countPlayerWorkerIds(this.builderWorkers.keys()) +
      this.countPlayerWorkerIds(this.returningBuilders) +
      this.countPlayerWorkerIds(this.toolWorkers.keys()) +
      this.countPlayerWorkerIds(this.militaryDispatchWorkers.keys()) +
      this.countPlayerWorkerIds(this.animationWorkers.keys()) +
      this.countPlayerWorkerIds(this.surveyorWorkers)
    );
  }

  getPlayerRoadSegmentWorkerCount(): number {
    return this.countPlayerWorkerIds(this.roadSegmentWorkers);
  }

  private countPlayerWorkerIds(workerIds: Iterable<number>): number {
    const entities = this.world.getEntities();
    let count = 0;
    for (const workerId of workerIds) {
      const entity = entities.find(e => e.id === workerId && e.active);
      if (entity && isPlayerOwned(entity)) count++;
    }
    return count;
  }

  beginMilitaryDispatch(workerEntityId: number, targetBuildingEntityId: number): void {
    this.militaryDispatchWorkers.set(workerEntityId, targetBuildingEntityId);
  }

  /** How many soldiers are currently walking from HQ to this fort (not yet slotted). */
  countMilitaryDispatchToBuilding(buildingEntityId: number): number {
    let n = 0;
    for (const [, bid] of this.militaryDispatchWorkers) {
      if (bid === buildingEntityId) n++;
    }
    return n;
  }

  /** Soldiers currently walking from HQ to any military post. */
  getMilitaryDispatchCount(): number {
    return this.militaryDispatchWorkers.size;
  }

  /** In-transit required-tool specialists per tool id. */
  getToolDispatchCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    const entities = this.world.getEntities();
    for (const [workerId, { tool }] of this.toolWorkers) {
      const entity = entities.find(e => e.id === workerId && e.active);
      if (!entity || !isPlayerOwned(entity)) continue;
      counts[tool] = (counts[tool] || 0) + 1;
    }
    return counts;
  }

  attachSurveyorWorker(workerEntityId: number): void {
    this.surveyorWorkers.add(workerEntityId);
  }

  /**
   * Conceal a newly created HQ worker until their turn to step onto the road.
   * This keeps synchronous job reservation (road segments, builders, soldiers)
   * while preventing multiple workers from visibly spawning on the same tile.
   */
  queueHqStreetEntry(
    entity: Entity,
    path: Position[],
    options: { speed?: number; onRelease?: () => void } = {}
  ): void {
    const hqId = this.world.getBaseCampEntity()?.id ?? null;
    const worker = entity.getComponent(Worker);
    const movable = entity.getComponent(Movable);
    if (!worker || !movable || hqId == null) {
      options.onRelease?.();
      return;
    }

    worker.concealedInBuildingId = hqId;
    worker.setState('idle');
    movable.clearPath();

    const now = getSimulationNowMs();
    const releaseAt = Math.max(now, this.nextHqStreetDispatchAtMs);
    this.nextHqStreetDispatchAtMs = releaseAt + HQ_STREET_DISPATCH_SPACING_MS;
    this.pendingHqStreetEntries.push({
      entity,
      path: [...path],
      speed: options.speed,
      onRelease: options.onRelease,
      releaseAt,
    });
  }

  private processHqStreetEntries(): void {
    const now = getSimulationNowMs();
    for (let i = this.pendingHqStreetEntries.length - 1; i >= 0; i--) {
      const entry = this.pendingHqStreetEntries[i]!;
      if (now < entry.releaseAt) continue;
      this.pendingHqStreetEntries.splice(i, 1);

      if (!entry.entity.active) continue;
      const releaseWorker = entry.entity.getComponent(Worker);
      const releaseMovable = entry.entity.getComponent(Movable);
      if (!releaseWorker || !releaseMovable) continue;

      releaseWorker.concealedInBuildingId = null;
      if (typeof entry.speed === 'number') {
        releaseMovable.speed = entry.speed;
      }
      if (entry.path.length > 0) {
        releaseMovable.setPath(entry.path);
        releaseWorker.setState('walking');
      }
      entry.onRelease?.();
    }
  }

  detachSurveyorWorker(workerEntityId: number): void {
    this.surveyorWorkers.delete(workerEntityId);
  }

  isRoadWorkerReturning(workerEntityId: number): boolean {
    return this.returningWorkers.has(workerEntityId);
  }

  restoreRoadSegmentWorker(workerEntityId: number): void {
    this.roadSegmentWorkers.add(workerEntityId);
  }

  moveRoadSegmentWorkerToSegment(workerEntityId: number, segment: RoadSegment): void {
    this.roadSegmentWorkers.add(workerEntityId);
    this.moveSegmentWorker(workerEntityId, segment);
  }

  returnRoadSegmentWorkerToHq(workerEntity: Entity): boolean {
    this.roadSegmentWorkers.delete(workerEntity.id);
    const hq = this.world.getBaseCampEntity();
    if (!hq) return false;
    return this.sendWorkerBackToBaseCamp(workerEntity, hq);
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
        const offRoadPath = pathFinder.findOffRoadPath(
          new Position(Math.floor(pos.x), Math.floor(pos.y)),
          new Position(spawnTile.x, spawnTile.y),
          tileMap
        );
        if (offRoadPath.length > 0) {
          movable.setPath(offRoadPath);
          worker.setState('walking');
          worker.visualActivity = 'general';
          worker.dropResource();
        } else {
          this.world.removeEntity(entity);
          this.returningWorkers.delete(workerId);
        }
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
          const worker = entity.getComponent(Worker);
          if (worker?.returnToHqToolSpecialist) {
            this.world.returnToolSpecialistToHq(worker.returnToHqToolSpecialist);
            worker.returnToHqToolSpecialist = null;
          } else if (worker?.returnToHqAsDonkey) {
            this.world.onDonkeyReturnedToHq();
          } else if (worker?.returnToHqAsSpecialist && worker.role === 'military') {
            this.world.onMilitarySpecialistReturnedToHq();
          }
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
    this.processHqStreetEntries();
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
      const builderWorker = builderEntity.getComponent(Worker);
      if (builderWorker?.concealedInBuildingId != null) continue;
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

    const constructionSites = entities
      .filter(entity => {
        if (!entity.active) return false;
        const building = entity.getComponent(Building);
        return building?.state === 'awaiting_materials';
      })
      .sort((a, b) => {
        const delta = this.world.getConstructionPriority(b) - this.world.getConstructionPriority(a);
        return delta !== 0 ? delta : a.id - b.id;
      });

    for (const entity of constructionSites) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (!building || building.state !== 'awaiting_materials') continue;

      if (building.canStartConstruction()) {
        const builderEntityId = building.builderEntityId;
        const priority = this.world.getConstructionPriority(entity);
        const higherPriorityReadySite = constructionSites.some(other => {
          if (other.id === entity.id) return false;
          const otherBuilding = other.getComponent(Building);
          return Boolean(
            otherBuilding &&
            otherBuilding.state === 'awaiting_materials' &&
            otherBuilding.builderEntityId === null &&
            otherBuilding.isActive &&
            otherBuilding.areMaterialsDelivered() &&
            this.world.getConstructionPriority(other) > priority
          );
        });
        if (higherPriorityReadySite) {
          continue;
        }

        building.beginConstruction(getSimulationNowMs());
        if (builderEntityId != null) {
          const builderEntity = entities.find(e => e.id === builderEntityId && e.active);
          const w = builderEntity?.getComponent(Worker);
          if (w) {
            w.hammerConstructionEnabled = true;
            w.setState('working');
            w.buildIdleUntil = getSimulationNowMs() + 1200 + Math.random() * 800;
          }
        }
        continue;
      }

      if (building.builderEntityId === null && building.isActive && building.areMaterialsDelivered()) {
        if (!this.tryReassignBuilderToSite(entity, constructionSites)) {
          this.spawnBuilder(entity);
        }
      }
    }

    for (const [workerId, buildingId] of this.militaryDispatchWorkers) {
      const workerEntity = entities.find(e => e.id === workerId && e.active);
      if (!workerEntity) {
        this.militaryDispatchWorkers.delete(workerId);
        continue;
      }

      const movable = workerEntity.getComponent(Movable);
      const militaryWorker = workerEntity.getComponent(Worker);
      if (militaryWorker?.concealedInBuildingId != null) continue;
      if (movable && !movable.isMoving) {
        const buildingEntity = entities.find(e => e.id === buildingId && e.active);
        if (!buildingEntity) {
          this.world.removeEntity(workerEntity);
          this.militaryDispatchWorkers.delete(workerId);
          continue;
        }

        const targetTile = this.findBuildingAdjacentRoadTile(buildingEntity);
        const workerPos = workerEntity.getComponent(Position);
        if (!workerPos) {
          this.militaryDispatchWorkers.delete(workerId);
          continue;
        }

        const gx = Math.floor(workerPos.x + 1e-6);
        const gy = Math.floor(workerPos.y + 1e-6);
        const onGoalTile =
          targetTile && workerPos && gx === targetTile.x && gy === targetTile.y;

        if (onGoalTile) {
          const building = buildingEntity.getComponent(Building);
          const workerComp = workerEntity.getComponent(Worker);
          const def = building ? dataManager.getBuilding(building.buildingType as BuildingType) : null;
          const cap = def?.military?.soldierCapacity;
          if (building && workerComp && typeof cap === 'number' && cap > 0) {
            building.initMilitaryGarrison(cap);
          }
          if (building && workerComp && building.militaryGarrison) {
            const idx = building.findFreeMilitarySlotIndex();
            if (idx >= 0) {
              building.assignMilitarySlot(idx, workerEntity.id);
              workerComp.concealedInBuildingId = buildingEntity.id;
              workerComp.setState('idle');
              workerComp.dropResource();
              workerPos.set(targetTile.x + 0.5, targetTile.y + 0.5);
              eventBus.emit('military:garrison_changed', { buildingEntityId: buildingEntity.id });
            } else {
              this.world.removeEntity(workerEntity);
            }
          } else {
            this.world.removeEntity(workerEntity);
          }
          this.militaryDispatchWorkers.delete(workerId);
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

    for (const [workerId, payload] of this.toolWorkers) {
      const { buildingId, tool } = payload;
      const workerEntity = entities.find(e => e.id === workerId && e.active);
      if (!workerEntity) {
        this.toolWorkers.delete(workerId);
        continue;
      }

      const movable = workerEntity.getComponent(Movable);
      const toolWorker = workerEntity.getComponent(Worker);
      if (toolWorker?.concealedInBuildingId != null) continue;
      if (movable && !movable.isMoving) {
        const buildingEntity = entities.find(e => e.id === buildingId && e.active);
        if (!buildingEntity) {
          this.world.removeEntity(workerEntity);
          this.world.returnToolSpecialistToHq(tool);
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
          if (building) {
            building.hasOperator = true;
            building.assignedToolSpecialist = tool;
          }
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
      if (!this.world.isEntitySimulationActive(entity)) continue;
      const building = entity.getComponent(Building);
      if (!building || !building.isComplete() || building.hasOperator) continue;
      if (!building.isActive) continue;

      let hasToolWorker = false;
      for (const { buildingId } of this.toolWorkers.values()) {
        if (buildingId === entity.id) {
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
      if (patrolWorker && patrolWorker.buildIdleUntil > getSimulationNowMs()) continue;

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
        if (workerComp.concealedInBuildingId != null) continue;

        const buildingEntity = entities.find(e => e.id === state.buildingEntityId && e.active);
        if (buildingEntity && !this.world.isEntitySimulationActive(buildingEntity)) {
          workerComp.concealedInBuildingId = null;
          this.world.removeEntity(workerEntity);
          this.cleanupAnimationWorker(workerId, state);
          continue;
        }
        const building = buildingEntity?.getComponent(Building);
        const production = buildingEntity?.getComponent(Production);
        const buildingDef = building ? dataManager.getBuilding(building.buildingType) : null;
        const animCfg = buildingDef ? this.resolveStaffingAnimation(buildingDef) : null;

        if (
          !buildingEntity ||
          !building ||
          !production ||
          (animCfg?.type !== 'well_operator' && animCfg?.type !== 'interior_operator')
        ) {
          workerComp.concealedInBuildingId = null;
          this.world.removeEntity(workerEntity);
          this.cleanupAnimationWorker(workerId, state);
          continue;
        }

        const speed = animCfg.workerSpeed;
        const drawingPhaseSec = animCfg.drawingPhaseSec;
        const walkLeadSec = animCfg.walkLeadSec ?? 5;
        const isInterior = animCfg.type === 'interior_operator';
        const carriedResource: ResourceType = 'water';
        const workVisual = 'production_well' as const;
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

        if (isInterior) {
          if (movable?.isMoving) continue;
          const onWork =
            Math.floor(workerPos.x) === state.workTile.x && Math.floor(workerPos.y) === state.workTile.y;
          if (!onWork) {
            const wpath = pathToWork();
            if (wpath.length > 0 && movable) {
              movable.speed = speed;
              movable.setPath(wpath);
              workerComp.setState('walking');
              state.phase = 'to_entrance';
            }
            continue;
          }
          state.phase = 'interior_inside';
          this.enterMillInterior(buildingEntity, workerComp, workerPos, movable);
          continue;
        }

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
          } else if (state.phase === 'interior_inside') {
            this.revealMillWorkerAtDoor(workerComp, workerPos, movable, state.workTile);
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
          if (
            state.phase === 'drawing' ||
            state.phase === 'to_entrance' ||
            state.phase === 'waiting_at_well' ||
            state.phase === 'interior_inside'
          ) {
            if (state.phase === 'drawing') {
              workerComp.dropResource();
            } else if (state.phase === 'interior_inside') {
              this.revealMillWorkerAtDoor(workerComp, workerPos, movable, state.workTile);
            }
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
          if (isInterior) {
            if (timer >= startDraw) {
              state.phase = 'interior_inside';
              this.enterMillInterior(buildingEntity, workerComp, workerPos, movable);
            } else {
              state.phase = 'waiting_at_well';
              workerComp.setState('idle');
              workerComp.visualActivity = 'general';
            }
          } else if (timer >= startDraw) {
            state.phase = 'drawing';
            workerComp.pickUpResource(carriedResource, 'overhead');
            workerComp.visualActivity = workVisual;
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
          if (isInterior) {
            if (timer >= startDraw) {
              state.phase = 'interior_inside';
              this.enterMillInterior(buildingEntity, workerComp, workerPos, movable);
            }
          } else if (timer >= startDraw) {
            state.phase = 'drawing';
            workerComp.pickUpResource(carriedResource, 'overhead');
            workerComp.visualActivity = workVisual;
            workerComp.setState('working');
          }
          continue;
        }

        if (state.phase === 'interior_inside') {
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
        if (buildingEntity && !this.world.isEntitySimulationActive(buildingEntity)) {
          this.world.removeEntity(workerEntity);
          this.cleanupAnimationWorker(workerId, plant);
          continue;
        }
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
        const nowMs = getSimulationNowMs();

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
      if (buildingEntity && !this.world.isEntitySimulationActive(buildingEntity)) {
        this.world.removeEntity(workerEntity);
        this.cleanupAnimationWorker(workerId, gather);
        continue;
      }

      switch (gather.phase) {
        case 'to_target': {
          gather.phase = 'chopping';
          workerComp.setState('working');
          if (gather.rockGather || gather.waterGather || gather.mineGather) {
            workerComp.visualActivity = 'production_gather';
          }
          if (gather.waterGather && gather.fisherWaterTile) {
            const dx = gather.fisherWaterTile.x - gather.targetTile.x;
            const dy = gather.fisherWaterTile.y - gather.targetTile.y;
            workerComp.idleFacing = gridFacingTowardWater(dx, dy);
            workerComp.fisherTowardWater = { dx, dy };
          }
          break;
        }
        case 'chopping': {
          if (!buildingEntity) {
            this.world.removeEntity(workerEntity);
            this.cleanupAnimationWorker(workerId, gather);
            continue;
          }

          if (gather.wildHunt) {
            const bldgH = buildingEntity.getComponent(Building);
            const bDefH = bldgH ? dataManager.getBuilding(bldgH.buildingType) : null;
            const animH = bDefH?.animation;
            if (!gather.terrainModified) {
              const nowMsH = getSimulationNowMs();
              if (gather.digUntilMs === undefined) {
                const digSec = animH?.type === 'gather' ? animH.digAtSiteSec ?? 2.5 : 2.5;
                gather.digUntilMs = nowMsH + digSec * 1000;
                workerComp.visualActivity = 'production_gather';
                workerComp.setState('working');
                break;
              }
              if (nowMsH < gather.digUntilMs) break;
              if (gather.rabbitId != null) {
                this.world.getWildlife().removeRabbitAfterSuccessfulHunt(gather.rabbitId);
              }
              gather.terrainModified = true;
              const carriedH =
                animH?.type === 'gather' && animH.carriedResource ? animH.carriedResource : 'ham';
              workerComp.pickUpResource(carriedH, 'overhead');
              delete workerComp.fisherTowardWater;
              workerComp.setState('carrying');
              workerComp.visualActivity = 'general';
              const spdH = animH?.type === 'gather' ? animH.workerSpeed : 1.1;
              const returnPathH = pathFinder.findOffRoadPath(
                new Position(Math.floor(workerPos.x), Math.floor(workerPos.y)),
                new Position(gather.entranceTile.x, gather.entranceTile.y),
                tileMap
              );
              if (returnPathH.length > 0) {
                movable.speed = spdH;
                movable.setPath(returnPathH);
                gather.phase = 'returning';
              } else {
                this.world.removeEntity(workerEntity);
                this.cleanupAnimationWorker(workerId, gather);
              }
            }
            break;
          }

          const bldg = buildingEntity.getComponent(Building);
          const bDef = bldg ? dataManager.getBuilding(bldg.buildingType) : null;
          const anim = bDef?.animation;

          if ((gather.rockGather || gather.waterGather || gather.mineGather) && anim?.type === 'gather') {
            const nowMs = getSimulationNowMs();
            if (gather.digUntilMs === undefined) {
              if (gather.waterGather && bldg && anim && bDef?.production) {
                const bPos = buildingEntity.getComponent(Position);
                if (bPos) {
                  const ft = gather.fisherWaterTile;
                  const rem = ft ? tileMap.getWaterFishRemainingAt(ft.x, ft.y) : 0;
                  if (rem <= 0) {
                    gather.waterFishPickAttempts = (gather.waterFishPickAttempts ?? 0) + 1;
                    if (gather.waterFishPickAttempts <= 4) {
                      this.reservedTreeTiles.delete(`${gather.targetTile.x},${gather.targetTile.y}`);
                      const gatherRadius =
                        bDef.production?.maxGatherRadius ?? anim.searchRadius ?? 7;
                      const maxWalkCells =
                        bDef.production?.maxGatherWalkCells ??
                        bDef.production?.maxGatherRadius ??
                        anim.searchRadius ??
                        gatherRadius;
                      const gatherExclude = new Set(this.reservedTreeTiles);
                      for (let dy = 0; dy < bldg.height; dy++) {
                        for (let dx = 0; dx < bldg.width; dx++) {
                          gatherExclude.add(`${bPos.x + dx},${bPos.y + dy}`);
                        }
                      }
                      gatherExclude.add(`${gather.targetTile.x},${gather.targetTile.y}`);
                      if (ft) gatherExclude.add(`${ft.x},${ft.y}`);
                      const pick = pickRandomReachableWaterFishTarget(
                        tileMap,
                        pathFinder,
                        gather.entranceTile.x,
                        gather.entranceTile.y,
                        gatherRadius,
                        maxWalkCells,
                        gatherExclude
                      );
                      if (pick) {
                        this.reservedTreeTiles.add(`${pick.standX},${pick.standY}`);
                        gather.targetTile = { x: pick.standX, y: pick.standY };
                        gather.fisherWaterTile = { x: pick.waterX, y: pick.waterY };
                        gather.waterFishPickAttempts = 0;
                        movable.setPath(pick.path);
                        gather.phase = 'to_target';
                        workerComp.setState('walking');
                        workerComp.visualActivity = 'general';
                        delete workerComp.fisherTowardWater;
                        break;
                      }
                    }
                    if (bldg) bldg.outOfMapResources = true;
                    this.world.removeEntity(workerEntity);
                    this.cleanupAnimationWorker(workerId, gather);
                    continue;
                  }
                }
              }
              const digSec = gather.waterGather ? 40 + Math.random() * 10 : anim.digAtSiteSec ?? 4;
              gather.digUntilMs = nowMs + digSec * 1000;
              workerComp.visualActivity = 'production_gather';
              workerComp.setState('working');
              break;
            }
            if (nowMs < gather.digUntilMs) break;

            if (!gather.terrainModified) {
              const productionRule = bDef?.production;
              const fishWx = gather.waterGather && gather.fisherWaterTile ? gather.fisherWaterTile.x : gather.targetTile.x;
              const fishWy = gather.waterGather && gather.fisherWaterTile ? gather.fisherWaterTile.y : gather.targetTile.y;
              const tile = tileMap.getTile(fishWx, fishWy);

              if (gather.mineGather) {
                const carried =
                  anim.carriedResource ??
                  (Object.keys(productionRule?.outputs ?? {}).find(
                    k => !dataManager.getResource(k as ResourceType)?.virtualOutput
                  ) as ResourceType | undefined) ??
                  'coal';
                gather.terrainModified = true;
                workerComp.pickUpResource(carried, 'overhead');
              } else if (gather.rockGather) {
                const stonesPer = productionRule?.stonesPerRockTile ?? 10;
                const carried =
                  anim.carriedResource ??
                  (Object.keys(productionRule?.outputs ?? {}).find(
                    k => !dataManager.getResource(k as ResourceType)?.virtualOutput
                  ) as ResourceType | undefined) ??
                  'stone';
                if (tile) {
                  let rem = tile.rockHarvestsRemaining ?? stonesPer;
                  rem--;
                  if (rem <= 0) {
                    const newTerrain = anim.terrainTransition[tile.terrain];
                    if (newTerrain) {
                      tileMap.setTerrain(gather.targetTile.x, gather.targetTile.y, newTerrain as never);
                      delete tile.rockHarvestsRemaining;
                      render.updateMinimapTiles([{ x: gather.targetTile.x, y: gather.targetTile.y }]);
                    }
                  } else {
                    tile.rockHarvestsRemaining = rem;
                  }
                }
                gather.terrainModified = true;
                workerComp.pickUpResource(carried, 'overhead');
              } else if (gather.waterGather) {
                const carried =
                  anim.carriedResource ??
                  (Object.keys(productionRule?.outputs ?? {}).find(
                    k => !dataManager.getResource(k as ResourceType)?.virtualOutput
                  ) as ResourceType | undefined) ??
                  'fish';
                let tookFish = false;
                if (tile && tile.terrain === 'water') {
                  tookFish = tileMap.takeOneWaterFishAt(fishWx, fishWy);
                  if (tookFish) {
                    render.updateMinimapTiles([{ x: fishWx, y: fishWy }]);
                  }
                }
                if (!tookFish) {
                  if (bldg) bldg.outOfMapResources = true;
                  this.world.removeEntity(workerEntity);
                  this.cleanupAnimationWorker(workerId, gather);
                  continue;
                }
                gather.terrainModified = true;
                workerComp.pickUpResource(carried, 'overhead');
              }

              delete workerComp.fisherTowardWater;
              workerComp.setState('carrying');
              workerComp.visualActivity = 'general';

              const spd = anim.workerSpeed;
              const returnPath = pathFinder.findOffRoadPath(
                new Position(Math.floor(workerPos.x), Math.floor(workerPos.y)),
                new Position(gather.entranceTile.x, gather.entranceTile.y),
                tileMap
              );
              if (returnPath.length > 0) {
                movable.speed = spd;
                movable.setPath(returnPath);
                gather.phase = 'returning';
              } else {
                this.world.removeEntity(workerEntity);
                this.cleanupAnimationWorker(workerId, gather);
              }
            }
            break;
          }

          const production = buildingEntity.getComponent(Production);
          if (production && production.getProgress() >= 0.9 && !gather.terrainModified) {
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

            const spd = anim?.type === 'gather' ? anim.workerSpeed : 1.2;
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
            if (gather.rockGather || gather.waterGather || gather.mineGather || gather.wildHunt) {
              const prod = buildingEntity.getComponent(Production);
              applyProductionCycleOutputs(buildingEntity, { suppressPickup: !isPlayerOwned(buildingEntity) });
              if (prod && prod.continuous) {
                prod.timer = 0;
              }
            }
          }
          if (!gather.wildHunt) {
            this.reservedTreeTiles.delete(`${gather.targetTile.x},${gather.targetTile.y}`);
          }
          this.animationWorkers.delete(workerId);
          continue;
        }
      }
    }

    for (const entity of entities) {
      if (!entity.active) continue;
      if (!this.world.isEntitySimulationActive(entity)) continue;
      const building = entity.getComponent(Building);
      const production = entity.getComponent(Production);
      if (!building || !production) continue;
      if (!building.isComplete() || !building.isActive) continue;
      if (building.animationWorkerId != null) continue;

      const buildingDef = dataManager.getBuilding(building.buildingType);
      if (!buildingDef) continue;
      const staffingAnim = this.resolveStaffingAnimation(buildingDef);
      if (!staffingAnim) continue;

      if (staffingAnim.type === 'well_operator' || staffingAnim.type === 'interior_operator') {
        this.spawnSiteOperator(entity);
        continue;
      }

      if (staffingAnim.type === 'plant_tree') {
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

  /** On military-building demolition, reveal garrisoned soldiers and send them back to HQ on roads. */
  returnMilitaryGarrisonWorkers(buildingEntity: Entity, workerEntityIds: number[]): void {
    if (workerEntityIds.length === 0) return;

    const entities = [...this.world.getEntities()];
    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();
    const spawnTile = this.findBaseCampSpawnTile();
    const roadTile = this.findBuildingAdjacentRoadTile(buildingEntity);

    if (!spawnTile || !roadTile) {
      for (const wid of workerEntityIds) {
        const entity = entities.find(e => e.id === wid && e.active);
        if (entity) this.world.removeEntity(entity);
      }
      return;
    }

    const roadPath = pathFinder.findPath(
      new Position(roadTile.x, roadTile.y),
      new Position(spawnTile.x, spawnTile.y),
      tileMap
    );
    const fallbackPath = pathFinder.findOffRoadPath(
      new Position(roadTile.x, roadTile.y),
      new Position(spawnTile.x, spawnTile.y),
      tileMap
    );

    for (const wid of workerEntityIds) {
      const entity = entities.find(e => e.id === wid && e.active);
      if (!entity) continue;

      const pos = entity.getComponent(Position);
      const movable = entity.getComponent(Movable);
      const worker = entity.getComponent(Worker);
      if (!pos || !movable || !worker) {
        this.world.removeEntity(entity);
        continue;
      }

      worker.concealedInBuildingId = null;
      worker.dropResource();
      worker.visualActivity = 'general';
      worker.setState('walking');
      worker.returnToHqAsSpecialist = true;
      pos.set(roadTile.x + 0.5, roadTile.y + 0.5);
      movable.speed = 1.8;
      const chosenPath =
        roadPath.length > 0
          ? roadPath
          : (fallbackPath.length > 0 ? fallbackPath : [new Position(spawnTile.x, spawnTile.y)]);
      movable.setPath(chosenPath);
      this.returningWorkers.add(wid);
    }
  }

  private sendWorkerBackToBaseCamp(workerEntity: Entity, sourceBuildingEntity: Entity, speed: number = 1.8): boolean {
    const spawnTile = this.findBaseCampSpawnTile();
    if (!spawnTile) return false;

    const pos = workerEntity.getComponent(Position);
    const movable = workerEntity.getComponent(Movable);
    const worker = workerEntity.getComponent(Worker);
    if (!pos || !movable || !worker) return false;

    if (worker.concealedInBuildingId != null) {
      const sourceRoad = this.findBuildingAdjacentRoadTile(sourceBuildingEntity);
      if (sourceRoad) pos.set(sourceRoad.x + 0.5, sourceRoad.y + 0.5);
    }

    worker.concealedInBuildingId = null;
    worker.visualActivity = 'general';
    worker.setState('walking');

    const start = new Position(Math.floor(pos.x), Math.floor(pos.y));
    const goal = new Position(spawnTile.x, spawnTile.y);
    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();
    const roadPath = pathFinder.findPath(start, goal, tileMap);
    const path = roadPath.length > 0 ? roadPath : pathFinder.findOffRoadPath(start, goal, tileMap);
    if (path.length === 0) return false;

    movable.speed = speed;
    movable.setPath(path);
    this.returningWorkers.add(workerEntity.id);
    return true;
  }

  sendLooseWorkerBackToBaseCamp(workerEntity: Entity, sourceBuildingEntity: Entity, speed: number = 1.8): boolean {
    return this.sendWorkerBackToBaseCamp(workerEntity, sourceBuildingEntity, speed);
  }

  returnAssignedToolSpecialistToHq(buildingEntity: Entity, tool: string): boolean {
    const roadTile = this.findBuildingAdjacentRoadTile(buildingEntity);
    const pos = buildingEntity.getComponent(Position);
    if (!roadTile && !pos) return false;

    const start = roadTile ?? { x: Math.floor(pos!.x), y: Math.floor(pos!.y) };
    const workerEntity = createWorker(start.x + 0.5, start.y + 0.5);
    setEntityFaction(workerEntity, getEntityFaction(buildingEntity));

    const worker = workerEntity.getComponent(Worker);
    if (worker) {
      worker.pickUpResource(tool);
      worker.visualActivity = 'deliver_tool';
      worker.returnToHqToolSpecialist = tool;
    }

    this.world.addEntity(workerEntity);
    if (this.sendWorkerBackToBaseCamp(workerEntity, buildingEntity)) {
      return true;
    }

    this.world.removeEntity(workerEntity);
    return false;
  }

  /** Remove attached worker entities and clear registry entries when a building is destroyed. */
  detachWorkersForDestroyedBuilding(entity: Entity, opts?: { retreatOwnerWorkers?: boolean }): void {
    const building = entity.getComponent(Building);
    if (!building) return;

    const entities = [...this.world.getEntities()];
    const retreatFaction = opts?.retreatOwnerWorkers || !isPlayerOwned(entity) ? getEntityFaction(entity) : null;

    if (building.builderEntityId != null) {
      const builderEntity = entities.find(e => e.id === building.builderEntityId && e.active);
      if (builderEntity) {
        if (retreatFaction) this.retreatWorkerToFactionHeadquarters(builderEntity, retreatFaction, entity);
        else this.world.removeEntity(builderEntity);
      }
      this.builderWorkers.delete(building.builderEntityId);
      this.returningBuilders.delete(building.builderEntityId);
    }

    if (building.animationWorkerId != null) {
      const animWorker = entities.find(e => e.id === building.animationWorkerId && e.active);
      if (animWorker) {
        if (retreatFaction) {
          this.retreatWorkerToFactionHeadquarters(animWorker, retreatFaction, entity);
        } else if (isPlayerOwned(entity)) {
          if (!this.sendWorkerBackToBaseCamp(animWorker, entity)) this.world.removeEntity(animWorker);
        } else {
          this.world.removeEntity(animWorker);
        }
      }
      const animState = this.animationWorkers.get(building.animationWorkerId);
      if (animState) {
        if (animState.kind === 'gather') {
          if (animState.wildHunt && animState.rabbitId != null) {
            this.world.getWildlife().releaseHuntReservation(animState.rabbitId);
          } else {
            this.reservedTreeTiles.delete(`${animState.targetTile.x},${animState.targetTile.y}`);
          }
        } else if (animState.kind === 'plant_tree') {
          this.reservedTreeTiles.delete(`${animState.plantTile.x},${animState.plantTile.y}`);
        }
        this.animationWorkers.delete(building.animationWorkerId);
      }
    }

    for (const [workerId, payload] of this.toolWorkers) {
      if (payload.buildingId === entity.id) {
        const workerEntity = entities.find(e => e.id === workerId && e.active);
        if (workerEntity) {
          if (retreatFaction) this.retreatWorkerToFactionHeadquarters(workerEntity, retreatFaction, entity);
          else this.world.removeEntity(workerEntity);
        }
        this.world.returnToolSpecialistToHq(payload.tool);
        this.toolWorkers.delete(workerId);
        break;
      }
    }

    for (const [workerId, buildingId] of this.militaryDispatchWorkers) {
      if (buildingId === entity.id) {
        const workerEntity = entities.find(e => e.id === workerId && e.active);
        if (workerEntity) {
          if (retreatFaction) this.retreatWorkerToFactionHeadquarters(workerEntity, retreatFaction, entity);
          else this.world.removeEntity(workerEntity);
        }
        this.militaryDispatchWorkers.delete(workerId);
      }
    }
  }

  private retreatWorkerToFactionHeadquarters(workerEntity: Entity, factionId: string, sourceBuildingEntity: Entity): void {
    const entities = [...this.world.getEntities()];
    const hq = entities.find(e => {
      if (!e.active || getEntityFaction(e) !== factionId) return false;
      return e.getComponent(Building)?.buildingType === 'base_camp';
    });
    if (!hq || hq.id === sourceBuildingEntity.id) {
      this.world.removeEntity(workerEntity);
      return;
    }

    const target = this.findBuildingAdjacentRoadTile(hq) ?? (() => {
      const hqPos = hq.getComponent(Position);
      const hqBuilding = hq.getComponent(Building);
      return hqPos && hqBuilding
        ? { x: hqPos.x + Math.floor(hqBuilding.width / 2), y: hqPos.y + Math.floor(hqBuilding.height / 2) }
        : null;
    })();
    if (!target) {
      this.world.removeEntity(workerEntity);
      return;
    }

    const worker = workerEntity.getComponent(Worker);
    const pos = workerEntity.getComponent(Position);
    const movable = workerEntity.getComponent(Movable);
    if (!worker || !pos || !movable) {
      this.world.removeEntity(workerEntity);
      return;
    }

    if (worker.concealedInBuildingId != null) {
      const sourceRoad = this.findBuildingAdjacentRoadTile(sourceBuildingEntity);
      if (sourceRoad) pos.set(sourceRoad.x, sourceRoad.y);
    }
    worker.concealedInBuildingId = null;
    worker.visualActivity = 'general';
    worker.dropResource();
    worker.setState('walking');

    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();
    const path = pathFinder.findOffRoadPath(
      new Position(Math.floor(pos.x), Math.floor(pos.y)),
      new Position(target.x, target.y),
      tileMap
    );
    if (path.length === 0) {
      this.world.removeEntity(workerEntity);
      return;
    }
    movable.speed = 1.4;
    movable.setPath(path);
  }

  spawnBuilderForPlacedBuilding(buildingEntity: Entity): void {
    this.spawnBuilder(buildingEntity);
  }

  /** HQ entrance road tile (or entrance cell); shared with construction dispatch and rescue. */
  getBaseCampSpawnTile(): { x: number; y: number } | null {
    return this.findBaseCampSpawnTile();
  }

  /** Road tile used as the goal for HQ→building walkers (tool delivery, soldiers, …). */
  getBuildingDispatchRoadTile(buildingEntity: Entity): { x: number; y: number } | null {
    return this.findBuildingAdjacentRoadTile(buildingEntity);
  }

  resetState(): void {
    this.returningWorkers.clear();
    this.roadSegmentWorkers.clear();
    this.builderWorkers.clear();
    this.returningBuilders.clear();
    this.toolWorkers.clear();
    this.militaryDispatchWorkers.clear();
    this.animationWorkers.clear();
    this.reservedTreeTiles.clear();
    this.surveyorWorkers.clear();
    this.pendingHqStreetEntries.length = 0;
    this.nextHqStreetDispatchAtMs = 0;
  }

  private spawnSegmentWorker(segment: RoadSegment): number | null {
    const connectedRoads = this.world.getBaseCampConnectedRoads();
    const isConnected = segment.tiles.some(t => connectedRoads.has(`${t.x},${t.y}`));
    if (!isConnected) {
      return null;
    }
    if (this.world.getAvailablePeasantSlotCount() <= 0) {
      console.warn('No available population for road worker');
      return null;
    }

    const spawnTile = this.findBaseCampSpawnTile();
    const rest = roadSegmentManager.getCenterRestPosition(segment);
    const near = roadSegmentManager.nearestSegmentTileToPoint(segment, rest.x, rest.y);
    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();

    const spawnX = spawnTile?.x ?? rest.x;
    const spawnY = spawnTile?.y ?? rest.y;

    const worker = createWorker(spawnX, spawnY);
    this.world.addEntity(worker);

    let streetPath: Position[] = [];
    if (spawnTile && (spawnX !== near.x || spawnY !== near.y)) {
      let path = pathFinder.findPath(new Position(spawnX, spawnY), new Position(near.x, near.y), tileMap);
      if (path.length > 0) {
        const endX = path[path.length - 1]!.x;
        const endY = path[path.length - 1]!.y;
        if (Math.hypot(endX - rest.x, endY - rest.y) > 1e-3) {
          path = [...path, new Position(rest.x, rest.y)];
        }
        streetPath = path;
      }
    } else if (Math.hypot(spawnX - rest.x, spawnY - rest.y) > 1e-3) {
      streetPath = [new Position(rest.x, rest.y)];
    }

    if (spawnTile) {
      this.queueHqStreetEntry(worker, streetPath);
    } else if (streetPath.length > 0) {
      const movable = worker.getComponent(Movable);
      const workerComp = worker.getComponent(Worker);
      if (movable && workerComp) {
        movable.setPath(streetPath);
        workerComp.setState('walking');
      }
    }

    console.log(`Road worker spawned for segment #${segment.id} at (${spawnX},${spawnY}) → rest (${rest.x},${rest.y})`);
    this.roadSegmentWorkers.add(worker.id);
    return worker.id;
  }

  private freeSegmentWorker(workerId: number): void {
    this.roadSegmentWorkers.delete(workerId);
    const entities = [...this.world.getEntities()];
    const entity = entities.find(e => e.id === workerId && e.active);
    if (!entity) return;

    const workerComp = entity.getComponent(Worker);
    if (workerComp?.transportTask) {
      const task = workerComp.transportTask;
      if (workerComp.carryingResource) {
        const p = entity.getComponent(Position);
        if (p) {
          const items = workerComp.carryingItems.length > 0
            ? workerComp.carryingItems
            : Array.from({ length: Math.max(1, workerComp.carryingAmount || task.amount || 1) }, () => ({
              resourceType: workerComp.carryingResource!,
              destinationEntityId: task.destEntityId ?? null,
            }));
          for (const item of items) {
            transportManager.addJunctionItem(Math.floor(p.x), Math.floor(p.y), item.resourceType, item.destinationEntityId);
          }
        }
        workerComp.dropResource();
      } else if (task.phase === 'to_pickup' && task.sourceEntityId === null) {
        const items = task.items && task.items.length > 0
          ? task.items
          : Array.from({ length: Math.max(1, task.amount || 1) }, () => ({
            resourceType: task.resourceType,
            destinationEntityId: task.destEntityId,
          }));
        transportManager.removePendingPickupItems(task.pickupPos.x, task.pickupPos.y, items);
        for (const item of items) {
          transportManager.addJunctionItem(task.pickupPos.x, task.pickupPos.y, item.resourceType, item.destinationEntityId);
        }
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

    const offRoadPath = pathFinder.findOffRoadPath(
      new Position(Math.floor(pos.x), Math.floor(pos.y)),
      new Position(spawnTile.x, spawnTile.y),
      tileMap
    );
    if (offRoadPath.length > 0) {
      const movable = entity.getComponent(Movable);
      const worker = entity.getComponent(Worker);
      if (movable && worker) {
        movable.setPath(offRoadPath);
        worker.setState('walking');
        worker.visualActivity = 'general';
        worker.dropResource();
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

    const rest = roadSegmentManager.getCenterRestPosition(segment);
    if (Math.hypot(pos.x - rest.x, pos.y - rest.y) < 0.04) return;

    const near = roadSegmentManager.nearestSegmentTileToPoint(segment, rest.x, rest.y);
    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();
    let path = pathFinder.findPath(
      new Position(Math.floor(pos.x), Math.floor(pos.y)),
      new Position(near.x, near.y),
      tileMap
    );

    if (path.length > 0) {
      const endX = path[path.length - 1]!.x;
      const endY = path[path.length - 1]!.y;
      if (Math.hypot(endX - rest.x, endY - rest.y) > 1e-3) {
        path = [...path, new Position(rest.x, rest.y)];
      }
      const movable = entity.getComponent(Movable);
      const workerComp = entity.getComponent(Worker);
      if (movable && workerComp) {
        movable.setPath(path);
        workerComp.setState('walking');
      }
    } else if (
      Math.floor(pos.x + 1e-9) === near.x &&
      Math.floor(pos.y + 1e-9) === near.y &&
      Math.hypot(pos.x - rest.x, pos.y - rest.y) > 1e-3
    ) {
      const movable = entity.getComponent(Movable);
      const workerComp = entity.getComponent(Worker);
      if (movable && workerComp) {
        movable.setPath([new Position(rest.x, rest.y)]);
        workerComp.setState('walking');
      }
    } else {
      pos.set(rest.x, rest.y);
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

  private findFootprintAdjacentNetworkRoadTile(
    pos: Position,
    building: Building,
    tileMap: TileMap,
    connected: Set<string>
  ): { x: number; y: number } | null {
    for (let dy = 0; dy < building.height; dy++) {
      for (let dx = 0; dx < building.width; dx++) {
        const adjacent = this.findAdjacentNetworkRoadTile(pos.x + dx, pos.y + dy, tileMap, connected);
        if (adjacent) return adjacent;
      }
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
      return this.findFootprintAdjacentNetworkRoadTile(pos, building, tileMap, connected) ?? { x: ex, y: ey };
    }

    return this.findFootprintAdjacentNetworkRoadTile(pos, building, tileMap, connected);
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

    this.queueHqStreetEntry(builder, path);
  }

  private tryReassignBuilderToSite(targetEntity: Entity, constructionSites: Entity[]): boolean {
    const targetBuilding = targetEntity.getComponent(Building);
    const targetPriority = this.world.getConstructionPriority(targetEntity);
    if (!targetBuilding || targetBuilding.builderEntityId != null) return false;

    const donorEntity = [...constructionSites].reverse().find(entity => {
      if (entity.id === targetEntity.id) return false;
      const building = entity.getComponent(Building);
      return Boolean(
        building &&
        building.state === 'awaiting_materials' &&
        building.builderEntityId != null &&
        this.world.getConstructionPriority(entity) < targetPriority
      );
    });
    if (!donorEntity) return false;

    const donorBuilding = donorEntity.getComponent(Building);
    if (!donorBuilding || donorBuilding.builderEntityId == null) return false;

    const builderEntity = this.world.getEntities().find(e => e.id === donorBuilding.builderEntityId && e.active);
    const builderPos = builderEntity?.getComponent(Position);
    const movable = builderEntity?.getComponent(Movable);
    const worker = builderEntity?.getComponent(Worker);
    const targetTile = this.findBuildingAdjacentRoadTile(targetEntity);
    if (!builderEntity || !builderPos || !movable || !worker || !targetTile) return false;

    const path = this.world.getPathFinder().findPath(
      new Position(Math.floor(builderPos.x), Math.floor(builderPos.y)),
      new Position(targetTile.x, targetTile.y),
      this.world.getTileMap()
    );
    if (path.length === 0) return false;

    donorBuilding.builderEntityId = null;
    donorBuilding.builderArrived = false;
    targetBuilding.builderEntityId = builderEntity.id;
    targetBuilding.builderArrived = false;
    this.builderWorkers.set(builderEntity.id, targetEntity.id);
    this.returningBuilders.delete(builderEntity.id);

    movable.speed = 1.8;
    movable.setPath(path);
    worker.setState('walking');
    worker.visualActivity = 'construct';
    worker.hammerConstructionEnabled = false;
    worker.buildIdleUntil = 0;

    return true;
  }

  private spawnToolWorker(buildingEntity: Entity, tool: string): void {
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
    if (!this.world.claimToolSpecialistForDispatch(tool)) return;

    const worker = createWorker(spawnTile.x, spawnTile.y);
    this.world.addEntity(worker);

    const workerComp = worker.getComponent(Worker);
    if (workerComp) {
      workerComp.pickUpResource(tool);
      workerComp.visualActivity = 'deliver_tool';
    }

    this.toolWorkers.set(worker.id, { buildingId: buildingEntity.id, tool });

    this.queueHqStreetEntry(worker, path);
  }

  /** Outfits tied to `interior_operator.operatorRole` (building-specific worker spec). */
  private applyInteriorOperatorAppearance(workerComp: Worker, operatorRole: string): void {
    const whiteApron = new Set(['mill', 'bakery']);
    if (!whiteApron.has(operatorRole)) return;
    workerComp.appearance = {
      skin: '#e8d4c4',
      hair: '#4a3020',
      tunic: '#f4f4f0',
      pants: '#e8e4dc',
      boots: '#5a5048',
      variant: 'hat',
    };
  }

  /** Idle + work tiles for well (1×1) or mill / other buildings with a road-connected footprint. */
  private computeSiteOperatorTiles(
    buildingEntity: Entity
  ): { idle: { x: number; y: number }; work: { x: number; y: number } } | null {
    const pos = buildingEntity.getComponent(Position);
    const building = buildingEntity.getComponent(Building);
    if (!pos || !building) return null;

    const tileMap = this.world.getTileMap();
    const okTile = (x: number, y: number): boolean => {
      const t = tileMap.getTile(x, y);
      return !!(t && t.walkable && !t.isOccupied());
    };

    if (building.width === 1 && building.height === 1) {
      const bx = pos.x;
      const by = pos.y;

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

    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const w = building.width;
    const h = building.height;

    const isOrthoAdjacentToFootprint = (x: number, y: number): boolean => {
      for (let ix = bx; ix < bx + w; ix++) {
        for (let iy = by; iy < by + h; iy++) {
          if (Math.abs(x - ix) + Math.abs(y - iy) === 1) return true;
        }
      }
      return false;
    };

    const candidates: { x: number; y: number }[] = [];
    for (let x = bx - 1; x <= bx + w; x++) {
      for (let y = by - 1; y <= by + h; y++) {
        if (x >= bx && x < bx + w && y >= by && y < by + h) continue;
        if (!isOrthoAdjacentToFootprint(x, y)) continue;
        if (okTile(x, y)) candidates.push({ x, y });
      }
    }
    if (candidates.length < 2) return null;

    const south = candidates.filter(t => t.y === by + h);
    const idlePool = south.length > 0 ? south : candidates;
    const idle = idlePool[0]!;
    const work = candidates.find(t => t.x !== idle.x || t.y !== idle.y) ?? candidates[1]!;
    return { idle, work };
  }

  /** Indoor operator: idle off to the side, `work` = doorstep (orthogonal to entrance cell). */
  private computeInteriorApproachTiles(
    buildingEntity: Entity
  ): { idle: { x: number; y: number }; work: { x: number; y: number } } | null {
    const pos = buildingEntity.getComponent(Position);
    const building = buildingEntity.getComponent(Building);
    if (!pos || !building) return null;
    const entranceOff = building.getEntranceOffset();
    if (!entranceOff) return null;

    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const w = building.width;
    const h = building.height;
    const ex = bx + entranceOff.dx;
    const ey = by + entranceOff.dy;

    const tileMap = this.world.getTileMap();
    const okTile = (x: number, y: number): boolean => {
      const t = tileMap.getTile(x, y);
      return !!(t && t.walkable && !t.isOccupied());
    };

    const onFootprint = (x: number, y: number): boolean =>
      x >= bx && x < bx + w && y >= by && y < by + h;

    const doorNeighbors: { x: number; y: number }[] = [];
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ] as [number, number][]) {
      const x = ex + dx;
      const y = ey + dy;
      if (onFootprint(x, y)) continue;
      if (okTile(x, y)) doorNeighbors.push({ x, y });
    }
    if (doorNeighbors.length === 0) return null;

    doorNeighbors.sort((a, b) => b.y - a.y || Math.abs(a.x - ex) - Math.abs(b.x - ex));
    const doorApproach = doorNeighbors[0]!;

    const perimeter: { x: number; y: number }[] = [];
    for (let x = bx - 1; x <= bx + w; x++) {
      for (let y = by - 1; y <= by + h; y++) {
        if (x >= bx && x < bx + w && y >= by && y < by + h) continue;
        let edge = false;
        for (let ix = bx; ix < bx + w; ix++) {
          for (let iy = by; iy < by + h; iy++) {
            if (Math.abs(x - ix) + Math.abs(y - iy) === 1) {
              edge = true;
              break;
            }
          }
          if (edge) break;
        }
        if (!edge) continue;
        if (okTile(x, y)) perimeter.push({ x, y });
      }
    }

    const idleCandidates = perimeter.filter(
      t => !(t.x === doorApproach.x && t.y === doorApproach.y)
    );
    if (idleCandidates.length === 0) return null;

    const south = idleCandidates.filter(t => t.y === by + h);
    const idle = (south.length > 0 ? south[0] : idleCandidates[0])!;

    return { idle, work: doorApproach };
  }

  private enterMillInterior(
    buildingEntity: Entity,
    workerComp: Worker,
    workerPos: Position,
    movable: Movable | null | undefined
  ): void {
    const bpos = buildingEntity.getComponent(Position);
    const building = buildingEntity.getComponent(Building);
    if (!bpos || !building) return;
    const bx = Math.floor(bpos.x);
    const by = Math.floor(bpos.y);
    const cx = bx + (building.width - 1) / 2 + 0.5;
    const cy = by + (building.height - 1) / 2 + 0.5;
    workerPos.set(cx, cy);
    movable?.clearPath();
    workerComp.dropResource();
    workerComp.visualActivity = 'general';
    workerComp.setState('working');
    workerComp.concealedInBuildingId = buildingEntity.id;
  }

  private revealMillWorkerAtDoor(
    workerComp: Worker,
    workerPos: Position,
    movable: Movable | null | undefined,
    door: { x: number; y: number }
  ): void {
    workerPos.set(door.x + 0.5, door.y + 0.5);
    workerComp.concealedInBuildingId = null;
    workerComp.visualActivity = 'general';
    movable?.clearPath();
  }

  private fallbackInteriorTiles(buildingEntity: Entity): { idle: { x: number; y: number }; work: { x: number; y: number } } | null {
    const pos = buildingEntity.getComponent(Position);
    const building = buildingEntity.getComponent(Building);
    if (!pos || !building) return null;
    const road = this.findBuildingAdjacentRoadTile(buildingEntity);
    const entrance = building.getEntranceOffset();
    const work = road ?? (entrance ? { x: pos.x + entrance.dx, y: pos.y + entrance.dy } : { x: pos.x, y: pos.y });
    return { idle: work, work };
  }

  private createConcealedInteriorOperator(buildingEntity: Entity, anim: Extract<AnimationConfig, { type: 'interior_operator' }>): boolean {
    const building = buildingEntity.getComponent(Building);
    const pos = buildingEntity.getComponent(Position);
    const production = buildingEntity.getComponent(Production);
    if (!building || !pos || !production || building.animationWorkerId != null) return false;

    const tiles = this.computeInteriorApproachTiles(buildingEntity) ?? this.fallbackInteriorTiles(buildingEntity);
    if (!tiles) return false;

    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const cx = bx + (building.width - 1) / 2 + 0.5;
    const cy = by + (building.height - 1) / 2 + 0.5;
    const worker = createWorker(cx, cy);
    setEntityFaction(worker, getEntityFaction(buildingEntity));

    const workerComp = worker.getComponent(Worker);
    const movable = worker.getComponent(Movable);
    if (workerComp) {
      workerComp.visualActivity = 'general';
      workerComp.setState('working');
      workerComp.concealedInBuildingId = buildingEntity.id;
      this.applyInteriorOperatorAppearance(workerComp, anim.operatorRole);
    }
    movable?.clearPath();

    this.world.addEntity(worker);
    building.animationWorkerId = worker.id;
    this.animationWorkers.set(worker.id, {
      kind: 'well_operator',
      buildingEntityId: buildingEntity.id,
      phase: 'interior_inside',
      idleTile: tiles.idle,
      workTile: tiles.work,
      lastProductionTimer: production.timer,
    });
    return true;
  }

  restoreInteriorOperatorsInsideCompletedBuildings(): void {
    for (const entity of this.world.getEntities()) {
      if (!entity.active || !isPlayerOwned(entity)) continue;
      const building = entity.getComponent(Building);
      const production = entity.getComponent(Production);
      if (!building || !production || !building.isComplete() || !building.isActive) continue;
      if (building.animationWorkerId != null) continue;

      const buildingDef = dataManager.getBuilding(building.buildingType);
      const anim = buildingDef ? this.resolveStaffingAnimation(buildingDef) : null;
      if (anim?.type !== 'interior_operator') continue;

      this.createConcealedInteriorOperator(entity, anim);
    }
  }

  private spawnSiteOperator(buildingEntity: Entity): void {
    const building = buildingEntity.getComponent(Building);
    const pos = buildingEntity.getComponent(Position);
    const production = buildingEntity.getComponent(Production);
    if (!building || !pos || !production) return;
    if (building.animationWorkerId != null) return;
    if (this.world.getAvailablePeasantSlotCount() <= 0) return;

    const buildingDef = dataManager.getBuilding(building.buildingType);
    if (!buildingDef) return;
    const anim = this.resolveStaffingAnimation(buildingDef);
    if (!anim || (anim.type !== 'well_operator' && anim.type !== 'interior_operator')) return;

    const tiles =
      anim.type === 'interior_operator'
        ? this.computeInteriorApproachTiles(buildingEntity)
        : this.computeSiteOperatorTiles(buildingEntity);
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

    const speed = anim.workerSpeed;

    const worker = createWorker(spawnTile.x, spawnTile.y);
    this.world.addEntity(worker);

    const workerComp = worker.getComponent(Worker);
    if (workerComp) {
      workerComp.visualActivity = 'general';
      if (anim.type === 'interior_operator') {
        this.applyInteriorOperatorAppearance(workerComp, anim.operatorRole);
      }
    }
    this.queueHqStreetEntry(worker, path, { speed });

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
    const production = buildingEntity.getComponent(Production);
    if (!building || !pos) return;
    if (building.animationWorkerId != null) return;
    if (isPlayerOwned(buildingEntity) && this.world.getAvailablePeasantSlotCount() <= 0) return;

    const buildingDef = dataManager.getBuilding(building.buildingType);
    if (!buildingDef?.animation || buildingDef.animation.type !== 'gather') return;
    const anim = buildingDef.animation;

    const rockGather = anim.gatherMode === 'rock_depletion';
    const waterGather = anim.gatherMode === 'water_depletion';
    const mineSiteGather = anim.gatherMode === 'mine_site';
    const wildHunt = anim.gatherMode === 'wild_hunt';
    if (rockGather || waterGather || mineSiteGather || wildHunt) {
      if (!production) return;
      const departBuffer = (anim.walkLeadSec ?? 0) + (anim.digAtSiteSec ?? 0) + 5;
      if (departBuffer > 0 && production.timer < production.productionTime - departBuffer) return;
    }

    const entrance = building.getEntranceOffset();
    const entranceX = entrance ? pos.x + entrance.dx : pos.x;
    const entranceY = entrance ? pos.y + entrance.dy : pos.y;

    const tileMap = this.world.getTileMap();
    const pathFinder = this.world.getPathFinder();

    const stonesPer = buildingDef.production?.stonesPerRockTile ?? 10;
    const gatherRadius =
      buildingDef.production?.maxGatherRadius ?? anim.searchRadius;
    const maxWalkCells =
      buildingDef.production?.maxGatherWalkCells ??
      buildingDef.production?.maxGatherRadius ??
      anim.searchRadius;

    const gatherExclude = new Set(this.reservedTreeTiles);
    if (rockGather || waterGather || mineSiteGather || wildHunt) {
      for (let dy = 0; dy < building.height; dy++) {
        for (let dx = 0; dx < building.width; dx++) {
          gatherExclude.add(`${pos.x + dx},${pos.y + dy}`);
        }
      }
    }

    let sourceTile: { x: number; y: number } | null = null;
    let path: Position[] = [];
    let fisherWaterTile: { x: number; y: number } | undefined;
    let huntRabbitId: number | undefined;

    if (mineSiteGather) {
      const maxMineWalk =
        buildingDef.production?.maxGatherWalkCells ??
        buildingDef.production?.maxGatherRadius ??
        anim.searchRadius ??
        22;
      sourceTile = this.findMineDigWorkTile(
        entranceX,
        entranceY,
        pos,
        building,
        tileMap,
        pathFinder,
        gatherExclude,
        maxMineWalk
      );
      if (sourceTile) {
        path = pathFinder.findOffRoadPath(
          new Position(entranceX, entranceY),
          new Position(sourceTile.x, sourceTile.y),
          tileMap
        );
        if (path.length === 0 || path.length > maxMineWalk) {
          sourceTile = null;
          path = [];
        }
      }
    } else if (rockGather) {
      const candidates = tileMap.listHarvestableRocksSorted(
        entranceX,
        entranceY,
        gatherRadius,
        anim.targetTerrain,
        stonesPer,
        gatherExclude
      );
      for (const c of candidates) {
        const p = pathFinder.findOffRoadPath(
          new Position(entranceX, entranceY),
          new Position(c.x, c.y),
          tileMap
        );
        if (p.length > 0 && p.length <= maxWalkCells) {
          sourceTile = c;
          path = p;
          break;
        }
      }
    } else if (waterGather) {
      const pick = pickRandomReachableWaterFishTarget(
        tileMap,
        pathFinder,
        entranceX,
        entranceY,
        gatherRadius,
        maxWalkCells,
        gatherExclude
      );
      if (pick) {
        sourceTile = { x: pick.standX, y: pick.standY };
        path = pick.path;
        fisherWaterTile = { x: pick.waterX, y: pick.waterY };
      }
    } else if (wildHunt) {
      const wildlife = this.world.getWildlife();
      const foot = new Set<string>();
      for (let dy = 0; dy < building.height; dy++) {
        for (let dx = 0; dx < building.width; dx++) {
          foot.add(`${pos.x + dx},${pos.y + dy}`);
        }
      }
      const huntPick = wildlife.pickAndReserveReachableRabbit(
        tileMap,
        pathFinder,
        entranceX,
        entranceY,
        gatherRadius,
        maxWalkCells,
        foot
      );
      if (huntPick) {
        sourceTile = { x: huntPick.rabbit.x, y: huntPick.rabbit.y };
        path = huntPick.path;
        huntRabbitId = huntPick.rabbit.id;
      }
    } else {
      const candidates = tileMap.listNearbyTerrainSorted(
        entranceX,
        entranceY,
        gatherRadius,
        anim.targetTerrain,
        this.reservedTreeTiles
      );
      for (const c of candidates) {
        const p = pathFinder.findOffRoadPath(
          new Position(entranceX, entranceY),
          new Position(c.x, c.y),
          tileMap
        );
        if (p.length > 0 && p.length <= maxWalkCells) {
          sourceTile = c;
          path = p;
          break;
        }
      }
    }

    if (!sourceTile || path.length === 0) {
      building.outOfMapResources = true;
      return;
    }
    building.outOfMapResources = false;

    if (!wildHunt) {
      this.reservedTreeTiles.add(`${sourceTile.x},${sourceTile.y}`);
    }

    const worker = createWorker(entranceX, entranceY);
    setEntityFaction(worker, getEntityFaction(buildingEntity));
    this.world.addEntity(worker);

    const workerComp = worker.getComponent(Worker);
    if (workerComp) {
      workerComp.pickUpResource(
        (buildingDef.requiredTool as string) ||
          (rockGather ? 'pickaxe' : waterGather ? 'fishing_rod' : wildHunt ? 'bow' : 'axe')
      );
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
      targetTile: sourceTile,
      fisherWaterTile: waterGather ? fisherWaterTile : undefined,
      terrainModified: false,
      entranceTile: { x: entranceX, y: entranceY },
      rockGather,
      waterGather,
      mineGather: mineSiteGather,
      wildHunt,
      rabbitId: huntRabbitId,
    });
  }

  /** Off-road tile next to the mine entrance where the miner stands to swing the pickaxe. */
  private findMineDigWorkTile(
    entranceX: number,
    entranceY: number,
    pos: Position,
    building: Building,
    tileMap: TileMap,
    pathFinder: PathFinder,
    reserved: Set<string>,
    maxWalkCells: number
  ): { x: number; y: number } | null {
    const foot = new Set<string>();
    for (let dy = 0; dy < building.height; dy++) {
      for (let dx = 0; dx < building.width; dx++) {
        foot.add(`${pos.x + dx},${pos.y + dy}`);
      }
    }
    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ] as const;
    const cand: { x: number; y: number; len: number }[] = [];
    for (const [dx, dy] of dirs) {
      const wx = entranceX + dx;
      const wy = entranceY + dy;
      const key = `${wx},${wy}`;
      if (foot.has(key)) continue;
      if (reserved.has(key)) continue;
      const tile = tileMap.getTile(wx, wy);
      if (!tile || !tile.walkable || tile.isOccupied()) continue;
      const path = pathFinder.findOffRoadPath(
        new Position(entranceX, entranceY),
        new Position(wx, wy),
        tileMap
      );
      if (path.length === 0 || path.length > maxWalkCells) continue;
      cand.push({ x: wx, y: wy, len: path.length });
    }
    cand.sort((a, b) => a.len - b.len);
    return cand.length ? { x: cand[0].x, y: cand[0].y } : null;
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
    if (isPlayerOwned(buildingEntity) && this.world.getAvailablePeasantSlotCount() <= 0) return;

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
    setEntityFaction(worker, getEntityFaction(buildingEntity));
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
      if (state.wildHunt && state.rabbitId != null) {
        this.world.getWildlife().releaseHuntReservation(state.rabbitId);
      } else {
        this.reservedTreeTiles.delete(`${state.targetTile.x},${state.targetTile.y}`);
      }
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
