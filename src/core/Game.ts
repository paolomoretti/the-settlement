/**
 * Main Game class - orchestrates all systems and manages game state
 */

import { Entity } from './Entity';
import { System } from './System';
import { eventBus } from './EventBus';
import { TileMap } from '@/map/TileMap';
import { RenderSystem, type DemolitionSiteVisual } from '@/systems/RenderSystem';
import { MovementSystem } from '@/systems/MovementSystem';
import { ProductionSystem } from '@/systems/ProductionSystem';
import { InputSystem } from '@/systems/InputSystem';
import { PathFinder } from '@/pathfinding/AStar';
import { audioManager } from '@/audio/AudioManager';
import { Position } from '@/components/Position';
import { Movable } from '@/components/Movable';
import { Worker, type TransportLoadItem } from '@/components/Worker';
import { Building } from '@/components/Building';
import { Production, type ProductionPriorityState } from '@/components/Production';
import { Storage } from '@/components/Storage';
import type { FactionId } from '@/components/Owner';
import {
  ENEMY_FACTIONS,
  PLAYER_FACTION,
  getEnemyFactionStyle,
  getEntityFaction,
  isEnemyFactionId,
  isPlayerOwned,
  setEntityFaction,
} from '@/components/ownerUtils';
import { dataManager } from '@/data/DataManager';
import { resourceManager } from '@/economics/ResourceManager';
import { roadSegmentManager, RoadSegment } from '@/economics/RoadSegmentManager';
import { transportManager } from '@/economics/TransportManager';
import { Inventory, BuildingType, ResourceType } from '@/types/GameData';

// Entity factories
import {
  createWorker,
  createMilitaryWorker,
  createBuilding,
  createBaseCamp,
} from '@/entities/EntityFactory';
import { GameWorkerRegistry } from '@/workers';
import { isInsightAltHeld } from '@/input/InsightAltKey';
import { isInsightRockTile } from '@/ui/hoverInsight/buildHoverLines';
import { axisAlignedGridLine } from '@/utils/gridLine';
import { SurveyCoordinator } from '@/survey/SurveyCoordinator';
import { ensureWellAquiferInitialized } from '@/map/wellAquifer';
import { WildlifeCoordinator } from '@/wildlife/WildlifeCoordinator';
import { TerritoryCoordinator } from '@/map/TerritoryCoordinator';
import {
  planEnemyVillages,
  type EnemyVillagePlan,
  type EnemyVillageBuildingPlan,
} from '@/world/EnemyVillageGenerator';
import { setSimulationNowMs } from './simulationClock';
import { WORKER_AMBIENT_SOUNDS } from '@/config/gameConfig';

const DEMOLITION_FIRE_DURATION_MS = 30_000;
const DEMOLITION_SCORCH_DURATION_MS = 60_000;
const ENEMY_ATTACK_DUEL_MS = 10_000;
const ENEMY_ATTACK_FALLEN_MS = 2_000;
const FAST_FORWARD_TIME_SCALE = 3;

type MilitaryRank = 1 | 2 | 3;
export type AttackRankSelection = Record<MilitaryRank, number>;
export type EnemyAttackOptions = {
  availableByRank: AttackRankSelection;
  maxByRank: AttackRankSelection;
  totalAvailable: number;
  canAttack: boolean;
  reason?: string;
};

type AttackParticipant = {
  workerEntityId: number;
  rank: MilitaryRank;
  sourceBuildingId: number;
  sourceSlotIndex: number;
};

type ActiveEnemyAttack = {
  id: number;
  targetEntityId: number;
  attackerFactionId: FactionId;
  targetFactionId: FactionId;
  initiatedBy: 'player' | 'enemy';
  attackers: AttackParticipant[];
  defenders: AttackParticipant[];
  attackerQueue: number[];
  defenderQueue: number[];
  currentAttackerId: number | null;
  currentDefenderId: number | null;
  phase: 'marching' | 'duel' | 'fallen' | 'returning' | 'complete';
  duelStartedAt: number;
  fallenUntil: number;
  fallenWorkerId: number | null;
  staging: {
    attacker: { x: number; y: number };
    defender: { x: number; y: number };
  };
  returnAssignments: Array<{
    workerEntityId: number;
    buildingEntityId: number;
    rank: MilitaryRank;
  }>;
};

function angleToWorkerFacing(angle: number): number {
  const normalized = (angle + Math.PI * 2) % (Math.PI * 2);
  return Math.round(normalized / (Math.PI / 2)) % 4;
}

export class Game {
  private entities: Entity[] = [];
  private systems: System[] = [];
  private running = false;
  private lastTime = 0;
  private simulationNowMs = Date.now();
  private timeScale = 1;
  private fps = 0;
  private frameCount = 0;
  private fpsTime = 0;

  public tileMap: TileMap;
  public renderSystem: RenderSystem;
  public movementSystem: MovementSystem;
  public productionSystem: ProductionSystem;
  public inputSystem: InputSystem;
  public pathFinder: PathFinder;

  // Selection system
  public selectedEntity: Entity | null = null;
  public isDraggingEntity = false;
  public dragPreviewPosition: { x: number; y: number } | null = null;

  /** Settlement disks + cordon; fog lifts via {@link TerritoryCoordinator.applyFogReveal}. */
  private territory: TerritoryCoordinator;
  private territoryDirty = true;

  // Game economy
  public inventory: Inventory = {};
  public baseCampEntity: Entity | null = null;
  public population = {
    current: 0,
    max: 0,
  };
  private productionPriorities: ProductionPriorityState = {};
  private buildingPriorities: Record<string, number> = {};
  /** Specialized workers idle at HQ and ready for reassignment. */
  private toolSpecialistsAtHq: Record<string, number> = {};
  /** Specialized military workers idle at HQ and ready for reassignment. */
  private militarySpecialistsAtHq = 0;
  /** Donkeys idle at HQ and ready to upgrade one road carrier. New games start with one for testing. */
  private donkeysAtHq = 1;

  /** Wild rabbits (spawn, wander, hunt targets); see `.claude/WILDLIFE_RABBITS.md`. */
  public wildlife = new WildlifeCoordinator();

  private workers!: GameWorkerRegistry;
  /** Geological survey: flag, surveyor, dominant-ore labels, lazy `Tile.cellMinerals`. */
  public surveys!: SurveyCoordinator;
  /** True while the grass-tile Surveyor popover is open (drives close-then-click-again UX). */
  public cellSurveyMenuOpen = false;
  /** Grass tile awaiting tap on the center “options” icon before opening the Surveyor menu. */
  public pendingSurveyGrid: { x: number; y: number } | null = null;
  private pendingBuildingPickups = new Set<number>(); // building entity IDs with workers en route
  private roadDragMode: 'create' | 'delete' | null = null;
  private lastMaterialCheckTime = 0;
  private lastProductionInputCheckTime = 0;
  /** Full transport heal (segment graph + route maps + junction rescue); mirrors road `scheduleSegmentRecalc`. */
  private lastPeriodicTransportHealTime = 0;
  private lastOutputTransportKickTime = 0;
  /** In-world seconds (uncapped); used for fish school regen on a fixed interval. */
  private worldTimeSeconds = 0;
  /** Next `worldTimeSeconds` at which we run water fish population regen (+1 per school tile). */
  private nextWaterFishRegenWorldSecond = 7200;
  /** Recently demolished building footprints: 30s blocking fire, then 60s cosmetic scorch. */
  private demolitionSites: DemolitionSiteVisual[] = [];
  private nextDemolitionSiteId = 1;
  private enemyRealms: EnemyVillagePlan[] = [];
  private activeEnemyAttacks: ActiveEnemyAttack[] = [];
  private nextEnemyAttackId = 1;
  private nextEnemyPressureCheckAt = 0;
  private nextEnemyRoadMaintenanceAt = 0;
  private nextBattleClashAt = 0;
  private nextForestAmbientAt = 0;
  private nextHammerSoundAt = 0;
  private readonly nextWorkerSoundAt = new Map<string, number>();
  private pendingWellDemolitions = new Map<number, number>();

  private readonly frameHooks: Array<() => void> = [];

  constructor(
    private canvas: HTMLCanvasElement,
    skipInit = false
  ) {
    setSimulationNowMs(this.simulationNowMs);

    // Initialize large map (20x bigger: 1000x1000)
    this.tileMap = new TileMap(1000, 1000);
    this.territory = new TerritoryCoordinator(this.tileMap);

    // Initialize systems
    this.renderSystem = new RenderSystem(canvas, this.tileMap);
    this.movementSystem = new MovementSystem(entity => this.isEntitySimulationActive(entity));
    this.productionSystem = new ProductionSystem(
      () => this.tileMap,
      () => this.pathFinder,
      () => this.wildlife,
      () => this.productionPriorities,
      entity => this.isEntitySimulationActive(entity)
    );
    this.inputSystem = new InputSystem(canvas, this.renderSystem);
    this.pathFinder = new PathFinder();
    this.renderSystem.setWildRabbitSupplier(() => this.wildlife.getRabbits());
    this.renderSystem.placementPreviewHooks = {
      canPlaceBuildingPreview: (type, gx, gy, w, h) =>
        this.canPreviewPlaceBuilding(type as BuildingType, gx, gy, w, h, undefined),
      canPlaceRoadPreview: (gx, gy) => this.canPreviewPlaceRoadCell(gx, gy),
    };
    this.renderSystem.getTerritoryCordonOverlay = () => {
      this.refreshTerritoryIfDirty();
      const layers = [];
      const playerLayer = this.territory.getLayer(PLAYER_FACTION);
      if (playerLayer.frontier.size > 0) {
        layers.push({
          frontier: playerLayer.frontier,
          unionU: playerLayer.unionU,
        });
      }
      for (let i = 0; i < ENEMY_FACTIONS.length; i++) {
        const factionId = ENEMY_FACTIONS[i]!;
        const enemyLayer = this.territory.getLayer(factionId);
        if (enemyLayer.frontier.size === 0) continue;
        const style = getEnemyFactionStyle(factionId);
        layers.push({
          frontier: enemyLayer.frontier,
          unionU: enemyLayer.unionU,
          style: {
            stickDark: style.poleDark,
            stickLight: style.poleLight,
            rope: style.rope,
            ropeHighlight: style.ropeHighlight,
            offsetX: 2.5 + (i % 3) * 0.7,
            offsetY: -1.5 - (i % 2) * 0.7,
          },
        });
      }
      return layers.length > 0 ? { layers } : null;
    };

    // Production runs before movement, movement before render
    this.systems.push(this.productionSystem, this.movementSystem, this.renderSystem);

    // Give ResourceManager access to entities
    resourceManager.setEntityGetter(() => this.entities);

    this.workers = new GameWorkerRegistry({
      getEntities: () => this.entities,
      getBaseCampEntity: () => this.baseCampEntity,
      getTileMap: () => this.tileMap,
      getPathFinder: () => this.pathFinder,
      addEntity: e => this.addEntity(e),
      removeEntity: e => this.removeEntity(e),
      getRenderSystem: () => this.renderSystem,
      getBaseCampConnectedRoads: () => this.getBaseCampConnectedRoads(),
      getAvailablePeasantSlotCount: () => this.getAvailablePopulation(),
      getConstructionPriority: e => this.getBuildingPriorityForEntity(e),
      getWildlife: () => this.wildlife,
      claimToolSpecialistForDispatch: (tool: string) => this.claimToolSpecialistForDispatch(tool),
      returnToolSpecialistToHq: (tool: string) => this.addToolSpecialistToHqPool(tool, 1),
      onMilitarySpecialistReturnedToHq: () => this.addMilitarySpecialistToHqPool(1),
      onDonkeyReturnedToHq: () => this.onDonkeyReturnedToHq(),
      isEntitySimulationActive: entity => this.isEntitySimulationActive(entity),
      getSimulationNowMs: () => this.simulationNowMs,
    });

    this.surveys = new SurveyCoordinator({
      getTileMap: () => this.tileMap,
      getPathFinder: () => this.pathFinder,
      getEntities: () => this.entities,
      addEntity: e => this.addEntity(e),
      removeEntity: e => this.removeEntity(e),
      getHqRoadNetwork: () => this.getBaseCampConnectedRoads(),
      getBuildingAt: (gx, gy) => this.findBuildingEntityAt(gx, gy),
      getMapSeed: () => this.tileMap.getSeed(),
      getAvailablePopulation: () => this.getAvailablePopulation(),
      getBaseCampSpawnTile: () => this.workers.getBaseCampSpawnTile(),
      queueHqStreetEntry: (entity, path, options) =>
        this.workers.queueHqStreetEntry(entity, path, options),
      attachSurveyorWorker: id => this.workers.attachSurveyorWorker(id),
      detachSurveyorWorker: id => this.workers.detachSurveyorWorker(id),
    });

    // Setup road segment callbacks
    roadSegmentManager.setCallbacks(this.workers.getRoadSegmentCallbacks());

    // Load sound effects
    audioManager.loadSound('road_build', '/audio/road_build.mp3');
    audioManager.loadSound('build_placed', '/audio/build_placed.mp3');
    audioManager.loadSound('demolish', '/audio/demolish.mp3');
    audioManager.loadSound('erase_demolition', '/audio/erase_demolition.mp3');
    audioManager.loadSound('building_complete', '/audio/building_complete.mp3');
    audioManager.loadSound('battle_clash_1', '/audio/battle_clash_1.mp3');
    audioManager.loadSound('battle_clash_2', '/audio/battle_clash_2.mp3');
    audioManager.loadSound('battle_victory', '/audio/battle_victory.mp3');
    audioManager.loadSound('battle_loss', '/audio/battle_loss.mp3');
    audioManager.loadSound('forest_1', '/audio/forest_1.mp3', 0.35);
    audioManager.loadSound('forest_2', '/audio/forest_2.mp3', 0.35);
    audioManager.loadSound('hammer', '/audio/hammer.mp3', 0.45);
    audioManager.loadSound('surveyor', '/audio/surveyor.mp3', 0.6);
    for (const def of dataManager.getAllBuildings()) {
      if (def.ambientSound) {
        audioManager.loadDynamicSound('building_worker_' + def.id, def.ambientSound.src);
      }
    }

    // Setup event listeners
    this.setupEventListeners();
    eventBus.on(
      'production:complete',
      (payload: { entityId: number; outputs: Record<string, number> }) =>
        this.onProductionComplete(payload)
    );
    this.productionPriorities = this.createDefaultProductionPriorities();
    this.buildingPriorities = this.createDefaultBuildingPriorities();

    // Initialize game world
    if (!skipInit) {
      this.initializeWorld();
    }
  }

  private createDefaultProductionPriorities(): ProductionPriorityState {
    const priorities: ProductionPriorityState = {};
    for (const building of dataManager.getAllBuildings()) {
      if (building.production?.outputMode !== 'weighted_random') continue;
      priorities[building.id] = {};
      for (const [resource, amount] of Object.entries(building.production.outputs)) {
        if ((amount ?? 0) > 0) {
          priorities[building.id]![resource] = 5;
        }
      }
    }
    return priorities;
  }

  private normalizeProductionPriorities(raw?: unknown): ProductionPriorityState {
    const defaults = this.createDefaultProductionPriorities();
    if (!raw || typeof raw !== 'object') return defaults;

    for (const [buildingType, resources] of Object.entries(defaults)) {
      const rawResources = (raw as Record<string, unknown>)[buildingType];
      if (!rawResources || typeof rawResources !== 'object') continue;
      for (const resource of Object.keys(resources)) {
        const value = (rawResources as Record<string, unknown>)[resource];
        if (typeof value === 'number' && Number.isFinite(value)) {
          resources[resource] = Math.min(10, Math.max(1, Math.round(value)));
        }
      }
    }
    return defaults;
  }

  private createDefaultBuildingPriorities(): Record<string, number> {
    const priorities: Record<string, number> = {};
    for (const building of dataManager.getAllBuildings()) {
      if (building.id === 'road' || building.id === 'base_camp') continue;
      priorities[building.id] = 50;
    }
    return priorities;
  }

  private normalizeBuildingPriorities(raw?: unknown): Record<string, number> {
    const defaults = this.createDefaultBuildingPriorities();
    if (!raw || typeof raw !== 'object') return defaults;
    for (const buildingType of Object.keys(defaults)) {
      const value = (raw as Record<string, unknown>)[buildingType];
      if (typeof value === 'number' && Number.isFinite(value)) {
        defaults[buildingType] = Math.min(100, Math.max(1, Math.round(value)));
      }
    }
    return defaults;
  }

  getProductionPriorities(): ProductionPriorityState {
    return this.productionPriorities;
  }

  getBuildingPriority(buildingType: string): number {
    return this.buildingPriorities[buildingType] ?? 50;
  }

  setBuildingPriority(buildingType: string, priority: number): void {
    this.buildingPriorities[buildingType] = Math.min(100, Math.max(1, Math.round(priority)));
  }

  private getBuildingPriorityForEntity(entity: Entity): number {
    const building = entity.getComponent(Building);
    return building ? this.getBuildingPriority(building.buildingType) : 50;
  }

  private sortEntitiesByBuildingPriority(entities: Entity[]): Entity[] {
    return entities
      .filter(e => isPlayerOwned(e))
      .sort((a, b) => {
        const delta = this.getBuildingPriorityForEntity(b) - this.getBuildingPriorityForEntity(a);
        return delta !== 0 ? delta : a.id - b.id;
      });
  }

  getProductionPriority(buildingType: string, resourceType: string): number {
    return this.productionPriorities[buildingType]?.[resourceType] ?? 5;
  }

  setProductionPriority(buildingType: string, resourceType: string, priority: number): void {
    if (!this.productionPriorities[buildingType]) {
      this.productionPriorities[buildingType] = {};
    }
    this.productionPriorities[buildingType]![resourceType] = Math.min(
      10,
      Math.max(1, Math.round(priority))
    );
  }

  getBuildingOperationalSummary(): Array<{
    buildingType: BuildingType;
    name: string;
    active: number;
    total: number;
  }> {
    const counts = new Map<BuildingType, { active: number; total: number }>();

    for (const entity of this.sortEntitiesByBuildingPriority(this.entities)) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (!building || building.buildingType === 'road' || building.buildingType === 'base_camp')
        continue;

      const buildingType = building.buildingType as BuildingType;
      const count = counts.get(buildingType) ?? { active: 0, total: 0 };
      count.total++;

      const def = dataManager.getBuilding(buildingType);
      const production = entity.getComponent(Production);
      const productionStopped =
        production != null &&
        (production.status === 'stopped_full' ||
          production.status === 'stopped_no_inputs' ||
          production.status === 'stopped_no_road');
      const hasRequiredStaff = !def?.requiredTool || building.hasOperator;
      const hasRequiredGarrison =
        !def?.military?.soldierCapacity || building.getMilitaryGarrisonFilledCount() > 0;
      const isOperational =
        building.isComplete() &&
        (!building.requiresRoad || building.isActive) &&
        hasRequiredStaff &&
        hasRequiredGarrison &&
        !productionStopped;

      if (isOperational) count.active++;
      counts.set(buildingType, count);
    }

    return dataManager
      .getAllBuildings()
      .filter(def => def.id !== 'road' && def.id !== 'base_camp')
      .map(def => {
        const count = counts.get(def.id);
        return {
          buildingType: def.id,
          name: def.name,
          active: count?.active ?? 0,
          total: count?.total ?? 0,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private setupEventListeners(): void {
    // Building events
    eventBus.on('build:road', data => this.buildRoad(data.x, data.y));
    eventBus.on(
      'build:road_path',
      (data: { from: { x: number; y: number }; to: { x: number; y: number } }) =>
        this.buildRoadPath(data.from, data.to)
    );
    eventBus.on('road:drag_end', () => {
      this.roadDragMode = null;
    });
    eventBus.on('erase:tile', (data: { x: number; y: number }) => this.eraseAt(data.x, data.y));

    // Generic building handler for all building types (derived from data)
    for (const building of dataManager.getAllBuildings()) {
      const type = building.id;
      eventBus.on(`build:${type}`, (data: { x: number; y: number }) =>
        this.buildGeneric(type, data.x, data.y)
      );
    }

    // Selection events
    eventBus.on(
      'select:entity',
      (data: { x: number; y: number; clientX?: number; clientY?: number }) =>
        this.selectEntityAt(data.x, data.y, data.clientX, data.clientY)
    );
    eventBus.on('delete:selected', () => this.deleteSelectedEntity());
    eventBus.on('road_worker:replace_with_donkey', (data: { entityId: number }) => {
      if (!this.replaceRoadWorkerWithDonkey(data.entityId)) {
        eventBus.emit('build:failed', {
          reason: 'No donkey available at headquarters',
        });
      } else if (this.selectedEntity?.id === data.entityId) {
        this.updateSelectionUI();
      }
    });
    eventBus.on('road_worker:return_donkey', (data: { entityId: number }) => {
      if (!this.returnRoadDonkeyToHq(data.entityId)) {
        eventBus.emit('build:failed', {
          reason: 'This carrier is not using a donkey',
        });
      } else if (this.selectedEntity?.id === data.entityId) {
        this.updateSelectionUI();
      }
    });
    eventBus.on('check:drag_selected', data => this.checkDragSelected(data.x, data.y));
    eventBus.on('drag:move', data => this.dragEntityTo(data.x, data.y));
    eventBus.on('drag:end', data => this.dropEntity(data.x, data.y));

    // Build failure toast
    eventBus.on('build:failed', data => {
      if (this.inputSystem.hoverGridPos) {
        const screenPos = this.renderSystem.gridToScreen(
          this.inputSystem.hoverGridPos.x,
          this.inputSystem.hoverGridPos.y
        );
        this.renderSystem.showToast(data.reason, screenPos.x, screenPos.y);
      }
    });

    eventBus.on('well:aquifer_depleted', (data: { entityId: number }) => {
      if (!this.pendingWellDemolitions.has(data.entityId)) {
        this.pendingWellDemolitions.set(data.entityId, this.getSimulationNowMs() + 2000);
      }
    });

    eventBus.on('military:garrison_changed', () => {
      this.markTerritoryDirty();
    });

    // Input mode changes
    eventBus.on('input:mode_changed', mode => {
      const modeElement = document.getElementById('current-mode');
      if (modeElement) {
        modeElement.textContent = mode.replace('_', ' ');
      }
    });
  }

  private initializeWorld(): void {
    this.population.current = dataManager.getStartingPopulation();

    // Create base camp in center
    const centerX = Math.floor(this.tileMap.width / 2);
    const centerY = Math.floor(this.tileMap.height / 2);

    // Build base camp — no roads, no workers. Roads are built by the player.
    this.buildBaseCamp(centerX, centerY);

    this.markTerritoryDirty();
    this.refreshTerritoryIfDirty();

    this.seedEnemyVillages(centerX + 3, centerY + 3);

    this.wildlife.seedInitialRabbits(this.tileMap, centerX, centerY);

    console.log(
      `World initialized at (${centerX}, ${centerY}) - Map size: ${this.tileMap.width}x${this.tileMap.height}`
    );
  }

  private markTerritoryDirty(): void {
    this.territoryDirty = true;
  }

  private refreshTerritoryIfDirty(): void {
    if (!this.territoryDirty) return;
    this.territory.rebuildFrom(this.entities, this.baseCampEntity);
    this.territory.applyFogReveal(this.renderSystem);
    this.updateEnemyRealmActivation();
    this.applyPlayerTerritoryPressureAftermath();
    this.removeRoadsOnTerritoryFrontiers();
    this.territoryDirty = false;
  }

  private isEnemyFactionActive(factionId: FactionId): boolean {
    if (factionId === PLAYER_FACTION) return true;
    return this.enemyRealms.some(
      realm => realm.factionId === factionId && realm.activated === true
    );
  }

  private isEntitySimulationActive(entity: Entity): boolean {
    const factionId = getEntityFaction(entity);
    return factionId === PLAYER_FACTION || this.isEnemyFactionActive(factionId);
  }

  private updateEnemyRealmActivation(): void {
    const playerLayer = this.territory.getLayer(PLAYER_FACTION);
    if (playerLayer.unionU.size === 0) return;
    for (const realm of this.enemyRealms) {
      if (realm.activated === true) continue;
      if (!this.playerTerritoryTouchesRealm(realm, playerLayer.unionU)) continue;
      realm.activated = true;
      this.seedEnemyRealmDecorations(realm);
      console.log(`${realm.factionId} activated as player territory reached the realm.`);
    }
  }

  private playerTerritoryTouchesRealm(
    realm: EnemyVillagePlan,
    playerCells: ReadonlySet<string>
  ): boolean {
    const margin = 1;
    for (let y = realm.bounds.y - margin; y < realm.bounds.y + realm.bounds.height + margin; y++) {
      for (let x = realm.bounds.x - margin; x < realm.bounds.x + realm.bounds.width + margin; x++) {
        if (playerCells.has(`${x},${y}`)) return true;
      }
    }
    return false;
  }

  private isAreaExplored(x: number, y: number, width: number = 1, height: number = 1): boolean {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const tile = this.tileMap.getTile(x + dx, y + dy);
        if (!tile || !tile.isExplored()) {
          return false;
        }
      }
    }
    return true;
  }

  /** Canvas build preview: walkable tiles, fog, and settlement interior / military cordon rule. */
  public canPreviewPlaceBuilding(
    _buildingType: BuildingType,
    gx: number,
    gy: number,
    w: number,
    h: number,
    ignoreEntityId?: number
  ): boolean {
    if (!this.canPlaceBuilding(gx, gy, w, h, ignoreEntityId)) return false;
    if (!this.isAreaExplored(gx, gy, w, h)) return false;
    this.refreshTerritoryIfDirty();
    return this.territory.isInteriorFootprint(gx, gy, w, h, PLAYER_FACTION);
  }

  /** Road preview / placement: fog lifted and strictly inside the cordon (not on rope cells). */
  public canPreviewPlaceRoadCell(gx: number, gy: number): boolean {
    if (this.isDemolitionFireBlockingCell(gx, gy)) return false;
    this.refreshTerritoryIfDirty();
    return this.territory.isInteriorCell(gx, gy, PLAYER_FACTION);
  }

  private segmentRecalcTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleSegmentRecalc(): void {
    if (this.segmentRecalcTimer) return;
    this.segmentRecalcTimer = setTimeout(() => {
      this.segmentRecalcTimer = null;
      roadSegmentManager.recalculate(this.tileMap);
      this.recomputeTransportRoutes();
    }, 200);
  }

  private flushSegmentRecalc(): void {
    if (this.segmentRecalcTimer) {
      clearTimeout(this.segmentRecalcTimer);
      this.segmentRecalcTimer = null;
    }
    roadSegmentManager.recalculate(this.tileMap);
    this.recomputeTransportRoutes();
  }

  /**
   * Refreshes direction maps when new goods appear in building buffers so segment workers
   * can resolve toward-base / toward-consumer indices (cheap vs full segment recalc).
   */
  private kickTransportRoutesForNewOutput(): void {
    if (!this.baseCampEntity) return;
    this.recomputeTransportRoutes();
  }

  private onProductionComplete(payload: {
    entityId: number;
    outputs: Record<string, number>;
  }): void {
    if ((payload.outputs.donkey ?? 0) > 0) {
      this.dispatchBredDonkeyToHq(payload.entityId, payload.outputs.donkey);
    }
    this.kickTransportRoutesForNewOutput();
  }

  private dispatchBredDonkeyToHq(sourceEntityId: number, count: number): void {
    const source = this.entities.find(e => e.id === sourceEntityId && e.active);
    if (!source) {
      this.donkeysAtHq += count;
      return;
    }
    const roadTile = this.workers.getBuildingDispatchRoadTile(source);
    const pos = source.getComponent(Position);
    const building = source.getComponent(Building);
    const startX = roadTile?.x ?? (pos && building ? pos.x + Math.floor(building.width / 2) : null);
    const startY =
      roadTile?.y ?? (pos && building ? pos.y + Math.floor(building.height / 2) : null);
    if (startX == null || startY == null) {
      this.donkeysAtHq += count;
      return;
    }

    for (let i = 0; i < count; i++) {
      const donkey = createWorker(startX + 0.5, startY + 0.5);
      const worker = donkey.getComponent(Worker);
      if (worker) {
        worker.carrierType = 'donkey';
        worker.transportCarryCapacity = 5;
        worker.returnToHqAsDonkey = true;
        worker.name = 'Donkey';
        worker.setState('walking');
      }
      this.addEntity(donkey);
      if (!this.workers.sendLooseWorkerBackToBaseCamp(donkey, source, 1.8)) {
        this.removeEntity(donkey);
        this.donkeysAtHq++;
      }
    }
    eventBus.emit('resource:updated');
  }

  private hasAnyUnroutedProductionOutput(): boolean {
    for (const entity of this.sortEntitiesByBuildingPriority(this.entities)) {
      if (!entity.active) continue;
      const production = entity.getComponent(Production);
      const building = entity.getComponent(Building);
      const storage = entity.getComponent(Storage);
      if (!production || !building?.isComplete() || !building.isActive) continue;
      if (production.getTotalBuffered() > 0) return true;
      if (storage?.isProductionStorage) {
        for (const res of Object.keys(production.outputs)) {
          if (storage.getAmount(res) > 0) return true;
        }
      }
    }
    return false;
  }

  private recomputeTransportRoutes(): void {
    if (!this.baseCampEntity) return;
    this.cancelInvalidTransportTasks();
    const segments = roadSegmentManager.getSegments();
    transportManager.computeRoutes(segments, this.baseCampEntity.id);
    transportManager.clearBuildingRoutes();
    for (const entity of this.sortEntitiesByBuildingPriority(this.entities)) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (!building) continue;

      // Routes for production buildings with inputs
      const production = entity.getComponent(Production);
      if (production && production.hasInputs() && building.isComplete()) {
        transportManager.computeRoutesToBuilding(segments, entity.id);
      }

      const storage = entity.getComponent(Storage);
      if (
        building.isComplete() &&
        storage &&
        !storage.isProductionStorage &&
        storage.accepts?.includes('gold_coin')
      ) {
        transportManager.computeRoutesToBuilding(segments, entity.id);
      }

      // Routes for construction sites awaiting materials
      if (building.state === 'awaiting_materials') {
        transportManager.computeRoutesToBuilding(segments, entity.id);
      }
    }
    this.rescueStrandedItems();
  }

