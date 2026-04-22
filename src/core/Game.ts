/**
 * Main Game class - orchestrates all systems and manages game state
 */

import { Entity } from './Entity';
import { System } from './System';
import { eventBus } from './EventBus';
import { TileMap } from '@/map/TileMap';
import { RenderSystem } from '@/systems/RenderSystem';
import { MovementSystem } from '@/systems/MovementSystem';
import { ProductionSystem } from '@/systems/ProductionSystem';
import { InputSystem } from '@/systems/InputSystem';
import { PathFinder } from '@/pathfinding/AStar';
import { audioManager } from '@/audio/AudioManager';
import { Position } from '@/components/Position';
import { Movable } from '@/components/Movable';
import { Worker } from '@/components/Worker';
import { Building } from '@/components/Building';
import { Production } from '@/components/Production';
import { Storage } from '@/components/Storage';
import { dataManager } from '@/data/DataManager';
import { resourceManager } from '@/economics/ResourceManager';
import { roadSegmentManager, RoadSegment } from '@/economics/RoadSegmentManager';
import { transportManager } from '@/economics/TransportManager';
import { Inventory, BuildingType } from '@/types/GameData';

// Entity factories
import { createWorker, createBuilding, createBaseCamp } from '@/entities/EntityFactory';
import { GameWorkerRegistry } from '@/workers';
import { isInsightAltHeld } from '@/input/InsightAltKey';
import { isInsightRockTile } from '@/ui/hoverInsight/buildHoverLines';
import { axisAlignedGridLine } from '@/utils/gridLine';

export class Game {
  private entities: Entity[] = [];
  private systems: System[] = [];
  private running = false;
  private lastTime = 0;
  private fps = 0;
  private frameCount = 0;
  private fpsTime = 0;

  private canvas: HTMLCanvasElement;
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

  // Exploration optimization
  private lastExplorationPos: { x: number; y: number } | null = null;
  private explorationThreshold = 10; // Only explore when camera moves this many tiles

  // Game economy
  public inventory: Inventory = {};
  public baseCampEntity: Entity | null = null;
  public population = {
    current: 0,
    max: 0
  };

  private workers!: GameWorkerRegistry;
  private pendingBuildingPickups = new Set<number>(); // building entity IDs with workers en route
  private roadDragMode: 'create' | 'delete' | null = null;
  private lastMaterialCheckTime = 0;
  private lastProductionInputCheckTime = 0;
  /** Full transport heal (segment graph + route maps + junction rescue); mirrors road `scheduleSegmentRecalc`. */
  private lastPeriodicTransportHealTime = 0;
  private lastOutputTransportKickTime = 0;

  private readonly frameHooks: Array<() => void> = [];