  private rescueStrandedItems(): void {
    const segments = roadSegmentManager.getSegments();
    const baseCampId = this.baseCampEntity?.id ?? null;
    const spawnTile = this.workers.getBaseCampSpawnTile();
    const baseCampStorage = this.baseCampEntity?.getComponent(Storage) ?? null;

    // Build lookup: position → segments containing that tile
    const posToSegments = new Map<string, RoadSegment[]>();
    for (const seg of segments) {
      for (const t of seg.tiles) {
        const key = `${t.x},${t.y}`;
        const list = posToSegments.get(key) || [];
        list.push(seg);
        posToSegments.set(key, list);
      }
    }

    // Check which positions are base camp entrance endpoints
    const baseCampEndpoints = new Set<string>();
    for (const seg of segments) {
      for (const ep of seg.endpoints) {
        if (ep.entityId === baseCampId) {
          baseCampEndpoints.add(`${ep.x},${ep.y}`);
        }
      }
    }

    // Collect all junction items, then drain
    const collected: {
      x: number;
      y: number;
      resourceType: string;
      destinationEntityId: number | null;
    }[] = [];
    for (const [key, items] of [...transportManager.getJunctionItemsMap().entries()]) {
      const [x, y] = key.split(',').map(Number);
      for (const item of items) {
        collected.push({
          x,
          y,
          resourceType: item.resourceType,
          destinationEntityId: item.destinationEntityId,
        });
      }
      while (transportManager.hasJunctionItems(x, y)) {
        transportManager.takeJunctionItem(x, y);
      }
    }

    if (collected.length === 0) return;

    // Re-add with corrected positions and destinations
    for (const { x, y, resourceType, destinationEntityId } of collected) {
      const key = `${x},${y}`;
      const segsHere = posToSegments.get(key);

      if (!segsHere || segsHere.length === 0) {
        // Not on any segment — deposit into base camp if possible, else move to spawn
        if (baseCampStorage) {
          baseCampStorage.addItem(resourceType, 1);
        } else if (spawnTile) {
          transportManager.addJunctionItem(spawnTile.x, spawnTile.y, resourceType, baseCampId);
        }
        continue;
      }

      // Check if original destination is routable from here
      let hasRoute = false;
      for (const seg of segsHere) {
        if (transportManager.getDirectionIndex(seg.id, destinationEntityId) !== undefined) {
          hasRoute = true;
          break;
        }
      }

      if (hasRoute) {
        transportManager.addJunctionItem(x, y, resourceType, destinationEntityId);
      } else {
        // Item has no route to its destination — deposit into base camp if at its entrance
        if (baseCampEndpoints.has(key) && baseCampStorage) {
          baseCampStorage.addItem(resourceType, 1);
          continue;
        }

        // Try redirecting to base camp from here
        let hasBaseCampRoute = false;
        for (const seg of segsHere) {
          if (transportManager.getDirectionIndex(seg.id, baseCampId) !== undefined) {
            hasBaseCampRoute = true;
            break;
          }
        }

        if (hasBaseCampRoute) {
          transportManager.addJunctionItem(x, y, resourceType, baseCampId);
        } else if (baseCampStorage) {
          baseCampStorage.addItem(resourceType, 1);
        } else if (spawnTile) {
          transportManager.addJunctionItem(spawnTile.x, spawnTile.y, resourceType, baseCampId);
        }
      }
    }
  }

  private cancelInvalidTransportTasks(): void {
    for (const segment of roadSegmentManager.getSegments()) {
      if (segment.assignedWorkerId === null) continue;
      const entity = this.entities.find(e => e.id === segment.assignedWorkerId && e.active);
      if (!entity) continue;
      const worker = entity.getComponent(Worker);
      if (!worker || !worker.transportTask) continue;
      const task = worker.transportTask;

      // Check if task positions still match this segment's endpoints
      const ep0 = segment.endpoints[0];
      const ep1 = segment.endpoints[1];
      const pickupMatch =
        (task.pickupPos.x === ep0.x && task.pickupPos.y === ep0.y) ||
        (task.pickupPos.x === ep1.x && task.pickupPos.y === ep1.y);
      const dropoffMatch =
        (task.dropoffPos.x === ep0.x && task.dropoffPos.y === ep0.y) ||
        (task.dropoffPos.x === ep1.x && task.dropoffPos.y === ep1.y);

      if (pickupMatch && dropoffMatch) continue;

      // Task is invalid — cancel it
      if (worker.carryingResource) {
        const p = entity.getComponent(Position);
        if (p) {
          const items =
            worker.carryingItems.length > 0
              ? worker.carryingItems
              : this.makeTransportLoadItems(
                  worker.carryingResource,
                  task.destEntityId,
                  Math.max(1, worker.carryingAmount || task.amount || 1)
                );
          for (const item of items) {
            transportManager.addJunctionItem(
              Math.floor(p.x),
              Math.floor(p.y),
              item.resourceType,
              item.destinationEntityId
            );
          }
        }
        worker.dropResource();
      } else if (task.phase === 'to_pickup' && task.sourceEntityId === null) {
        const items =
          task.items && task.items.length > 0
            ? task.items
            : this.makeTransportLoadItems(
                task.resourceType,
                task.destEntityId,
                Math.max(1, task.amount || 1)
              );
        transportManager.removePendingPickupItems(task.pickupPos.x, task.pickupPos.y, items);
        for (const item of items) {
          transportManager.addJunctionItem(
            task.pickupPos.x,
            task.pickupPos.y,
            item.resourceType,
            item.destinationEntityId
          );
        }
      }
      worker.transportTask = null;
      worker.setState('idle');
    }
  }

  private buildRoad(x: number, y: number): void {
    if (!this.isAreaExplored(x, y)) {
      return;
    }
    if (this.isDemolitionFireBlockingCell(x, y)) {
      return;
    }
    this.refreshTerritoryIfDirty();
    if (!this.territory.isInteriorCell(x, y, PLAYER_FACTION)) {
      return;
    }

    const tile = this.tileMap.getTile(x, y);
    if (!tile) return;

    const isExistingRoad = tile.hasRoad && !tile.isOccupied();

    // On first tile of a drag, lock the mode based on what's under the cursor
    if (this.roadDragMode === null) {
      this.roadDragMode = isExistingRoad ? 'delete' : 'create';
    }

    if (this.roadDragMode === 'delete') {
      if (!isExistingRoad) return;
      audioManager.playSound('demolish');
      tile.hasRoad = false;
      roadSegmentManager.removeRoad(x, y);
      this.scheduleSegmentRecalc();
      this.updateBuildingRoadConnections();
      this.workers.rerouteReturningWorkers();
    } else {
      if (this.tileMap.buildRoad(x, y)) {
        audioManager.playSound('road_build');
        roadSegmentManager.addRoad(x, y);
        this.scheduleSegmentRecalc();
        this.updateBuildingRoadConnections();
      }
    }
  }

  private canUseRoadPathCell(x: number, y: number): boolean {
    const tile = this.tileMap.getTile(x, y);
    if (!tile || !tile.isExplored()) return false;
    if (this.isDemolitionFireBlockingCell(x, y)) return false;
    this.refreshTerritoryIfDirty();
    if (!this.territory.isInteriorCell(x, y, PLAYER_FACTION)) return false;
    if (tile.hasRoad && !tile.isOccupied()) return true;
    return tile.terrain !== 'water' && tile.terrain !== 'mountain' && !tile.isOccupied();
  }

  private planRoadPath(
    from: { x: number; y: number },
    to: { x: number; y: number }
  ): { x: number; y: number }[] {
    return this.pathFinder.findBuildableRoadPath(from, to, this.tileMap, {
      canUseCell: (x, y) => this.canUseRoadPathCell(x, y),
      isExistingRoad: (x, y) => {
        const tile = this.tileMap.getTile(x, y);
        return !!(tile?.hasRoad && !tile.isOccupied());
      },
    });
  }

  private buildRoadPath(from: { x: number; y: number }, to: { x: number; y: number }): void {
    const path = this.planRoadPath(from, to);
    if (path.length === 0) {
      eventBus.emit('build:failed', { reason: 'No valid road path' });
      return;
    }

    this.roadDragMode = 'create';
    let built = 0;
    for (const cell of path) {
      const tile = this.tileMap.getTile(cell.x, cell.y);
      if (!tile || (tile.hasRoad && !tile.isOccupied())) continue;
      if (!this.canUseRoadPathCell(cell.x, cell.y)) continue;
      if (this.tileMap.buildRoad(cell.x, cell.y)) {
        roadSegmentManager.addRoad(cell.x, cell.y);
        built++;
      }
    }

    this.roadDragMode = null;
    if (built === 0) return;
    audioManager.playSound('road_build');
    this.flushSegmentRecalc();
    this.updateBuildingRoadConnections();
  }

  private findBuildingEntityAt(x: number, y: number): Entity | null {
    const found = this.entities.find(entity => {
      const pos = entity.getComponent(Position);
      const building = entity.getComponent(Building);
      if (!pos || !building) return false;
      return x >= pos.x && x < pos.x + building.width && y >= pos.y && y < pos.y + building.height;
    });
    return found ?? null;
  }

  private eraseAt(x: number, y: number): void {
    if (!this.isAreaExplored(x, y, 1, 1)) return;
    this.refreshTerritoryIfDirty();
    if (!this.territory.isInteriorCell(x, y, PLAYER_FACTION)) return;

    const buildingEntity = this.findBuildingEntityAt(x, y);
    if (buildingEntity) {
      if (!isPlayerOwned(buildingEntity)) return;
      const building = buildingEntity.getComponent(Building);
      const def = building ? dataManager.getBuilding(building.buildingType) : null;
      if (def?.isHeadquarters) return;

      this.destroyBuildingEntity(buildingEntity, 'erase_demolition');
      this.renderSystem.spawnEraseSmoke(x, y);
      eventBus.emit('erase:done');
      return;
    }

    const tile = this.tileMap.getTile(x, y);
    if (!tile) return;

    if (tile.hasRoad && !tile.isOccupied()) {
      audioManager.playSound('erase_demolition');
      tile.hasRoad = false;
      roadSegmentManager.removeRoad(x, y);
      this.scheduleSegmentRecalc();
      this.updateBuildingRoadConnections();
      this.workers.rerouteReturningWorkers();
      this.renderSystem.spawnEraseSmoke(x, y);
      eventBus.emit('erase:done');
      return;
    }

    if (tile.terrain === 'tree' || tile.terrain === 'forest') {
      this.tileMap.setTerrain(x, y, 'grass');
      this.renderSystem.updateMinimapTiles([{ x, y }]);
      audioManager.playSound('erase_demolition');
      this.renderSystem.spawnEraseSmoke(x, y);
      eventBus.emit('erase:done');
    }
  }

  /** Shared demolition path for Delete key and erase tool. */
  private destroyBuildingEntity(
    entity: Entity,
    demolishSound: 'demolish' | 'erase_demolition' = 'demolish',
    opts?: { retreatOwnerWorkers?: boolean }
  ): void {
    const pos = entity.getComponent(Position);
    const building = entity.getComponent(Building);

    if (!pos || !building) return;
    this.addDemolitionSite(pos.x, pos.y, building.width, building.height);

    if (building.state === 'awaiting_materials' && building.constructionMaterials) {
      const baseCampStorage = this.baseCampEntity?.getComponent(Storage);
      if (baseCampStorage) {
        for (const [res] of Object.entries(building.constructionMaterials)) {
          const delivered = building.materialsDelivered[res] || 0;
          if (delivered > 0) baseCampStorage.addItem(res, delivered);
        }
      }
    }

    if (building.militaryGarrison) {
      const garrisonWorkerIds: number[] = [];
      for (const slot of building.militaryGarrison) {
        if (!slot) continue;
        garrisonWorkerIds.push(slot.workerEntityId);
      }
      if (garrisonWorkerIds.length > 0) {
        if (isPlayerOwned(entity)) {
          this.workers.returnMilitaryGarrisonWorkers(entity, garrisonWorkerIds);
        } else {
          for (const workerId of garrisonWorkerIds) {
            const workerEntity = this.entities.find(e => e.id === workerId && e.active);
            if (workerEntity) this.removeEntity(workerEntity);
          }
        }
      }
      building.militaryGarrison = null;
    }

    if (building.assignedToolSpecialist) {
      if (isPlayerOwned(entity)) {
        const returnedVisibly = this.workers.returnAssignedToolSpecialistToHq(
          entity,
          building.assignedToolSpecialist
        );
        if (!returnedVisibly) this.addToolSpecialistToHqPool(building.assignedToolSpecialist, 1);
      }
      building.assignedToolSpecialist = null;
    }

    this.workers.detachWorkersForDestroyedBuilding(entity, opts);

    const entrance = building.getEntranceOffset();

    for (let dy = 0; dy < building.height; dy++) {
      for (let dx = 0; dx < building.width; dx++) {
        const t = this.tileMap.getTile(pos.x + dx, pos.y + dy);
        if (t && t.occupiedBy === entity.id) {
          t.release();
        }
      }
    }

    if (entrance) {
      const t = this.tileMap.getTile(pos.x + entrance.dx, pos.y + entrance.dy);
      if (t) t.hasRoad = false;
    } else if (building.width === 1 && building.height === 1 && !building.passable) {
      const t = this.tileMap.getTile(pos.x, pos.y);
      if (t) t.hasRoad = false;
    }

    audioManager.playSound(demolishSound);
    resourceManager.onBuildingDestroyed(entity.id);
    if (this.selectedEntity === entity) {
      this.selectedEntity = null;
    }
    console.log(`Deleted entity #${entity.id}`);
    this.removeEntity(entity);
    this.recomputePopulationMaxCapacity();
    this.syncInventory();
    this.updateSelectionUI();
    roadSegmentManager.recalculate(this.tileMap);
    this.recomputeTransportRoutes();
    this.updateBuildingRoadConnections();
    if (building && this.buildingAffectsTerritoryDisk(building.buildingType)) {
      this.markTerritoryDirty();
    }
  }

  private buildingAffectsTerritoryDisk(buildingType: BuildingType): boolean {
    if (buildingType === 'base_camp') return true;
    const def = dataManager.getBuilding(buildingType);
    return typeof def?.military?.territoryVisionRadius === 'number';
  }

  private getBaseCampConnectedRoads(): Set<string> {
    const connected = new Set<string>();
    if (!this.baseCampEntity) return connected;

    const baseCampPos = this.baseCampEntity.getComponent(Position);
    const baseCampBuilding = this.baseCampEntity.getComponent(Building);
    if (!baseCampPos || !baseCampBuilding) return connected;

    const hqId = this.baseCampEntity.id;
    /** HQ entrance road sits on an occupied tile; walkers use it, so it must be part of the graph. */
    const isHqRoadNetworkTile = (x: number, y: number): boolean => {
      const t = this.tileMap.getTile(x, y);
      if (!t || !t.hasRoad) return false;
      if (!t.isOccupied()) return true;
      return t.occupiedBy === hqId;
    };

    const entrance = baseCampBuilding.getEntranceOffset();
    if (!entrance) return connected;

    const entranceX = baseCampPos.x + entrance.dx;
    const entranceY = baseCampPos.y + entrance.dy;

    const queue: { x: number; y: number }[] = [];
    const seed = (x: number, y: number) => {
      const key = `${x},${y}`;
      if (connected.has(key)) return;
      if (!isHqRoadNetworkTile(x, y)) return;
      connected.add(key);
      queue.push({ x, y });
    };

    // Start from the HQ entrance road (occupied) so BFS can reach the first player-built road tile.
    seed(entranceX, entranceY);

    const cardinalDirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    while (queue.length > 0) {
      const { x, y } = queue.shift()!;
      for (const [dx, dy] of cardinalDirs) {
        const nx = x + dx;
        const ny = y + dy;
        const key = `${nx},${ny}`;
        if (connected.has(key)) continue;
        const neighbor = this.tileMap.getTile(nx, ny);
        if (
          neighbor &&
          neighbor.hasRoad &&
          (!neighbor.isOccupied() || neighbor.occupiedBy === hqId)
        ) {
          connected.add(key);
          queue.push({ x: nx, y: ny });
        }
      }
    }

    return connected;
  }

  private hasBuildingConnectedRoad(
    pos: Position,
    building: Building,
    connectedRoads: Set<string>
  ): boolean {
    const hasConnectedRoadAt = (x: number, y: number): boolean => connectedRoads.has(`${x},${y}`);
    const entrance = building.getEntranceOffset();
    if (entrance) {
      const ex = pos.x + entrance.dx;
      const ey = pos.y + entrance.dy;
      const dirs = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ];
      for (const [dx, dy] of dirs) {
        if (hasConnectedRoadAt(ex + dx, ey + dy)) return true;
      }
    }