  constructor(canvas: HTMLCanvasElement, skipInit = false) {
    this.canvas = canvas;

    // Initialize large map (20x bigger: 1000x1000)
    this.tileMap = new TileMap(1000, 1000);

    // Initialize systems
    this.renderSystem = new RenderSystem(canvas, this.tileMap);
    this.movementSystem = new MovementSystem();
    this.productionSystem = new ProductionSystem();
    this.inputSystem = new InputSystem(canvas, this.renderSystem);
    this.pathFinder = new PathFinder();

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
      getAvailablePeasantSlotCount: () =>
        this.population.current - roadSegmentManager.getWorkerCount() - this.workers.getReservedPopulationCount(),
    });

    // Setup road segment callbacks
    roadSegmentManager.setCallbacks(this.workers.getRoadSegmentCallbacks());

    // Load sound effects
    audioManager.loadSound('road_build', '/audio/road_build.mp3');
    audioManager.loadSound('build_placed', '/audio/build_placed.mp3');
    audioManager.loadSound('demolish', '/audio/demolish.mp3');
    audioManager.loadSound('erase_demolition', '/audio/erase_demolition.mp3');
    audioManager.loadSound('building_complete', '/audio/building_complete.mp3');

    // Setup event listeners
    this.setupEventListeners();
    eventBus.on('production:complete', (payload: { entityId: number; outputs: Record<string, number> }) =>
      this.onProductionComplete(payload)
    );

    // Initialize game world
    if (!skipInit) {
      this.initializeWorld();
    }
  }

  private setupEventListeners(): void {
    // Building events
    eventBus.on('build:road', (data) => this.buildRoad(data.x, data.y));
    eventBus.on('road:drag_end', () => { this.roadDragMode = null; });
    eventBus.on('erase:tile', (data: { x: number; y: number }) => this.eraseAt(data.x, data.y));

    // Generic building handler for all building types (derived from data)
    for (const building of dataManager.getAllBuildings()) {
      const type = building.id;
      eventBus.on(`build:${type}`, (data: { x: number; y: number }) => this.buildGeneric(type, data.x, data.y));
    }

    // Selection events
    eventBus.on('select:entity', (data) => this.selectEntityAt(data.x, data.y));
    eventBus.on('delete:selected', () => this.deleteSelectedEntity());
    eventBus.on('check:drag_selected', (data) => this.checkDragSelected(data.x, data.y));
    eventBus.on('drag:move', (data) => this.dragEntityTo(data.x, data.y));
    eventBus.on('drag:end', (data) => this.dropEntity(data.x, data.y));

    // Build failure toast
    eventBus.on('build:failed', (data) => {
      if (this.inputSystem.hoverGridPos) {
        const screenPos = this.renderSystem.gridToScreen(
          this.inputSystem.hoverGridPos.x,
          this.inputSystem.hoverGridPos.y
        );
        this.renderSystem.showToast(data.reason, screenPos.x, screenPos.y);
      }
    });

    // Input mode changes
    eventBus.on('input:mode_changed', (mode) => {
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

    // Explore initial area around spawn
    this.exploreArea(centerX, centerY, 25);

    // Build base camp — no roads, no workers. Roads are built by the player.
    this.buildBaseCamp(centerX, centerY);

    console.log(`World initialized at (${centerX}, ${centerY}) - Map size: ${this.tileMap.width}x${this.tileMap.height}`);
  }

  exploreArea(centerX: number, centerY: number, radius: number): { x: number; y: number }[] {
    const newlyExplored: { x: number; y: number }[] = [];

    for (let y = centerY - radius; y <= centerY + radius; y++) {
      for (let x = centerX - radius; x <= centerX + radius; x++) {
        const tile = this.tileMap.getTile(x, y);
        if (tile && !tile.isExplored()) {
          tile.explore();
          newlyExplored.push({ x, y });
        }
      }
    }

    // Update minimap with newly explored tiles
    if (newlyExplored.length > 0) {
      this.renderSystem.updateMinimapTiles(newlyExplored);
    }

    return newlyExplored;
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

  private segmentRecalcTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleSegmentRecalc(): void {
    if (this.segmentRecalcTimer) return;
    this.segmentRecalcTimer = setTimeout(() => {
      this.segmentRecalcTimer = null;
      roadSegmentManager.recalculate(this.tileMap);
      this.recomputeTransportRoutes();
    }, 200);
  }

  /**
   * Refreshes direction maps when new goods appear in building buffers so segment workers
   * can resolve toward-base / toward-consumer indices (cheap vs full segment recalc).
   */
  private kickTransportRoutesForNewOutput(): void {
    if (!this.baseCampEntity) return;
    this.recomputeTransportRoutes();
  }

  private onProductionComplete(_payload: { entityId: number; outputs: Record<string, number> }): void {
    this.kickTransportRoutesForNewOutput();
  }

  private hasAnyUnroutedProductionOutput(): boolean {
    for (const entity of this.entities) {
      if (!entity.active) continue;
      const production = entity.getComponent(Production);
      const building = entity.getComponent(Building);
      const storage = entity.getComponent(Storage);
      if (!production || !building?.isComplete() || !building.isActive) continue;
      if (storage?.isProductionStorage) {
        for (const res of Object.keys(production.outputs)) {
          if (storage.getAmount(res) > 0) return true;
        }
      } else if (production.getTotalBuffered() > 0) {
        return true;
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
    for (const entity of this.entities) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (!building) continue;

      // Routes for production buildings with inputs
      const production = entity.getComponent(Production);
      if (production && production.hasInputs() && building.isComplete()) {
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
    const collected: { x: number; y: number; resourceType: string; destinationEntityId: number | null }[] = [];
    for (const [key, items] of [...transportManager.getJunctionItemsMap().entries()]) {
      const [x, y] = key.split(',').map(Number);
      for (const item of items) {
        collected.push({ x, y, resourceType: item.resourceType, destinationEntityId: item.destinationEntityId });
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
      const pickupMatch = (task.pickupPos.x === ep0.x && task.pickupPos.y === ep0.y) ||
                          (task.pickupPos.x === ep1.x && task.pickupPos.y === ep1.y);
      const dropoffMatch = (task.dropoffPos.x === ep0.x && task.dropoffPos.y === ep0.y) ||
                           (task.dropoffPos.x === ep1.x && task.dropoffPos.y === ep1.y);

      if (pickupMatch && dropoffMatch) continue;

      // Task is invalid — cancel it
      if (worker.carryingResource) {
        const p = entity.getComponent(Position);
        if (p) {
          transportManager.addJunctionItem(Math.floor(p.x), Math.floor(p.y), worker.carryingResource, task.destEntityId);
        }
        worker.carryingResource = undefined;
      } else if (task.phase === 'to_pickup' && task.sourceEntityId === null) {
        transportManager.removePendingPickupVisual(task.pickupPos.x, task.pickupPos.y, task.resourceType);
        transportManager.addJunctionItem(task.pickupPos.x, task.pickupPos.y, task.resourceType, task.destEntityId);
      }
      worker.transportTask = null;
      worker.setState('idle');
    }
  }

  private buildRoad(x: number, y: number): void {
    if (!this.isAreaExplored(x, y)) {
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

  private findBuildingEntityAt(x: number, y: number): Entity | null {
    const found = this.entities.find(entity => {
      const pos = entity.getComponent(Position);
      const building = entity.getComponent(Building);
      if (!pos || !building) return false;
      return x >= pos.x && x < pos.x + building.width &&
             y >= pos.y && y < pos.y + building.height;
    });
    return found ?? null;
  }

  private eraseAt(x: number, y: number): void {
    if (!this.isAreaExplored(x, y, 1, 1)) return;

    const buildingEntity = this.findBuildingEntityAt(x, y);
    if (buildingEntity) {
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
  private destroyBuildingEntity(entity: Entity, demolishSound: 'demolish' | 'erase_demolition' = 'demolish'): void {
    const pos = entity.getComponent(Position);
    const building = entity.getComponent(Building);

    if (!pos || !building) return;

    if (building.state === 'awaiting_materials' && building.constructionMaterials) {
      const baseCampStorage = this.baseCampEntity?.getComponent(Storage);
      if (baseCampStorage) {
        for (const [res, required] of Object.entries(building.constructionMaterials)) {
          const sent = building.materialsSent[res] || 0;
          const undispatched = required - sent;
          if (undispatched > 0) baseCampStorage.addItem(res, undispatched);
          const delivered = building.materialsDelivered[res] || 0;
          if (delivered > 0) baseCampStorage.addItem(res, delivered);
        }
      }
    }

    this.workers.detachWorkersForDestroyedBuilding(entity);

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

    const cardinalDirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    while (queue.length > 0) {
      const { x, y } = queue.shift()!;
      for (const [dx, dy] of cardinalDirs) {
        const nx = x + dx;
        const ny = y + dy;
        const key = `${nx},${ny}`;
        if (connected.has(key)) continue;
        const neighbor = this.tileMap.getTile(nx, ny);
        if (neighbor && neighbor.hasRoad && (!neighbor.isOccupied() || neighbor.occupiedBy === hqId)) {
          connected.add(key);
          queue.push({ x: nx, y: ny });
        }
      }
    }

    return connected;
  }

  private hasBuildingConnectedRoad(pos: Position, building: Building, connectedRoads: Set<string>): boolean {
    const entrance = building.getEntranceOffset();
    if (entrance) {
      const ex = pos.x + entrance.dx;
      const ey = pos.y + entrance.dy;
      const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (const [dx, dy] of dirs) {
        const key = `${ex + dx},${ey + dy}`;
        if (connectedRoads.has(key)) return true;
      }
      return false;
    }

    // Fallback for 1x1 buildings: any cardinal adjacent connected road
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dx, dy] of dirs) {
      const key = `${pos.x + dx},${pos.y + dy}`;
      if (connectedRoads.has(key)) return true;
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

      building.isActive = this.hasBuildingConnectedRoad(pos, building, connectedRoads);
    }

    this.recheckProductionInputDeliveries(true);
  }

  private canPlaceBuilding(x: number, y: number, width: number, height: number, ignoreEntityId?: number): boolean {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const tile = this.tileMap.getTile(x + dx, y + dy);
        if (!tile) return false;

        if (!tile.walkable) return false;

        if (tile.isOccupied() && tile.occupiedBy !== ignoreEntityId) return false;
      }
    }
    return true;
  }

  private occupyBuildingTiles(entityId: number, x: number, y: number, width: number, height: number, building?: Building): void {
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
    console.log(`Population: ${this.population.current}/${this.population.max} (peasants / housing cap)`);
  }

  /** Housing cap = starting population baseline + completed residential `provides` (hut, house, …). */
  private recomputePopulationMaxCapacity(): void {
    const baseline = dataManager.getStartingPopulation();
    let extra = 0;
    for (const entity of this.entities) {
      if (!entity.active) continue;
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

    // Check affordability
    if (!resourceManager.canAfford(buildingDef.buildCost)) {
      console.warn(`Cannot afford ${buildingDef.name}`);
      eventBus.emit('build:failed', { reason: `Cannot afford ${buildingDef.name}` });
      return;
    }

    // Check if area is explored
    if (!this.isAreaExplored(x, y, buildingDef.size.width, buildingDef.size.height)) {
      eventBus.emit('build:failed', { reason: 'Cannot build in unexplored area' });
      return;
    }

    // Check if space is available
    if (!this.canPlaceBuilding(x, y, buildingDef.size.width, buildingDef.size.height, undefined)) {
      eventBus.emit('build:failed', { reason: 'Cannot build here' });
      return;
    }

    // Deduct resources from storage buildings
    resourceManager.deductResources(buildingDef.buildCost);
    this.syncInventory();

    // Create building entity
    const entity = createBuilding(buildingType, x, y);
    const building = entity.getComponent(Building);

    if (!building) return;

    // Set construction state based on whether building has costs
    const hasCosts = Object.values(buildingDef.buildCost).some(v => v > 0);
    if (building.buildTimeSec > 0) {
      if (hasCosts) {
        building.startAwaitingMaterials(building.buildTimeSec, buildingDef.buildCost);
      } else {
        building.startConstruction(building.buildTimeSec);
      }
    }

    this.addEntity(entity);
    this.occupyBuildingTiles(entity.id, x, y, building.width, building.height, building);

    // Dispatch construction materials as junction items at base camp entrance
    if (building.state === 'awaiting_materials' && building.constructionMaterials) {
      const spawnTile = this.workers.getBaseCampSpawnTile();
      if (spawnTile) {
        for (const [res, amount] of Object.entries(building.constructionMaterials)) {
          for (let i = 0; i < amount; i++) {
            transportManager.addJunctionItem(spawnTile.x, spawnTile.y, res, entity.id);
          }
          building.materialsSent[res] = amount;
        }
      }

      // Spawn builder worker
      this.workers.spawnBuilderForPlacedBuilding(entity);
    }

    if (building.isComplete()) {
      this.recomputePopulationMaxCapacity();
    }

    audioManager.playSound('build_placed');
    this.updateBuildingRoadConnections();
    this.recheckConstructionMaterials(true);
    this.recheckProductionInputDeliveries(true);
    eventBus.emit('build:success');
    console.log(`${buildingDef.name} (${building.width}x${building.height}) placed at (${x}, ${y}) — ${building.state}`);
  }

  public getAvailablePopulation(): number {
    return this.population.current - roadSegmentManager.getWorkerCount() - this.workers.getReservedPopulationCount();
  }

  /**
   * Replenishes lost junction items and fills gaps when HQ inventory cannot pay again.
   * Build cost is deducted once at place time; `materialsSent` is how many were queued for physical
   * delivery. If items disappear from the spawn tile / route, `storage` may be empty — we must still
   * spawn junction entries without a second deduction (same goods already paid for).
   */
  private recheckConstructionMaterials(force = false): void {
    if (!this.baseCampEntity) return;
    const now = Date.now();
    if (!force && now - this.lastMaterialCheckTime < 2000) return;
    this.lastMaterialCheckTime = now;

    const storage = this.baseCampEntity.getComponent(Storage);
    if (!storage) return;
    const spawnTile = this.workers.getBaseCampSpawnTile();
    if (!spawnTile) return;

    for (const entity of this.entities) {
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
          if (worker.transportTask.destEntityId === entity.id && worker.transportTask.resourceType === res) {
            inTransit++;
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
        inTransit++;
      } else if (task.phase === 'to_pickup' && task.sourceEntityId != null) {
        inTransit++;
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
      if (
        task &&
        task.destEntityId === destEntityId &&
        task.resourceType === resourceType
      ) {
        if (task.phase === 'to_dropoff') {
          n++;
        } else if (task.phase === 'to_pickup' && task.sourceEntityId != null) {
          n++;
        }
      }
    }

    return n;
  }

  /**
   * For multi-input recipes, do not pull `res` from HQ unless every other input type either already
   * satisfies its per-cycle amount in the building (plus in-flight to it) or HQ still holds enough
   * of that type to cover the remainder. Prevents filling local storage with only grain when water
   * is missing.
   */
  private canDispatchHqProductionInputForMultiRecipe(
    entityId: number,
    storage: Storage,
    hqStorage: Storage,
    inputs: Record<string, number>,
    res: string
  ): boolean {
    const types = Object.keys(inputs).filter(k => (inputs[k] ?? 0) > 0);
    if (types.length <= 1) return true;

    const pipeline = (t: string) =>
      storage.getAmount(t) + this.countInTransitToBuildingForResource(entityId, t);

    for (const other of types) {
      if (other === res) continue;
      const need = inputs[other] ?? 0;
      if (need <= 0) continue;
      const shortfall = Math.max(0, need - pipeline(other));
      if (shortfall <= 0) continue;
      if (hqStorage.getAmount(other) < shortfall) {
        return false;
      }
    }
    return true;
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
      maxOtherShortfall = Math.max(
        maxOtherShortfall,
        Math.max(0, (inputs[o] ?? 0) - pipeline(o))
      );
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
    if (!storage?.isProductionStorage || !production?.hasInputs() || !building?.isComplete() || !building.isActive) {
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
    if (!building?.isComplete() || !building.isActive || !production?.hasInputs() || !storage?.isProductionStorage || !hqStorage) {
      return;
    }

    const spawnTile = this.workers.getBaseCampSpawnTile();
    if (!spawnTile) return;

    const inputTypes = Object.entries(production.inputs)
      .filter(([, need]) => need > 0)
      .map(([res]) => res);
    if (inputTypes.length === 0) return;

    let dispatchSlots = Math.max(
      0,
      storage.capacity - storage.getTotalStored() - this.countInTransitToBuilding(entity.id)
    );

    while (dispatchSlots > 0) {
      let sent = false;
      for (const res of inputTypes) {
        if (dispatchSlots <= 0) break;
        if (hqStorage.getAmount(res) <= 0) continue;
        if (!storage.canAccept(res)) continue;
        if (
          !this.canDispatchHqProductionInputForMultiRecipe(
            entity.id,
            storage,
            hqStorage,
            production.inputs,
            res
          )
        ) {
          continue;
        }
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
    const now = Date.now();
    if (!force && now - this.lastProductionInputCheckTime < 2000) return;
    this.lastProductionInputCheckTime = now;

    for (const entity of this.entities) {
      if (!entity.active) continue;
      this.rescueStuckMultiInputProductionStorage(entity);
      this.tryDispatchHqProductionInputsForBuilding(entity);
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
      if (!production.inputs[resourceType]) continue;
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

  private tryStartTransport(segment: RoadSegment, worker: Worker, movable: Movable, pos: Position): void {
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
      const junctionItem = transportManager.takeJunctionItemForDirection(ep.x, ep.y, segment.id, pickupIdx);
      if (junctionItem) {
        transportManager.addPendingPickupVisual(ep.x, ep.y, junctionItem.resourceType, junctionItem.destinationEntityId);
        worker.transportTask = {
          phase: 'to_pickup',
          pickupPos: { x: ep.x, y: ep.y },
          dropoffPos: { x: dropoffEp.x, y: dropoffEp.y },
          resourceType: junctionItem.resourceType,
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
        transportManager.addJunctionItem(tile.x, tile.y, item.resourceType, item.destinationEntityId);
        continue;
      }
      transportManager.addPendingPickupVisual(tile.x, tile.y, item.resourceType, destEntityId);
      const dropoffEp = segment.endpoints[dirIdx];
      worker.transportTask = {
        phase: 'to_pickup',
        pickupPos: { x: tile.x, y: tile.y },
        dropoffPos: { x: dropoffEp.x, y: dropoffEp.y },
        resourceType: item.resourceType,
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
    const junctionItem = transportManager.takeJunctionItemForDirection(tileX, tileY, segment.id, epIdx);
    if (!junctionItem) return false;
    transportManager.addPendingPickupVisual(
      tileX,
      tileY,
      junctionItem.resourceType,
      junctionItem.destinationEntityId
    );
    const otherEp = segment.endpoints[1 - epIdx]!;
    worker.transportTask = {
      phase: 'to_pickup',
      pickupPos: { x: tileX, y: tileY },
      dropoffPos: { x: otherEp.x, y: otherEp.y },
      resourceType: junctionItem.resourceType,
      sourceEntityId: null,
      destEntityId: junctionItem.destinationEntityId,
    };
    this.advanceTransport(segment, worker, movable, pos);
    return true;
  }

  private advanceTransport(segment: RoadSegment, worker: Worker, movable: Movable, pos: Position): void {
    const task = worker.transportTask!;
    switch (task.phase) {
      case 'to_pickup': {
        let taken = false;
        if (task.sourceEntityId != null) {
          const bldgEntity = this.entities.find(e => e.id === task.sourceEntityId && e.active);
          if (bldgEntity) {
            const production = bldgEntity.getComponent(Production);
            const bldgStorage = bldgEntity.getComponent(Storage);
            if (bldgStorage && bldgStorage.isProductionStorage && production) {
              if (bldgStorage.removeItem(task.resourceType, 1) > 0) {
                worker.pickUpResource(task.resourceType);
                taken = true;
              }
            } else if (production && production.removeFromBuffer(task.resourceType, 1) > 0) {
              worker.pickUpResource(task.resourceType);
              taken = true;
            }
          }
        } else {
          transportManager.removePendingPickupVisual(task.pickupPos.x, task.pickupPos.y, task.resourceType);
          worker.pickUpResource(task.resourceType);
          taken = true;
        }
        if (!taken) {
          worker.transportTask = null;
          worker.setState('idle');
          this.walkWorkerToCenter(segment, movable, pos, worker);
          return;
        }
        task.phase = 'to_dropoff';
        const path = this.getSegmentPathToTile(segment, pos, task.dropoffPos.x, task.dropoffPos.y);
        if (path.length > 0) {
          movable.setPath(path);
          worker.setState('carrying');
        }
        break;
      }
      case 'to_dropoff': {
        const res = worker.carryingResource;
        if (!res) {
          worker.transportTask = null;
          worker.setState('idle');
          this.walkWorkerToCenter(segment, movable, pos, worker);
          return;
        }

        const dropoffEpIdx = segment.endpoints.findIndex(
          ep => ep.x === task.dropoffPos.x && ep.y === task.dropoffPos.y
        );
        const dropoffEp = segment.endpoints[dropoffEpIdx];

        if (dropoffEp?.entityId === task.destEntityId && task.destEntityId != null) {
          if (task.destEntityId === this.baseCampEntity?.id) {
            const storage = this.baseCampEntity!.getComponent(Storage);
            if (storage) storage.addItem(res, 1);
          } else {
            const destEntity = this.entities.find(e => e.id === task.destEntityId && e.active);
            if (destEntity) {
              // Check if this is a construction site delivery
              const destBuilding = destEntity.getComponent(Building);
              if (destBuilding && destBuilding.state === 'awaiting_materials') {
                if (!destBuilding.deliverMaterial(res)) {
                  transportManager.addJunctionItem(task.dropoffPos.x, task.dropoffPos.y, res, this.baseCampEntity?.id ?? null);
                }
              } else {
                const destStorage = destEntity.getComponent(Storage);
                const destProduction = destEntity.getComponent(Production);
                if (
                  destStorage &&
                  destStorage.canAccept(res) &&
                  this.canAddProductionInputToLocalStorage(
                    destEntity,
                    destStorage,
                    destProduction ?? null,
                    res,
                    1,
                    true
                  )
                ) {
                  destStorage.addItem(res, 1);
                } else {
                  transportManager.addJunctionItem(task.dropoffPos.x, task.dropoffPos.y, res, this.baseCampEntity?.id ?? null);
                }
              }
            } else {
              transportManager.addJunctionItem(task.dropoffPos.x, task.dropoffPos.y, res, this.baseCampEntity?.id ?? null);
            }
          }
        } else {
          transportManager.addJunctionItem(task.dropoffPos.x, task.dropoffPos.y, res, task.destEntityId);
        }

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

  private walkWorkerToCenter(segment: RoadSegment, movable: Movable, pos: Position, worker: Worker): void {
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

  private gameLoop = (currentTime: number): void => {
    if (!this.running) return;

    const deltaTime = Math.min((currentTime - this.lastTime) / 1000, 0.1);
    this.lastTime = currentTime;

    // Update FPS
    this.frameCount++;
    this.fpsTime += deltaTime;
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
        if (
          this.inputSystem.isPointerDragging() &&
          this.inputSystem.getShiftKeyHeld()
        ) {
          const anchor = this.inputSystem.getRoadDragAnchorGrid();
          if (anchor && (anchor.x !== gx || anchor.y !== gy)) {
            roadLineTiles = axisAlignedGridLine(anchor.x, anchor.y, gx, gy);
          }
        }
      }
      this.renderSystem.buildPreview = {
        mode,
        gridX: gx,
        gridY: gy,
        roadLineTiles,
        roadDragIntent
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
      const hoveredEntity = this.entities.find(entity => {
        const pos = entity.getComponent(Position);
        const building = entity.getComponent(Building);
        if (!pos || !building) return false;
        return hx >= pos.x && hx < pos.x + building.width &&
               hy >= pos.y && hy < pos.y + building.height;
      });
      this.renderSystem.hoveredEntityId = hoveredEntity?.id ?? null;
    } else {
      this.renderSystem.hoveredEntityId = null;
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

    this.workers.tickReturnLegs();

    // Update construction delivery (builder arrivals, material checks)
    this.workers.updateConstructionDelivery();

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

    // Explore area around visible viewport
    this.exploreVisibleArea();

    // Update all systems
    this.systems.forEach(system => system.update(deltaTime));

    // Update transport relay chain
    this.updateTransport();

    // Periodic transport heal: `rescueStrandedItems` alone does not refresh direction maps, so goods
    // can sit on roads until the next road edit triggers `recalculate` + `recomputeTransportRoutes`.
    const now = Date.now();
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
        building.updateConstruction();
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

          this.recheckProductionInputDeliveries(true);
          this.recomputePopulationMaxCapacity();
        }
      }
    }
  }

  private syncInventory(): void {
    this.inventory = resourceManager.getGlobalInventory();
  }

  private exploreVisibleArea(): void {
    // Get viewport bounds in grid coordinates
    const viewportCenterWorld = this.renderSystem.screenToWorld(
      this.canvas.width / 2,
      this.canvas.height / 2
    );

    const centerX = Math.floor(viewportCenterWorld.x);
    const centerY = Math.floor(viewportCenterWorld.y);

    // Only explore if camera has moved significantly (optimization)
    if (this.lastExplorationPos) {
      const dx = Math.abs(centerX - this.lastExplorationPos.x);
      const dy = Math.abs(centerY - this.lastExplorationPos.y);
      if (dx < this.explorationThreshold && dy < this.explorationThreshold) {
        return; // Camera hasn't moved enough
      }
    }

    this.lastExplorationPos = { x: centerX, y: centerY };

    const viewportRadius = 30; // Explore 30 tiles around viewport center

    this.exploreArea(centerX, centerY, viewportRadius);
  }

  private updateDebugInfo(): void {
    const fpsElement = document.getElementById('fps');
    const entityCountElement = document.getElementById('entity-count');

    if (fpsElement) fpsElement.textContent = this.fps.toString();
    if (entityCountElement) entityCountElement.textContent = this.entities.length.toString();
  }

  public getViewportBounds() {
    return this.renderSystem['getViewportBounds']();
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

  // Selection and editing functionality
  selectEntityAt(x: number, y: number): void {
    // Find entity at this position (buildings and roads only, not workers)
    const foundEntity = this.entities.find(entity => {
      const pos = entity.getComponent(Position);
      const building = entity.getComponent(Building);

      if (!pos || !building) return false;

      // Check if click is within building footprint
      return x >= pos.x && x < pos.x + building.width &&
             y >= pos.y && y < pos.y + building.height;
    });

    if (foundEntity) {
      // Check if it's the base camp
      if (foundEntity === this.baseCampEntity) {
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
      // Clicked on empty space - deselect
      this.selectedEntity = null;
      this.updateSelectionUI();
    }
  }

  checkDragSelected(x: number, y: number): void {
    // Check if clicking on the selected entity to start dragging
    if (!this.selectedEntity) return;

    const pos = this.selectedEntity.getComponent(Position);
    const building = this.selectedEntity.getComponent(Building);

    if (!pos || !building) return;

    // Check if click is within selected building footprint
    const isClickingSelected = x >= pos.x && x < pos.x + building.width &&
                               y >= pos.y && y < pos.y + building.height;

    if (isClickingSelected) {
      // Start dragging the selected entity
      this.startDraggingEntity();
      this.inputSystem.setMode('select');
      console.log(`Starting drag of entity #${this.selectedEntity.id}`);
    }
  }

  deleteSelectedEntity(): void {
    if (!this.selectedEntity) return;
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
      console.log(`Attempting to drop building at (${x}, ${y}), original was (${this.originalDragPosition?.x}, ${this.originalDragPosition?.y})`);

      // Check if new position is valid (ignore tiles occupied by this entity itself)
      if (this.canPlaceBuilding(x, y, building.width, building.height, this.selectedEntity.id)) {
        // Update the actual position now
        pos.set(x, y);
        this.occupyBuildingTiles(this.selectedEntity.id, x, y, building.width, building.height, building);
        console.log(`✅ Successfully moved entity from (${this.originalDragPosition?.x}, ${this.originalDragPosition?.y}) to (${x}, ${y})`);
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
      }
    } else {
      eventBus.emit('building:deselected');
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

        const data: any = {
          type: building?.buildingType,
          x: pos?.x,
          y: pos?.y
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
      camera: this.renderSystem.getCamera(),
      timestamp: Date.now()
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
    this.renderSystem.updateTileMap(this.tileMap);

    this.selectedEntity = null;
    this.baseCampEntity = null;
    this.isDraggingEntity = false;
    this.dragPreviewPosition = null;
    this.lastExplorationPos = null;
    this.inventory = {};
    this.population = { current: 0, max: 0 };
    this.workers.resetState();
    this.pendingBuildingPickups.clear();

    this.initializeWorld();
    this.rebuildMinimapFromLoadedMap();
  }

  loadSaveData(saveData: any): boolean {
    try {
      this.tileMap = TileMap.deserialize(saveData.map);
      this.renderSystem.updateTileMap(this.tileMap);
      this.rebuildMinimapFromLoadedMap();

      this.entities.forEach(e => e.destroy());
      this.entities = [];
      this.systems.forEach(system => system.cleanup());
      resourceManager.reset();
      roadSegmentManager.reset();

      this.selectedEntity = null;
      this.isDraggingEntity = false;
      this.dragPreviewPosition = null;
      this.lastExplorationPos = null;
      this.workers.resetState();
      this.pendingBuildingPickups.clear();

      if (saveData.population && typeof saveData.population.current === 'number') {
        this.population.current = saveData.population.current;
      } else {
        this.population.current = dataManager.getStartingPopulation();
      }
      this.baseCampEntity = null;

      for (const buildingData of saveData.buildings) {
        if (!buildingData.type || buildingData.x === undefined || buildingData.y === undefined) continue;

        const entity = createBuilding(buildingData.type, buildingData.x, buildingData.y);

        if (buildingData.type === 'base_camp') {
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
            building.constructionStartedAt = buildingData.constructionStartedAt;
            building.buildTimeSec = buildingData.buildTimeSec;
            building.state = 'under_construction';
            building.updateConstruction();
          } else {
            building.state = 'complete';
            building.constructionStartedAt = null;
            building.completedAt = buildingData.completedAt || Date.now();
          }

          if (buildingData.hasOperator === false) {
            building.hasOperator = false;
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
          this.occupyBuildingTiles(entity.id, buildingData.x, buildingData.y, building.width, building.height, building);
        }
      }

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
        // Re-spawn workers for segments that had them
        for (const seg of roadSegmentManager.getSegments()) {
          if (seg.assignedWorkerId !== null) {
            const rest = roadSegmentManager.getCenterRestPosition(seg);
            const worker = createWorker(rest.x, rest.y);
            this.addEntity(worker);
            seg.assignedWorkerId = worker.id;
          }
        }
      } else {
        // Old save without segments — recalculate from roads
        roadSegmentManager.recalculate(this.tileMap);
      }

      this.updateBuildingRoadConnections();

      if (this.baseCampEntity) {
        const segments = roadSegmentManager.getSegments();
        transportManager.computeRoutes(segments, this.baseCampEntity.id);
        for (const entity of this.entities) {
          if (!entity.active) continue;
          const production = entity.getComponent(Production);
          const building = entity.getComponent(Building);
          if (!production || !building || !production.hasInputs()) continue;
          if (!building.isComplete()) continue;
          transportManager.computeRoutesToBuilding(segments, entity.id);
        }
      }

      if (saveData.camera) {
        this.renderSystem.setCamera(saveData.camera);
      } else if (saveData.zoom) {
        this.renderSystem.setZoom(saveData.zoom);
      }

      this.recomputePopulationMaxCapacity();
      this.recheckProductionInputDeliveries(true);

      return true;
    } catch (error) {
      console.error('Failed to load game:', error);
      return false;
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