    // Players read a building as connected when a road touches any side of its footprint.
    // The formal entrance tile still seeds transport, but connection status should match the visible edge.
    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (let dy = 0; dy < building.height; dy++) {
      for (let dx = 0; dx < building.width; dx++) {
        const x = pos.x + dx;
        const y = pos.y + dy;
        for (const [ox, oy] of dirs) {
          if (hasConnectedRoadAt(x + ox, y + oy)) return true;
        }
      }
    }
    return false;
  }

  private hasBuildingAdjacentRoad(pos: Position, building: Building): boolean {
    const entrance = building.getEntranceOffset();
    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    if (entrance) {
      const baseX = pos.x + entrance.dx;
      const baseY = pos.y + entrance.dy;
      for (const [dx, dy] of dirs) {
        if (this.tileMap.getTile(baseX + dx, baseY + dy)?.hasRoad) return true;
      }
    }
    for (let dy = 0; dy < building.height; dy++) {
      for (let dx = 0; dx < building.width; dx++) {
        const x = pos.x + dx;
        const y = pos.y + dy;
        for (const [ox, oy] of dirs) {
          if (this.tileMap.getTile(x + ox, y + oy)?.hasRoad) return true;
        }
      }
    }
    return false;
  }

  public updateBuildingRoadConnections(): void {
    const connectedRoads = this.getBaseCampConnectedRoads();

    for (const entity of this.entities) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      const pos = entity.getComponent(Position);
      if (!building || !pos || !building.requiresRoad) continue;

      building.isActive = isPlayerOwned(entity)
        ? this.hasBuildingConnectedRoad(pos, building, connectedRoads)
        : this.hasBuildingAdjacentRoad(pos, building);
    }

    this.recheckProductionInputDeliveries(true);
  }

  private canPlaceBuilding(
    x: number,
    y: number,
    width: number,
    height: number,
    ignoreEntityId?: number
  ): boolean {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const tile = this.tileMap.getTile(x + dx, y + dy);
        if (!tile) return false;

        if (!tile.walkable) return false;

        if (tile.isOccupied() && tile.occupiedBy !== ignoreEntityId) return false;
        if (this.isDemolitionFireBlockingCell(x + dx, y + dy)) return false;
      }
    }
    return true;
  }

  private isDemolitionFireBlockingCell(x: number, y: number): boolean {
    const now = this.simulationNowMs;
    return this.demolitionSites.some(
      site =>
        now - site.startedAt < DEMOLITION_FIRE_DURATION_MS &&
        x >= site.x &&
        x < site.x + site.width &&
        y >= site.y &&
        y < site.y + site.height
    );
  }

  private addDemolitionSite(x: number, y: number, width: number, height: number): void {
    this.demolitionSites.push({
      id: this.nextDemolitionSiteId++,
      x,
      y,
      width,
      height,
      startedAt: this.simulationNowMs,
    });
    this.syncDemolitionSitesToRender();
  }

  private cleanupDemolitionSites(): void {
    const expiresBefore =
      this.simulationNowMs - DEMOLITION_FIRE_DURATION_MS - DEMOLITION_SCORCH_DURATION_MS;
    const before = this.demolitionSites.length;
    this.demolitionSites = this.demolitionSites.filter(site => site.startedAt > expiresBefore);
    if (this.demolitionSites.length !== before) this.syncDemolitionSitesToRender();
  }

  private syncDemolitionSitesToRender(): void {
    this.renderSystem.setDemolitionSites(this.demolitionSites);
  }

  private occupyBuildingTiles(
    entityId: number,
    x: number,
    y: number,
    width: number,
    height: number,
    building?: Building
  ): void {
    const entrance = building?.getEntranceOffset();
    let roadsRemoved = false;
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const tile = this.tileMap.getTile(x + dx, y + dy);
        if (!tile) continue;

        if (entrance && dx === entrance.dx && dy === entrance.dy) {
          tile.occupy(entityId);
          tile.hasRoad = true;
          continue;
        }

        tile.occupy(entityId);
        if (tile.hasRoad) {
          tile.hasRoad = false;
          roadSegmentManager.removeRoad(x + dx, y + dy);
          roadsRemoved = true;
        }
      }
    }

    // 1x1 buildings use no entrance offset, but transport needs the footprint tile tagged
    // like a building entrance (occupied + hasRoad) so RoadSegmentManager associates
    // adjacent road nodes with this entity for computeRoutesToBuilding — otherwise
    // construction materials never leave base camp.
    let oneByOneTaggedForTransport = false;
    if (!entrance && width === 1 && height === 1 && building && !building.passable) {
      const tile = this.tileMap.getTile(x, y);
      if (tile) {
        tile.hasRoad = true;
        oneByOneTaggedForTransport = true;
      }
    }

    if (roadsRemoved || entrance || oneByOneTaggedForTransport) {
      roadSegmentManager.recalculate(this.tileMap);
      this.recomputeTransportRoutes();
    }
  }

  private buildBaseCamp(x: number, y: number): void {
    const baseCamp = createBaseCamp(x, y);
    const building = baseCamp.getComponent(Building);

    if (!building) return;

    this.addEntity(baseCamp);
    // Must be set before occupyBuildingTiles: recalculate uses getBaseCampConnectedRoads() → baseCampEntity.
    this.baseCampEntity = baseCamp;
    this.occupyBuildingTiles(baseCamp.id, x, y, building.width, building.height, building);

    this.recomputePopulationMaxCapacity();

    // Load starting resources into base camp storage
    const storage = baseCamp.getComponent(Storage);
    if (storage) {
      const startingResources = dataManager.getStartingResources();
      for (const [resource, amount] of Object.entries(startingResources)) {
        storage.addItem(resource, amount);
      }
    }
    this.syncInventory();

    console.log(`Base Camp (${building.width}x${building.height}) established at (${x}, ${y})`);
    console.log(`Starting inventory:`, this.inventory);
    console.log(
      `Population: ${this.population.current}/${this.population.max} (peasants / housing cap)`
    );
  }

  private seedEnemyVillages(playerCenterX: number, playerCenterY: number): void {
    const plans = planEnemyVillages(this.tileMap, {
      x: playerCenterX,
      y: playerCenterY,
    });
    if (plans.length === 0) {
      console.warn('Enemy village generation skipped: no valid sites.');
      return;
    }
    for (const plan of plans) {
      this.seedEnemyVillage(plan);
    }
    this.enemyRealms = plans;
    this.markTerritoryDirty();
    this.refreshTerritoryIfDirty();
    console.log(`${plans.length} enemy villages generated.`);
  }

  private seedEnemyVillage(plan: EnemyVillagePlan): void {
    this.flattenEnemyVillagePatch(plan.bounds);
    this.applyEnemyVillageWater(plan.waterCells);
    this.placeEnemyBuilding(plan.headquarters, plan.factionId, true);
    for (const buildingPlan of plan.buildings) {
      this.placeEnemyBuilding(buildingPlan, plan.factionId, false);
    }
    for (const road of plan.roads) {
      if (this.tileMap.buildRoad(road.x, road.y)) {
        roadSegmentManager.addRoad(road.x, road.y);
      }
    }
    this.revealCells(plan.revealCells);
    roadSegmentManager.recalculate(this.tileMap);
    this.updateBuildingRoadConnections();
    console.log(`${plan.factionId} village generated at (${plan.bounds.x}, ${plan.bounds.y})`);
  }

  private flattenEnemyVillagePatch(bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): void {
    for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
      for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
        const tile = this.tileMap.getTile(x, y);
        if (!tile || tile.isOccupied()) continue;
        if (tile.terrain === 'grass') continue;
        this.tileMap.setTerrain(x, y, 'grass');
      }
    }
  }

  private applyEnemyVillageWater(cells: { x: number; y: number }[]): void {
    for (const cell of cells) {
      const tile = this.tileMap.getTile(cell.x, cell.y);
      if (!tile || tile.isOccupied()) continue;
      this.tileMap.setTerrain(cell.x, cell.y, 'water');
      tile.hasRoad = false;
    }
  }

  private revealCells(cells: { x: number; y: number }[]): void {
    const newly: { x: number; y: number }[] = [];
    for (const cell of cells) {
      const tile = this.tileMap.getTile(cell.x, cell.y);
      if (!tile || tile.isExplored()) continue;
      tile.explore();
      newly.push(cell);
    }
    if (newly.length > 0) this.renderSystem.updateMinimapTiles(newly);
  }

  private placeEnemyBuilding(
    plan: EnemyVillageBuildingPlan,
    factionId: FactionId,
    isHeadquarters: boolean
  ): Entity | null {
    const entity = createBuilding(plan.type, plan.x, plan.y);
    setEntityFaction(entity, factionId);
    const building = entity.getComponent(Building);
    if (!building) return null;
    building.state = 'complete';
    building.constructionStartedAt = null;
    building.constructionProgress = 1;
    building.completedAt = this.simulationNowMs;
    building.hasOperator = true;

    this.addEntity(entity);
    this.occupyBuildingTiles(entity.id, plan.x, plan.y, building.width, building.height, building);
    if (isHeadquarters) {
      const storage = entity.getComponent(Storage);
      if (storage) {
        const stock: Partial<Record<ResourceType, number>> = {
          wood_log: 20,
          wood_plank: 30,
          stone: 24,
          iron_bar: 8,
          gold_coin: 8,
          sword: 8,
          shield: 8,
          bread: 16,
          fish: 12,
          ham: 10,
          axe: 3,
          saw: 2,
          pickaxe: 2,
          hammer: 3,
        };
        for (const [resource, amount] of Object.entries(stock)) {
          storage.addItem(resource, amount ?? 0);
        }
      }
    }

    if (plan.seedGarrison) {
      const cap = dataManager.getBuilding(plan.type)?.military?.soldierCapacity;
      if (typeof cap === 'number' && cap > 0) {
        building.initMilitaryGarrison(cap);
        const fillRatio = Math.max(0.1, Math.min(1, plan.garrisonFillRatio ?? 0.5));
        const fillCount = Math.min(cap, Math.max(1, Math.ceil(cap * fillRatio)));
        const rank = plan.garrisonRank ?? 1;
        for (let i = 0; i < fillCount; i++) {
          const soldier = createMilitaryWorker(plan.x + 0.5, plan.y + 0.5, rank);
          setEntityFaction(soldier, factionId);
          const worker = soldier.getComponent(Worker);
          if (worker) {
            worker.concealedInBuildingId = entity.id;
            worker.setState('idle');
          }
          this.addEntity(soldier);
          building.assignMilitarySlot(i, soldier.id);
          if (rank > 1 && building.militaryGarrison?.[i]) {
            building.militaryGarrison[i] = { rank, workerEntityId: soldier.id };
          }
        }
      }
    }

    return entity;
  }

  private seedEnemyFarmWorker(farmEntity: Entity, factionId: FactionId): void {
    const pos = farmEntity.getComponent(Position);
    const building = farmEntity.getComponent(Building);
    if (!pos || !building) return;
    const candidates = [
      { x: pos.x - 1, y: pos.y + building.height },
      { x: pos.x, y: pos.y + building.height },
      { x: pos.x + building.width, y: pos.y + 1 },
      { x: pos.x + building.width, y: pos.y + building.height },
    ];
    const spot = candidates.find(c => {
      const tile = this.tileMap.getTile(c.x, c.y);
      return tile && tile.walkable && !tile.isOccupied() && !tile.hasRoad;
    });
    if (!spot) return;
    const workerEntity = createWorker(spot.x, spot.y);
    setEntityFaction(workerEntity, factionId);
    const worker = workerEntity.getComponent(Worker);
    if (worker) {
      worker.pickUpResource('scythe');
      worker.visualActivity = 'production_gather';
      worker.setState('working');
    }
    this.addEntity(workerEntity);
  }

  private seedEnemyStreetWorkers(plan: EnemyVillagePlan): void {
    const roadCells = plan.roads.filter(cell => {
      const tile = this.tileMap.getTile(cell.x, cell.y);
      return tile?.hasRoad && !tile.isOccupied();
    });
    if (roadCells.length === 0) return;

    const count = Math.min(5, Math.max(2, Math.floor(roadCells.length / 8)));
    for (let i = 0; i < count; i++) {
      const start = roadCells[Math.floor((i / count) * roadCells.length)]!;
      const end = roadCells[Math.floor(((i + 0.5) / count) * roadCells.length) % roadCells.length]!;
      const workerEntity = createWorker(start.x, start.y);
      setEntityFaction(workerEntity, plan.factionId);
      const worker = workerEntity.getComponent(Worker);
      const movable = workerEntity.getComponent(Movable);
      if (worker) worker.setState('idle');
      if (movable && (start.x !== end.x || start.y !== end.y)) {
        const path = this.pathFinder.findPath(
          new Position(start.x, start.y),
          new Position(end.x, end.y),
          this.tileMap
        );
        if (path.length > 0) {
          movable.speed = 1.2;
          movable.setPath(path);
          if (worker) worker.setState('walking');
        }
      }
      this.addEntity(workerEntity);
    }
  }

  private seedEnemyRealmDecorations(realm: EnemyVillagePlan): void {
    for (const entity of this.entities) {
      if (!entity.active || getEntityFaction(entity) !== realm.factionId) continue;
      const building = entity.getComponent(Building);
      if (building?.buildingType === 'farm') {
        this.seedEnemyFarmWorker(entity, realm.factionId);
      }
    }
    this.seedEnemyStreetWorkers(realm);
  }

  private seedLoadedEnemyDecorations(): void {
    for (const realm of this.enemyRealms) {
      if (realm.activated === true) this.seedEnemyRealmDecorations(realm);
    }
  }

  /** Housing cap = starting population baseline + completed residential `provides` (hut, house, …). */
  private recomputePopulationMaxCapacity(): void {
    const baseline = dataManager.getStartingPopulation();
    let extra = 0;
    for (const entity of this.entities) {
      if (!entity.active) continue;
      if (!isPlayerOwned(entity)) continue;
      const b = entity.getComponent(Building);
      if (!b?.isComplete()) continue;
      if (b.buildingType === 'base_camp') continue;
      const def = dataManager.getBuilding(b.buildingType);
      const add = def?.population?.provides;
      if (typeof add === 'number' && add > 0) extra += add;
    }
    this.population.max = baseline + extra;
  }

  private buildGeneric(buildingType: BuildingType, x: number, y: number): void {
    // Get building definition
    const buildingDef = dataManager.getBuilding(buildingType);
    if (!buildingDef) {
      console.error(`Unknown building type: ${buildingType}`);
      return;
    }

    // Fog + settlement placement (interior or military cordon-touch rule)
    if (!this.isAreaExplored(x, y, buildingDef.size.width, buildingDef.size.height)) {
      eventBus.emit('build:failed', {
        reason: 'Cannot build in unexplored area',
      });
      return;
    }

    this.refreshTerritoryIfDirty();
    if (
      !this.territory.isInteriorFootprint(
        x,
        y,
        buildingDef.size.width,
        buildingDef.size.height,
        PLAYER_FACTION
      )
    ) {
      eventBus.emit('build:failed', {
        reason:
          'Build only inside your settlement, not on the cordon, contested cells, or enemy land.',
      });
      return;
    }

    // Check if space is available
    if (!this.canPlaceBuilding(x, y, buildingDef.size.width, buildingDef.size.height, undefined)) {
      eventBus.emit('build:failed', { reason: 'Cannot build here' });
      return;
    }

    // Create building entity
    const entity = createBuilding(buildingType, x, y);
    const building = entity.getComponent(Building);

    if (!building) return;

    const isMilitaryPost =
      typeof buildingDef.military?.soldierCapacity === 'number' &&
      buildingDef.military.soldierCapacity > 0;
    // Set construction state based on whether building has deliverable material costs.
    const hasCosts = Object.values(buildingDef.buildCost).some(v => v > 0);
    if (building.buildTimeSec > 0) {
      if (hasCosts) {
        building.startAwaitingMaterials(building.buildTimeSec, buildingDef.buildCost);
      } else if (isMilitaryPost) {
        // No carts needed, but keep the visible builder arrival -> build -> return sequence.
        building.startAwaitingMaterials(building.buildTimeSec, {});
      } else {
        building.startConstruction(building.buildTimeSec, this.simulationNowMs);
      }
    }

    this.addEntity(entity);
    this.occupyBuildingTiles(entity.id, x, y, building.width, building.height, building);

    if (building.isComplete()) {
      this.recomputePopulationMaxCapacity();
      this.tryFinalizeWellAquifer(entity);
    }

    audioManager.playSound('build_placed');
    this.updateBuildingRoadConnections();
    this.recheckConstructionMaterials(true);
    this.recheckProductionInputDeliveries(true);
    eventBus.emit('build:success');
    console.log(
      `${buildingDef.name} (${building.width}x${building.height}) placed at (${x}, ${y}) — ${building.state}`
    );
  }

  private getToolSpecialistsAtHqCount(): number {
    return Object.values(this.toolSpecialistsAtHq).reduce((sum, n) => sum + n, 0);
  }

  private getToolSpecialistsAssignedToBuildingsCount(): number {
    let n = 0;
    for (const e of this.entities) {
      if (!e.active) continue;
      if (!isPlayerOwned(e)) continue;
      const b = e.getComponent(Building);
      if (b?.assignedToolSpecialist) n++;
    }
    return n;
  }

  private getToolSpecialistsInTransitCount(): number {
    return Object.values(this.workers.getToolDispatchCounts()).reduce((sum, n) => sum + n, 0);
  }

  private getTotalToolSpecialistsCount(): number {
    return (
      this.getToolSpecialistsAtHqCount() +
      this.getToolSpecialistsAssignedToBuildingsCount() +
      this.getToolSpecialistsInTransitCount()
    );
  }

  private getTotalMilitarySpecialistsCount(): number {
    let activeMilitaryWorkers = 0;
    for (const e of this.entities) {
      if (!e.active) continue;
      if (!isPlayerOwned(e)) continue;
      const w = e.getComponent(Worker);
      if (w?.role === 'military') activeMilitaryWorkers++;
    }
    return this.militarySpecialistsAtHq + activeMilitaryWorkers;
  }

  private claimToolSpecialistForDispatch(tool: string): boolean {
    const pooled = this.toolSpecialistsAtHq[tool] || 0;
    if (pooled > 0) {
      this.toolSpecialistsAtHq[tool] = pooled - 1;
      return true;
    }

    if (this.getAvailablePopulation() <= 0) return false;
    const hqStorage = this.baseCampEntity?.getComponent(Storage);
    if (!hqStorage || hqStorage.getAmount(tool) < 1) return false;
    hqStorage.removeItem(tool, 1);
    this.syncInventory();
    return true;
  }

  private addToolSpecialistToHqPool(tool: string, count: number = 1): void {
    if (count <= 0) return;
    this.toolSpecialistsAtHq[tool] = (this.toolSpecialistsAtHq[tool] || 0) + count;
  }

  private consumeMilitarySpecialistFromHqPool(): boolean {
    if (this.militarySpecialistsAtHq <= 0) return false;
    this.militarySpecialistsAtHq--;
    return true;
  }

  private addMilitarySpecialistToHqPool(count: number = 1): void {
    if (count <= 0) return;
    this.militarySpecialistsAtHq += count;
  }

  private onDonkeyReturnedToHq(): void {
    this.donkeysAtHq++;
    eventBus.emit('resource:updated');
  }

  public getDonkeysAtHq(): number {
    return this.donkeysAtHq;
  }

  private countAssignedDonkeys(): number {
    let n = 0;
    for (const seg of roadSegmentManager.getSegments()) {
      if (seg.assignedWorkerId == null) continue;
      const entity = this.entities.find(e => e.id === seg.assignedWorkerId && e.active);
      const worker = entity?.getComponent(Worker);
      if (worker?.carrierType === 'donkey') n++;
    }
    return n;
  }

  private getRoadSegmentForWorkerId(workerId: number): RoadSegment | null {
    return roadSegmentManager.getSegments().find(seg => seg.assignedWorkerId === workerId) ?? null;
  }

  public canReplaceRoadWorkerWithDonkey(workerEntityId: number): boolean {
    const entity = this.entities.find(e => e.id === workerEntityId && e.active);
    const worker = entity?.getComponent(Worker);
    if (!worker || !this.getRoadSegmentForWorkerId(workerEntityId)) return false;
    if (worker.carrierType === 'donkey') return false;
    return this.donkeysAtHq > 0 || this.countAssignedDonkeys() > 0;
  }

  public canReturnRoadDonkeyToHq(workerEntityId: number): boolean {
    const entity = this.entities.find(e => e.id === workerEntityId && e.active);
    const worker = entity?.getComponent(Worker);
    return (
      !!worker &&
      !!this.getRoadSegmentForWorkerId(workerEntityId) &&
      worker.carrierType === 'donkey'
    );
  }

  public returnRoadDonkeyToHq(workerEntityId: number): boolean {
    const entity = this.entities.find(e => e.id === workerEntityId && e.active);
    const worker = entity?.getComponent(Worker);
    const segment = this.getRoadSegmentForWorkerId(workerEntityId);
    if (!entity || !worker || !segment || worker.carrierType !== 'donkey') {
      return false;
    }

    this.cancelRoadWorkerTransportForReassignment(entity);
    const replacement = this.dispatchRoadCarrierFromHq(segment, 'worker');
    if (!replacement) return false;
    segment.assignedWorkerId = replacement.id;
    worker.returnToHqAsDonkey = true;
    if (!this.workers.returnRoadSegmentWorkerToHq(entity)) {
      this.removeEntity(entity);
      this.onDonkeyReturnedToHq();
    }
    eventBus.emit('resource:updated');
    return true;
  }

  public replaceRoadWorkerWithDonkey(workerEntityId: number): boolean {
    const entity = this.entities.find(e => e.id === workerEntityId && e.active);
    const worker = entity?.getComponent(Worker);
    const targetSegment = this.getRoadSegmentForWorkerId(workerEntityId);
    if (!entity || !worker || !targetSegment) return false;
    if (worker.carrierType === 'donkey') return false;

    if (this.donkeysAtHq > 0) {
      this.donkeysAtHq--;
      this.cancelRoadWorkerTransportForReassignment(entity);
      const replacement = this.dispatchRoadCarrierFromHq(targetSegment, 'donkey');
      if (!replacement) {
        this.donkeysAtHq++;
        return false;
      }
      targetSegment.assignedWorkerId = replacement.id;
      if (!this.workers.returnRoadSegmentWorkerToHq(entity)) {
        this.removeEntity(entity);
      }
      eventBus.emit('resource:updated');
      return true;
    } else {
      const donorSegment = roadSegmentManager.getSegments().find(seg => {
        if (seg.assignedWorkerId === workerEntityId || seg.assignedWorkerId == null) return false;
        const donorEntity = this.entities.find(e => e.id === seg.assignedWorkerId && e.active);
        return donorEntity?.getComponent(Worker)?.carrierType === 'donkey';
      });
      const donor =
        donorSegment?.assignedWorkerId != null
          ? this.entities.find(e => e.id === donorSegment.assignedWorkerId && e.active)
          : null;
      const donorWorker = donor?.getComponent(Worker);
      if (!donorSegment || !donor || !donorWorker) return false;

      this.cancelRoadWorkerTransportForReassignment(donor);
      this.cancelRoadWorkerTransportForReassignment(entity);

      const donorReplacement = this.dispatchRoadCarrierFromHq(donorSegment, 'worker');
      if (!donorReplacement) return false;
      donorSegment.assignedWorkerId = donorReplacement.id;
      targetSegment.assignedWorkerId = donor.id;
      this.workers.moveRoadSegmentWorkerToSegment(donor.id, targetSegment);
      if (!this.workers.returnRoadSegmentWorkerToHq(entity)) {
        this.removeEntity(entity);
      }
      eventBus.emit('resource:updated');
      return true;
    }
  }

  private dispatchRoadCarrierFromHq(
    segment: RoadSegment,
    carrierType: 'worker' | 'donkey'
  ): Entity | null {
    const spawnTile = this.workers.getBaseCampSpawnTile();
    if (!spawnTile) return null;
    const entity = createWorker(spawnTile.x, spawnTile.y);
    const worker = entity.getComponent(Worker);
    if (worker && carrierType === 'donkey') {
      worker.carrierType = 'donkey';
      worker.transportCarryCapacity = 5;
      worker.name = 'Donkey';
    }
    this.addEntity(entity);
    this.workers.restoreRoadSegmentWorker(entity.id);
    this.workers.moveRoadSegmentWorkerToSegment(entity.id, segment);
    return entity;
  }

  private cancelRoadWorkerTransportForReassignment(entity: Entity): void {
    const worker = entity.getComponent(Worker);
    if (!worker?.transportTask) return;
    const task = worker.transportTask;
    if (worker.carryingResource) {
      const pos = entity.getComponent(Position);
      if (pos) {
        const items =
          worker.carryingItems.length > 0
            ? worker.carryingItems
            : this.makeTransportLoadItems(
                worker.carryingResource,
                task.destEntityId,
                Math.max(1, worker.carryingAmount || task.amount || 1)
              );
        for (const item of items) {
          transportManager.addJunctionItem(
            Math.floor(pos.x),
            Math.floor(pos.y),
            item.resourceType,
            item.destinationEntityId
          );
        }
      }
      worker.dropResource();
    } else if (task.phase === 'to_pickup' && task.sourceEntityId === null) {
      const items =
        task.items && task.items.length > 0
          ? task.items
          : this.makeTransportLoadItems(
              task.resourceType,
              task.destEntityId,
              Math.max(1, task.amount || 1)
            );
      transportManager.removePendingPickupItems(task.pickupPos.x, task.pickupPos.y, items);
      for (const item of items) {
        transportManager.addJunctionItem(
          task.pickupPos.x,
          task.pickupPos.y,
          item.resourceType,
          item.destinationEntityId
        );
      }
    }
    worker.transportTask = null;
    worker.setState('idle');
  }

  public getSpecializedWorkersSummary(): Array<{
    id: string;
    label: string;
    employed: number;
    total: number;
    hqReady: number;
    iconResourceId: string;
  }> {
    const rows: Array<{
      id: string;
      label: string;
      employed: number;
      total: number;
      hqReady: number;
      iconResourceId: string;
    }> = [];
    const flavorByTool: Record<string, string> = {
      axe: 'Woodcutter',
      saw: 'Sawyer',
      pickaxe: 'Miner',
      shovel: 'Digger',
      fishing_rod: 'Fisher',
      scythe: 'Farmer',
      hammer: 'Builder',
      rolling_pin: 'Baker',
      crucible: 'Smelter',
      tongs: 'Blacksmith',
      cleaver: 'Butcher',
      bow: 'Hunter',
    };
    const toolDispatch = this.workers.getToolDispatchCounts();
    const toolAssigned: Record<string, number> = {};
    for (const e of this.entities) {
      if (!e.active) continue;
      if (!isPlayerOwned(e)) continue;
      const b = e.getComponent(Building);
      if (!b?.assignedToolSpecialist) continue;
      toolAssigned[b.assignedToolSpecialist] = (toolAssigned[b.assignedToolSpecialist] || 0) + 1;
    }

    const toolIds = new Set<string>();
    for (const building of dataManager.getAllBuildings()) {
      if (building.requiredTool) toolIds.add(building.requiredTool);
    }
    for (const tool of Object.keys(this.toolSpecialistsAtHq)) toolIds.add(tool);
    for (const tool of Object.keys(toolDispatch)) toolIds.add(tool);
    for (const tool of Object.keys(toolAssigned)) toolIds.add(tool);

    for (const tool of toolIds) {
      const atHq = this.toolSpecialistsAtHq[tool] || 0;
      const employed = (toolDispatch[tool] || 0) + (toolAssigned[tool] || 0);
      const total = atHq + employed;
      const resName = dataManager.getResource(tool as ResourceType)?.name || tool;
      const flavor = flavorByTool[tool];
      const label = flavor ? `${flavor} (${resName})` : `${resName} Specialist`;
      rows.push({
        id: `tool:${tool}`,
        label,
        employed,
        total,
        hqReady: atHq,
        iconResourceId: tool,
      });
    }

    const militaryTotal = this.getTotalMilitarySpecialistsCount();
    rows.push({
      id: 'military',
      label: 'Soldier (Sword + Shield)',
      employed: Math.max(0, militaryTotal - this.militarySpecialistsAtHq),
      total: militaryTotal,
      hqReady: this.militarySpecialistsAtHq,
      iconResourceId: 'sword',
    });

    rows.push({
      id: 'donkey',
      label: 'Donkey',
      employed: this.countAssignedDonkeys(),
      total: this.donkeysAtHq + this.countAssignedDonkeys(),
      hqReady: this.donkeysAtHq,
      iconResourceId: 'donkey',
    });

    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }

  public getAvailablePopulation(): number {
    return (
      this.population.current -
      this.workers.getPlayerRoadSegmentWorkerCount() -
      this.workers.getReservedPopulationCount() -
      this.getTotalToolSpecialistsCount() -
      this.getTotalMilitarySpecialistsCount()
    );
  }

  /** Soldiers inside military posts (not available for roads / HQ dispatch). */
  public getTotalMilitaryGarrisonedCount(): number {
    let n = 0;
    for (const e of this.entities) {
      if (!e.active) continue;
      if (!isPlayerOwned(e)) continue;
      const b = e.getComponent(Building);
      if (b?.militaryGarrison) n += b.getMilitaryGarrisonFilledCount();
    }
    return n;
  }

  /**
   * Assemble one soldier at HQ (1× worker slot + sword + shield), walk to the target military building.
   * Weapons must already be in HQ storage (delivered by road workers from the armory).
   * @param opts.silent — no on-screen toasts (used by automatic garrison fill).
   */
  public trainMilitary(buildingEntity: Entity, opts?: { silent?: boolean }): boolean {
    const silent = opts?.silent ?? false;
    const toastFail = (msg: string) => {
      if (silent) return;
      const hp = this.inputSystem.hoverGridPos;
      if (hp) {
        const sp = this.renderSystem.gridToScreen(hp.x, hp.y);
        this.renderSystem.showToast(msg, sp.x, sp.y);
      } else {
        const canvas = this.renderSystem['canvas'] as HTMLCanvasElement | undefined;
        const w = canvas?.clientWidth ?? 800;
        this.renderSystem.showToast(msg, w * 0.5, 96);
      }
    };

    const building = buildingEntity.getComponent(Building);
    const def = building ? dataManager.getBuilding(building.buildingType as BuildingType) : null;
    const cap = def?.military?.soldierCapacity;
    if (!this.baseCampEntity || !building || !def || typeof cap !== 'number' || cap <= 0)
      return false;
    if (!isPlayerOwned(buildingEntity)) return false;
    if (!building.isComplete() || !building.isActive) return false;
    if (this.hasMilitaryFromBuildingInActiveAttack(buildingEntity.id)) return false;

    building.initMilitaryGarrison(cap);
    if (building.findFreeMilitarySlotIndex() < 0) {
      toastFail('Garrison is full');
      return false;
    }
    const pending = this.workers.countMilitaryDispatchToBuilding(buildingEntity.id);
    const emptySlots = building.militaryGarrison!.filter(s => s == null).length;
    if (pending >= emptySlots) {
      toastFail('Every free slot already has a soldier marching to this post');
      return false;
    }
    const usePooledMilitary = this.militarySpecialistsAtHq > 0;
    if (!usePooledMilitary) {
      if (this.getAvailablePopulation() <= 0) {
        toastFail('No free settlers');
        return false;
      }

      const hqStorage = this.baseCampEntity.getComponent(Storage);
      if (!hqStorage || hqStorage.getAmount('sword') < 1 || hqStorage.getAmount('shield') < 1) {
        toastFail('Need sword and shield at HQ (not only in armory buffer)');
        return false;
      }
    }

    const spawnTile = this.workers.getBaseCampSpawnTile();
    const roadGoal = this.workers.getBuildingDispatchRoadTile(buildingEntity);
    if (!spawnTile || !roadGoal) {
      toastFail('No road to HQ or fort entrance');
      return false;
    }

    const path = this.pathFinder.findPath(
      new Position(spawnTile.x, spawnTile.y),
      new Position(roadGoal.x, roadGoal.y),
      this.tileMap
    );
    if (path.length === 0) {
      toastFail('No road path from HQ to this fort — connect both to the same road network');
      return false;
    }

    if (usePooledMilitary) {
      // Pool count was validated above; consume only after dispatch path is confirmed.
      this.consumeMilitarySpecialistFromHqPool();
    } else {
      const hqStorage = this.baseCampEntity.getComponent(Storage);
      if (!hqStorage || hqStorage.getAmount('sword') < 1 || hqStorage.getAmount('shield') < 1) {
        toastFail('Need sword and shield at HQ (not only in armory buffer)');
        return false;
      }
      hqStorage.removeItem('sword', 1);
      hqStorage.removeItem('shield', 1);
      this.syncInventory();
    }

    const soldier = createMilitaryWorker(spawnTile.x, spawnTile.y, 1);
    this.addEntity(soldier);
    const w = soldier.getComponent(Worker);
    if (w) w.setState('idle');
    this.workers.queueHqStreetEntry(soldier, path);
    this.workers.beginMilitaryDispatch(soldier.id, buildingEntity.id);
    if (!silent) {
      const hp = this.inputSystem.hoverGridPos;
      if (hp) {
        const sp = this.renderSystem.gridToScreen(hp.x, hp.y);
        this.renderSystem.showToast('Soldier marching from HQ', sp.x, sp.y);
      } else {
        const canvasEl = (this.renderSystem as unknown as { canvas: HTMLCanvasElement }).canvas;
        this.renderSystem.showToast('Soldier marching from HQ', canvasEl.clientWidth * 0.5, 96);
      }
    }
    return true;
  }

  /**
   * When a military post has empty slots, HQ holds a sword+shield pair, and a path exists,
   * train one soldier (same rules as the popover). Runs on the production-input recheck timer.
   */
  private tryAutoTrainMilitaryGarrisons(): void {
    if (!this.baseCampEntity) return;
    for (let round = 0; round < 16; round++) {
      let trainedThisRound = false;
      for (const entity of this.entities) {
        if (!entity.active) continue;
        if (!isPlayerOwned(entity)) continue;
        const building = entity.getComponent(Building);
        const def = building
          ? dataManager.getBuilding(building.buildingType as BuildingType)
          : null;
        const cap = def?.military?.soldierCapacity;
        if (!building?.isComplete() || !building.isActive || typeof cap !== 'number' || cap <= 0)
          continue;
        if (this.hasMilitaryFromBuildingInActiveAttack(entity.id)) continue;
        building.initMilitaryGarrison(cap);
        if (building.findFreeMilitarySlotIndex() < 0) continue;
        const emptySlots = building.militaryGarrison!.filter(s => s == null).length;
        const pending = this.workers.countMilitaryDispatchToBuilding(entity.id);
        if (pending >= emptySlots) continue;

        if (this.trainMilitary(entity, { silent: true })) {
          trainedThisRound = true;
        }
      }
      if (!trainedThisRound) break;
    }
  }

  private hasMilitaryFromBuildingInActiveAttack(buildingEntityId: number): boolean {
    return this.activeEnemyAttacks.some(
      attack =>
        attack.phase !== 'complete' &&
        (attack.attackers.some(p => p.sourceBuildingId === buildingEntityId) ||
          attack.defenders.some(p => p.sourceBuildingId === buildingEntityId) ||
          attack.returnAssignments.some(p => p.buildingEntityId === buildingEntityId))
    );
  }

  /**
   * Replenishes lost junction items and fills gaps when HQ inventory cannot pay again.
   * Build cost is deducted once at place time; `materialsSent` is how many were queued for physical
   * delivery. If items disappear from the spawn tile / route, `storage` may be empty — we must still
   * spawn junction entries without a second deduction (same goods already paid for).
   */
  private recheckConstructionMaterials(force = false): void {
    if (!this.baseCampEntity) return;
    const now = this.simulationNowMs;
    if (!force && now - this.lastMaterialCheckTime < 2000) return;
    this.lastMaterialCheckTime = now;

    const storage = this.baseCampEntity.getComponent(Storage);
    if (!storage) return;
    const spawnTile = this.workers.getBaseCampSpawnTile();
    if (!spawnTile) return;

    for (const entity of this.sortEntitiesByBuildingPriority(this.entities)) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (!building || building.state !== 'awaiting_materials') continue;
      if (!building.constructionMaterials) continue;
      if (!building.isActive) continue;

      for (const [res, needed] of Object.entries(building.constructionMaterials)) {
        const delivered = building.materialsDelivered[res] || 0;
        const remaining = needed - delivered;
        if (remaining <= 0) continue;

        // Count in-transit: junction items + pending visuals + workers carrying for this building
        let inTransit = 0;

        for (const [, items] of transportManager.getJunctionItemsMap()) {
          for (const item of items) {
            if (item.destinationEntityId === entity.id && item.resourceType === res) {
              inTransit++;
            }
          }
        }

        for (const [, items] of transportManager.getPendingPickupVisualsMap()) {
          for (const item of items) {
            if (item.destinationEntityId === entity.id && item.resourceType === res) {
              inTransit++;
            }
          }
        }

        for (const seg of roadSegmentManager.getSegments()) {
          if (seg.assignedWorkerId === null) continue;
          const workerEntity = this.entities.find(e => e.id === seg.assignedWorkerId && e.active);
          if (!workerEntity) continue;
          const worker = workerEntity.getComponent(Worker);
          if (!worker?.transportTask) continue;
          if (worker.carryingItems.length > 0) {
            inTransit +=
              worker.carryingItems.length > 0
                ? worker.carryingItems.filter(
                    item => item.destinationEntityId === entity.id && item.resourceType === res
                  ).length
                : 0;
          } else if (
            worker.transportTask.destEntityId === entity.id &&
            worker.transportTask.resourceType === res
          ) {
            inTransit += Math.max(1, worker.carryingAmount || worker.transportTask.amount || 1);
          }
        }

        const sent = building.materialsSent[res] || 0;
        // Goods already paid for at build time but missing from the pipe (e.g. route reset, stranded)
        const prepaidGap = sent - delivered - inTransit;
        if (prepaidGap > 0) {
          const addPrepaid = Math.min(prepaidGap, remaining - inTransit);
          for (let i = 0; i < addPrepaid; i++) {
            transportManager.addJunctionItem(spawnTile.x, spawnTile.y, res, entity.id);
          }
          inTransit += addPrepaid;
        }

        // Brand-new dispatch from stock (e.g. initial place had no spawn or extra materials)
        const stillNeed = remaining - inTransit;
        if (stillNeed <= 0) continue;

        for (let i = 0; i < stillNeed; i++) {
          if (storage.getAmount(res) <= 0) break;
          storage.removeItem(res, 1);
          transportManager.addJunctionItem(spawnTile.x, spawnTile.y, res, entity.id);
          building.materialsSent[res] = (building.materialsSent[res] || 0) + 1;
        }
      }
    }
  }

  /**
   * Goods in the transport pipe to a building (junction, pickup visual, or worker en route).
   * Junction-origin hauls in `to_pickup` are represented by pending visuals only — do not also count
   * the worker or we double-count reserved storage slots.
   */
  private countInTransitToBuilding(destEntityId: number): number {
    let inTransit = 0;

    for (const [, items] of transportManager.getJunctionItemsMap()) {
      for (const item of items) {
        if (item.destinationEntityId === destEntityId) inTransit++;
      }
    }

    for (const [, items] of transportManager.getPendingPickupVisualsMap()) {
      for (const item of items) {
        if (item.destinationEntityId === destEntityId) inTransit++;
      }
    }

    for (const seg of roadSegmentManager.getSegments()) {
      if (seg.assignedWorkerId === null) continue;
      const workerEntity = this.entities.find(e => e.id === seg.assignedWorkerId && e.active);
      if (!workerEntity) continue;
      const worker = workerEntity.getComponent(Worker);
      const task = worker?.transportTask;
      if (!task || task.destEntityId !== destEntityId) continue;
      if (task.phase === 'to_dropoff') {
        inTransit += worker?.carryingItems.length
          ? worker.carryingItems.filter(item => item.destinationEntityId === destEntityId).length
          : Math.max(1, worker?.carryingAmount || task.amount || 1);
      } else if (task.phase === 'to_pickup' && task.sourceEntityId != null) {
        inTransit += Math.max(1, task.amount || 1);
      }
    }

    return inTransit;
  }

  /** In-transit units of a specific resource bound for this building (junction, visuals, road workers). */
  private countInTransitToBuildingForResource(destEntityId: number, resourceType: string): number {
    let n = 0;

    for (const [, items] of transportManager.getJunctionItemsMap()) {
      for (const item of items) {
        if (item.destinationEntityId === destEntityId && item.resourceType === resourceType) {
          n++;
        }
      }
    }

    for (const [, items] of transportManager.getPendingPickupVisualsMap()) {
      for (const item of items) {
        if (item.destinationEntityId === destEntityId && item.resourceType === resourceType) {
          n++;
        }
      }
    }

    for (const seg of roadSegmentManager.getSegments()) {
      if (seg.assignedWorkerId === null) continue;
      const workerEntity = this.entities.find(e => e.id === seg.assignedWorkerId && e.active);
      if (!workerEntity) continue;
      const worker = workerEntity.getComponent(Worker);
      const task = worker?.transportTask;
      if (task && task.destEntityId === destEntityId && task.resourceType === resourceType) {
        if (task.phase === 'to_dropoff') {
          n += worker?.carryingItems.length
            ? worker.carryingItems.filter(
                item =>
                  item.destinationEntityId === destEntityId && item.resourceType === resourceType
              ).length
            : Math.max(1, worker?.carryingAmount || task.amount || 1);
        } else if (task.phase === 'to_pickup' && task.sourceEntityId != null) {
          n += Math.max(1, task.amount || 1);
        }
      }
    }

    return n;
  }

  /**
   * For multi-input local storage, refuse a delivery that would leave less free space than another
   * input still needs to reach its recipe amount (prevents filling the whole store with grain when
   * water still has to fit).
   *
   * @param incomingAlreadyInTransit — when true, `amount` is already included in
   *   `countInTransitToBuilding` (worker at drop-off). Do not subtract `amount` again from free
   *   space or we reject valid deliveries (e.g. last water unit while grain fills the rest).
   */
  /**
   * Older saves kept finished goods in the same Storage as recipe inputs. Outputs now use
   * `Production.outputBuffer` only; move legacy output stacks into the buffer or eject overflow
   * to the camp junction toward HQ.
   */
  private migrateLegacyProductionOutputsFromBuffer(entity: Entity): void {
    const storage = entity.getComponent(Storage);
    const production = entity.getComponent(Production);
    if (!storage?.isProductionStorage || !production) return;

    const spawnTile = this.baseCampEntity ? this.workers.getBaseCampSpawnTile() : null;
    const campId = this.baseCampEntity?.id ?? null;

    for (const res of Object.keys(production.outputs)) {
      if (dataManager.getResource(res as ResourceType)?.virtualOutput) continue;

      let n = storage.getAmount(res);
      while (n > 0) {
        const room = production.maxOutputBuffer - production.getTotalBuffered();
        if (room > 0) {
          const move = Math.min(n, room);
          storage.removeItem(res, move);
          production.addToBuffer(res, move);
          resourceManager.requestPickup(entity.id, res, move);
          n -= move;
        } else if (spawnTile && campId != null) {
          storage.removeItem(res, 1);
          transportManager.addJunctionItem(spawnTile.x, spawnTile.y, res, campId);
          n--;
        } else {
          break;
        }
      }
    }
  }

  private canAddProductionInputToLocalStorage(
    entity: Entity,
    storage: Storage,
    production: Production | null,
    resourceType: string,
    amount: number,
    incomingAlreadyInTransit: boolean = false
  ): boolean {
    if (!production?.hasInputs() || !storage.isProductionStorage) return true;

    const inputs = production.inputs;
    const types = Object.keys(inputs).filter(k => (inputs[k] ?? 0) > 0);
    if (types.length <= 1) return true;

    const inFlight = this.countInTransitToBuilding(entity.id);
    const freeEff = storage.capacity - storage.getTotalStored() - inFlight;

    if (incomingAlreadyInTransit) {
      if (freeEff < 0) return false;
    } else if (freeEff < amount) {
      return false;
    }

    const freeAfterAccept = incomingAlreadyInTransit ? freeEff : freeEff - amount;

    const pipeline = (t: string) =>
      storage.getAmount(t) + this.countInTransitToBuildingForResource(entity.id, t);

    let maxOtherShortfall = 0;
    for (const o of types) {
      if (o === resourceType) continue;
      maxOtherShortfall = Math.max(maxOtherShortfall, Math.max(0, (inputs[o] ?? 0) - pipeline(o)));
    }
    return freeAfterAccept >= maxOtherShortfall;
  }

  /**
   * If a multi-input building is full but the recipe cannot run (missing another input), eject one
   * unit at a time from the most over-stocked type toward HQ until there is enough headroom.
   */
  private rescueStuckMultiInputProductionStorage(entity: Entity): void {
    const storage = entity.getComponent(Storage);
    const production = entity.getComponent(Production);
    const building = entity.getComponent(Building);
    if (
      !storage?.isProductionStorage ||
      !production?.hasInputs() ||
      !building?.isComplete() ||
      !building.isActive
    ) {
      return;
    }

    const inputs = production.inputs;
    const types = Object.keys(inputs).filter(k => (inputs[k] ?? 0) > 0);
    if (types.length <= 1) return;

    if (types.every(t => storage.getAmount(t) >= (inputs[t] ?? 0))) return;

    const maxShortfall = () =>
      Math.max(0, ...types.map(t => Math.max(0, (inputs[t] ?? 0) - storage.getAmount(t))));

    if (storage.getFreeSpace() >= maxShortfall()) return;

    const spawnTile = this.workers.getBaseCampSpawnTile();
    if (!spawnTile || !this.baseCampEntity) return;

    let ejected = false;
    while (storage.getFreeSpace() < maxShortfall()) {
      let victim: string | null = null;
      let bestScore = 0;
      for (const t of types) {
        const excess = storage.getAmount(t) - (inputs[t] ?? 0);
        if (excess > bestScore) {
          bestScore = excess;
          victim = t;
        }
      }
      if (bestScore <= 0) {
        for (const t of Object.keys(storage.items)) {
          if (types.includes(t)) continue;
          const n = storage.getAmount(t);
          if (n > bestScore) {
            bestScore = n;
            victim = t;
          }
        }
      }
      if (!victim || bestScore <= 0) break;
      if (storage.removeItem(victim, 1) < 1) break;
      transportManager.addJunctionItem(spawnTile.x, spawnTile.y, victim, this.baseCampEntity.id);
      ejected = true;
    }
    if (ejected) {
      eventBus.emit('resource:updated');
    }
  }

  /** Pull HQ inventory onto the base-camp spawn junction for production buildings with local input storage. */
  private tryDispatchHqProductionInputsForBuilding(entity: Entity): void {
    if (!this.baseCampEntity) return;
    const building = entity.getComponent(Building);
    const production = entity.getComponent(Production);
    const storage = entity.getComponent(Storage);
    const hqStorage = this.baseCampEntity.getComponent(Storage);
    if (
      !building?.isComplete() ||
      !building.isActive ||
      !production?.hasInputs() ||
      !storage?.isProductionStorage ||
      !hqStorage
    ) {
      return;
    }

    const spawnTile = this.workers.getBaseCampSpawnTile();
    if (!spawnTile) return;

    const inputTypes = production.getAllInputResourceTypes();
    if (inputTypes.length === 0) return;

    const fixedInputTypes = Object.keys(production.inputs).filter(
      k => (production.inputs[k] ?? 0) > 0
    );
    const totalFixedInputAmount = fixedInputTypes.reduce(
      (sum, res) => sum + (production.inputs[res] ?? 0),
      0
    );
    const baseFixedQuota: Record<string, number> = {};
    let assignedFixedQuota = 0;
    if (fixedInputTypes.length > 0 && totalFixedInputAmount > 0) {
      for (const res of fixedInputTypes) {
        const quota = Math.max(
          production.inputs[res] ?? 0,
          Math.floor(storage.capacity * ((production.inputs[res] ?? 0) / totalFixedInputAmount))
        );
        baseFixedQuota[res] = quota;
        assignedFixedQuota += quota;
      }
      let remainder = Math.max(0, storage.capacity - assignedFixedQuota);
      for (const res of fixedInputTypes) {
        if (remainder <= 0) break;
        baseFixedQuota[res]++;
        remainder--;
      }
    }

    const targetStoredOrInTransit = (res: string): number => {
      const needFixed = production.inputs[res] ?? 0;
      if (needFixed > 0) {
        return fixedInputTypes.length <= 1 ? storage.capacity : (baseFixedQuota[res] ?? needFixed);
      }
      for (const g of production.inputsAny) {
        if (!g.resourceTypes.includes(res as ResourceType)) continue;
        return Math.max(
          g.amount,
          Math.floor(storage.capacity / Math.max(1, g.resourceTypes.length))
        );
      }
      return 0;
    };

    const stillNeedsInput = (res: string): boolean => {
      const target = targetStoredOrInTransit(res);
      if (target <= 0) return false;
      const pipeline =
        storage.getAmount(res) + this.countInTransitToBuildingForResource(entity.id, res);
      if (pipeline >= target) return false;
      for (const g of production.inputsAny) {
        if (!g.resourceTypes.includes(res as ResourceType)) continue;
        const groupPipeline = production.pipelineSumForInputsAnyGroup(g, storage, r =>
          this.countInTransitToBuildingForResource(entity.id, r)
        );
        return groupPipeline < storage.capacity;
      }
      return true;
    };

    let dispatchSlots = Math.max(
      0,
      storage.capacity - storage.getTotalStored() - this.countInTransitToBuilding(entity.id)
    );

    while (dispatchSlots > 0) {
      let sent = false;
      for (const res of inputTypes) {
        if (dispatchSlots <= 0) break;
        if (!stillNeedsInput(res)) continue;
        if (hqStorage.getAmount(res) <= 0) continue;
        if (!storage.canAccept(res)) continue;
        if (!this.canAddProductionInputToLocalStorage(entity, storage, production, res, 1)) {
          continue;
        }
        hqStorage.removeItem(res, 1);
        transportManager.addJunctionItem(spawnTile.x, spawnTile.y, res, entity.id);
        dispatchSlots--;
        sent = true;
      }
      if (!sent) break;
    }
  }

  /**
   * When HQ holds inputs and a production building has free local storage, spawn junction items at
   * the camp entrance (same path as construction materials). Throttled like construction recheck.
   */
  private recheckProductionInputDeliveries(force = false): void {
    if (!this.baseCampEntity) return;
    const now = this.simulationNowMs;
    if (!force && now - this.lastProductionInputCheckTime < 2000) return;
    this.lastProductionInputCheckTime = now;

    for (const entity of this.sortEntitiesByBuildingPriority(this.entities)) {
      if (!entity.active) continue;
      this.rescueStuckMultiInputProductionStorage(entity);
      this.tryDispatchHqProductionInputsForBuilding(entity);
    }
    this.tryDispatchMilitaryGoldPayroll();
    this.tryAutoTrainMilitaryGarrisons();
  }

  /** One delivered `gold_coin` promotes one soldier one rank; coin is consumed (not stockpiled). */
  private tryConsumeMilitaryGoldAfterDelivery(destEntity: Entity, destBuilding: Building): void {
    const storage = destEntity.getComponent(Storage);
    if (!storage || !destBuilding.militaryGarrison || !destBuilding.militaryWantsMoreGold()) return;
    const idx = destBuilding.pickSlotIndexForGoldPromotion();
    if (idx < 0) return;
    if (storage.getAmount('gold_coin') < 1) return;
    storage.removeItem('gold_coin', 1);
    destBuilding.promoteMilitaryAtSlot(idx);
    const slot = destBuilding.militaryGarrison[idx];
    if (slot) {
      const wEnt = this.entities.find(e => e.id === slot.workerEntityId && e.active);
      const w = wEnt?.getComponent(Worker);
      if (w) w.applyMilitaryAppearance(slot.rank);
    }
    eventBus.emit('resource:updated');
  }

  /** Send `gold_coin` from HQ to military posts that have garrison and room for promotions. */
  private tryDispatchMilitaryGoldPayroll(): void {
    if (!this.baseCampEntity) return;
    const hqStorage = this.baseCampEntity.getComponent(Storage);
    const spawnTile = this.workers.getBaseCampSpawnTile();
    if (!hqStorage || !spawnTile) return;

    for (const entity of this.entities) {
      if (!entity.active) continue;
      if (!isPlayerOwned(entity)) continue;
      const building = entity.getComponent(Building);
      const storage = entity.getComponent(Storage);
      if (!building?.isComplete() || !building.isActive || !storage) continue;
      if (!building.militaryGarrison || !building.militaryWantsMoreGold()) continue;
      if (!storage.canAccept('gold_coin')) continue;

      const inFlight = this.countInTransitToBuildingForResource(entity.id, 'gold_coin');
      if (inFlight > 0) continue;

      const free = storage.getFreeSpace();
      if (free <= 0) continue;

      if (hqStorage.getAmount('gold_coin') < 1) continue;

      hqStorage.removeItem('gold_coin', 1);
      transportManager.addJunctionItem(spawnTile.x, spawnTile.y, 'gold_coin', entity.id);
      eventBus.emit('resource:updated');
    }
  }

  private updateTransport(): void {
    const segments = roadSegmentManager.getSegments();

    // Rebuild pending building pickups from actual worker state to prevent stale entries
    this.pendingBuildingPickups.clear();
    for (const seg of segments) {
      if (seg.assignedWorkerId === null) continue;
      const e = this.entities.find(ent => ent.id === seg.assignedWorkerId && ent.active);
      if (!e) continue;
      const w = e.getComponent(Worker);
      if (w?.transportTask?.sourceEntityId != null && w.transportTask.phase === 'to_pickup') {
        this.pendingBuildingPickups.add(w.transportTask.sourceEntityId);
      }
    }

    for (const segment of segments) {
      if (segment.assignedWorkerId === null) continue;
      const entity = this.entities.find(e => e.id === segment.assignedWorkerId && e.active);
      if (!entity) continue;
      const worker = entity.getComponent(Worker);
      const movable = entity.getComponent(Movable);
      const pos = entity.getComponent(Position);
      if (!worker || !movable || !pos) continue;
      if (worker.concealedInBuildingId != null) continue;
      if (movable.isMoving) continue;
      if (this.workers.isRoadWorkerReturning(entity.id)) continue;
      if (!worker.transportTask) {
        this.tryStartTransport(segment, worker, movable, pos);
      } else {
        this.advanceTransport(segment, worker, movable, pos);
      }
    }
  }

  private findDemandingBuilding(resourceType: string): Entity | null {
    for (const entity of this.entities) {
      if (!entity.active) continue;
      const production = entity.getComponent(Production);
      const storage = entity.getComponent(Storage);
      const building = entity.getComponent(Building);
      if (!production || !storage || !building) continue;
      if (!storage.isProductionStorage) continue;
      if (!building.isComplete() || !building.isActive) continue;
      if (!production.getAllInputResourceTypes().includes(resourceType as ResourceType)) continue;
      const needFixed = production.inputs[resourceType] ?? 0;
      if (needFixed > 0) {
        const pipeline =
          storage.getAmount(resourceType) +
          this.countInTransitToBuildingForResource(entity.id, resourceType);
        if (pipeline >= needFixed) continue;
      } else {
        let wantsThis = false;
        for (const g of production.inputsAny) {
          if (!g.resourceTypes.includes(resourceType as ResourceType)) continue;
          wantsThis = true;
          const p = production.pipelineSumForInputsAnyGroup(g, storage, r =>
            this.countInTransitToBuildingForResource(entity.id, r)
          );
          if (p >= g.amount) {
            wantsThis = false;
            break;
          }
        }
        if (!wantsThis) continue;
      }
      if (storage.isFull()) continue;
      return entity;
    }
    return null;
  }

  private checkBuildingForOutput(buildingEntityId: number): { resourceType: string } | null {
    const bldgEntity = this.entities.find(e => e.id === buildingEntityId && e.active);
    if (!bldgEntity) return null;
    const production = bldgEntity.getComponent(Production);
    if (!production) return null;
    const storage = bldgEntity.getComponent(Storage);
    if (storage && storage.isProductionStorage) {
      for (const res of Object.keys(production.outputs)) {
        if ((production.outputBuffer[res] ?? 0) > 0) {
          return { resourceType: res };
        }
      }
      for (const res of Object.keys(production.outputs)) {
        if (storage.getAmount(res) > 0) {
          return { resourceType: res };
        }
      }
    } else {
      for (const [res, amount] of Object.entries(production.outputBuffer)) {
        if (amount > 0) {
          return { resourceType: res };
        }
      }
    }
    return null;
  }

  private tryStartTransport(
    segment: RoadSegment,
    worker: Worker,
    movable: Movable,
    pos: Position
  ): void {
    for (let pickupIdx = 0; pickupIdx < 2; pickupIdx++) {
      const ep = segment.endpoints[pickupIdx];
      const dropoffIdx = 1 - pickupIdx;
      const dropoffEp = segment.endpoints[dropoffIdx];

      // Building-adjacent outputs: endpoint may be type `building` OR `junction` (T-crossing next to
      // an entrance still carries entityId — only `building` was checked before, so pickups never
      // started at junction endpoints).
      if (ep.entityId != null && !this.pendingBuildingPickups.has(ep.entityId)) {
        const output = this.checkBuildingForOutput(ep.entityId);
        if (output) {
          let destEntityId: number | null = this.baseCampEntity?.id ?? null;
          const demandBuilding = this.findDemandingBuilding(output.resourceType);
          if (demandBuilding) {
            const dirIdx = transportManager.getDirectionIndex(segment.id, demandBuilding.id);
            if (dirIdx !== undefined && dirIdx !== pickupIdx) {
              destEntityId = demandBuilding.id;
            }
            // If this segment cannot carry toward the consumer from this pickup end, still ship
            // to HQ — never skip pickup entirely (that left buffers stuck when another route existed).
          }

          let dirCheck = transportManager.getDirectionIndex(segment.id, destEntityId);
          if (dirCheck === undefined) {
            this.kickTransportRoutesForNewOutput();
            dirCheck = transportManager.getDirectionIndex(segment.id, destEntityId);
          }
          if (dirCheck === undefined || dirCheck === pickupIdx) continue;

          this.pendingBuildingPickups.add(ep.entityId);
          worker.transportTask = {
            phase: 'to_pickup',
            pickupPos: { x: ep.x, y: ep.y },
            dropoffPos: { x: dropoffEp.x, y: dropoffEp.y },
            resourceType: output.resourceType,
            amount: Math.max(1, worker.transportCarryCapacity),
            sourceEntityId: ep.entityId,
            destEntityId,
          };
          const path = this.getSegmentPathToTile(segment, pos, ep.x, ep.y);
          if (path.length > 0) {
            movable.setPath(path);
            worker.setState('walking');
          } else {
            // Worker already on the pickup tile (zero-length segment hop) — run pickup immediately.
            this.advanceTransport(segment, worker, movable, pos);
          }
          return;
        }
      }

      // Check junction items at this endpoint
      const junctionItem = transportManager.takeJunctionItemForDirection(
        ep.x,
        ep.y,
        segment.id,
        pickupIdx
      );
      if (junctionItem) {
        const items = [
          junctionItem,
          ...transportManager.takeJunctionItemsForDirection(
            ep.x,
            ep.y,
            segment.id,
            pickupIdx,
            Math.max(0, worker.transportCarryCapacity - 1)
          ),
        ];
        transportManager.addPendingPickupItems(ep.x, ep.y, items);
        worker.transportTask = {
          phase: 'to_pickup',
          pickupPos: { x: ep.x, y: ep.y },
          dropoffPos: { x: dropoffEp.x, y: dropoffEp.y },
          resourceType: junctionItem.resourceType,
          amount: items.length,
          items,
          sourceEntityId: null,
          destEntityId: junctionItem.destinationEntityId,
        };
        const path = this.getSegmentPathToTile(segment, pos, ep.x, ep.y);
        if (path.length > 0) {
          movable.setPath(path);
          worker.setState('walking');
        }
        return;
      }
    }

    // Check for stranded items on corridor tiles (dropped during recalc) — skip endpoints,
    // which are handled by the direction-aware junction pickup above
    const ep0 = segment.endpoints[0];
    const ep1 = segment.endpoints[1];
    for (const tile of segment.tiles) {
      if (tile.x === ep0.x && tile.y === ep0.y) continue;
      if (tile.x === ep1.x && tile.y === ep1.y) continue;
      if (!transportManager.hasJunctionItems(tile.x, tile.y)) continue;
      const item = transportManager.takeJunctionItem(tile.x, tile.y);
      if (!item) continue;

      let destEntityId = item.destinationEntityId;
      let dirIdx = transportManager.getDirectionIndex(segment.id, destEntityId);

      // If original destination unreachable, redirect to base camp
      if (dirIdx === undefined) {
        destEntityId = this.baseCampEntity?.id ?? null;
        dirIdx = transportManager.getDirectionIndex(segment.id, destEntityId);
      }

      if (dirIdx === undefined) {
        transportManager.addJunctionItem(
          tile.x,
          tile.y,
          item.resourceType,
          item.destinationEntityId
        );
        continue;
      }
      transportManager.addPendingPickupVisual(tile.x, tile.y, item.resourceType, destEntityId);
      const dropoffEp = segment.endpoints[dirIdx];
      worker.transportTask = {
        phase: 'to_pickup',
        pickupPos: { x: tile.x, y: tile.y },
        dropoffPos: { x: dropoffEp.x, y: dropoffEp.y },
        resourceType: item.resourceType,
        amount: 1,
        sourceEntityId: null,
        destEntityId,
      };
      const path = this.getSegmentPathToTile(segment, pos, tile.x, tile.y);
      if (path.length > 0) {
        movable.setPath(path);
        worker.setState('walking');
      }
      return;
    }
  }

  /**
   * After depositing at a segment endpoint, if the same tile already had (or now has) a junction
   * item routable along this segment, start pickup immediately instead of walking to the segment
   * center first.
   */
  private tryChainedJunctionPickupAfterDropoff(
    segment: RoadSegment,
    worker: Worker,
    movable: Movable,
    pos: Position,
    tileX: number,
    tileY: number
  ): boolean {
    const epIdx = segment.endpoints.findIndex(ep => ep.x === tileX && ep.y === tileY);
    if (epIdx < 0) return false;
    const junctionItem = transportManager.takeJunctionItemForDirection(
      tileX,
      tileY,
      segment.id,
      epIdx
    );
    if (!junctionItem) return false;
    const items = [
      junctionItem,
      ...transportManager.takeJunctionItemsForDirection(
        tileX,
        tileY,
        segment.id,
        epIdx,
        Math.max(0, worker.transportCarryCapacity - 1)
      ),
    ];
    transportManager.addPendingPickupItems(tileX, tileY, items);
    const otherEp = segment.endpoints[1 - epIdx]!;
    worker.transportTask = {
      phase: 'to_pickup',
      pickupPos: { x: tileX, y: tileY },
      dropoffPos: { x: otherEp.x, y: otherEp.y },
      resourceType: junctionItem.resourceType,
      amount: items.length,
      items,
      sourceEntityId: null,
      destEntityId: junctionItem.destinationEntityId,
    };
    this.advanceTransport(segment, worker, movable, pos);
    return true;
  }

  private advanceTransport(
    segment: RoadSegment,
    worker: Worker,
    movable: Movable,
    pos: Position
  ): void {
    const task = worker.transportTask!;
    switch (task.phase) {
      case 'to_pickup': {
        let taken = false;
        let takenAmount = 0;
        const requestedAmount = Math.max(
          1,
          Math.min(worker.transportCarryCapacity, task.amount || 1)
        );
        if (task.sourceEntityId != null) {
          const bldgEntity = this.entities.find(e => e.id === task.sourceEntityId && e.active);
          if (bldgEntity) {
            const production = bldgEntity.getComponent(Production);
            const bldgStorage = bldgEntity.getComponent(Storage);
            if (
              production &&
              (takenAmount = production.removeFromBuffer(task.resourceType, requestedAmount)) > 0
            ) {
              worker.pickUpTransportItems(
                this.makeTransportLoadItems(task.resourceType, task.destEntityId, takenAmount)
              );
              taken = true;
            } else if (
              bldgStorage?.isProductionStorage &&
              (takenAmount = bldgStorage.removeItem(task.resourceType, requestedAmount)) > 0
            ) {
              worker.pickUpTransportItems(
                this.makeTransportLoadItems(task.resourceType, task.destEntityId, takenAmount)
              );
              taken = true;
            }
          }
        } else {
          const reservedItems =
            task.items && task.items.length > 0
              ? task.items
              : this.makeTransportLoadItems(
                  task.resourceType,
                  task.destEntityId,
                  Math.max(1, task.amount || 1)
                );
          transportManager.removePendingPickupItems(
            task.pickupPos.x,
            task.pickupPos.y,
            reservedItems
          );
          let carriedItems = [...reservedItems];
          const pickupEpIdx = segment.endpoints.findIndex(
            ep => ep.x === task.pickupPos.x && ep.y === task.pickupPos.y
          );
          if (pickupEpIdx >= 0 && carriedItems.length < worker.transportCarryCapacity) {
            const extraItems = transportManager.takeJunctionItemsForDirection(
              task.pickupPos.x,
              task.pickupPos.y,
              segment.id,
              pickupEpIdx,
              worker.transportCarryCapacity - carriedItems.length
            );
            carriedItems = [...carriedItems, ...extraItems];
          }
          takenAmount = carriedItems.length;
          worker.pickUpTransportItems(carriedItems);
          taken = true;
        }
        if (!taken) {
          worker.transportTask = null;
          worker.setState('idle');
          this.walkWorkerToCenter(segment, movable, pos, worker);
          return;
        }
        task.amount = takenAmount;
        task.phase = 'to_dropoff';
        const path = this.getSegmentPathToTile(segment, pos, task.dropoffPos.x, task.dropoffPos.y);
        if (path.length > 0) {
          movable.setPath(path);
          worker.setState('carrying');
        }
        break;
      }
      case 'to_dropoff': {
        const carriedItems =
          worker.carryingItems.length > 0
            ? worker.carryingItems
            : worker.carryingResource
              ? this.makeTransportLoadItems(
                  worker.carryingResource,
                  task.destEntityId,
                  Math.max(1, worker.carryingAmount || task.amount || 1)
                )
              : [];
        if (carriedItems.length === 0) {
          worker.transportTask = null;
          worker.setState('idle');
          this.walkWorkerToCenter(segment, movable, pos, worker);
          return;
        }

        const dropoffEpIdx = segment.endpoints.findIndex(
          ep => ep.x === task.dropoffPos.x && ep.y === task.dropoffPos.y
        );
        const dropoffEp = segment.endpoints[dropoffEpIdx];

        // During batch unload, do not count this donkey's remaining carried stack as still in
        // transit to the same storage. Otherwise production storage accepts the first unit and
        // rejects the rest as "already reserved", causing one-by-one re-delivery loops.
        worker.carryingItems = [];
        this.deliverTransportLoadItems(carriedItems, dropoffEp, task.dropoffPos);

        worker.dropResource();

        const px = task.dropoffPos.x;
        const py = task.dropoffPos.y;
        if (this.tryChainedJunctionPickupAfterDropoff(segment, worker, movable, pos, px, py)) {
          break;
        }

        task.phase = 'to_center';
        this.walkWorkerToCenter(segment, movable, pos, worker);
        break;
      }
      case 'to_center': {
        worker.transportTask = null;
        worker.setState('idle');
        break;
      }
    }
  }

  private makeTransportLoadItems(
    resourceType: string,
    destinationEntityId: number | null,
    amount: number
  ): TransportLoadItem[] {
    return Array.from({ length: Math.max(0, Math.floor(amount)) }, () => ({
      resourceType,
      destinationEntityId,
    }));
  }

  private deliverTransportLoadItems(
    items: TransportLoadItem[],
    dropoffEp: RoadSegment['endpoints'][number] | undefined,
    dropoffPos: { x: number; y: number }
  ): void {
    const remaining: TransportLoadItem[] = [];
    const groupedFinalDeliveries = new Map<number, TransportLoadItem[]>();

    for (const item of items) {
      if (dropoffEp?.entityId === item.destinationEntityId && item.destinationEntityId != null) {
        const list = groupedFinalDeliveries.get(item.destinationEntityId) ?? [];
        list.push(item);
        groupedFinalDeliveries.set(item.destinationEntityId, list);
      } else {
        remaining.push(item);
      }
    }

    for (const [destEntityId, destItems] of groupedFinalDeliveries) {
      if (destEntityId === this.baseCampEntity?.id) {
        const storage = this.baseCampEntity.getComponent(Storage);
        if (storage) {
          for (const [res, count] of this.groupTransportItemsByResource(destItems)) {
            const added = storage.addItem(res, count);
            for (let i = added; i < count; i++) {
              transportManager.addJunctionItem(dropoffPos.x, dropoffPos.y, res, destEntityId);
            }
          }
        }
        continue;
      }

      const destEntity = this.entities.find(e => e.id === destEntityId && e.active);
      if (!destEntity) {
        for (const item of destItems) {
          transportManager.addJunctionItem(
            dropoffPos.x,
            dropoffPos.y,
            item.resourceType,
            this.baseCampEntity?.id ?? null
          );
        }
        continue;
      }

      const destBuilding = destEntity.getComponent(Building);
      if (destBuilding && destBuilding.state === 'awaiting_materials') {
        for (const item of destItems) {
          if (!destBuilding.deliverMaterial(item.resourceType)) {
            transportManager.addJunctionItem(
              dropoffPos.x,
              dropoffPos.y,
              item.resourceType,
              this.baseCampEntity?.id ?? null
            );
          }
        }
        continue;
      }

      const destStorage = destEntity.getComponent(Storage);
      if (destStorage) {
        for (const [res, count] of this.groupTransportItemsByResource(destItems)) {
          const added = destStorage.addItem(res, count);
          if (added > 0 && res === 'gold_coin' && destBuilding) {
            for (let i = 0; i < added; i++) {
              this.tryConsumeMilitaryGoldAfterDelivery(destEntity, destBuilding);
            }
          }
          for (let i = added; i < count; i++) {
            transportManager.addJunctionItem(
              dropoffPos.x,
              dropoffPos.y,
              res,
              this.baseCampEntity?.id ?? null
            );
          }
        }
        continue;
      }

      for (const item of destItems) {
        transportManager.addJunctionItem(
          dropoffPos.x,
          dropoffPos.y,
          item.resourceType,
          this.baseCampEntity?.id ?? null
        );
      }
    }

    for (const item of remaining) {
      transportManager.addJunctionItem(
        dropoffPos.x,
        dropoffPos.y,
        item.resourceType,
        item.destinationEntityId
      );
    }
  }

  private groupTransportItemsByResource(items: TransportLoadItem[]): Map<string, number> {
    const grouped = new Map<string, number>();
    for (const item of items) {
      grouped.set(item.resourceType, (grouped.get(item.resourceType) ?? 0) + 1);
    }
    return grouped;
  }

  private walkWorkerToCenter(
    segment: RoadSegment,
    movable: Movable,
    pos: Position,
    worker: Worker
  ): void {
    const path = this.getSegmentPath(segment, pos);
    if (path.length > 0) {
      movable.setPath(path);
      worker.setState('walking');
    }
  }

  /** Walk along segment tile centers, then optional fractional step to geometric center. */
  private getSegmentPath(segment: RoadSegment, fromPos: Position): Position[] {
    const tiles = segment.tiles;
    const n = tiles.length;
    if (n === 0) return [];

    const rest = roadSegmentManager.getCenterRestPosition(segment);
    const toX = rest.x;
    const toY = rest.y;
    const mid = (n - 1) / 2;
    const lo = Math.floor(mid);
    const hi = Math.ceil(mid);

    const fromX = Math.floor(fromPos.x);
    const fromY = Math.floor(fromPos.y);
    let fromIdx = tiles.findIndex(t => t.x === fromX && t.y === fromY);
    if (fromIdx === -1) {
      let minDist = Infinity;
      tiles.forEach((t, i) => {
        const d = Math.abs(t.x - fromX) + Math.abs(t.y - fromY);
        if (d < minDist) {
          minDist = d;
          fromIdx = i;
        }
      });
    }
    if (fromIdx === -1) return [];

    let toIdx: number;
    if (fromIdx < lo) toIdx = lo;
    else if (fromIdx > hi) toIdx = hi;
    else toIdx = fromIdx;

    const path: Position[] = [];
    if (fromIdx !== toIdx) {
      const step = fromIdx < toIdx ? 1 : -1;
      for (let i = fromIdx + step; step > 0 ? i <= toIdx : i >= toIdx; i += step) {
        path.push(new Position(tiles[i]!.x, tiles[i]!.y));
      }
    }

    const lastX = path.length > 0 ? path[path.length - 1]!.x : fromPos.x;
    const lastY = path.length > 0 ? path[path.length - 1]!.y : fromPos.y;
    if (Math.hypot(lastX - toX, lastY - toY) > 1e-3) {
      path.push(new Position(toX, toY));
    }

    return path;
  }

  /** Walk along segment tile centers from `fromPos` to integer tile `(toX, toY)` on the segment. */
  private getSegmentPathToTile(
    segment: RoadSegment,
    fromPos: Position,
    toX: number,
    toY: number
  ): Position[] {
    const tiles = segment.tiles;
    const fromX = Math.floor(fromPos.x);
    const fromY = Math.floor(fromPos.y);
    let fromIdx = tiles.findIndex(t => t.x === fromX && t.y === fromY);
    const toIdx = tiles.findIndex(t => t.x === toX && t.y === toY);
    if (fromIdx === -1) {
      let minDist = Infinity;
      tiles.forEach((t, i) => {
        const d = Math.abs(t.x - fromX) + Math.abs(t.y - fromY);
        if (d < minDist) {
          minDist = d;
          fromIdx = i;
        }
      });
    }
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return [];
    const path: Position[] = [];
    const step = fromIdx < toIdx ? 1 : -1;
    for (let i = fromIdx + step; step > 0 ? i <= toIdx : i >= toIdx; i += step) {
      path.push(new Position(tiles[i]!.x, tiles[i]!.y));
    }
    return path;
  }

  addEntity(entity: Entity): void {
    this.entities.push(entity);
    this.systems.forEach(system => system.addEntity(entity));
  }

  removeEntity(entity: Entity): void {
    const i = this.entities.indexOf(entity);
    if (i !== -1) this.entities.splice(i, 1);
    this.systems.forEach(system => system.removeEntity(entity));
    entity.destroy();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.gameLoop(this.lastTime);
  }

  stop(): void {
    this.running = false;
  }

  getSimulationNowMs(): number {
    return this.simulationNowMs;
  }

  getTimeScale(): number {
    return this.timeScale;
  }

  isFastForwardEnabled(): boolean {
    return this.timeScale > 1;
  }

  setFastForwardEnabled(enabled: boolean): void {
    this.timeScale = enabled ? FAST_FORWARD_TIME_SCALE : 1;
  }

  private gameLoop = (currentTime: number): void => {
    if (!this.running) return;

    const realDeltaTime = Math.min((currentTime - this.lastTime) / 1000, 0.1);
    const deltaTime = realDeltaTime * this.timeScale;
    this.lastTime = currentTime;
    this.simulationNowMs += deltaTime * 1000;
    setSimulationNowMs(this.simulationNowMs);

    this.worldTimeSeconds += deltaTime;
    while (this.worldTimeSeconds >= this.nextWaterFishRegenWorldSecond) {
      this.nextWaterFishRegenWorldSecond += 7200;
      this.tileMap.applyWaterFishPopulationRegen();
    }
    this.cleanupDemolitionSites();
    this.processPendingWellDemolitions();

    this.wildlife.tick(this.tileMap, this.simulationNowMs);

    // Update FPS
    this.frameCount++;
    this.fpsTime += realDeltaTime;
    if (this.fpsTime >= 1) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsTime = 0;
      this.updateDebugInfo();
    }

    // Clean up destroyed entities
    this.entities = this.entities.filter(e => e.active);
    this.systems.forEach(system => system.cleanup());

    // Update build preview based on input mode and hover position
    const mode = this.inputSystem.getMode();
    if (mode !== 'view' && mode !== 'select' && this.inputSystem.hoverGridPos) {
      const gx = this.inputSystem.hoverGridPos.x;
      const gy = this.inputSystem.hoverGridPos.y;
      let roadLineTiles: { x: number; y: number }[] | undefined;
      let roadDragIntent: 'create' | 'delete' | undefined;
      if (mode === 'build_road') {
        const t = this.tileMap.getTile(gx, gy);
        const isExistingRoad = !!(t && t.hasRoad && !t.isOccupied());
        roadDragIntent = this.roadDragMode ?? (isExistingRoad ? 'delete' : 'create');
        if (this.inputSystem.getShiftKeyHeld()) {
          const pathAnchor = this.inputSystem.getRoadPathAnchorGrid();
          if (pathAnchor && (pathAnchor.x !== gx || pathAnchor.y !== gy)) {
            roadLineTiles = this.planRoadPath(pathAnchor, { x: gx, y: gy });
            roadDragIntent = 'create';
          } else if (this.inputSystem.isPointerDragging()) {
            const dragAnchor = this.inputSystem.getRoadDragAnchorGrid();
            if (dragAnchor && (dragAnchor.x !== gx || dragAnchor.y !== gy)) {
              roadLineTiles = axisAlignedGridLine(dragAnchor.x, dragAnchor.y, gx, gy);
            }
          }
        }
      }
      this.renderSystem.buildPreview = {
        mode,
        gridX: gx,
        gridY: gy,
        roadLineTiles,
        roadDragIntent,
      };
    } else {
      this.renderSystem.buildPreview = null;
    }

    // Sync selected entity with render system for visual feedback
    this.renderSystem.selectedEntityId = this.selectedEntity?.id ?? null;
    this.renderSystem.dragPreviewPosition = this.dragPreviewPosition;

    // Track hovered entity for tooltips
    if (this.inputSystem.hoverGridPos) {
      const hx = this.inputSystem.hoverGridPos.x;
      const hy = this.inputSystem.hoverGridPos.y;
      const hoveredWorker = this.findRoadWorkerAtPointer(
        hx,
        hy,
        this.inputSystem.getHoverClientPos() ?? undefined
      );
      const hoveredEntity =
        hoveredWorker ??
        this.entities.find(entity => {
          const pos = entity.getComponent(Position);
          const building = entity.getComponent(Building);
          if (!pos || !building) return false;
          return (
            hx >= pos.x &&
            hx < pos.x + building.width &&
            hy >= pos.y &&
            hy < pos.y + building.height
          );
        });
      this.renderSystem.hoveredEntityId = hoveredEntity?.id ?? null;
      this.inputSystem.setHoverPointerActive(!!hoveredWorker);
    } else {
      this.renderSystem.hoveredEntityId = null;
      this.inputSystem.setHoverPointerActive(false);
    }

    // Alt/Option insight: full tile grid while held; building / rock highlight only in view + stable hover
    this.renderSystem.showInsightGrid = isInsightAltHeld();
    const insightHoverOk =
      isInsightAltHeld() &&
      mode === 'view' &&
      !this.isDraggingEntity &&
      !this.inputSystem.isSpacebarPanning() &&
      Boolean(this.inputSystem.hoverGridPos);

    if (insightHoverOk && this.inputSystem.hoverGridPos) {
      const hx = this.inputSystem.hoverGridPos.x;
      const hy = this.inputSystem.hoverGridPos.y;
      const tile = this.tileMap.getTile(hx, hy);
      if (tile?.isExplored()) {
        const bEnt = this.getBuildingEntityAtGrid(hx, hy);
        if (bEnt) {
          this.renderSystem.insightHighlightEntityId = bEnt.id;
          this.renderSystem.insightHighlightRock = null;
          this.renderSystem.insightHighlightWater = null;
        } else {
          this.renderSystem.insightHighlightEntityId = null;
          if (isInsightRockTile(tile)) {
            this.renderSystem.insightHighlightRock = { x: hx, y: hy };
            this.renderSystem.insightHighlightWater = null;
          } else if (tile.terrain === 'water') {
            this.renderSystem.insightHighlightRock = null;
            this.renderSystem.insightHighlightWater = { x: hx, y: hy };
          } else {
            this.renderSystem.insightHighlightRock = null;
            this.renderSystem.insightHighlightWater = null;
          }
        }
      } else {
        this.renderSystem.insightHighlightEntityId = null;
        this.renderSystem.insightHighlightRock = null;
        this.renderSystem.insightHighlightWater = null;
      }
    } else {
      this.renderSystem.insightHighlightEntityId = null;
      this.renderSystem.insightHighlightRock = null;
      this.renderSystem.insightHighlightWater = null;
    }

    // Re-dispatch lost construction materials
    this.recheckConstructionMaterials();

    // HQ → production building input storage (junction at base camp)
    this.recheckProductionInputDeliveries();

    // Move builders around the building during construction
    this.workers.updateBuilderPatrol();

    // Update animation workers (woodcutter etc.)
    this.workers.updateAnimationWorkers();

    // Update building construction progress
    this.updateConstruction();
    this.updateEnemyRealmDefeat();

    this.refreshTerritoryIfDirty();
    this.updateEnemyBorderPressure();
    this.updateEnemyRoadMaintenance();

    this.surveys.tick(this.simulationNowMs);
    this.renderSystem.setSurveyWorkerIdsOnTop(this.surveys.getActiveSurveyorWorkerIds());
    this.renderSystem.setSurveyOverlay(this.surveys.getOverlayForRender(this.simulationNowMs));

    // Update all systems
    this.systems.forEach(system => system.update(deltaTime));
    this.updateEnemyAttacks();
    this.updateForestAmbient();
    this.updateHammerSound();
    this.updateWorkerAmbientSounds();
    this.pruneAllMilitaryGarrisons();

    /** After movement so walkers that finish a path this frame see `isMoving === false` at goal tile. */
    this.workers.tickReturnLegs();
    this.workers.updateConstructionDelivery();
    this.refreshTerritoryIfDirty();

    // Update transport relay chain
    this.updateTransport();

    // Periodic transport heal: `rescueStrandedItems` alone does not refresh direction maps, so goods
    // can sit on roads until the next road edit triggers `recalculate` + `recomputeTransportRoutes`.
    const now = this.simulationNowMs;
    if (now - this.lastPeriodicTransportHealTime > 8000) {
      this.lastPeriodicTransportHealTime = now;
      roadSegmentManager.recalculate(this.tileMap);
      this.recomputeTransportRoutes();
    }

    // Heal stale toward-base / toward-consumer maps when goods sit in output buffers
    if (now - this.lastOutputTransportKickTime > 6000) {
      this.lastOutputTransportKickTime = now;
      if (this.hasAnyUnroutedProductionOutput()) {
        this.kickTransportRoutesForNewOutput();
      }
    }

    // Keep inventory in sync with storage components
    this.syncInventory();

    for (const hook of this.frameHooks) {
      hook();
    }

    requestAnimationFrame(this.gameLoop);
  };

  private updateConstruction(): void {
    for (const entity of this.entities) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (building && building.state === 'under_construction') {
        building.updateConstruction(this.simulationNowMs);
        if (building.isComplete()) {
          audioManager.playSound('building_complete');
          this.workers.returnBuilder(entity);

          // Mark building as needing tool worker if it has a requiredTool
          const buildingDef = dataManager.getBuilding(building.buildingType);
          if (buildingDef?.requiredTool) {
            building.hasOperator = false;
          }

          const production = entity.getComponent(Production);
          if (production && production.hasInputs()) {
            transportManager.computeRoutesToBuilding(roadSegmentManager.getSegments(), entity.id);
          }

          const soldierCap = buildingDef?.military?.soldierCapacity;
          if (typeof soldierCap === 'number' && soldierCap > 0) {
            building.initMilitaryGarrison(soldierCap);
          }
          const st = entity.getComponent(Storage);
          if (st && !st.isProductionStorage && st.accepts?.includes('gold_coin')) {
            transportManager.computeRoutesToBuilding(roadSegmentManager.getSegments(), entity.id);
          }

          this.recheckProductionInputDeliveries(true);
          this.recomputePopulationMaxCapacity();
          this.tryFinalizeWellAquifer(entity);
          if (typeof buildingDef?.military?.territoryVisionRadius === 'number') {
            this.markTerritoryDirty();
          }
        }
      }
    }
  }

  private updateEnemyRealmDefeat(): void {
    // Enemy HQ conquest is now player-driven through attacks. Military posts can keep
    // projecting territory after the HQ falls, so the old auto-burn rule is disabled.
  }

  /** Roll lazy underground water when a well finishes construction; dry cells (depleted) never reroll. */
  private tryFinalizeWellAquifer(entity: Entity): void {
    const building = entity.getComponent(Building);
    const pos = entity.getComponent(Position);
    if (!building || !pos || building.buildingType !== 'well' || !building.isComplete()) return;
    const tile = this.tileMap.getTile(Math.floor(pos.x), Math.floor(pos.y));
    if (!tile) return;
    ensureWellAquiferInitialized(tile);
    if ((tile.cellWellWaterRemaining ?? 0) <= 0) {
      building.outOfMapResources = true;
      eventBus.emit('well:aquifer_depleted', { entityId: entity.id });
    }
  }

  private processPendingWellDemolitions(): void {
    const now = this.simulationNowMs;
    for (const [entityId, demolishAt] of [...this.pendingWellDemolitions]) {
      if (now < demolishAt) continue;
      this.pendingWellDemolitions.delete(entityId);
      const ent = this.entities.find(e => e.id === entityId && e.active);
      if (!ent) continue;
      const b = ent.getComponent(Building);
      if (b?.buildingType !== 'well') continue;
      this.destroyBuildingEntity(ent);
    }
  }

  private syncInventory(): void {
    this.inventory = resourceManager.getGlobalInventory();
  }

  private updateDebugInfo(): void {
    const fpsElement = document.getElementById('fps');
    const entityCountElement = document.getElementById('entity-count');

    if (fpsElement) fpsElement.textContent = this.fps.toString();
    if (entityCountElement) entityCountElement.textContent = this.entities.length.toString();
  }

  public getViewportBounds() {
    return this.renderSystem.getViewportBounds();
  }

  /** Register a callback invoked once per frame after core simulation (UI overlays, hover tooltips). */
  registerFrameHook(cb: () => void): () => void {
    this.frameHooks.push(cb);
    return () => {
      const i = this.frameHooks.indexOf(cb);
      if (i !== -1) this.frameHooks.splice(i, 1);
    };
  }

  public getBuildingEntityAtGrid(x: number, y: number): Entity | null {
    return this.findBuildingEntityAt(x, y);
  }

  private isMilitaryBuilding(building: Building | null | undefined): boolean {
    if (!building) return false;
    const def = dataManager.getBuilding(building.buildingType);
    const cap = def?.military?.soldierCapacity;
    return typeof cap === 'number' && cap > 0;
  }

  public isEnemyAttackTarget(entity: Entity): boolean {
    if (!entity.active || isPlayerOwned(entity)) return false;
    const building = entity.getComponent(Building);
    if (!building?.isComplete()) return false;
    return building.buildingType === 'base_camp' || this.isMilitaryBuilding(building);
  }

  private getBuildingCenter(entity: Entity): { x: number; y: number } | null {
    const pos = entity.getComponent(Position);
    const building = entity.getComponent(Building);
    if (!pos || !building) return null;
    return {
      x: pos.x + Math.floor(building.width / 2),
      y: pos.y + Math.floor(building.height / 2),
    };
  }

  private getEnemyAttackRangeCells(): number {
    return dataManager.getGameConfig().enemyRealms.attacks.maxRangeCells;
  }

  public getEnemyAttackOptions(targetEntity: Entity): EnemyAttackOptions {
    const empty: AttackRankSelection = { 1: 0, 2: 0, 3: 0 };
    if (!this.isEnemyAttackTarget(targetEntity)) {
      return {
        availableByRank: { ...empty },
        maxByRank: { ...empty },
        totalAvailable: 0,
        canAttack: false,
        reason: 'Not an attack target',
      };
    }
    const targetCenter = this.getBuildingCenter(targetEntity);
    if (!targetCenter) {
      return {
        availableByRank: { ...empty },
        maxByRank: { ...empty },
        totalAvailable: 0,
        canAttack: false,
        reason: 'No target position',
      };
    }

    const availableByRank: AttackRankSelection = { 1: 0, 2: 0, 3: 0 };
    for (const entity of this.entities) {
      if (!entity.active || !isPlayerOwned(entity)) continue;
      const building = entity.getComponent(Building);
      if (!building?.militaryGarrison || !this.isMilitaryBuilding(building)) continue;
      this.pruneInvalidMilitaryGarrisonSlots(entity);
      const center = this.getBuildingCenter(entity);
      if (!center) continue;
      const dist = Math.max(
        Math.abs(center.x - targetCenter.x),
        Math.abs(center.y - targetCenter.y)
      );
      if (dist > this.getEnemyAttackRangeCells()) continue;
      for (const slot of building.militaryGarrison) {
        if (!slot) continue;
        availableByRank[slot.rank]++;
      }
    }
    const totalAvailable = availableByRank[1] + availableByRank[2] + availableByRank[3];
    return {
      availableByRank,
      maxByRank: { ...availableByRank },
      totalAvailable,
      canAttack: totalAvailable > 0,
      reason: totalAvailable > 0 ? undefined : 'No soldiers in range',
    };
  }

  public startEnemyAttack(
    targetEntity: Entity,
    selectedByRank: Partial<Record<MilitaryRank, number>>
  ): boolean {
    if (!this.isEnemyAttackTarget(targetEntity)) return false;
    if (
      this.activeEnemyAttacks.some(
        attack => attack.targetEntityId === targetEntity.id && attack.phase !== 'complete'
      )
    ) {
      eventBus.emit('toast', { message: 'Attack already underway.' });
      return false;
    }

    const requested: AttackRankSelection = {
      1: Math.max(0, Math.floor(selectedByRank[1] ?? 0)),
      2: Math.max(0, Math.floor(selectedByRank[2] ?? 0)),
      3: Math.max(0, Math.floor(selectedByRank[3] ?? 0)),
    };
    const totalRequested = requested[1] + requested[2] + requested[3];
    if (totalRequested <= 0) return false;

    const options = this.getEnemyAttackOptions(targetEntity);
    if (
      requested[1] > options.availableByRank[1] ||
      requested[2] > options.availableByRank[2] ||
      requested[3] > options.availableByRank[3]
    ) {
      eventBus.emit('toast', { message: 'Not enough soldiers in range.' });
      return false;
    }

    const targetCenter = this.getBuildingCenter(targetEntity);
    if (!targetCenter) return false;
    const staging = this.getAttackStagingTiles(targetEntity);
    const attackers = this.claimAttackersForEnemyAttack(targetCenter, requested);
    if (attackers.length !== totalRequested) {
      this.restoreClaimedAttackers(attackers);
      eventBus.emit('toast', {
        message: 'Could not assemble the selected soldiers.',
      });
      return false;
    }

    this.ensureGarrisonWorkersForBuilding(targetEntity);
    const defenders = this.claimDefendersForEnemyAttack(targetEntity);
    const targetFactionId = getEntityFaction(targetEntity);
    const attack: ActiveEnemyAttack = {
      id: this.nextEnemyAttackId++,
      targetEntityId: targetEntity.id,
      attackerFactionId: PLAYER_FACTION,
      targetFactionId,
      initiatedBy: 'player',
      attackers,
      defenders,
      attackerQueue: attackers.map(a => a.workerEntityId),
      defenderQueue: defenders.map(d => d.workerEntityId),
      currentAttackerId: null,
      currentDefenderId: null,
      phase: 'marching',
      duelStartedAt: 0,
      fallenUntil: 0,
      fallenWorkerId: null,
      staging,
      returnAssignments: [],
    };
    this.activeEnemyAttacks.push(attack);
    this.marchAttackParticipants(attack);
    eventBus.emit('toast', {
      message: defenders.length > 0 ? 'Attack underway.' : 'No defenders. Capturing target.',
    });
    return true;
  }

  private claimAttackersForEnemyAttack(
    targetCenter: { x: number; y: number },
    requested: AttackRankSelection
  ): AttackParticipant[] {
    const claimed: AttackParticipant[] = [];
    const remaining: AttackRankSelection = { ...requested };
    const sourceBuildings = this.entities
      .filter(entity => {
        if (!entity.active || !isPlayerOwned(entity)) return false;
        const building = entity.getComponent(Building);
        if (!building?.militaryGarrison || !this.isMilitaryBuilding(building)) return false;
        const center = this.getBuildingCenter(entity);
        if (!center) return false;
        return (
          Math.max(Math.abs(center.x - targetCenter.x), Math.abs(center.y - targetCenter.y)) <=
          this.getEnemyAttackRangeCells()
        );
      })
      .sort((a, b) => {
        const ac = this.getBuildingCenter(a)!;
        const bc = this.getBuildingCenter(b)!;
        const ad = Math.max(Math.abs(ac.x - targetCenter.x), Math.abs(ac.y - targetCenter.y));
        const bd = Math.max(Math.abs(bc.x - targetCenter.x), Math.abs(bc.y - targetCenter.y));
        return ad - bd;
      });

    for (const entity of sourceBuildings) {
      this.pruneInvalidMilitaryGarrisonSlots(entity);
      const building = entity.getComponent(Building)!;
      if (!building.militaryGarrison) continue;
      for (let i = 0; i < building.militaryGarrison.length; i++) {
        const slot = building.militaryGarrison[i];
        if (!slot || remaining[slot.rank] <= 0) continue;
        claimed.push({
          workerEntityId: slot.workerEntityId,
          rank: slot.rank,
          sourceBuildingId: entity.id,
          sourceSlotIndex: i,
        });
        building.militaryGarrison[i] = null;
        eventBus.emit('military:garrison_changed', {
          buildingEntityId: entity.id,
        });
        remaining[slot.rank]--;
        if (remaining[1] + remaining[2] + remaining[3] <= 0) return claimed;
      }
    }
    return claimed;
  }

  private claimDefendersForEnemyAttack(targetEntity: Entity): AttackParticipant[] {
    const building = targetEntity.getComponent(Building);
    if (!building?.militaryGarrison) return [];
    this.pruneInvalidMilitaryGarrisonSlots(targetEntity);
    const defenders: AttackParticipant[] = [];
    for (let i = 0; i < building.militaryGarrison.length; i++) {
      const slot = building.militaryGarrison[i];
      if (!slot) continue;
      defenders.push({
        workerEntityId: slot.workerEntityId,
        rank: slot.rank,
        sourceBuildingId: targetEntity.id,
        sourceSlotIndex: i,
      });
      building.militaryGarrison[i] = null;
      eventBus.emit('military:garrison_changed', {
        buildingEntityId: targetEntity.id,
      });
    }
    return defenders;
  }

  private isWorkerInActiveEnemyAttack(workerEntityId: number): boolean {
    return this.activeEnemyAttacks.some(
      attack =>
        attack.phase !== 'complete' &&
        (attack.currentAttackerId === workerEntityId ||
          attack.currentDefenderId === workerEntityId ||
          attack.fallenWorkerId === workerEntityId ||
          attack.attackerQueue.includes(workerEntityId) ||
          attack.defenderQueue.includes(workerEntityId) ||
          attack.attackers.some(p => p.workerEntityId === workerEntityId) ||
          attack.defenders.some(p => p.workerEntityId === workerEntityId) ||
          attack.returnAssignments.some(p => p.workerEntityId === workerEntityId))
    );
  }

  private pruneInvalidMilitaryGarrisonSlots(buildingEntity: Entity): void {
    const building = buildingEntity.getComponent(Building);
    if (!building?.militaryGarrison) return;
    let changed = false;
    for (let i = 0; i < building.militaryGarrison.length; i++) {
      const slot = building.militaryGarrison[i];
      if (!slot) continue;
      const workerEntity = this.entities.find(e => e.id === slot.workerEntityId && e.active);
      const worker = workerEntity?.getComponent(Worker);
      if (
        !workerEntity ||
        !worker ||
        worker.concealedInBuildingId !== buildingEntity.id ||
        this.isWorkerInActiveEnemyAttack(slot.workerEntityId)
      ) {
        building.militaryGarrison[i] = null;
        changed = true;
      }
    }
    if (changed)
      eventBus.emit('military:garrison_changed', {
        buildingEntityId: buildingEntity.id,
      });
  }

  private pruneAllMilitaryGarrisons(): void {
    for (const entity of this.entities) {
      if (!entity.active) continue;
      if (!entity.getComponent(Building)?.militaryGarrison) continue;
      this.pruneInvalidMilitaryGarrisonSlots(entity);
    }
  }

  private removeWorkerFromAllMilitaryGarrisons(workerEntityId: number): void {
    for (const entity of this.entities) {
      const building = entity.getComponent(Building);
      if (!building?.militaryGarrison) continue;
      let changed = false;
      for (let i = 0; i < building.militaryGarrison.length; i++) {
        if (building.militaryGarrison[i]?.workerEntityId === workerEntityId) {
          building.militaryGarrison[i] = null;
          changed = true;
        }
      }
      if (changed)
        eventBus.emit('military:garrison_changed', {
          buildingEntityId: entity.id,
        });
    }
  }

  private ensureGarrisonWorkersForBuilding(buildingEntity: Entity): void {
    const building = buildingEntity.getComponent(Building);
    const pos = buildingEntity.getComponent(Position);
    if (!building?.militaryGarrison || !pos) return;
    const factionId = getEntityFaction(buildingEntity);
    const exit = this.getBuildingExitTile(buildingEntity, 0) ?? {
      x: pos.x + 0.5,
      y: pos.y + 0.5,
    };
    for (const slot of building.militaryGarrison) {
      if (!slot) continue;
      const existing = this.entities.find(e => e.id === slot.workerEntityId && e.active);
      if (existing) continue;
      const workerEntity = createMilitaryWorker(exit.x, exit.y, slot.rank);
      setEntityFaction(workerEntity, factionId);
      const worker = workerEntity.getComponent(Worker);
      if (worker) {
        worker.concealedInBuildingId = buildingEntity.id;
        worker.setState('idle');
        worker.dropResource();
      }
      this.addEntity(workerEntity);
      slot.workerEntityId = workerEntity.id;
    }
  }

  private restoreClaimedAttackers(participants: AttackParticipant[]): void {
    for (const p of participants) {
      const source = this.entities.find(e => e.id === p.sourceBuildingId);
      const building = source?.getComponent(Building);
      if (!building?.militaryGarrison) continue;
      building.militaryGarrison[p.sourceSlotIndex] = {
        workerEntityId: p.workerEntityId,
        rank: p.rank,
      };
    }
  }

  private getAttackStagingTiles(targetEntity: Entity): ActiveEnemyAttack['staging'] {
    const targetCenter = this.getBuildingCenter(targetEntity) ?? { x: 0, y: 0 };
    const attacker = this.findNearestOpenTile(targetCenter.x - 3, targetCenter.y, targetCenter) ??
      this.findNearestOpenTile(targetCenter.x, targetCenter.y + 3, targetCenter) ?? {
        x: targetCenter.x - 3,
        y: targetCenter.y,
      };
    const defender = this.findNearestOpenTile(targetCenter.x - 1, targetCenter.y, targetCenter) ??
      this.findNearestOpenTile(targetCenter.x, targetCenter.y + 1, targetCenter) ?? {
        x: targetCenter.x - 1,
        y: targetCenter.y,
      };
    return { attacker, defender };
  }

  private offsetAttackStaging(
    base: { x: number; y: number },
    index: number,
    side: 'attacker' | 'defender'
  ): { x: number; y: number } {
    const forward = side === 'attacker' ? -1 : 1;
    const offsets = [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
      { x: forward, y: 0 },
      { x: forward, y: 1 },
      { x: forward, y: -1 },
      { x: -forward, y: 0 },
    ];
    const offset = offsets[index % offsets.length];
    return this.findNearestOpenTile(base.x + offset.x, base.y + offset.y, base) ?? base;
  }

  private getBuildingExitTile(
    buildingEntity: Entity,
    index: number
  ): { x: number; y: number } | null {
    const pos = buildingEntity.getComponent(Position);
    const building = buildingEntity.getComponent(Building);
    if (!pos || !building) return null;
    const entrance = building.getEntranceOffset();
    const base = entrance
      ? { x: pos.x + entrance.dx, y: pos.y + entrance.dy }
      : {
          x: pos.x + Math.floor(building.width / 2),
          y: pos.y + Math.floor(building.height / 2),
        };
    return this.offsetAttackStaging(base, index, 'defender');
  }

  private findNearestOpenTile(
    x: number,
    y: number,
    avoid?: { x: number; y: number }
  ): { x: number; y: number } | null {
    for (let r = 0; r <= 5; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const gx = Math.floor(x + dx);
          const gy = Math.floor(y + dy);
          if (avoid && gx === Math.floor(avoid.x) && gy === Math.floor(avoid.y)) continue;
          const tile = this.tileMap.getTile(gx, gy);
          if (tile?.walkable && !tile.isOccupied()) return { x: gx, y: gy };
        }
      }
    }
    return null;
  }

  private marchAttackParticipants(attack: ActiveEnemyAttack): void {
    const moveTo = (
      p: AttackParticipant,
      dest: { x: number; y: number },
      faction: FactionId,
      index: number
    ) => {
      const workerEntity = this.entities.find(e => e.id === p.workerEntityId);
      if (!workerEntity) return;
      setEntityFaction(workerEntity, faction);
      let pos = workerEntity.getComponent(Position);
      const worker = workerEntity.getComponent(Worker);
      let movable = workerEntity.getComponent(Movable);
      if (!pos) {
        pos = new Position(dest.x, dest.y);
        workerEntity.addComponent(pos);
      }
      if (!movable) {
        movable = new Movable(2.2);
        workerEntity.addComponent(movable);
      }
      if (worker?.concealedInBuildingId != null) {
        const exit = this.getBuildingExitTile(
          this.entities.find(e => e.id === p.sourceBuildingId) ?? workerEntity,
          index
        );
        if (exit) {
          pos.set(exit.x, exit.y);
        }
      }
      if (worker) {
        worker.role = 'military';
        worker.militaryRank = p.rank;
        worker.concealedInBuildingId = null;
        worker.visualActivity = 'general';
        worker.setState('walking');
      }
      const path = this.pathFinder.findOffRoadPath(pos, new Position(dest.x, dest.y), this.tileMap);
      movable.setPath(path.length > 0 ? path : [new Position(dest.x, dest.y)]);
    };
    attack.attackers.forEach((p, index) =>
      moveTo(
        p,
        this.offsetAttackStaging(attack.staging.attacker, index, 'attacker'),
        attack.attackerFactionId,
        index
      )
    );
    attack.defenders.forEach((p, index) =>
      moveTo(
        p,
        this.offsetAttackStaging(attack.staging.defender, index, 'defender'),
        attack.targetFactionId,
        index
      )
    );
  }

  private updateEnemyBorderPressure(): void {
    const attackConfig = dataManager.getGameConfig().enemyRealms.attacks;
    if (!attackConfig.enabled || this.enemyRealms.length === 0) return;

    const now = this.simulationNowMs;
    if (now < this.nextEnemyPressureCheckAt) return;
    this.nextEnemyPressureCheckAt = now + attackConfig.checkIntervalMs;

    for (const realm of this.enemyRealms) {
      const aggressiveness = this.getRealmAggressiveness(realm);
      if (aggressiveness <= 0 || realm.activated !== true) continue;
      if (!this.factionTerritoriesTouch(realm.factionId, PLAYER_FACTION)) {
        realm.nextAttackAt = undefined;
        continue;
      }

      this.reinforceEnemyRealmGarrison(realm, now);

      if (this.hasActiveAttackForFaction(realm.factionId)) continue;
      const firstDelay = this.getAggressionTuningValue(
        attackConfig.firstAttackDelayMsByAggressiveness,
        aggressiveness,
        Number.POSITIVE_INFINITY
      );
      if (realm.nextAttackAt === undefined) {
        realm.nextAttackAt = Number.isFinite(firstDelay)
          ? now + firstDelay
          : Number.POSITIVE_INFINITY;
        continue;
      }
      if (Number.isFinite(firstDelay) && realm.nextAttackAt > now + firstDelay) {
        realm.nextAttackAt = now + firstDelay;
      }
      if (now < realm.nextAttackAt) continue;

      const cooldown = this.getAggressionTuningValue(
        attackConfig.cooldownMsByAggressiveness,
        aggressiveness,
        Number.POSITIVE_INFINITY
      );
      const attempted = this.startEnemyRealmAttack(realm);
      realm.nextAttackAt =
        now + (attempted ? cooldown : Math.min(cooldown, attackConfig.checkIntervalMs * 6));
    }
  }

  private getRealmAggressiveness(realm: EnemyVillagePlan): number {
    const override = dataManager.getGameConfig().enemyRealms.debugAggressivenessOverride;
    if (typeof override === 'number') {
      return Math.max(0, Math.min(5, Math.floor(override)));
    }
    if (typeof realm.aggressivenessLevel === 'number') {
      return Math.max(0, Math.min(5, Math.floor(realm.aggressivenessLevel)));
    }
    const index = this.enemyRealms.findIndex(r => r.factionId === realm.factionId);
    const configured =
      dataManager.getGameConfig().enemyRealms.aggressivenessByVillageIndex[index] ?? 0;
    realm.aggressivenessLevel = Math.max(0, Math.min(5, Math.floor(configured)));
    return realm.aggressivenessLevel;
  }

  private getAggressionTuningValue(
    values: Record<number, number>,
    aggressiveness: number,
    fallback: number
  ): number {
    return values[aggressiveness] ?? values[Math.max(0, Math.min(5, aggressiveness))] ?? fallback;
  }

  private factionTerritoriesTouch(a: FactionId, b: FactionId): boolean {
    const aLayer = this.territory.getLayer(a);
    const bLayer = this.territory.getLayer(b);
    if (aLayer.unionU.size === 0 || bLayer.unionU.size === 0) return false;
    const dirs: readonly [number, number][] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (const cell of aLayer.frontier) {
      const [xRaw, yRaw] = cell.split(',');
      const x = Number(xRaw);
      const y = Number(yRaw);
      for (const [dx, dy] of dirs) {
        if (bLayer.unionU.has(`${x + dx},${y + dy}`)) return true;
      }
    }
    return false;
  }

  private hasActiveAttackForFaction(factionId: FactionId): boolean {
    return this.activeEnemyAttacks.some(
      attack =>
        attack.phase !== 'complete' &&
        (attack.attackerFactionId === factionId || attack.targetFactionId === factionId)
    );
  }

  private startEnemyRealmAttack(realm: EnemyVillagePlan): boolean {
    const target = this.findEnemyRealmAttackTarget(realm);
    if (!target) return false;
    const targetCenter = this.getBuildingCenter(target);
    if (!targetCenter) return false;

    const aggressiveness = this.getRealmAggressiveness(realm);
    const attackConfig = dataManager.getGameConfig().enemyRealms.attacks;
    const maxAttackers = this.getAggressionTuningValue(
      attackConfig.maxAttackersByAggressiveness,
      aggressiveness,
      0
    );
    const attackers = this.claimFactionAttackers(realm.factionId, targetCenter, maxAttackers);
    if (attackers.length === 0) return false;

    this.ensureGarrisonWorkersForBuilding(target);
    const defenders = this.claimDefendersForEnemyAttack(target);
    const attack: ActiveEnemyAttack = {
      id: this.nextEnemyAttackId++,
      targetEntityId: target.id,
      attackerFactionId: realm.factionId,
      targetFactionId: PLAYER_FACTION,
      initiatedBy: 'enemy',
      attackers,
      defenders,
      attackerQueue: attackers.map(a => a.workerEntityId),
      defenderQueue: defenders.map(d => d.workerEntityId),
      currentAttackerId: null,
      currentDefenderId: null,
      phase: 'marching',
      duelStartedAt: 0,
      fallenUntil: 0,
      fallenWorkerId: null,
      staging: this.getAttackStagingTiles(target),
      returnAssignments: [],
    };
    this.activeEnemyAttacks.push(attack);
    this.marchAttackParticipants(attack);
    eventBus.emit('toast', {
      message: 'Enemy raid sighted near the frontier.',
      duration: 10_000,
    });
    return true;
  }

  private findEnemyRealmAttackTarget(realm: EnemyVillagePlan): Entity | null {
    const enemySources = this.getFactionMilitaryCenters(realm.factionId);
    if (enemySources.length === 0) return null;
    const range = this.getEnemyAttackRangeCells();

    const candidates = this.entities
      .filter(entity => {
        if (!entity.active || !isPlayerOwned(entity)) return false;
        if (
          this.activeEnemyAttacks.some(
            attack => attack.targetEntityId === entity.id && attack.phase !== 'complete'
          )
        )
          return false;
        const building = entity.getComponent(Building);
        return !!building?.isComplete() && this.isMilitaryBuilding(building);
      })
      .map(entity => {
        const center = this.getBuildingCenter(entity);
        const building = entity.getComponent(Building);
        if (!center || !building) return null;
        const nearest = Math.min(
          ...enemySources.map(source =>
            Math.max(Math.abs(source.x - center.x), Math.abs(source.y - center.y))
          )
        );
        if (nearest > range) return null;
        return {
          entity,
          distance: nearest,
          defenders: building.getMilitaryGarrisonFilledCount(),
        };
      })
      .filter(
        (entry): entry is { entity: Entity; distance: number; defenders: number } => entry !== null
      )
      .sort((a, b) => a.distance - b.distance || a.defenders - b.defenders);

    return candidates[0]?.entity ?? null;
  }

  private getFactionMilitaryCenters(
    factionId: FactionId
  ): Array<{ entity: Entity; x: number; y: number }> {
    return this.entities
      .filter(entity => {
        if (!entity.active || getEntityFaction(entity) !== factionId) return false;
        if (this.hasMilitaryFromBuildingInActiveAttack(entity.id)) return false;
        const building = entity.getComponent(Building);
        return (
          !!building?.isComplete() &&
          this.isMilitaryBuilding(building) &&
          building.getMilitaryGarrisonFilledCount() > 0
        );
      })
      .map(entity => {
        const center = this.getBuildingCenter(entity);
        return center ? { entity, ...center } : null;
      })
      .filter((entry): entry is { entity: Entity; x: number; y: number } => entry !== null);
  }

  private claimFactionAttackers(
    factionId: FactionId,
    targetCenter: { x: number; y: number },
    maxCount: number
  ): AttackParticipant[] {
    if (maxCount <= 0) return [];
    const claimed: AttackParticipant[] = [];
    const sources = this.getFactionMilitaryCenters(factionId)
      .filter(
        source =>
          Math.max(Math.abs(source.x - targetCenter.x), Math.abs(source.y - targetCenter.y)) <=
          this.getEnemyAttackRangeCells()
      )
      .sort((a, b) => {
        const ad = Math.max(Math.abs(a.x - targetCenter.x), Math.abs(a.y - targetCenter.y));
        const bd = Math.max(Math.abs(b.x - targetCenter.x), Math.abs(b.y - targetCenter.y));
        return ad - bd;
      });

    for (const source of sources) {
      this.pruneInvalidMilitaryGarrisonSlots(source.entity);
      const building = source.entity.getComponent(Building);
      if (!building?.militaryGarrison) continue;
      for (const rank of [3, 2, 1] as const) {
        for (let i = 0; i < building.militaryGarrison.length; i++) {
          const slot = building.militaryGarrison[i];
          if (!slot || slot.rank !== rank) continue;
          claimed.push({
            workerEntityId: slot.workerEntityId,
            rank: slot.rank,
            sourceBuildingId: source.entity.id,
            sourceSlotIndex: i,
          });
          building.militaryGarrison[i] = null;
          eventBus.emit('military:garrison_changed', {
            buildingEntityId: source.entity.id,
          });
          if (claimed.length >= maxCount) return claimed;
        }
      }
    }
    return claimed;
  }

  private reinforceEnemyRealmGarrison(realm: EnemyVillagePlan, now: number): void {
    const attackConfig = dataManager.getGameConfig().enemyRealms.attacks;
    if (
      realm.lastReinforcedAt !== undefined &&
      now - realm.lastReinforcedAt < attackConfig.garrisonReinforceIntervalMs
    ) {
      return;
    }
    realm.lastReinforcedAt = now;

    let remaining = Math.max(0, attackConfig.garrisonReinforceCount);
    if (remaining <= 0) return;
    const rank = this.getEnemyReinforcementRank(this.getRealmAggressiveness(realm));
    const posts = this.entities
      .filter(entity => {
        if (!entity.active || getEntityFaction(entity) !== realm.factionId) return false;
        if (this.hasMilitaryFromBuildingInActiveAttack(entity.id)) return false;
        const building = entity.getComponent(Building);
        return !!building?.isComplete() && this.isMilitaryBuilding(building);
      })
      .sort((a, b) => {
        const af = a.getComponent(Building)?.getMilitaryGarrisonFilledCount() ?? 0;
        const bf = b.getComponent(Building)?.getMilitaryGarrisonFilledCount() ?? 0;
        return af - bf;
      });

    for (const entity of posts) {
      const building = entity.getComponent(Building);
      const pos = entity.getComponent(Position);
      if (!building || !pos) continue;
      const cap = dataManager.getBuilding(building.buildingType)?.military?.soldierCapacity ?? 0;
      building.initMilitaryGarrison(cap);
      const slotIndex = building.findFreeMilitarySlotIndex();
      if (slotIndex < 0) continue;

      const soldier = createMilitaryWorker(pos.x + 0.5, pos.y + 0.5, rank);
      setEntityFaction(soldier, realm.factionId);
      const worker = soldier.getComponent(Worker);
      if (worker) {
        worker.concealedInBuildingId = entity.id;
        worker.setState('idle');
      }
      this.addEntity(soldier);
      building.militaryGarrison![slotIndex] = {
        rank,
        workerEntityId: soldier.id,
      };
      building.militaryTerritoryEstablished = true;
      eventBus.emit('military:garrison_changed', {
        buildingEntityId: entity.id,
      });
      remaining--;
      if (remaining <= 0) break;
    }
  }

  private getEnemyReinforcementRank(aggressiveness: number): MilitaryRank {
    if (aggressiveness >= 5) return 3;
    if (aggressiveness >= 3) return 2;
    return 1;
  }

  private updateEnemyRoadMaintenance(): void {
    const config = dataManager.getGameConfig().enemyRealms.roadMaintenance;
    if (!config.enabled || this.enemyRealms.length === 0) return;

    const now = this.simulationNowMs;
    if (now < this.nextEnemyRoadMaintenanceAt) return;
    this.nextEnemyRoadMaintenanceAt = now + config.intervalMs;

    let repairsRemaining = Math.max(0, config.maxRepairsPerTick);
    let forwardBarracksRemaining = Math.max(0, config.maxForwardBarracksPerTick);
    if (repairsRemaining <= 0 && forwardBarracksRemaining <= 0) return;

    for (const realm of this.enemyRealms) {
      if (realm.activated !== true || !this.isEnemyRealmVisible(realm)) continue;
      if (
        forwardBarracksRemaining > 0 &&
        this.buildForwardBarracksForIsolatedMilitary(
          realm,
          config.maxPathCells,
          config.forwardBarracksSearchRadius
        )
      ) {
        forwardBarracksRemaining--;
      }
      while (
        repairsRemaining > 0 &&
        this.repairOneEnemyRoadConnection(realm, config.maxPathCells)
      ) {
        repairsRemaining--;
      }
      if (repairsRemaining <= 0 && forwardBarracksRemaining <= 0) break;
    }
  }

  private isEnemyRealmVisible(realm: EnemyVillagePlan): boolean {
    for (let y = realm.bounds.y; y < realm.bounds.y + realm.bounds.height; y++) {
      for (let x = realm.bounds.x; x < realm.bounds.x + realm.bounds.width; x++) {
        if (this.tileMap.getTile(x, y)?.isExplored()) return true;
      }
    }
    return false;
  }

  private repairOneEnemyRoadConnection(realm: EnemyVillagePlan, maxPathCells: number): boolean {
    const hq = this.findEnemyHeadquarters(realm.factionId);
    if (!hq) return false;
    const connectedRoads = this.getFactionHeadquartersConnectedRoads(realm.factionId, hq);
    const disconnected = this.entities
      .filter(entity => {
        if (!entity.active || getEntityFaction(entity) !== realm.factionId) return false;
        const building = entity.getComponent(Building);
        const pos = entity.getComponent(Position);
        if (!building || !pos || !building.requiresRoad) return false;
        if (this.hasBuildingConnectedRoad(pos, building, connectedRoads)) return false;
        return this.getEnemyRoadAnchorForBuilding(entity, realm.factionId) !== null;
      })
      .sort((a, b) => {
        const ac = this.getBuildingCenter(a);
        const bc = this.getBuildingCenter(b);
        const ah = this.getBuildingCenter(this.findEnemyHeadquarters(realm.factionId) ?? a);
        if (!ac || !bc || !ah) return 0;
        const ad = Math.max(Math.abs(ac.x - ah.x), Math.abs(ac.y - ah.y));
        const bd = Math.max(Math.abs(bc.x - ah.x), Math.abs(bc.y - ah.y));
        return ad - bd;
      });

    for (const entity of disconnected) {
      const target = this.getEnemyRoadAnchorForBuilding(entity, realm.factionId);
      if (!target) continue;
      const source = this.findNearestEnemyRoadCell(
        realm.factionId,
        target,
        realm.bounds,
        connectedRoads
      );
      if (!source) continue;
      const path = this.planEnemyRoadPath(source, target, realm.factionId);
      if (path.length === 0 || path.length > maxPathCells) continue;

      if (this.buildEnemyRoadPath(path, realm.factionId)) return true;
    }
    return false;
  }

  private findEnemyHeadquarters(factionId: FactionId): Entity | null {
    return (
      this.entities.find(entity => {
        if (!entity.active || getEntityFaction(entity) !== factionId) return false;
        return entity.getComponent(Building)?.buildingType === 'base_camp';
      }) ?? null
    );
  }

  private getFactionHeadquartersConnectedRoads(
    factionId: FactionId,
    headquarters: Entity
  ): Set<string> {
    const connected = new Set<string>();
    const pos = headquarters.getComponent(Position);
    const building = headquarters.getComponent(Building);
    if (!pos || !building) return connected;

    const isNetworkRoad = (x: number, y: number): boolean => {
      const tile = this.tileMap.getTile(x, y);
      if (!tile?.hasRoad) return false;
      if (!tile.isOccupied()) return this.territory.isInteriorCell(x, y, factionId);
      const occupant = this.entities.find(entity => entity.id === tile.occupiedBy);
      return !!occupant && getEntityFaction(occupant) === factionId;
    };

    const entrance = building.getEntranceOffset();
    if (!entrance) return connected;
    const queue: { x: number; y: number }[] = [];
    const seed = (x: number, y: number): void => {
      const key = `${x},${y}`;
      if (connected.has(key) || !isNetworkRoad(x, y)) return;
      connected.add(key);
      queue.push({ x, y });
    };
    seed(pos.x + entrance.dx, pos.y + entrance.dy);

    const dirs: readonly [number, number][] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    while (queue.length > 0) {
      const { x, y } = queue.shift()!;
      for (const [dx, dy] of dirs) seed(x + dx, y + dy);
    }
    return connected;
  }

  private buildForwardBarracksForIsolatedMilitary(
    realm: EnemyVillagePlan,
    maxPathCells: number,
    searchRadius: number
  ): boolean {
    const hq = this.findEnemyHeadquarters(realm.factionId);
    if (!hq) return false;
    const connectedRoads = this.getFactionHeadquartersConnectedRoads(realm.factionId, hq);
    if (connectedRoads.size === 0) return false;

    const isolatedPost = this.findIsolatedEnemyMilitaryPost(realm.factionId, hq, connectedRoads);
    if (!isolatedPost) return false;

    const targetAnchor = this.getEnemyRoadAnchorForBuilding(isolatedPost, realm.factionId);
    const barracksSite = targetAnchor
      ? this.findForwardBarracksSite(realm.factionId, isolatedPost, targetAnchor, searchRadius)
      : null;
    if (!barracksSite) return false;
    if (
      this.hasEnemyBarracksNear(
        realm.factionId,
        isolatedPost,
        Math.max(6, Math.floor(searchRadius / 2))
      )
    )
      return false;

    const barracksPlan: EnemyVillageBuildingPlan = {
      type: 'barracks',
      x: barracksSite.x,
      y: barracksSite.y,
      seedGarrison: true,
      garrisonFillRatio: 1,
      garrisonRank: this.getEnemyReinforcementRank(this.getRealmAggressiveness(realm)),
    };
    const barracks = this.placeEnemyBuilding(barracksPlan, realm.factionId, false);
    if (!barracks) return false;

    const barracksBuilding = barracks.getComponent(Building);
    if (barracksBuilding) barracksBuilding.militaryTerritoryEstablished = true;
    this.markTerritoryDirty();
    this.refreshTerritoryIfDirty();

    const barracksAnchor = this.getEnemyRoadAnchorForBuilding(barracks, realm.factionId);
    const source = barracksAnchor
      ? this.findNearestEnemyRoadCell(realm.factionId, barracksAnchor, realm.bounds, connectedRoads)
      : null;
    if (source && barracksAnchor) {
      const path = this.planEnemyRoadPath(source, barracksAnchor, realm.factionId);
      if (path.length > 0 && path.length <= maxPathCells)
        this.buildEnemyRoadPath(path, realm.factionId);
    }

    const refreshedConnectedRoads = this.getFactionHeadquartersConnectedRoads(realm.factionId, hq);
    const isolatedStillDisconnected = (() => {
      const pos = isolatedPost.getComponent(Position);
      const building = isolatedPost.getComponent(Building);
      return (
        !!pos &&
        !!building &&
        !this.hasBuildingConnectedRoad(pos, building, refreshedConnectedRoads)
      );
    })();
    if (isolatedStillDisconnected && barracksAnchor && targetAnchor) {
      const path = this.planEnemyRoadPath(barracksAnchor, targetAnchor, realm.factionId);
      if (path.length > 0 && path.length <= maxPathCells)
        this.buildEnemyRoadPath(path, realm.factionId);
    }

    this.updateBuildingRoadConnections();
    eventBus.emit('toast', {
      message: 'Enemy realm builds a forward barracks.',
      type: 'warning',
    });
    return true;
  }

  private findIsolatedEnemyMilitaryPost(
    factionId: FactionId,
    headquarters: Entity,
    connectedRoads: Set<string>
  ): Entity | null {
    const hqCenter = this.getBuildingCenter(headquarters);
    const candidates = this.entities
      .filter(entity => {
        if (!entity.active || entity === headquarters || getEntityFaction(entity) !== factionId)
          return false;
        const building = entity.getComponent(Building);
        const pos = entity.getComponent(Position);
        if (!building || !pos || !building.isComplete() || !this.isMilitaryBuilding(building))
          return false;
        if (this.hasBuildingConnectedRoad(pos, building, connectedRoads)) return false;
        return this.getEnemyRoadAnchorForBuilding(entity, factionId) !== null;
      })
      .sort((a, b) => {
        const ac = this.getBuildingCenter(a);
        const bc = this.getBuildingCenter(b);
        if (!ac || !bc || !hqCenter) return 0;
        return (
          Math.abs(bc.x - hqCenter.x) +
          Math.abs(bc.y - hqCenter.y) -
          (Math.abs(ac.x - hqCenter.x) + Math.abs(ac.y - hqCenter.y))
        );
      });
    return candidates[0] ?? null;
  }

  private findForwardBarracksSite(
    factionId: FactionId,
    isolatedPost: Entity,
    targetAnchor: { x: number; y: number },
    searchRadius: number
  ): { x: number; y: number } | null {
    const def = dataManager.getBuilding('barracks');
    const center = this.getBuildingCenter(isolatedPost);
    if (!def || !center) return null;

    let best: { x: number; y: number; score: number } | null = null;
    const radius = Math.max(4, searchRadius);
    const { width, height } = def.size;
    for (
      let y = Math.max(0, Math.floor(center.y) - radius);
      y <= Math.min(this.tileMap.height - 1, Math.ceil(center.y) + radius);
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(center.x) - radius);
        x <= Math.min(this.tileMap.width - 1, Math.ceil(center.x) + radius);
        x++
      ) {
        if (!this.canPlaceEnemyBuildingAt(x, y, width, height, factionId)) continue;
        const footprintCenter = { x: x + width / 2, y: y + height / 2 };
        const distanceToPost =
          Math.abs(footprintCenter.x - center.x) + Math.abs(footprintCenter.y - center.y);
        const distanceToAnchor =
          Math.abs(footprintCenter.x - targetAnchor.x) +
          Math.abs(footprintCenter.y - targetAnchor.y);
        const frontierScore = this.distanceFromFactionFrontier(x, y, width, height, factionId);
        const score = distanceToPost + distanceToAnchor * 0.5 + frontierScore * 0.35;
        if (!best || score < best.score) best = { x, y, score };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  private hasEnemyBarracksNear(factionId: FactionId, target: Entity, radius: number): boolean {
    const center = this.getBuildingCenter(target);
    if (!center) return false;
    return this.entities.some(entity => {
      if (!entity.active || entity === target || getEntityFaction(entity) !== factionId)
        return false;
      const building = entity.getComponent(Building);
      const otherCenter = this.getBuildingCenter(entity);
      if (!building || building.buildingType !== 'barracks' || !otherCenter) return false;
      const distance = Math.abs(otherCenter.x - center.x) + Math.abs(otherCenter.y - center.y);
      return distance <= radius;
    });
  }

  private canPlaceEnemyBuildingAt(
    x: number,
    y: number,
    width: number,
    height: number,
    factionId: FactionId
  ): boolean {
    if (!this.canPlaceBuilding(x, y, width, height)) return false;
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        if (!this.territory.isInteriorCell(x + dx, y + dy, factionId)) return false;
      }
    }
    return true;
  }

  private distanceFromFactionFrontier(
    x: number,
    y: number,
    width: number,
    height: number,
    factionId: FactionId
  ): number {
    let best = Number.POSITIVE_INFINITY;
    const radius = 8;
    for (
      let cy = Math.max(0, y - radius);
      cy <= Math.min(this.tileMap.height - 1, y + height + radius);
      cy++
    ) {
      for (
        let cx = Math.max(0, x - radius);
        cx <= Math.min(this.tileMap.width - 1, x + width + radius);
        cx++
      ) {
        if (!this.territory.getLayer(factionId).frontier.has(`${cx},${cy}`)) continue;
        const distance = Math.abs(cx - (x + width / 2)) + Math.abs(cy - (y + height / 2));
        if (distance < best) best = distance;
      }
    }
    return Number.isFinite(best) ? best : radius + 1;
  }

  private getEnemyRoadAnchorForBuilding(
    entity: Entity,
    factionId: FactionId
  ): { x: number; y: number } | null {
    const pos = entity.getComponent(Position);
    const building = entity.getComponent(Building);
    if (!pos || !building) return null;

    const candidates: Array<{ x: number; y: number }> = [];
    const entrance = building.getEntranceOffset();
    if (entrance) {
      const ex = pos.x + entrance.dx;
      const ey = pos.y + entrance.dy;
      candidates.push(
        { x: ex + 1, y: ey },
        { x: ex, y: ey + 1 },
        { x: ex, y: ey - 1 },
        { x: ex - 1, y: ey }
      );
    }

    const dirs: readonly [number, number][] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (let dy = 0; dy < building.height; dy++) {
      for (let dx = 0; dx < building.width; dx++) {
        const x = pos.x + dx;
        const y = pos.y + dy;
        for (const [ox, oy] of dirs) candidates.push({ x: x + ox, y: y + oy });
      }
    }

    return candidates.find(cell => this.canUseEnemyRoadPathCell(cell.x, cell.y, factionId)) ?? null;
  }

  private findNearestEnemyRoadCell(
    factionId: FactionId,
    target: { x: number; y: number },
    bounds: { x: number; y: number; width: number; height: number },
    connectedRoads?: Set<string>
  ): { x: number; y: number } | null {
    let best: { x: number; y: number; distance: number } | null = null;
    if (connectedRoads) {
      for (const key of connectedRoads) {
        const [rawX, rawY] = key.split(',');
        const x = Number(rawX);
        const y = Number(rawY);
        const tile = this.tileMap.getTile(x, y);
        if (!tile?.hasRoad || tile.isOccupied()) continue;
        const distance = Math.abs(x - target.x) + Math.abs(y - target.y);
        if (!best || distance < best.distance) best = { x, y, distance };
      }
      return best ? { x: best.x, y: best.y } : null;
    }

    const minX = Math.max(0, bounds.x - 4);
    const minY = Math.max(0, bounds.y - 4);
    const maxX = Math.min(this.tileMap.width - 1, bounds.x + bounds.width + 4);
    const maxY = Math.min(this.tileMap.height - 1, bounds.y + bounds.height + 4);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const tile = this.tileMap.getTile(x, y);
        if (!tile?.hasRoad || tile.isOccupied()) continue;
        if (!this.territory.isInteriorCell(x, y, factionId)) continue;
        const distance = Math.abs(x - target.x) + Math.abs(y - target.y);
        if (!best || distance < best.distance) best = { x, y, distance };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  private buildEnemyRoadPath(path: { x: number; y: number }[], factionId: FactionId): boolean {
    let built = 0;
    for (const cell of path) {
      const tile = this.tileMap.getTile(cell.x, cell.y);
      if (!tile || (tile.hasRoad && !tile.isOccupied())) continue;
      if (!this.canUseEnemyRoadPathCell(cell.x, cell.y, factionId)) continue;
      if (this.tileMap.buildRoad(cell.x, cell.y)) {
        roadSegmentManager.addRoad(cell.x, cell.y);
        built++;
      }
    }
    if (built <= 0) return false;

    roadSegmentManager.recalculate(this.tileMap);
    this.recomputeTransportRoutes();
    this.updateBuildingRoadConnections();
    return true;
  }

  private planEnemyRoadPath(
    from: { x: number; y: number },
    to: { x: number; y: number },
    factionId: FactionId
  ): { x: number; y: number }[] {
    return this.pathFinder.findBuildableRoadPath(from, to, this.tileMap, {
      canUseCell: (x, y) => this.canUseEnemyRoadPathCell(x, y, factionId),
      isExistingRoad: (x, y) => {
        const tile = this.tileMap.getTile(x, y);
        return !!(tile?.hasRoad && !tile.isOccupied());
      },
    });
  }

  private canUseEnemyRoadPathCell(x: number, y: number, factionId: FactionId): boolean {
    const tile = this.tileMap.getTile(x, y);
    if (!tile) return false;
    if (this.isDemolitionFireBlockingCell(x, y)) return false;
    if (!this.territory.isInteriorCell(x, y, factionId)) return false;
    if (tile.hasRoad && !tile.isOccupied()) return true;
    return tile.terrain !== 'water' && tile.terrain !== 'mountain' && !tile.isOccupied();
  }

  private updateEnemyAttacks(): void {
    if (this.activeEnemyAttacks.length === 0) {
      this.nextBattleClashAt = 0;
      return;
    }
    const now = this.simulationNowMs;
    for (const attack of this.activeEnemyAttacks) {
      if (attack.phase === 'complete') continue;
      if (attack.phase === 'marching') {
        const arrived = [...attack.attackers, ...attack.defenders].every(p => {
          const entity = this.entities.find(e => e.id === p.workerEntityId);
          const movable = entity?.getComponent(Movable);
          return !movable || !movable.isMoving;
        });
        if (arrived) {
          this.beginNextEnemyAttackDuel(attack);
        }
      } else if (attack.phase === 'duel') {
        this.keepDuelistsFacing(attack);
        if (now - attack.duelStartedAt >= ENEMY_ATTACK_DUEL_MS) {
          this.resolveEnemyAttackDuel(attack, now);
        }
      } else if (attack.phase === 'fallen' && now >= attack.fallenUntil) {
        if (attack.fallenWorkerId != null) {
          this.removeWorkerFromAllMilitaryGarrisons(attack.fallenWorkerId);
          const fallen = this.entities.find(e => e.id === attack.fallenWorkerId);
          if (fallen) this.removeEntity(fallen);
        }
        attack.fallenWorkerId = null;
        this.beginNextEnemyAttackDuel(attack);
      } else if (attack.phase === 'returning') {
        const arrived = attack.returnAssignments.every(a => {
          const entity = this.entities.find(e => e.id === a.workerEntityId);
          const movable = entity?.getComponent(Movable);
          return !entity || !entity.active || !movable || !movable.isMoving;
        });
        if (arrived) {
          this.finishEnemyAttackReturn(attack);
        }
      }
    }
    this.activeEnemyAttacks = this.activeEnemyAttacks.filter(attack => attack.phase !== 'complete');
    this.updateBattleAudio(now);
  }

  private updateBattleAudio(now: number): void {
    const hasVisibleDuel = this.activeEnemyAttacks.some(
      attack => attack.phase === 'duel' && this.isAttackVisibleToPlayer(attack)
    );
    if (!hasVisibleDuel) {
      this.nextBattleClashAt = 0;
      return;
    }
    if (now < this.nextBattleClashAt) return;

    audioManager.playSound(Math.random() < 0.5 ? 'battle_clash_1' : 'battle_clash_2');
    const quickFollowUp = Math.random() < 0.35;
    const delayMs = quickFollowUp ? 180 + Math.random() * 260 : 700 + Math.random() * 900;
    this.nextBattleClashAt = now + delayMs;
  }

  private playBattleOutcomeSoundIfVisible(attack: ActiveEnemyAttack, playerWon: boolean): void {
    if (!this.isAttackVisibleToPlayer(attack)) return;
    audioManager.playSound(playerWon ? 'battle_victory' : 'battle_loss');
  }

  private isOnScreen(gridX: number, gridY: number): boolean {
    const screen = this.renderSystem.gridToScreen(gridX, gridY);
    const pad = 32;
    return (
      screen.x >= -pad &&
      screen.x <= this.canvas.width + pad &&
      screen.y >= -pad &&
      screen.y <= this.canvas.height + pad
    );
  }

  private updateForestAmbient(): void {
    if (!document.hasFocus()) return;
    const now = Date.now(); // wall-clock — unaffected by fast-forward
    if (now < this.nextForestAmbientAt) return;

    const bounds = this.renderSystem.getViewportBounds();
    let forestCount = 0;
    const CLUSTER_THRESHOLD = 25;

    outer: for (let y = bounds.minY; y <= bounds.maxY; y++) {
      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        const tile = this.tileMap.getTile(x, y);
        if (
          tile?.isExplored() &&
          (tile.terrain === 'forest' || tile.terrain === 'tree') &&
          tile.forestDepth >= 1
        ) {
          forestCount++;
          if (forestCount >= CLUSTER_THRESHOLD) break outer;
        }
      }
    }

    if (forestCount < CLUSTER_THRESHOLD) return;

    audioManager.playSound(Math.random() < 0.5 ? 'forest_1' : 'forest_2');
    // Next sound in 25–55 seconds (wall-clock)
    this.nextForestAmbientAt = now + 25_000 + Math.random() * 30_000;
  }

  private updateHammerSound(): void {
    if (!document.hasFocus()) return;
    const now = Date.now(); // wall-clock — unaffected by fast-forward
    if (now < this.nextHammerSoundAt) return;

    const bounds = this.renderSystem.getViewportBounds();

    const hasVisibleConstruction = this.entities.some(entity => {
      if (!entity.active) return false;
      const building = entity.getComponent(Building);
      if (building?.state !== 'under_construction') return false;
      const pos = entity.getComponent(Position);
      if (!pos) return false;
      const cx = pos.x + (building.width ?? 1) / 2;
      const cy = pos.y + (building.height ?? 1) / 2;
      if (
        cx + (building.width ?? 1) < bounds.minX ||
        cx > bounds.maxX ||
        cy + (building.height ?? 1) < bounds.minY ||
        cy > bounds.maxY
      )
        return false;
      return this.isOnScreen(cx, cy);
    });

    if (!hasVisibleConstruction) return;

    audioManager.playSound('hammer');
    // Randomise slightly around 10 s so repeated sounds feel natural
    this.nextHammerSoundAt = now + 9_500 + Math.random() * 1_000;
  }

  private updateWorkerAmbientSounds(): void {
    if (!document.hasFocus()) return;
    const now = Date.now(); // wall-clock — unaffected by fast-forward

    // ── Surveyor section ─────────────────────────────────────────────────────
    const surveyorConfig = WORKER_AMBIENT_SOUNDS['surveyor'];
    if (surveyorConfig) {
      const surveyorIds = this.surveys.getWorkingSurveyorWorkerIds();
      if (surveyorIds.length > 0) {
        const nextAt = this.nextWorkerSoundAt.get('surveyor') ?? 0;
        if (now >= nextAt) {
          const isVisible = surveyorIds.some(id => {
            const entity = this.entities.find(e => e.id === id && e.active);
            if (!entity) return false;
            const pos = entity.getComponent(Position);
            return pos != null && this.isOnScreen(pos.x, pos.y);
          });
          if (isVisible) {
            audioManager.playSound('surveyor');
            this.nextWorkerSoundAt.set('surveyor', now + surveyorConfig.intervalSec * 1_000);
          }
        }
      }
    }

    // ── Building animation workers section ───────────────────────────────────
    const animMap = this.workers.getAnimationWorkerBuildingMap();
    for (const [workerId, buildingEntityId] of animMap) {
      const buildingEntity = this.entities.find(e => e.id === buildingEntityId && e.active);
      if (!buildingEntity) continue;
      const building = buildingEntity.getComponent(Building);
      if (!building) continue;
      const def = dataManager.getBuilding(building.buildingType);
      if (!def?.ambientSound) continue;
      const key = `building_worker_${building.buildingType}`;
      const nextAt = this.nextWorkerSoundAt.get(key) ?? 0;
      if (now < nextAt) continue;
      const workerEntity = this.entities.find(e => e.id === workerId && e.active);
      if (!workerEntity) continue;
      const pos = workerEntity.getComponent(Position);
      if (!pos || !this.isOnScreen(pos.x, pos.y)) continue;
      audioManager.playDynamicSound(key);
      this.nextWorkerSoundAt.set(key, now + def.ambientSound.intervalSec * 1_000);
    }
  }

  private isAttackVisibleToPlayer(attack: ActiveEnemyAttack): boolean {
    const points: Array<{ x: number; y: number }> = [];
    if (attack.currentAttackerId != null) {
      const attackerPos = this.entities
        .find(e => e.id === attack.currentAttackerId)
        ?.getComponent(Position);
      if (attackerPos) points.push({ x: attackerPos.x, y: attackerPos.y });
    }
    if (attack.currentDefenderId != null) {
      const defenderPos = this.entities
        .find(e => e.id === attack.currentDefenderId)
        ?.getComponent(Position);
      if (defenderPos) points.push({ x: defenderPos.x, y: defenderPos.y });
    }
    if (points.length === 0) {
      points.push({
        x: (attack.staging.attacker.x + attack.staging.defender.x) / 2,
        y: (attack.staging.attacker.y + attack.staging.defender.y) / 2,
      });
    }

    return points.some(point => this.isBattlePointVisible(point.x, point.y));
  }

  private isBattlePointVisible(gridX: number, gridY: number): boolean {
    const tile = this.tileMap.getTile(Math.floor(gridX), Math.floor(gridY));
    if (!tile?.isExplored()) return false;

    const screen = this.renderSystem.gridToScreen(gridX, gridY);
    const padding = 48;
    return (
      screen.x >= -padding &&
      screen.x <= this.canvas.width + padding &&
      screen.y >= -padding &&
      screen.y <= this.canvas.height + padding
    );
  }

  private beginNextEnemyAttackDuel(attack: ActiveEnemyAttack): void {
    if (attack.currentAttackerId == null)
      attack.currentAttackerId = attack.attackerQueue.shift() ?? null;
    if (attack.currentDefenderId == null)
      attack.currentDefenderId = attack.defenderQueue.shift() ?? null;

    if (attack.currentAttackerId == null) {
      this.finishEnemyAttackLoss(attack);
      return;
    }
    if (attack.currentDefenderId == null) {
      this.finishEnemyAttackWin(attack);
      return;
    }

    attack.phase = 'duel';
    attack.duelStartedAt = this.simulationNowMs;
    for (const id of [attack.currentAttackerId, attack.currentDefenderId]) {
      const worker = this.entities.find(e => e.id === id)?.getComponent(Worker);
      if (!worker) continue;
      worker.visualActivity = 'combat_duel';
      worker.carryingResource = undefined;
      worker.setState('working');
    }
    this.setDuelistsCloseTogether(attack);
    this.keepDuelistsFacing(attack);
  }

  private setDuelistsCloseTogether(attack: ActiveEnemyAttack): void {
    if (attack.currentAttackerId == null || attack.currentDefenderId == null) return;
    const attacker = this.entities.find(e => e.id === attack.currentAttackerId);
    const defender = this.entities.find(e => e.id === attack.currentDefenderId);
    const ap = attacker?.getComponent(Position);
    const dp = defender?.getComponent(Position);
    if (!ap || !dp) return;

    const midX = (attack.staging.attacker.x + attack.staging.defender.x) / 2;
    const midY = (attack.staging.attacker.y + attack.staging.defender.y) / 2;
    // Fractional tile offsets put sprites just a few screen pixels apart in isometric projection.
    ap.set(midX - 0.09, midY + 0.09);
    dp.set(midX + 0.09, midY - 0.09);
    attacker?.getComponent(Movable)?.clearPath();
    defender?.getComponent(Movable)?.clearPath();
  }

  private keepDuelistsFacing(attack: ActiveEnemyAttack): void {
    if (attack.currentAttackerId == null || attack.currentDefenderId == null) return;
    const attacker = this.entities.find(e => e.id === attack.currentAttackerId);
    const defender = this.entities.find(e => e.id === attack.currentDefenderId);
    const ap = attacker?.getComponent(Position);
    const dp = defender?.getComponent(Position);
    const aw = attacker?.getComponent(Worker);
    const dw = defender?.getComponent(Worker);
    if (!ap || !dp) return;
    const angle = Math.atan2(dp.y - ap.y, dp.x - ap.x);
    const facing = angleToWorkerFacing(angle);
    if (aw) aw.idleFacing = facing;
    if (dw) dw.idleFacing = (facing + 2) % 4;
  }

  private resolveEnemyAttackDuel(attack: ActiveEnemyAttack, now: number): void {
    const attackerId = attack.currentAttackerId;
    const defenderId = attack.currentDefenderId;
    if (attackerId == null || defenderId == null) return;
    const attackerRank = this.getAttackParticipantRank(attack, attackerId);
    const defenderRank = this.getAttackParticipantRank(attack, defenderId);
    const attackerRoll = Math.random() * this.getMilitaryRankWeight(attackerRank);
    const defenderRoll = Math.random() * this.getMilitaryRankWeight(defenderRank);
    const attackerDies = attackerRoll < defenderRoll;
    const loserId = attackerDies ? attackerId : defenderId;
    const winnerId = attackerDies ? defenderId : attackerId;

    const winnerWorker = this.entities.find(e => e.id === winnerId)?.getComponent(Worker);
    if (winnerWorker) {
      winnerWorker.visualActivity = 'combat_duel';
      winnerWorker.setState('working');
    }
    const loserWorker = this.entities.find(e => e.id === loserId)?.getComponent(Worker);
    if (loserWorker) {
      loserWorker.visualActivity = 'combat_fallen';
      loserWorker.buildIdleUntil = now + ENEMY_ATTACK_FALLEN_MS;
      loserWorker.setState('idle');
    }
    if (attackerDies) attack.currentAttackerId = null;
    else attack.currentDefenderId = null;
    attack.fallenWorkerId = loserId;
    attack.fallenUntil = now + ENEMY_ATTACK_FALLEN_MS;
    attack.phase = 'fallen';
  }

  private getAttackParticipantRank(
    attack: ActiveEnemyAttack,
    workerEntityId: number
  ): MilitaryRank {
    const participant = [...attack.attackers, ...attack.defenders].find(
      p => p.workerEntityId === workerEntityId
    );
    return participant?.rank ?? 1;
  }

  private getMilitaryRankWeight(rank: MilitaryRank): number {
    return rank === 3 ? 2.4 : rank === 2 ? 1.6 : 1;
  }

  private finishEnemyAttackLoss(attack: ActiveEnemyAttack): void {
    const playerWon = attack.attackerFactionId !== PLAYER_FACTION;
    this.playBattleOutcomeSoundIfVisible(attack, playerWon);
    const survivorIds = [attack.currentDefenderId, ...attack.defenderQueue].filter(
      (id): id is number => id != null
    );
    this.startAttackReturn(
      attack,
      survivorIds.map(id => ({
        workerEntityId: id,
        buildingEntityId: attack.targetEntityId,
        rank: this.getAttackParticipantRank(attack, id),
      }))
    );
    this.showAttackResultToast(
      attack.initiatedBy === 'enemy' ? 'Enemy attack repelled.' : 'Attack failed.',
      attack
    );
  }

  private finishEnemyAttackWin(attack: ActiveEnemyAttack): void {
    const playerWon = attack.attackerFactionId === PLAYER_FACTION;
    this.playBattleOutcomeSoundIfVisible(attack, playerWon);
    const target = this.entities.find(e => e.id === attack.targetEntityId);
    const building = target?.getComponent(Building);
    if (!target || !building) {
      attack.phase = 'complete';
      return;
    }

    const survivingAttackers = [attack.currentAttackerId, ...attack.attackerQueue].filter(
      (id): id is number => id != null
    );
    if (building.buildingType === 'base_camp') {
      setEntityFaction(target, attack.attackerFactionId);
      if (attack.attackerFactionId === PLAYER_FACTION) {
        this.burnEnemyRealmAfterHqCapture(attack.targetFactionId);
      }
      this.startAttackReturn(
        attack,
        survivingAttackers.map(id => {
          const participant = attack.attackers.find(p => p.workerEntityId === id);
          return {
            workerEntityId: id,
            buildingEntityId: participant?.sourceBuildingId ?? attack.targetEntityId,
            rank: this.getAttackParticipantRank(attack, id),
          };
        })
      );
      this.showAttackResultToast(
        attack.attackerFactionId === PLAYER_FACTION
          ? 'Enemy headquarters captured.'
          : 'Headquarters captured by enemy.',
        attack
      );
    } else {
      setEntityFaction(target, attack.attackerFactionId);
      building.militaryTerritoryEstablished = false;
      this.startAttackReturn(
        attack,
        this.getCapturedMilitaryReturnAssignments(target, attack, survivingAttackers)
      );
      this.showAttackResultToast(
        attack.attackerFactionId === PLAYER_FACTION
          ? 'Enemy military building captured.'
          : 'Military building captured by enemy.',
        attack
      );
    }
    this.selectedEntity = null;
    this.updateSelectionUI();
  }

  private startAttackReturn(
    attack: ActiveEnemyAttack,
    assignments: Array<{
      workerEntityId: number;
      buildingEntityId: number;
      rank: MilitaryRank;
    }>
  ): void {
    attack.returnAssignments = assignments.filter(a =>
      this.entities.some(e => e.id === a.workerEntityId && e.active)
    );
    if (attack.returnAssignments.length === 0) {
      attack.phase = 'complete';
      return;
    }

    for (const assignment of attack.returnAssignments) {
      this.walkAttackSurvivorToBuilding(assignment.workerEntityId, assignment.buildingEntityId);
    }

    attack.phase = 'returning';
    this.markTerritoryDirty();
  }

  private getCapturedMilitaryReturnAssignments(
    target: Entity,
    attack: ActiveEnemyAttack,
    survivingAttackers: number[]
  ): Array<{
    workerEntityId: number;
    buildingEntityId: number;
    rank: MilitaryRank;
  }> {
    const building = target.getComponent(Building);
    const cap = Math.max(
      dataManager.getBuilding(building?.buildingType ?? 'road')?.military?.soldierCapacity ?? 0,
      0
    );
    return survivingAttackers.map((id, index) => {
      const participant = attack.attackers.find(p => p.workerEntityId === id);
      return {
        workerEntityId: id,
        buildingEntityId: index < cap ? target.id : (participant?.sourceBuildingId ?? target.id),
        rank: this.getAttackParticipantRank(attack, id),
      };
    });
  }

  private walkAttackSurvivorToBuilding(workerEntityId: number, buildingEntityId: number): void {
    const workerEntity = this.entities.find(e => e.id === workerEntityId && e.active);
    const buildingEntity = this.entities.find(e => e.id === buildingEntityId && e.active);
    const worker = workerEntity?.getComponent(Worker);
    const pos = workerEntity?.getComponent(Position);
    const movable = workerEntity?.getComponent(Movable);
    if (!workerEntity || !buildingEntity || !worker || !pos || !movable) {
      if (workerEntity) this.removeEntity(workerEntity);
      return;
    }
    const goal = this.getAttackReturnTile(buildingEntity);
    if (!goal) {
      this.removeEntity(workerEntity);
      return;
    }
    worker.visualActivity = 'general';
    worker.concealedInBuildingId = null;
    worker.setState('walking');
    movable.speed = 1.8;
    const path = this.pathFinder.findOffRoadPath(pos, new Position(goal.x, goal.y), this.tileMap);
    movable.setPath(path.length > 0 ? path : [new Position(goal.x, goal.y)]);
  }

  private finishEnemyAttackReturn(attack: ActiveEnemyAttack): void {
    for (const assignment of attack.returnAssignments) {
      const workerEntity = this.entities.find(e => e.id === assignment.workerEntityId && e.active);
      const buildingEntity = this.entities.find(
        e => e.id === assignment.buildingEntityId && e.active
      );
      const worker = workerEntity?.getComponent(Worker);
      const pos = workerEntity?.getComponent(Position);
      const movable = workerEntity?.getComponent(Movable);
      if (!workerEntity || !buildingEntity || !worker) continue;
      const goal = this.getAttackReturnTile(buildingEntity);
      if (goal && pos) pos.set(goal.x, goal.y);
      movable?.clearPath();
      const building = buildingEntity.getComponent(Building);
      if (building) {
        const def = dataManager.getBuilding(building.buildingType);
        const cap = Math.max(
          def?.military?.soldierCapacity ?? building.militaryGarrison?.length ?? 0,
          0
        );
        if (cap > 0 && (!building.militaryGarrison || building.militaryGarrison.length !== cap)) {
          building.militaryGarrison = Array.from({ length: cap }, () => null);
        }
        const slotIdx = building.militaryGarrison?.findIndex(slot => slot === null) ?? -1;
        if (slotIdx >= 0 && building.militaryGarrison) {
          building.militaryGarrison[slotIdx] = {
            workerEntityId: assignment.workerEntityId,
            rank: assignment.rank,
          };
          building.militaryTerritoryEstablished = true;
          eventBus.emit('military:garrison_changed', {
            buildingEntityId: buildingEntity.id,
          });
        } else {
          this.removeEntity(workerEntity);
          continue;
        }
      }
      worker.visualActivity = 'general';
      worker.concealedInBuildingId = buildingEntity.id;
      worker.setState('idle');
      setEntityFaction(workerEntity, getEntityFaction(buildingEntity));
    }
    const target = this.entities.find(e => e.id === attack.targetEntityId && e.active);
    if (
      target &&
      attack.attackerFactionId === PLAYER_FACTION &&
      isPlayerOwned(target) &&
      this.isMilitaryBuilding(target.getComponent(Building))
    ) {
      this.markTerritoryDirty();
      this.refreshTerritoryIfDirty();
      this.applyConqueredTerritoryAftermath(attack.targetFactionId);
    }
    if (
      target &&
      attack.attackerFactionId !== PLAYER_FACTION &&
      getEntityFaction(target) === attack.attackerFactionId &&
      this.isMilitaryBuilding(target.getComponent(Building))
    ) {
      this.markTerritoryDirty();
      this.refreshTerritoryIfDirty();
      this.applyFactionTerritoryAftermath(attack.attackerFactionId, PLAYER_FACTION);
    }
    attack.phase = 'complete';
    this.markTerritoryDirty();
  }

  private getAttackReturnTile(buildingEntity: Entity): { x: number; y: number } | null {
    const pos = buildingEntity.getComponent(Position);
    const building = buildingEntity.getComponent(Building);
    if (!pos || !building) return null;
    const entrance = building.getEntranceOffset();
    return entrance
      ? { x: pos.x + entrance.dx, y: pos.y + entrance.dy }
      : this.getBuildingCenter(buildingEntity);
  }

  private showAttackResultToast(message: string, attack: ActiveEnemyAttack): void {
    const target = this.entities.find(e => e.id === attack.targetEntityId);
    const center = target ? this.getBuildingCenter(target) : null;
    const focus = center ?? {
      x: (attack.staging.attacker.x + attack.staging.defender.x) / 2,
      y: (attack.staging.attacker.y + attack.staging.defender.y) / 2,
    };
    eventBus.emit('toast', {
      message,
      duration: 10_000,
      action: {
        label: '⌖',
        title: 'Jump to attack location',
        onClick: () => this.renderSystem.centerOnGrid(focus.x, focus.y),
      },
    });
  }

  private getBuildingLootDropTile(entity: Entity): { x: number; y: number } | null {
    const pos = entity.getComponent(Position);
    const building = entity.getComponent(Building);
    if (!pos || !building) return null;

    const entrance = building.getEntranceOffset();
    return entrance
      ? { x: pos.x + entrance.dx, y: pos.y + entrance.dy }
      : {
          x: pos.x + Math.floor(building.width / 2),
          y: pos.y + Math.floor(building.height / 2),
        };
  }

  private collectBuildingResources(entity: Entity): string[] {
    const resources: string[] = [];
    const storage = entity.getComponent(Storage);
    if (storage) {
      for (const [resource, amount] of Object.entries(storage.items)) {
        for (let i = 0; i < Math.floor(amount); i++) resources.push(resource);
      }
      storage.items = {};
    }

    const production = entity.getComponent(Production);
    if (production) {
      for (const [resource, amount] of Object.entries(production.outputBuffer)) {
        for (let i = 0; i < Math.floor(amount); i++) resources.push(resource);
      }
      production.outputBuffer = {};
    }
    return resources;
  }

  private dropCollectedResourcesForPickup(
    dropTile: { x: number; y: number },
    resources: string[]
  ): void {
    const destination = this.baseCampEntity?.id ?? null;
    for (const resource of resources) {
      transportManager.addJunctionItem(dropTile.x, dropTile.y, resource, destination);
    }
  }

  private destroyConqueredEnemyCivilianBuilding(entity: Entity): void {
    const dropTile = this.getBuildingLootDropTile(entity);
    const resources = this.collectBuildingResources(entity);
    this.destroyBuildingEntity(entity, 'demolish', {
      retreatOwnerWorkers: true,
    });
    if (dropTile) {
      const tile = this.tileMap.getTile(dropTile.x, dropTile.y);
      if (tile) tile.hasRoad = true;
      this.dropCollectedResourcesForPickup(dropTile, resources);
    }
  }

  private burnEnemyRealmAfterHqCapture(enemyFactionId: FactionId): void {
    const toBurn = this.entities.filter(entity => {
      if (!entity.active || getEntityFaction(entity) !== enemyFactionId) return false;
      const building = entity.getComponent(Building);
      return (
        !!building && building.buildingType !== 'base_camp' && !this.isMilitaryBuilding(building)
      );
    });
    for (const entity of toBurn) this.destroyConqueredEnemyCivilianBuilding(entity);
    this.removeOrRetreatEnemyWorkersInPlayerLand(enemyFactionId);
    this.markTerritoryDirty();
  }

  private applyPlayerTerritoryPressureAftermath(): void {
    for (const factionId of ENEMY_FACTIONS) {
      if (this.hasCivilianBuildingInFactionTerritory(factionId, PLAYER_FACTION)) {
        this.applyConqueredTerritoryAftermath(factionId);
      }
    }
  }

  private hasCivilianBuildingInFactionTerritory(
    victimFactionId: FactionId,
    ownerFactionId: FactionId
  ): boolean {
    const ownedCells = this.getFactionOwnedCells(ownerFactionId);

    return this.entities.some(entity => {
      if (!entity.active || getEntityFaction(entity) !== victimFactionId) return false;
      const building = entity.getComponent(Building);
      const pos = entity.getComponent(Position);
      if (
        !building ||
        !pos ||
        building.buildingType === 'base_camp' ||
        this.isMilitaryBuilding(building)
      )
        return false;
      return this.buildingFootprintTouchesCells(pos, building, ownedCells);
    });
  }

  private applyConqueredTerritoryAftermath(enemyFactionId: FactionId): void {
    this.applyFactionTerritoryAftermath(PLAYER_FACTION, enemyFactionId);
  }

  private applyFactionTerritoryAftermath(
    ownerFactionId: FactionId,
    victimFactionId: FactionId
  ): void {
    const ownedCells = this.getFactionOwnedCells(ownerFactionId);
    const toBurn = this.entities.filter(entity => {
      if (!entity.active || getEntityFaction(entity) !== victimFactionId) return false;
      const building = entity.getComponent(Building);
      const pos = entity.getComponent(Position);
      if (
        !building ||
        !pos ||
        building.buildingType === 'base_camp' ||
        this.isMilitaryBuilding(building)
      )
        return false;
      return this.buildingFootprintTouchesCells(pos, building, ownedCells);
    });
    for (const entity of toBurn) this.destroyConqueredEnemyCivilianBuilding(entity);
    if (ownerFactionId === PLAYER_FACTION) {
      this.removeOrRetreatEnemyWorkersInPlayerLand(victimFactionId);
    }
    roadSegmentManager.recalculate(this.tileMap);
    this.recomputeTransportRoutes();
  }

  private getFactionOwnedCells(factionId: FactionId): Set<string> {
    const layer = this.territory.getLayer(factionId);
    return new Set<string>([...layer.unionU, ...layer.frontier, ...layer.interior]);
  }

  private removeRoadsOnTerritoryFrontiers(): void {
    const frontierCells = new Set<string>();
    for (const factionId of this.territory.getFactionIds()) {
      for (const cell of this.territory.getLayer(factionId).frontier) {
        frontierCells.add(cell);
      }
    }

    let changed = false;
    for (const cell of frontierCells) {
      const [xRaw, yRaw] = cell.split(',');
      const x = Number(xRaw);
      const y = Number(yRaw);
      const tile = this.tileMap.getTile(x, y);
      transportManager.clearItemsAt(x, y);
      if (!tile?.hasRoad) continue;
      tile.hasRoad = false;
      roadSegmentManager.removeRoad(x, y);
      changed = true;
    }

    if (changed) {
      roadSegmentManager.recalculate(this.tileMap);
      this.recomputeTransportRoutes();
      this.updateBuildingRoadConnections();
      this.workers.rerouteReturningWorkers();
    }
  }

  private buildingFootprintTouchesCells(
    pos: Position,
    building: Building,
    cells: ReadonlySet<string>
  ): boolean {
    for (let dy = 0; dy < building.height; dy++) {
      for (let dx = 0; dx < building.width; dx++) {
        if (cells.has(`${pos.x + dx},${pos.y + dy}`)) return true;
      }
    }
    return false;
  }

  private removeOrRetreatEnemyWorkersInPlayerLand(enemyFactionId: FactionId): void {
    const playerLayer = this.territory.getLayer(PLAYER_FACTION);
    const playerOwnedCells = new Set<string>([
      ...playerLayer.unionU,
      ...playerLayer.frontier,
      ...playerLayer.interior,
    ]);
    for (const entity of this.entities) {
      if (
        !entity.active ||
        getEntityFaction(entity) !== enemyFactionId ||
        !entity.hasComponent(Worker)
      )
        continue;
      const pos = entity.getComponent(Position);
      if (!pos || !playerOwnedCells.has(`${Math.floor(pos.x)},${Math.floor(pos.y)}`)) continue;
      const hq = this.findEnemyHeadquarters(enemyFactionId);
      const center = hq ? this.getBuildingCenter(hq) : null;
      const movable = entity.getComponent(Movable);
      const worker = entity.getComponent(Worker);
      if (!center || !movable) {
        this.removeEntity(entity);
        continue;
      }
      const path = this.pathFinder.findOffRoadPath(
        pos,
        new Position(center.x, center.y),
        this.tileMap
      );
      if (path.length === 0) {
        this.removeEntity(entity);
      } else {
        worker?.setState('walking');
        movable.setPath(path);
      }
    }
  }

  /** Highlight a grass tile while the “Send Surveyor” popover is open (canvas). */
  setSurveyMenuHighlight(tile: { x: number; y: number } | null): void {
    this.renderSystem.setSurveyMenuHighlight(tile);
  }

  clearSurveyPending(): void {
    this.pendingSurveyGrid = null;
    this.renderSystem.setSurveyPendingTile(null);
  }

  /** Clear selected building and grass survey-pending cell (Escape / V when not dragging a building). */
  clearMapSelection(): void {
    if (!this.isDraggingEntity) {
      this.selectedEntity = null;
      this.updateSelectionUI();
    }
    this.clearSurveyPending();
  }

  private isClickOnSurveyOptionIcon(
    gx: number,
    gy: number,
    clientX?: number,
    clientY?: number
  ): boolean {
    if (clientX === undefined || clientY === undefined) return false;
    const c = this.renderSystem.gridToScreen(gx, gy);
    const r = 24;
    const dx = clientX - c.x;
    const dy = clientY - c.y;
    return dx * dx + dy * dy <= r * r;
  }

  // Selection and editing functionality
  private findRoadWorkerAtPointer(
    gridX: number,
    gridY: number,
    clientPos?: { x: number; y: number }
  ): Entity | null {
    let best: { entity: Entity; distSq: number } | null = null;
    for (const seg of roadSegmentManager.getSegments()) {
      if (seg.assignedWorkerId == null) continue;
      const entity = this.entities.find(e => e.id === seg.assignedWorkerId && e.active);
      if (!entity) continue;
      const worker = entity.getComponent(Worker);
      const pos = entity.getComponent(Position);
      if (!worker || !pos || worker.concealedInBuildingId != null) continue;

      if (clientPos) {
        const screen = this.renderSystem.gridToScreen(pos.x, pos.y);
        const dx = clientPos.x - screen.x;
        const dy = clientPos.y - screen.y;
        const radius = worker.carrierType === 'donkey' ? 30 : 22;
        const distSq = dx * dx + dy * dy;
        if (distSq <= radius * radius && (!best || distSq < best.distSq)) {
          best = { entity, distSq };
        }
      } else if (Math.floor(pos.x) === gridX && Math.floor(pos.y) === gridY) {
        return entity;
      }
    }
    return best?.entity ?? null;
  }

  selectEntityAt(x: number, y: number, clientX?: number, clientY?: number): void {
    const surveyMenuWasOpen = this.cellSurveyMenuOpen;
    if (surveyMenuWasOpen) {
      eventBus.emit('survey:cell_menu_close');
    }

    const roadWorker = this.findRoadWorkerAtPointer(
      x,
      y,
      clientX !== undefined && clientY !== undefined ? { x: clientX, y: clientY } : undefined
    );
    if (roadWorker) {
      this.clearSurveyPending();
      this.selectedEntity = roadWorker;
      this.updateSelectionUI();
      return;
    }

    // Find entity at this position (buildings and roads only, not workers)
    const foundEntity = this.entities.find(entity => {
      const pos = entity.getComponent(Position);
      const building = entity.getComponent(Building);

      if (!pos || !building) return false;

      // Check if click is within building footprint
      return x >= pos.x && x < pos.x + building.width && y >= pos.y && y < pos.y + building.height;
    });

    if (foundEntity) {
      this.clearSurveyPending();
      if (!this.isAreaExplored(x, y, 1, 1)) {
        this.selectedEntity = null;
        this.updateSelectionUI();
        return;
      }
      if (!isPlayerOwned(foundEntity) && !this.isEnemyAttackTarget(foundEntity)) {
        this.selectedEntity = null;
        this.updateSelectionUI();
        return;
      }

      // Check if it's the base camp
      if (foundEntity === this.baseCampEntity && isPlayerOwned(foundEntity)) {
        // Show inventory panel
        eventBus.emit('open:inventory');
        console.log(`🏕️ Base Camp clicked - opening inventory`);
        return;
      }

      if (this.selectedEntity === foundEntity) {
        // Clicking on already selected entity - deselect it
        this.selectedEntity = null;
        this.updateSelectionUI();
        console.log(`Deselected entity #${foundEntity.id}`);
      } else {
        // Select new entity
        this.selectedEntity = foundEntity;
        this.updateSelectionUI();
        console.log(`Selected entity #${foundEntity.id}`);
      }
    } else {
      const eligible =
        this.isAreaExplored(x, y, 1, 1) && this.surveys.isTileEligibleForSurveyTarget(x, y);

      const pending = this.pendingSurveyGrid;
      const onPendingCell = pending !== null && pending.x === x && pending.y === y;
      const iconHit =
        onPendingCell &&
        !surveyMenuWasOpen &&
        this.isClickOnSurveyOptionIcon(x, y, clientX, clientY);

      if (eligible && iconHit) {
        eventBus.emit('cell:empty_menu', {
          gridX: x,
          gridY: y,
          canSend: this.surveys.canSendSurveyorTo(x, y),
        });
      } else if (eligible) {
        this.pendingSurveyGrid = { x, y };
        this.renderSystem.setSurveyPendingTile({ x, y });
      } else {
        this.clearSurveyPending();
      }

      // Clicked on empty space - deselect
      this.selectedEntity = null;
      this.updateSelectionUI();
    }
  }

  checkDragSelected(x: number, y: number): void {
    // Check if clicking on the selected entity to start dragging
    if (!this.selectedEntity) return;
    if (!isPlayerOwned(this.selectedEntity)) return;

    const pos = this.selectedEntity.getComponent(Position);
    const building = this.selectedEntity.getComponent(Building);

    if (!pos || !building) return;

    // Check if click is within selected building footprint
    const isClickingSelected =
      x >= pos.x && x < pos.x + building.width && y >= pos.y && y < pos.y + building.height;

    if (isClickingSelected) {
      // Start dragging the selected entity
      this.startDraggingEntity();
      this.inputSystem.setMode('select');
      console.log(`Starting drag of entity #${this.selectedEntity.id}`);
    }
  }

  deleteSelectedEntity(): void {
    if (!this.selectedEntity) return;
    if (!isPlayerOwned(this.selectedEntity)) return;
    this.destroyBuildingEntity(this.selectedEntity);
  }

  private originalDragPosition: { x: number; y: number } | null = null;

  startDraggingEntity(): void {
    if (this.selectedEntity) {
      this.isDraggingEntity = true;

      // Store original position for reverting if needed
      const pos = this.selectedEntity.getComponent(Position);
      if (pos) {
        this.originalDragPosition = { x: pos.x, y: pos.y };
      }

      // Release tiles during drag
      const building = this.selectedEntity.getComponent(Building);

      if (pos && building) {
        const entrance = building.getEntranceOffset();

        for (let dy = 0; dy < building.height; dy++) {
          for (let dx = 0; dx < building.width; dx++) {
            const tile = this.tileMap.getTile(pos.x + dx, pos.y + dy);
            if (tile && tile.occupiedBy === this.selectedEntity.id) {
              tile.release();
            }
          }
        }

        // Remove entrance road tile
        if (entrance) {
          const tile = this.tileMap.getTile(pos.x + entrance.dx, pos.y + entrance.dy);
          if (tile) tile.hasRoad = false;
        }
      }
    }
  }

  dragEntityTo(x: number, y: number): void {
    if (this.isDraggingEntity && this.selectedEntity) {
      // Store the drag preview position, but DON'T update the actual entity position yet
      this.dragPreviewPosition = { x, y };
    }
  }

  dropEntity(x: number, y: number): void {
    if (!this.isDraggingEntity || !this.selectedEntity) return;

    const pos = this.selectedEntity.getComponent(Position);
    const building = this.selectedEntity.getComponent(Building);

    if (pos && building) {
      console.log(
        `Attempting to drop building at (${x}, ${y}), original was (${this.originalDragPosition?.x}, ${this.originalDragPosition?.y})`
      );

      // Check if new position is valid (ignore tiles occupied by this entity itself)
      if (
        this.canPreviewPlaceBuilding(
          building.buildingType,
          x,
          y,
          building.width,
          building.height,
          this.selectedEntity.id
        )
      ) {
        // Update the actual position now
        pos.set(x, y);
        this.occupyBuildingTiles(
          this.selectedEntity.id,
          x,
          y,
          building.width,
          building.height,
          building
        );
        if (this.buildingAffectsTerritoryDisk(building.buildingType)) {
          this.markTerritoryDirty();
        }
        console.log(
          `✅ Successfully moved entity from (${this.originalDragPosition?.x}, ${this.originalDragPosition?.y}) to (${x}, ${y})`
        );
      } else {
        console.warn(`❌ Cannot place building at (${x}, ${y}), reverting to original position`);
        // Entity position is still at original, just re-occupy tiles
        if (this.originalDragPosition) {
          this.occupyBuildingTiles(
            this.selectedEntity.id,
            this.originalDragPosition.x,
            this.originalDragPosition.y,
            building.width,
            building.height,
            building
          );
        }
      }
    }

    this.isDraggingEntity = false;
    this.originalDragPosition = null;
    this.dragPreviewPosition = null;
    this.updateBuildingRoadConnections();
  }

  private updateSelectionUI(): void {
    if (this.selectedEntity) {
      const building = this.selectedEntity.getComponent(Building);
      if (building) {
        eventBus.emit('building:selected', { entity: this.selectedEntity });
        return;
      }
      const worker = this.selectedEntity.getComponent(Worker);
      if (worker && this.getRoadSegmentForWorkerId(this.selectedEntity.id)) {
        eventBus.emit('road_worker:selected', {
          entity: this.selectedEntity,
          worker,
          segment: this.getRoadSegmentForWorkerId(this.selectedEntity.id),
          donkeysAtHq: this.donkeysAtHq,
          canReplaceWithDonkey: this.canReplaceRoadWorkerWithDonkey(this.selectedEntity.id),
          canReturnDonkeyToHq: this.canReturnRoadDonkeyToHq(this.selectedEntity.id),
        });
        return;
      }
      eventBus.emit('building:deselected');
    } else {
      eventBus.emit('building:deselected');
      eventBus.emit('road_worker:deselected');
    }
  }

  getSaveData(): object {
    const buildingsToSave = this.entities.filter(e => {
      const building = e.getComponent(Building);
      const worker = e.getComponent(Worker);
      return building && !worker;
    });

    return {
      map: this.tileMap.serialize(),
      buildings: buildingsToSave.map(e => {
        const pos = e.getComponent(Position);
        const building = e.getComponent(Building);
        const production = e.getComponent(Production);
        const storage = e.getComponent(Storage);
        const factionId = getEntityFaction(e);

        const data: any = {
          type: building?.buildingType,
          x: pos?.x,
          y: pos?.y,
          factionId,
        };

        if (building?.state === 'awaiting_materials') {
          data.state = 'awaiting_materials';
          data.buildTimeSec = building.buildTimeSec;
          data.constructionMaterials = building.constructionMaterials;
          data.materialsSent = building.materialsSent;
          data.materialsDelivered = building.materialsDelivered;
          data.builderArrived = building.builderArrived;
        } else if (building?.constructionStartedAt) {
          data.constructionStartedAt = building.constructionStartedAt;
          data.buildTimeSec = building.buildTimeSec;
        }

        if (building?.completedAt) {
          data.completedAt = building.completedAt;
        }

        if (building && !building.hasOperator) {
          data.hasOperator = false;
        }
        if (building?.assignedToolSpecialist) {
          data.assignedToolSpecialist = building.assignedToolSpecialist;
        }

        if (building?.militaryGarrison && building.militaryGarrison.length > 0) {
          data.militaryGarrison = building.militaryGarrison.map(s =>
            s ? { rank: s.rank, workerEntityId: s.workerEntityId } : null
          );
        }
        if (building?.militaryTerritoryEstablished) {
          data.militaryTerritoryEstablished = true;
        }

        if (production) {
          data.production = production.serialize();
        }

        if (storage) {
          data.storage = storage.serialize();
        }

        return data;
      }),
      transportQueue: resourceManager.serialize(),
      transport: transportManager.serialize(),
      roadSegments: roadSegmentManager.serialize(),
      inventory: this.inventory,
      population: this.population,
      productionPriorities: this.productionPriorities,
      buildingPriorities: this.buildingPriorities,
      simulationNowMs: this.simulationNowMs,
      specialistPools: {
        tools: this.toolSpecialistsAtHq,
        military: this.militarySpecialistsAtHq,
        donkeys: this.donkeysAtHq,
      },
      donkeyRoadSegments: roadSegmentManager
        .getSegments()
        .filter(seg => {
          if (seg.assignedWorkerId == null) return false;
          const entity = this.entities.find(e => e.id === seg.assignedWorkerId && e.active);
          return entity?.getComponent(Worker)?.carrierType === 'donkey';
        })
        .map(seg => seg.id),
      camera: this.renderSystem.getCamera(),
      wildlife: this.wildlife.serialize(),
      demolitionSites: this.demolitionSites,
      nextDemolitionSiteId: this.nextDemolitionSiteId,
      pendingWellDemolitions: Array.from(this.pendingWellDemolitions.entries()).map(
        ([entityId, demolishAt]) => ({
          entityId,
          demolishAt,
        })
      ),
      enemyRealms: this.enemyRealms,
      timestamp: Date.now(),
    };
  }

  resetForNewGame(): void {
    this.entities.forEach(e => e.destroy());
    this.entities = [];
    this.systems.forEach(system => system.cleanup());
    resourceManager.reset();
    roadSegmentManager.reset();
    transportManager.reset();

    this.tileMap = new TileMap(1000, 1000);
    this.territory = new TerritoryCoordinator(this.tileMap);
    this.renderSystem.updateTileMap(this.tileMap);

    this.cellSurveyMenuOpen = false;
    this.clearSurveyPending();
    this.selectedEntity = null;
    this.baseCampEntity = null;
    this.isDraggingEntity = false;
    this.dragPreviewPosition = null;
    this.inventory = {};
    this.population = { current: 0, max: 0 };
    this.simulationNowMs = Date.now();
    setSimulationNowMs(this.simulationNowMs);
    this.productionPriorities = this.createDefaultProductionPriorities();
    this.buildingPriorities = this.createDefaultBuildingPriorities();
    this.toolSpecialistsAtHq = {};
    this.militarySpecialistsAtHq = 0;
    this.donkeysAtHq = 1;
    this.workers.resetState();
    this.surveys.reset();
    this.pendingBuildingPickups.clear();
    this.demolitionSites = [];
    this.nextDemolitionSiteId = 1;
    this.enemyRealms = [];
    this.activeEnemyAttacks = [];
    this.nextEnemyAttackId = 1;
    this.nextEnemyPressureCheckAt = 0;
    this.nextEnemyRoadMaintenanceAt = 0;
    this.nextBattleClashAt = 0;
    this.nextForestAmbientAt = 0;
    this.nextHammerSoundAt = 0;
    this.nextWorkerSoundAt.clear();
    this.pendingWellDemolitions.clear();
    this.syncDemolitionSitesToRender();

    this.wildlife.reset();

    this.initializeWorld();
    this.rebuildMinimapFromLoadedMap();
  }

  loadSaveData(saveData: any): boolean {
    try {
      this.simulationNowMs =
        typeof saveData?.simulationNowMs === 'number' && Number.isFinite(saveData.simulationNowMs)
          ? Math.max(0, saveData.simulationNowMs)
          : Date.now();
      setSimulationNowMs(this.simulationNowMs);

      this.tileMap = TileMap.deserialize(saveData.map);
      this.territory = new TerritoryCoordinator(this.tileMap);
      this.renderSystem.updateTileMap(this.tileMap);
      this.rebuildMinimapFromLoadedMap();

      this.entities.forEach(e => e.destroy());
      this.entities = [];
      this.systems.forEach(system => system.cleanup());
      resourceManager.reset();
      roadSegmentManager.reset();

      this.cellSurveyMenuOpen = false;
      this.clearSurveyPending();
      this.selectedEntity = null;
      this.isDraggingEntity = false;
      this.dragPreviewPosition = null;
      this.workers.resetState();
      this.surveys.reset();
      this.pendingBuildingPickups.clear();
      this.toolSpecialistsAtHq = {};
      this.militarySpecialistsAtHq = 0;
      this.donkeysAtHq = 0;
      this.demolitionSites = [];
      this.nextDemolitionSiteId = 1;
      this.enemyRealms = Array.isArray(saveData.enemyRealms) ? saveData.enemyRealms : [];
      this.activeEnemyAttacks = [];
      this.nextEnemyAttackId = 1;
      this.nextEnemyPressureCheckAt = 0;
      this.nextEnemyRoadMaintenanceAt = 0;
      this.nextBattleClashAt = 0;
      this.nextForestAmbientAt = 0;
      this.nextHammerSoundAt = 0;
      this.nextWorkerSoundAt.clear();
      this.pendingWellDemolitions.clear();
      this.syncDemolitionSitesToRender();

      if (saveData.wildlife) {
        this.wildlife.deserialize(saveData.wildlife);
      } else {
        this.wildlife.reset();
        this.wildlife.onLoadedLegacySave();
      }

      if (saveData.population && typeof saveData.population.current === 'number') {
        this.population.current = saveData.population.current;
      } else {
        this.population.current = dataManager.getStartingPopulation();
      }
      this.productionPriorities = this.normalizeProductionPriorities(saveData.productionPriorities);
      this.buildingPriorities = this.normalizeBuildingPriorities(saveData.buildingPriorities);
      if (saveData.specialistPools) {
        const tools = saveData.specialistPools.tools;
        if (tools && typeof tools === 'object') {
          this.toolSpecialistsAtHq = {};
          for (const [tool, n] of Object.entries(tools)) {
            if (typeof n === 'number' && n > 0) {
              this.toolSpecialistsAtHq[tool] = Math.floor(n);
            }
          }
        }
        const military = saveData.specialistPools.military;
        if (typeof military === 'number' && military > 0) {
          this.militarySpecialistsAtHq = Math.floor(military);
        }
        const donkeys = saveData.specialistPools.donkeys;
        if (typeof donkeys === 'number' && donkeys > 0) {
          this.donkeysAtHq = Math.floor(donkeys);
        }
      }
      this.baseCampEntity = null;

      for (const buildingData of saveData.buildings) {
        if (!buildingData.type || buildingData.x === undefined || buildingData.y === undefined)
          continue;

        const entity = createBuilding(buildingData.type, buildingData.x, buildingData.y);
        const savedFaction: FactionId = isEnemyFactionId(buildingData.factionId)
          ? buildingData.factionId
          : PLAYER_FACTION;
        setEntityFaction(entity, savedFaction);

        if (buildingData.type === 'base_camp' && savedFaction === PLAYER_FACTION) {
          this.baseCampEntity = entity;
        }

        const building = entity.getComponent(Building);
        if (building) {
          if (buildingData.state === 'awaiting_materials') {
            building.state = 'awaiting_materials';
            building.buildTimeSec = buildingData.buildTimeSec;
            building.constructionMaterials = buildingData.constructionMaterials || {};
            building.materialsSent = buildingData.materialsSent || {};
            building.materialsDelivered = buildingData.materialsDelivered || {};
            building.builderArrived = buildingData.builderArrived || false;
          } else if (buildingData.constructionStartedAt) {
            building.constructionStartedAt = Math.min(
              buildingData.constructionStartedAt,
              this.simulationNowMs
            );
            building.buildTimeSec = buildingData.buildTimeSec;
            building.state = 'under_construction';
            building.updateConstruction(this.simulationNowMs);
          } else {
            building.state = 'complete';
            building.constructionStartedAt = null;
            building.completedAt = buildingData.completedAt
              ? Math.min(buildingData.completedAt, this.simulationNowMs)
              : this.simulationNowMs;
          }

          if (buildingData.hasOperator === false) {
            building.hasOperator = false;
          }
          if (
            typeof buildingData.assignedToolSpecialist === 'string' &&
            buildingData.assignedToolSpecialist.length > 0
          ) {
            building.assignedToolSpecialist = buildingData.assignedToolSpecialist;
          }

          const capRestore = dataManager.getBuilding(buildingData.type as BuildingType)?.military
            ?.soldierCapacity;
          if (typeof capRestore === 'number' && capRestore > 0) {
            building.initMilitaryGarrison(capRestore);
            building.militaryTerritoryEstablished =
              buildingData.militaryTerritoryEstablished === true;
            if (Array.isArray(buildingData.militaryGarrison) && building.militaryGarrison) {
              for (let i = 0; i < building.militaryGarrison.length; i++) {
                const entry = buildingData.militaryGarrison[i];
                if (
                  !entry ||
                  typeof entry.rank !== 'number' ||
                  typeof entry.workerEntityId !== 'number'
                ) {
                  building.militaryGarrison[i] = null;
                  continue;
                }
                building.militaryGarrison[i] = {
                  rank: Math.min(3, Math.max(1, entry.rank)) as 1 | 2 | 3,
                  workerEntityId: entry.workerEntityId,
                };
                building.militaryTerritoryEstablished = true;
              }
            }
          }

          // Restore production state
          const production = entity.getComponent(Production);
          if (production && buildingData.production) {
            production.deserialize(buildingData.production);
          }

          // Restore storage state
          const storage = entity.getComponent(Storage);
          if (storage && buildingData.storage) {
            storage.deserialize(buildingData.storage);
          } else if (storage && buildingData.type === 'base_camp' && saveData.inventory) {
            // Backwards compatibility: load old inventory into base camp storage
            for (const [resource, amount] of Object.entries(saveData.inventory)) {
              storage.addItem(resource, amount as number);
            }
          }

          this.addEntity(entity);
          this.occupyBuildingTiles(
            entity.id,
            buildingData.x,
            buildingData.y,
            building.width,
            building.height,
            building
          );
          if (building.state === 'complete' && building.buildingType === 'well') {
            this.tryFinalizeWellAquifer(entity);
          }
        }
      }

      for (const ent of this.entities) {
        this.migrateLegacyProductionOutputsFromBuffer(ent);
      }

      this.ensureMilitaryGarrisonWorkersPresent();

      // Restore transport queue
      if (saveData.transportQueue) {
        resourceManager.deserialize(saveData.transportQueue);
      }

      // Restore junction items
      if (saveData.transport) {
        transportManager.deserialize(saveData.transport);
      }

      this.syncInventory();

      // Rebuild road segments and spawn workers
      roadSegmentManager.rebuildRoadTileSet(this.tileMap);
      if (saveData.roadSegments) {
        roadSegmentManager.deserialize(saveData.roadSegments);
        const donkeyRoadSegments = new Set<number>(
          Array.isArray(saveData.donkeyRoadSegments) ? saveData.donkeyRoadSegments : []
        );
        // Re-spawn workers for segments that had them
        for (const seg of roadSegmentManager.getSegments()) {
          if (seg.assignedWorkerId !== null) {
            const rest = roadSegmentManager.getCenterRestPosition(seg);
            const worker = createWorker(rest.x, rest.y);
            if (donkeyRoadSegments.has(seg.id)) {
              const workerComp = worker.getComponent(Worker);
              if (workerComp) {
                workerComp.carrierType = 'donkey';
                workerComp.transportCarryCapacity = 5;
                workerComp.name = 'Donkey';
              }
            }
            this.addEntity(worker);
            seg.assignedWorkerId = worker.id;
            this.workers.restoreRoadSegmentWorker(worker.id);
          }
        }
      } else {
        // Old save without segments — recalculate from roads
        roadSegmentManager.recalculate(this.tileMap);
      }

      this.updateBuildingRoadConnections();
      this.workers.restoreInteriorOperatorsInsideCompletedBuildings();
      this.seedLoadedEnemyDecorations();

      if (this.baseCampEntity) {
        const segments = roadSegmentManager.getSegments();
        transportManager.computeRoutes(segments, this.baseCampEntity.id);
        for (const entity of this.entities) {
          if (!entity.active) continue;
          const production = entity.getComponent(Production);
          const building = entity.getComponent(Building);
          const storage = entity.getComponent(Storage);
          if (!building?.isComplete()) continue;
          const needsRoute =
            (production?.hasInputs() && !!production) ||
            (!!storage && !storage.isProductionStorage && storage.accepts?.includes('gold_coin'));
          if (!needsRoute) continue;
          transportManager.computeRoutesToBuilding(segments, entity.id);
        }
      }

      if (Array.isArray(saveData.demolitionSites)) {
        const now = this.simulationNowMs;
        const maxAge = DEMOLITION_FIRE_DURATION_MS + DEMOLITION_SCORCH_DURATION_MS;
        this.demolitionSites = saveData.demolitionSites
          .filter(
            (site: any) =>
              typeof site?.id === 'number' &&
              typeof site.x === 'number' &&
              typeof site.y === 'number' &&
              typeof site.width === 'number' &&
              typeof site.height === 'number' &&
              typeof site.startedAt === 'number' &&
              Math.max(0, now - site.startedAt) < maxAge
          )
          .map((site: any) => ({
            id: site.id,
            x: site.x,
            y: site.y,
            width: site.width,
            height: site.height,
            startedAt: Math.min(site.startedAt, now),
          }));
        const maxId = this.demolitionSites.reduce((m, site) => Math.max(m, site.id), 0);
        const savedNextId =
          typeof saveData.nextDemolitionSiteId === 'number' ? saveData.nextDemolitionSiteId : 1;
        this.nextDemolitionSiteId = Math.max(savedNextId, maxId + 1);
        this.syncDemolitionSitesToRender();
      }

      if (Array.isArray(saveData.pendingWellDemolitions)) {
        for (const pending of saveData.pendingWellDemolitions) {
          if (
            pending &&
            typeof pending.entityId === 'number' &&
            typeof pending.demolishAt === 'number' &&
            Number.isFinite(pending.demolishAt)
          ) {
            this.pendingWellDemolitions.set(
              pending.entityId,
              Math.max(this.simulationNowMs, pending.demolishAt)
            );
          }
        }
      }

      if (saveData.camera) {
        this.renderSystem.setCamera(saveData.camera);
      } else if (saveData.zoom) {
        this.renderSystem.setZoom(saveData.zoom);
      }

      this.recomputePopulationMaxCapacity();
      this.recheckProductionInputDeliveries(true);

      this.markTerritoryDirty();
      this.refreshTerritoryIfDirty();

      return true;
    } catch (error) {
      console.error('Failed to load game:', error);
      return false;
    }
  }

  /** Recreate hidden military entities for persisted garrison slots after loading saves. */
  private ensureMilitaryGarrisonWorkersPresent(): void {
    for (const ent of this.entities) {
      if (!ent.active) continue;
      const building = ent.getComponent(Building);
      const pos = ent.getComponent(Position);
      if (!building?.militaryGarrison || !pos) continue;
      const factionId = getEntityFaction(ent);

      for (let i = 0; i < building.militaryGarrison.length; i++) {
        const slot = building.militaryGarrison[i];
        if (!slot) continue;
        const existing = this.entities.find(e => e.id === slot.workerEntityId && e.active);
        if (existing) continue;

        const workerEntity = createMilitaryWorker(pos.x + 0.5, pos.y + 0.5, slot.rank);
        setEntityFaction(workerEntity, factionId);
        const worker = workerEntity.getComponent(Worker);
        if (worker) {
          worker.concealedInBuildingId = ent.id;
          worker.setState('idle');
          worker.dropResource();
        }
        this.addEntity(workerEntity);
        slot.workerEntityId = workerEntity.id;
      }
    }
  }

  private rebuildMinimapFromLoadedMap(): void {
    // Rebuild the minimap by updating all explored tiles
    const exploreTiles: { x: number; y: number }[] = [];

    for (let y = 0; y < this.tileMap.height; y++) {
      for (let x = 0; x < this.tileMap.width; x++) {
        const tile = this.tileMap.getTile(x, y);
        if (tile && tile.isExplored()) {
          exploreTiles.push({ x, y });
        }
      }
    }

    // Update minimap with all explored tiles
    if (exploreTiles.length > 0) {
      this.renderSystem.updateMinimapTiles(exploreTiles);
    }
  }
}
