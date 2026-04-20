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

  private returningWorkers = new Set<number>();
  private builderWorkers = new Map<number, number>(); // builderEntityId → buildingEntityId
  private returningBuilders = new Set<number>();
  private toolWorkers = new Map<number, number>(); // toolWorkerEntityId → buildingEntityId
  private animationWorkers = new Map<number, { buildingEntityId: number; phase: 'to_target' | 'chopping' | 'returning'; targetTile: { x: number; y: number }; terrainModified: boolean; entranceTile: { x: number; y: number } }>();
  private reservedTreeTiles = new Set<string>();
  private pendingBuildingPickups = new Set<number>(); // building entity IDs with workers en route
  private roadDragMode: 'create' | 'delete' | null = null;
  private lastMaterialCheckTime = 0;
  private lastRescueCheckTime = 0;

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

    // Setup road segment callbacks
    roadSegmentManager.setCallbacks({
      spawnWorker: (seg) => this.spawnSegmentWorker(seg),
      freeWorker: (id) => this.freeSegmentWorker(id),
      moveWorker: (id, seg) => this.moveSegmentWorker(id, seg),
    });

    // Load sound effects
    audioManager.loadSound('road_build', '/audio/road_build.mp3');
    audioManager.loadSound('build_placed', '/audio/build_placed.mp3');
    audioManager.loadSound('demolish', '/audio/demolish.mp3');
    audioManager.loadSound('building_complete', '/audio/building_complete.mp3');

    // Setup event listeners
    this.setupEventListeners();

    // Initialize game world
    if (!skipInit) {
      this.initializeWorld();
    }
  }

  private setupEventListeners(): void {
    // Building events
    eventBus.on('build:road', (data) => this.buildRoad(data.x, data.y));
    eventBus.on('road:drag_end', () => { this.roadDragMode = null; });

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
    const spawnTile = this.findBaseCampSpawnTile();
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
      this.rerouteReturningWorkers();
    } else {
      if (this.tileMap.buildRoad(x, y)) {
        audioManager.playSound('road_build');
        roadSegmentManager.addRoad(x, y);
        this.scheduleSegmentRecalc();
        this.updateBuildingRoadConnections();
      }
    }
  }


  private getBaseCampConnectedRoads(): Set<string> {
    const connected = new Set<string>();
    if (!this.baseCampEntity) return connected;

    const baseCampPos = this.baseCampEntity.getComponent(Position);
    const baseCampBuilding = this.baseCampEntity.getComponent(Building);
    if (!baseCampPos || !baseCampBuilding) return connected;

    const entrance = baseCampBuilding.getEntranceOffset();
    if (!entrance) return connected;

    const entranceX = baseCampPos.x + entrance.dx;
    const entranceY = baseCampPos.y + entrance.dy;
    const entranceKey = `${entranceX},${entranceY}`;
    connected.add(entranceKey);

    // Seed BFS from road tiles adjacent to the entrance
    const queue: { x: number; y: number }[] = [];
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dx, dy] of dirs) {
      const tile = this.tileMap.getTile(entranceX + dx, entranceY + dy);
      if (tile && tile.hasRoad && !tile.isOccupied()) {
        const key = `${entranceX + dx},${entranceY + dy}`;
        if (!connected.has(key)) {
          connected.add(key);
          queue.push({ x: entranceX + dx, y: entranceY + dy });
        }
      }
    }

    // BFS flood-fill through connected road tiles (cardinal only, skip occupied/entrance tiles)
    const cardinalDirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    while (queue.length > 0) {
      const { x, y } = queue.shift()!;
      for (const [dx, dy] of cardinalDirs) {
        const neighbor = this.tileMap.getTile(x + dx, y + dy);
        if (neighbor && neighbor.hasRoad && !neighbor.isOccupied()) {
          const key = `${neighbor.x},${neighbor.y}`;
          if (!connected.has(key)) {
            connected.add(key);
            queue.push({ x: neighbor.x, y: neighbor.y });
          }
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
    if (roadsRemoved || entrance) {
      roadSegmentManager.recalculate(this.tileMap);
      this.recomputeTransportRoutes();
    }
  }

  private buildBaseCamp(x: number, y: number): void {
    const baseCamp = createBaseCamp(x, y);
    const building = baseCamp.getComponent(Building);

    if (!building) return;

    this.addEntity(baseCamp);
    this.occupyBuildingTiles(baseCamp.id, x, y, building.width, building.height, building);
    this.baseCampEntity = baseCamp;

    // Update population max
    const baseCampDef = dataManager.getBuilding('base_camp');
    this.population.max = baseCampDef?.population?.provides || 15;

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
    console.log(`Population: ${this.population.current}/${this.population.max}`);
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
      const spawnTile = this.findBaseCampSpawnTile();
      if (spawnTile) {
        for (const [res, amount] of Object.entries(building.constructionMaterials)) {
          for (let i = 0; i < amount; i++) {
            transportManager.addJunctionItem(spawnTile.x, spawnTile.y, res, entity.id);
          }
          building.materialsSent[res] = amount;
        }
      }

      // Spawn builder worker
      this.spawnBuilder(entity);
    }

    // Update population if residential
    if (buildingDef.population?.provides) {
      this.population.max += buildingDef.population.provides;
    }

    audioManager.playSound('build_placed');
    this.updateBuildingRoadConnections();
    eventBus.emit('build:success');
    console.log(`${buildingDef.name} (${building.width}x${building.height}) placed at (${x}, ${y}) — ${building.state}`);
  }

  public getAvailablePopulation(): number {
    return this.population.current - roadSegmentManager.getWorkerCount() - this.returningWorkers.size - this.builderWorkers.size - this.returningBuilders.size - this.toolWorkers.size - this.animationWorkers.size;
  }

  private findBaseCampSpawnTile(): { x: number; y: number } | null {
    if (!this.baseCampEntity) return null;
    const pos = this.baseCampEntity.getComponent(Position);
    const building = this.baseCampEntity.getComponent(Building);
    if (!pos || !building) return null;

    const entrance = building.getEntranceOffset();
    if (!entrance) return null;

    const ex = pos.x + entrance.dx;
    const ey = pos.y + entrance.dy;

    // Find the first road tile cardinally adjacent to the entrance
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dx, dy] of dirs) {
      const tile = this.tileMap.getTile(ex + dx, ey + dy);
      if (tile && tile.hasRoad && !tile.isOccupied()) {
        return { x: ex + dx, y: ey + dy };
      }
    }

    // Fall back to the entrance tile itself
    return { x: ex, y: ey };
  }

  private spawnSegmentWorker(segment: RoadSegment): number | null {
    if (this.getAvailablePopulation() <= 0) {
      console.warn('No available population for road worker');
      return null;
    }

    // Only spawn workers on segments connected to base camp
    const connectedRoads = this.getBaseCampConnectedRoads();
    const isConnected = segment.tiles.some(t => connectedRoads.has(`${t.x},${t.y}`));
    if (!isConnected) {
      return null;
    }

    const spawnTile = this.findBaseCampSpawnTile();
    const center = roadSegmentManager.getCenterTile(segment);

    // Spawn at base camp road tile, or directly at center if no spawn tile
    const spawnX = spawnTile?.x ?? center.x;
    const spawnY = spawnTile?.y ?? center.y;

    const worker = createWorker(spawnX, spawnY);
    this.addEntity(worker);

    // Pathfind to segment center if not already there
    if (spawnTile && (spawnX !== center.x || spawnY !== center.y)) {
      const path = this.pathFinder.findPath(
        new Position(spawnX, spawnY),
        new Position(center.x, center.y),
        this.tileMap
      );
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
    const entity = this.entities.find(e => e.id === workerId && e.active);
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
    if (!pos) { this.removeEntity(entity); return; }

    const spawnTile = this.findBaseCampSpawnTile();
    if (!spawnTile) { this.removeEntity(entity); return; }

    const path = this.pathFinder.findPath(
      new Position(Math.floor(pos.x), Math.floor(pos.y)),
      new Position(spawnTile.x, spawnTile.y),
      this.tileMap
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

    this.removeEntity(entity);
  }

  private rerouteReturningWorkers(): void {
    if (this.returningWorkers.size === 0) return;
    const spawnTile = this.findBaseCampSpawnTile();

    for (const workerId of this.returningWorkers) {
      const entity = this.entities.find(e => e.id === workerId && e.active);
      if (!entity) { this.returningWorkers.delete(workerId); continue; }

      const pos = entity.getComponent(Position);
      const movable = entity.getComponent(Movable);
      const worker = entity.getComponent(Worker);
      if (!pos || !movable || !worker) { this.removeEntity(entity); this.returningWorkers.delete(workerId); continue; }

      if (!spawnTile) { this.removeEntity(entity); this.returningWorkers.delete(workerId); continue; }

      const path = this.pathFinder.findPath(
        new Position(Math.floor(pos.x), Math.floor(pos.y)),
        new Position(spawnTile.x, spawnTile.y),
        this.tileMap
      );

      if (path.length > 0) {
        movable.setPath(path);
        worker.setState('walking');
      } else {
        this.removeEntity(entity);
        this.returningWorkers.delete(workerId);
      }
    }
  }

  private moveSegmentWorker(workerId: number, segment: RoadSegment): void {
    const entity = this.entities.find(e => e.id === workerId && e.active);
    if (!entity) return;

    const pos = entity.getComponent(Position);
    if (!pos) return;

    const center = roadSegmentManager.getCenterTile(segment);
    if (Math.floor(pos.x) === center.x && Math.floor(pos.y) === center.y) return;

    const path = this.pathFinder.findPath(
      new Position(Math.floor(pos.x), Math.floor(pos.y)),
      new Position(center.x, center.y),
      this.tileMap
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

  private findBuildingAdjacentRoadTile(buildingEntity: Entity): { x: number; y: number } | null {
    const pos = buildingEntity.getComponent(Position);
    const building = buildingEntity.getComponent(Building);
    if (!pos || !building) return null;

    const entrance = building.getEntranceOffset();
    if (entrance) {
      const ex = pos.x + entrance.dx;
      const ey = pos.y + entrance.dy;
      const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (const [dx, dy] of dirs) {
        const tile = this.tileMap.getTile(ex + dx, ey + dy);
        if (tile && tile.hasRoad && !tile.isOccupied()) {
          return { x: ex + dx, y: ey + dy };
        }
      }
      return { x: ex, y: ey };
    }

    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dx, dy] of dirs) {
      const tile = this.tileMap.getTile(pos.x + dx, pos.y + dy);
      if (tile && tile.hasRoad && !tile.isOccupied()) {
        return { x: pos.x + dx, y: pos.y + dy };
      }
    }
    return null;
  }

  private spawnBuilder(buildingEntity: Entity): void {
    const building = buildingEntity.getComponent(Building);
    if (!building || building.builderEntityId != null) return;
    if (this.getAvailablePopulation() <= 0) return;

    const spawnTile = this.findBaseCampSpawnTile();
    if (!spawnTile) return;

    const targetTile = this.findBuildingAdjacentRoadTile(buildingEntity);
    if (!targetTile) return;

    const path = this.pathFinder.findPath(
      new Position(spawnTile.x, spawnTile.y),
      new Position(targetTile.x, targetTile.y),
      this.tileMap
    );
    if (path.length === 0) return;

    const builder = createWorker(spawnTile.x, spawnTile.y);
    this.addEntity(builder);

    const workerComp = builder.getComponent(Worker);
    if (workerComp) {
      workerComp.carryingResource = 'hammer';
    }

    building.builderEntityId = builder.id;
    this.builderWorkers.set(builder.id, buildingEntity.id);

    const movable = builder.getComponent(Movable);
    if (movable && workerComp) {
      movable.setPath(path);
      workerComp.setState('walking');
    }
  }

  private returnBuilder(buildingEntity: Entity): void {
    const building = buildingEntity.getComponent(Building);
    if (!building || building.builderEntityId === null) return;

    const builderEntity = this.entities.find(e => e.id === building.builderEntityId && e.active);
    if (!builderEntity) {
      building.builderEntityId = null;
      return;
    }

    const bPos = builderEntity.getComponent(Position);
    if (!bPos) {
      this.removeEntity(builderEntity);
      building.builderEntityId = null;
      return;
    }

    const spawnTile = this.findBaseCampSpawnTile();
    if (!spawnTile) {
      this.removeEntity(builderEntity);
      building.builderEntityId = null;
      return;
    }

    const builderX = Math.floor(bPos.x);
    const builderY = Math.floor(bPos.y);
    const currentTile = this.tileMap.getTile(builderX, builderY);

    let prefixPath: Position[] = [];
    let pathStartX = builderX;
    let pathStartY = builderY;

    if (!currentTile || !currentTile.hasRoad) {
      const roadTile = this.findBuildingAdjacentRoadTile(buildingEntity);
      if (!roadTile) {
        this.removeEntity(builderEntity);
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

    const path = this.pathFinder.findPath(
      new Position(pathStartX, pathStartY),
      new Position(spawnTile.x, spawnTile.y),
      this.tileMap
    );

    if (path.length > 0) {
      const fullPath = [...prefixPath, ...path];
      const movable = builderEntity.getComponent(Movable);
      const worker = builderEntity.getComponent(Worker);
      if (movable && worker) {
        movable.speed = 1.8;
        movable.setPath(fullPath);
        worker.setState('walking');
        this.returningBuilders.add(builderEntity.id);
      }
    } else {
      this.removeEntity(builderEntity);
    }

    building.builderEntityId = null;
  }

  private getBuildingPerimeterTiles(bx: number, by: number, w: number, h: number): { x: number; y: number }[] {
    const tiles: { x: number; y: number }[] = [];
    for (let x = bx - 1; x <= bx + w; x++) {
      for (let y = by - 1; y <= by + h; y++) {
        if (x >= bx && x < bx + w && y >= by && y < by + h) continue;
        const tile = this.tileMap.getTile(x, y);
        if (tile && tile.isWalkable()) {
          tiles.push({ x, y });
        }
      }
    }
    return tiles;
  }

  private findPerimeterPath(
    startX: number, startY: number,
    endX: number, endY: number,
    perimeterTiles: { x: number; y: number }[]
  ): Position[] {
    const key = (x: number, y: number) => `${x},${y}`;
    const tileSet = new Set(perimeterTiles.map(t => key(t.x, t.y)));
    tileSet.add(key(endX, endY));

    const visited = new Set<string>();
    const queue: { x: number; y: number; path: Position[] }[] = [
      { x: startX, y: startY, path: [] }
    ];
    visited.add(key(startX, startY));

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.x === endX && current.y === endY) {
        return current.path;
      }

      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
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

  private updateBuilderPatrol(): void {
    for (const entity of this.entities) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (!building) continue;
      if (building.state !== 'under_construction') continue;
      if (building.builderEntityId === null) continue;

      const builderEntity = this.entities.find(e => e.id === building.builderEntityId && e.active);
      if (!builderEntity) continue;

      const movable = builderEntity.getComponent(Movable);
      if (!movable || movable.isMoving) continue;

      const builderPos = builderEntity.getComponent(Position);
      if (!builderPos) continue;

      const pos = entity.getComponent(Position);
      if (!pos) continue;

      const bx = Math.floor(pos.x);
      const by = Math.floor(pos.y);
      const perimeterTiles = this.getBuildingPerimeterTiles(bx, by, building.width, building.height);
      if (perimeterTiles.length === 0) continue;

      const cx = Math.floor(builderPos.x);
      const cy = Math.floor(builderPos.y);
      const adjacent = perimeterTiles.filter(t =>
        Math.abs(t.x - cx) + Math.abs(t.y - cy) === 1
      );

      if (adjacent.length > 0) {
        const edgeAdjacent = adjacent.filter(t => {
          for (let ix = bx; ix < bx + building.width; ix++) {
            for (let iy = by; iy < by + building.height; iy++) {
              if (Math.abs(t.x - ix) + Math.abs(t.y - iy) === 1) return true;
            }
          }
          return false;
        });
        const candidates = edgeAdjacent.length > 0 ? edgeAdjacent : adjacent;
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        movable.speed = 0.9;
        movable.setPath([new Position(target.x, target.y)]);
        const worker = builderEntity.getComponent(Worker);
        if (worker) worker.setState('walking');
      }
    }
  }

  private spawnAnimationWorker(buildingEntity: Entity): void {
    const building = buildingEntity.getComponent(Building);
    const pos = buildingEntity.getComponent(Position);
    if (!building || !pos) return;
    if (building.animationWorkerId != null) return;
    if (this.getAvailablePopulation() <= 0) return;

    const buildingDef = dataManager.getBuilding(building.buildingType);
    if (!buildingDef?.animation) return;
    const anim = buildingDef.animation;

    const entrance = building.getEntranceOffset();
    const entranceX = entrance ? pos.x + entrance.dx : pos.x;
    const entranceY = entrance ? pos.y + entrance.dy : pos.y;

    const treeTile = this.tileMap.findNearbyTerrain(
      entranceX, entranceY,
      anim.searchRadius,
      anim.targetTerrain,
      this.reservedTreeTiles
    );
    if (!treeTile) return;

    const path = this.pathFinder.findOffRoadPath(
      new Position(entranceX, entranceY),
      new Position(treeTile.x, treeTile.y),
      this.tileMap
    );
    if (path.length === 0) return;

    this.reservedTreeTiles.add(`${treeTile.x},${treeTile.y}`);

    const worker = createWorker(entranceX, entranceY);
    this.addEntity(worker);

    const workerComp = worker.getComponent(Worker);
    if (workerComp) {
      workerComp.carryingResource = (buildingDef.requiredTool as string) || 'axe';
    }

    const movable = worker.getComponent(Movable);
    if (movable) {
      movable.speed = anim.workerSpeed;
      movable.setPath(path);
      if (workerComp) workerComp.setState('walking');
    }

    building.animationWorkerId = worker.id;
    this.animationWorkers.set(worker.id, {
      buildingEntityId: buildingEntity.id,
      phase: 'to_target',
      targetTile: treeTile,
      terrainModified: false,
      entranceTile: { x: entranceX, y: entranceY },
    });
  }

  private updateAnimationWorkers(): void {
    for (const [workerId, state] of this.animationWorkers) {
      const workerEntity = this.entities.find(e => e.id === workerId && e.active);
      if (!workerEntity) {
        this.cleanupAnimationWorker(workerId, state);
        continue;
      }

      const movable = workerEntity.getComponent(Movable);
      if (!movable || movable.isMoving) continue;

      const workerComp = workerEntity.getComponent(Worker);
      const workerPos = workerEntity.getComponent(Position);
      if (!workerComp || !workerPos) continue;

      const buildingEntity = this.entities.find(e => e.id === state.buildingEntityId && e.active);

      switch (state.phase) {
        case 'to_target': {
          state.phase = 'chopping';
          workerComp.setState('working');
          break;
        }
        case 'chopping': {
          if (!buildingEntity) {
            this.removeEntity(workerEntity);
            this.cleanupAnimationWorker(workerId, state);
            continue;
          }

          const production = buildingEntity.getComponent(Production);
          if (production && production.getProgress() >= 0.9 && !state.terrainModified) {
            const bldg = buildingEntity.getComponent(Building);
            const buildingDef = bldg ? dataManager.getBuilding(bldg.buildingType) : null;
            const anim = buildingDef?.animation;
            if (anim) {
              const tile = this.tileMap.getTile(state.targetTile.x, state.targetTile.y);
              if (tile) {
                const newTerrain = anim.terrainTransition[tile.terrain];
                if (newTerrain) {
                  this.tileMap.setTerrain(state.targetTile.x, state.targetTile.y, newTerrain as any);
                  this.renderSystem.updateMinimapTiles([{ x: state.targetTile.x, y: state.targetTile.y }]);
                }
              }
            }
            state.terrainModified = true;
            workerComp.carryingResource = 'wood_log';
            workerComp.setState('carrying');

            const returnPath = this.pathFinder.findOffRoadPath(
              new Position(Math.floor(workerPos.x), Math.floor(workerPos.y)),
              new Position(state.entranceTile.x, state.entranceTile.y),
              this.tileMap
            );
            if (returnPath.length > 0) {
              movable.speed = (anim?.workerSpeed || 1.2);
              movable.setPath(returnPath);
            }
            state.phase = 'returning';
          } else {
            const tx = state.targetTile.x;
            const ty = state.targetTile.y;
            const cx = Math.floor(workerPos.x);
            const cy = Math.floor(workerPos.y);
            const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
            const walkable = dirs
              .map(([dx, dy]) => ({ x: tx + dx, y: ty + dy }))
              .filter(p => {
                if (p.x === cx && p.y === cy) return false;
                const t = this.tileMap.getTile(p.x, p.y);
                return t && t.walkable && !t.isOccupied();
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
          this.removeEntity(workerEntity);
          if (buildingEntity) {
            const building = buildingEntity.getComponent(Building);
            if (building) building.animationWorkerId = null;
          }
          this.reservedTreeTiles.delete(`${state.targetTile.x},${state.targetTile.y}`);
          this.animationWorkers.delete(workerId);
          continue;
        }
      }
    }

    // Spawn animation workers for buildings that started producing
    for (const entity of this.entities) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      const production = entity.getComponent(Production);
      if (!building || !production) continue;
      if (!building.isComplete() || !building.isActive) continue;
      if (building.animationWorkerId != null) continue;
      if (production.status !== 'producing') continue;

      const buildingDef = dataManager.getBuilding(building.buildingType);
      if (!buildingDef?.animation) continue;

      this.spawnAnimationWorker(entity);
    }
  }

  private cleanupAnimationWorker(workerId: number, state: { buildingEntityId: number; targetTile: { x: number; y: number } }): void {
    this.reservedTreeTiles.delete(`${state.targetTile.x},${state.targetTile.y}`);
    this.animationWorkers.delete(workerId);
    const buildingEntity = this.entities.find(e => e.id === state.buildingEntityId && e.active);
    if (buildingEntity) {
      const building = buildingEntity.getComponent(Building);
      if (building) building.animationWorkerId = null;
    }
  }

  private spawnToolWorker(buildingEntity: Entity, tool: string): void {
    if (this.getAvailablePopulation() <= 0) return;

    const spawnTile = this.findBaseCampSpawnTile();
    if (!spawnTile) return;

    const targetTile = this.findBuildingAdjacentRoadTile(buildingEntity);
    if (!targetTile) return;

    const path = this.pathFinder.findPath(
      new Position(spawnTile.x, spawnTile.y),
      new Position(targetTile.x, targetTile.y),
      this.tileMap
    );
    if (path.length === 0) return;

    const worker = createWorker(spawnTile.x, spawnTile.y);
    this.addEntity(worker);

    const workerComp = worker.getComponent(Worker);
    if (workerComp) {
      workerComp.carryingResource = tool;
    }

    this.toolWorkers.set(worker.id, buildingEntity.id);

    const movable = worker.getComponent(Movable);
    if (movable && workerComp) {
      movable.setPath(path);
      workerComp.setState('walking');
    }
  }

  private updateConstructionDelivery(): void {
    // Check builder arrivals
    for (const [builderId, buildingId] of this.builderWorkers) {
      const builderEntity = this.entities.find(e => e.id === builderId && e.active);
      if (!builderEntity) {
        this.builderWorkers.delete(builderId);
        continue;
      }

      const movable = builderEntity.getComponent(Movable);
      if (movable && !movable.isMoving) {
        const buildingEntity = this.entities.find(e => e.id === buildingId && e.active);
        if (!buildingEntity) {
          this.removeEntity(builderEntity);
          this.builderWorkers.delete(builderId);
          continue;
        }

        const targetTile = this.findBuildingAdjacentRoadTile(buildingEntity);
        const builderPos = builderEntity.getComponent(Position);

        if (targetTile && builderPos &&
            Math.floor(builderPos.x) === targetTile.x &&
            Math.floor(builderPos.y) === targetTile.y) {
          const building = buildingEntity.getComponent(Building);
          if (building) building.builderArrived = true;
          this.builderWorkers.delete(builderId);
        } else if (targetTile && builderPos) {
          const path = this.pathFinder.findPath(
            new Position(Math.floor(builderPos.x), Math.floor(builderPos.y)),
            new Position(targetTile.x, targetTile.y),
            this.tileMap
          );
          if (path.length > 0) {
            movable.setPath(path);
            const workerComp = builderEntity.getComponent(Worker);
            if (workerComp) workerComp.setState('walking');
          }
        }
      }
    }

    // Check construction sites
    for (const entity of this.entities) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (!building || building.state !== 'awaiting_materials') continue;

      if (building.canStartConstruction()) {
        building.beginConstruction();
        continue;
      }

      // Spawn builder if needed and building has road connection
      if (building.builderEntityId === null && building.isActive) {
        this.spawnBuilder(entity);
      }
    }

    // Check tool worker arrivals
    for (const [workerId, buildingId] of this.toolWorkers) {
      const workerEntity = this.entities.find(e => e.id === workerId && e.active);
      if (!workerEntity) {
        this.toolWorkers.delete(workerId);
        continue;
      }

      const movable = workerEntity.getComponent(Movable);
      if (movable && !movable.isMoving) {
        const buildingEntity = this.entities.find(e => e.id === buildingId && e.active);
        if (!buildingEntity) {
          this.removeEntity(workerEntity);
          this.toolWorkers.delete(workerId);
          continue;
        }

        const targetTile = this.findBuildingAdjacentRoadTile(buildingEntity);
        const workerPos = workerEntity.getComponent(Position);

        if (targetTile && workerPos &&
            Math.floor(workerPos.x) === targetTile.x &&
            Math.floor(workerPos.y) === targetTile.y) {
          const building = buildingEntity.getComponent(Building);
          if (building) building.hasOperator = true;
          this.removeEntity(workerEntity);
          this.toolWorkers.delete(workerId);
        } else if (targetTile && workerPos) {
          const path = this.pathFinder.findPath(
            new Position(Math.floor(workerPos.x), Math.floor(workerPos.y)),
            new Position(targetTile.x, targetTile.y),
            this.tileMap
          );
          if (path.length > 0) {
            movable.setPath(path);
            const wc = workerEntity.getComponent(Worker);
            if (wc) wc.setState('walking');
          }
        }
      }
    }

    // Spawn tool workers for completed buildings needing operators
    for (const entity of this.entities) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (!building || !building.isComplete() || building.hasOperator) continue;
      if (!building.isActive) continue;

      let hasToolWorker = false;
      for (const [, bId] of this.toolWorkers) {
        if (bId === entity.id) { hasToolWorker = true; break; }
      }
      if (hasToolWorker) continue;

      const buildingDef = dataManager.getBuilding(building.buildingType);
      if (buildingDef?.requiredTool) {
        this.spawnToolWorker(entity, buildingDef.requiredTool as string);
      }
    }
  }

  private recheckConstructionMaterials(): void {
    if (!this.baseCampEntity) return;
    const now = Date.now();
    if (now - this.lastMaterialCheckTime < 2000) return;
    this.lastMaterialCheckTime = now;

    const storage = this.baseCampEntity.getComponent(Storage);
    if (!storage) return;
    const spawnTile = this.findBaseCampSpawnTile();
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
            if (item.destinationEntityId === entity.id && item.resourceType === res) inTransit++;
          }
        }

        for (const [, items] of transportManager.getPendingPickupVisualsMap()) {
          for (const item of items) {
            if (item.destinationEntityId === entity.id && item.resourceType === res) inTransit++;
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

        const toDispatch = remaining - inTransit;
        if (toDispatch <= 0) continue;

        for (let i = 0; i < toDispatch; i++) {
          if (storage.getAmount(res) <= 0) break;
          storage.removeItem(res, 1);
          transportManager.addJunctionItem(spawnTile.x, spawnTile.y, res, entity.id);
        }
      }
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
      if (this.returningWorkers.has(entity.id)) continue;
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

  private canAnySegmentRouteToBuilding(x: number, y: number, destEntityId: number, excludeSegmentId: number): boolean {
    const segments = roadSegmentManager.getSegments();
    for (const seg of segments) {
      if (seg.id === excludeSegmentId) continue;
      let epIdx = -1;
      if (seg.endpoints[0].x === x && seg.endpoints[0].y === y) epIdx = 0;
      else if (seg.endpoints[1].x === x && seg.endpoints[1].y === y) epIdx = 1;
      if (epIdx === -1) continue;
      const dirIdx = transportManager.getDirectionIndex(seg.id, destEntityId);
      if (dirIdx !== undefined && dirIdx !== epIdx) {
        return true;
      }
    }
    return false;
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

      // Check building output at this endpoint
      if (ep.type === 'building' && ep.entityId != null && !this.pendingBuildingPickups.has(ep.entityId)) {
        const output = this.checkBuildingForOutput(ep.entityId);
        if (output) {
          let destEntityId: number | null = this.baseCampEntity?.id ?? null;
          const demandBuilding = this.findDemandingBuilding(output.resourceType);
          if (demandBuilding) {
            const dirIdx = transportManager.getDirectionIndex(segment.id, demandBuilding.id);
            if (dirIdx !== undefined && dirIdx !== pickupIdx) {
              destEntityId = demandBuilding.id;
            } else if (this.canAnySegmentRouteToBuilding(ep.x, ep.y, demandBuilding.id, segment.id)) {
              continue;
            }
          }

          const dirCheck = transportManager.getDirectionIndex(segment.id, destEntityId);
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
          const path = this.getSegmentPath(segment, pos, ep.x, ep.y);
          if (path.length > 0) {
            movable.setPath(path);
            worker.setState('walking');
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
        const path = this.getSegmentPath(segment, pos, ep.x, ep.y);
        if (path.length > 0) {
          movable.setPath(path);
          worker.setState('walking');
        }
        return;
      }
    }

    // Check for stranded items anywhere along the segment (dropped during recalc)
    for (const tile of segment.tiles) {
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
      const path = this.getSegmentPath(segment, pos, tile.x, tile.y);
      if (path.length > 0) {
        movable.setPath(path);
        worker.setState('walking');
      }
      return;
    }

  }

  private advanceTransport(segment: RoadSegment, worker: Worker, movable: Movable, pos: Position): void {
    const task = worker.transportTask!;
    switch (task.phase) {
      case 'to_pickup': {
        let taken = false;
        if (task.sourceEntityId != null) {
          this.pendingBuildingPickups.delete(task.sourceEntityId);
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
        const path = this.getSegmentPath(segment, pos, task.dropoffPos.x, task.dropoffPos.y);
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
                if (destStorage && destStorage.canAccept(res)) {
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
    const center = roadSegmentManager.getCenterTile(segment);
    const path = this.getSegmentPath(segment, pos, center.x, center.y);
    if (path.length > 0) {
      movable.setPath(path);
      worker.setState('walking');
    }
  }

  private getSegmentPath(segment: RoadSegment, fromPos: Position, toX: number, toY: number): Position[] {
    const tiles = segment.tiles;
    const fromX = Math.floor(fromPos.x);
    const fromY = Math.floor(fromPos.y);
    let fromIdx = tiles.findIndex(t => t.x === fromX && t.y === fromY);
    const toIdx = tiles.findIndex(t => t.x === toX && t.y === toY);
    if (fromIdx === -1) {
      let minDist = Infinity;
      tiles.forEach((t, i) => {
        const d = Math.abs(t.x - fromX) + Math.abs(t.y - fromY);
        if (d < minDist) { minDist = d; fromIdx = i; }
      });
    }
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return [];
    const path: Position[] = [];
    const step = fromIdx < toIdx ? 1 : -1;
    for (let i = fromIdx + step; step > 0 ? i <= toIdx : i >= toIdx; i += step) {
      path.push(new Position(tiles[i].x, tiles[i].y));
    }
    return path;
  }

  addEntity(entity: Entity): void {
    this.entities.push(entity);
    this.systems.forEach(system => system.addEntity(entity));
  }

  removeEntity(entity: Entity): void {
    entity.destroy();
    this.systems.forEach(system => system.removeEntity(entity));
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
      this.renderSystem.buildPreview = {
        mode,
        gridX: this.inputSystem.hoverGridPos.x,
        gridY: this.inputSystem.hoverGridPos.y
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

    // Remove returning workers that reached base camp
    if (this.returningWorkers.size > 0) {
      for (const workerId of this.returningWorkers) {
        const entity = this.entities.find(e => e.id === workerId && e.active);
        if (!entity) { this.returningWorkers.delete(workerId); continue; }
        const movable = entity.getComponent(Movable);
        if (movable && !movable.isMoving) {
          this.removeEntity(entity);
          this.returningWorkers.delete(workerId);
        }
      }
    }

    // Remove returning builders that reached base camp
    if (this.returningBuilders.size > 0) {
      for (const builderId of this.returningBuilders) {
        const entity = this.entities.find(e => e.id === builderId && e.active);
        if (!entity) { this.returningBuilders.delete(builderId); continue; }
        const movable = entity.getComponent(Movable);
        if (movable && !movable.isMoving) {
          this.removeEntity(entity);
          this.returningBuilders.delete(builderId);
        }
      }
    }

    // Update construction delivery (builder arrivals, material checks)
    this.updateConstructionDelivery();

    // Re-dispatch lost construction materials
    this.recheckConstructionMaterials();

    // Move builders around the building during construction
    this.updateBuilderPatrol();

    // Update animation workers (woodcutter etc.)
    this.updateAnimationWorkers();

    // Update building construction progress
    this.updateConstruction();

    // Explore area around visible viewport
    this.exploreVisibleArea();

    // Update all systems
    this.systems.forEach(system => system.update(deltaTime));

    // Update transport relay chain
    this.updateTransport();

    // Periodically rescue stranded junction items
    const now = Date.now();
    if (now - this.lastRescueCheckTime > 5000) {
      this.lastRescueCheckTime = now;
      this.rescueStrandedItems();
    }

    // Keep inventory in sync with storage components
    this.syncInventory();

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
          this.returnBuilder(entity);

          // Mark building as needing tool worker if it has a requiredTool
          const buildingDef = dataManager.getBuilding(building.buildingType);
          if (buildingDef?.requiredTool) {
            building.hasOperator = false;
          }

          const production = entity.getComponent(Production);
          if (production && production.hasInputs()) {
            transportManager.computeRoutesToBuilding(roadSegmentManager.getSegments(), entity.id);
          }
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

    const pos = this.selectedEntity.getComponent(Position);
    const building = this.selectedEntity.getComponent(Building);

    if (pos && building) {
      // Refund construction materials if building is awaiting materials
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

      // Remove builder worker if exists
      if (building.builderEntityId != null) {
        const builderEntity = this.entities.find(e => e.id === building.builderEntityId && e.active);
        if (builderEntity) this.removeEntity(builderEntity);
        this.builderWorkers.delete(building.builderEntityId);
        this.returningBuilders.delete(building.builderEntityId);
      }

      // Remove animation worker if active
      if (building.animationWorkerId != null) {
        const animWorker = this.entities.find(e => e.id === building.animationWorkerId && e.active);
        if (animWorker) this.removeEntity(animWorker);
        const animState = this.animationWorkers.get(building.animationWorkerId);
        if (animState) {
          this.reservedTreeTiles.delete(`${animState.targetTile.x},${animState.targetTile.y}`);
          this.animationWorkers.delete(building.animationWorkerId);
        }
      }

      // Remove tool worker if in transit
      for (const [workerId, buildingId] of this.toolWorkers) {
        if (buildingId === this.selectedEntity!.id) {
          const workerEntity = this.entities.find(e => e.id === workerId && e.active);
          if (workerEntity) this.removeEntity(workerEntity);
          this.toolWorkers.delete(workerId);
          break;
        }
      }

      const entrance = building.getEntranceOffset();

      // Release occupied tiles
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

      audioManager.playSound('demolish');
      resourceManager.onBuildingDestroyed(this.selectedEntity.id);
      console.log(`Deleted entity #${this.selectedEntity.id}`);
      this.removeEntity(this.selectedEntity);
      this.selectedEntity = null;
      this.syncInventory();
      this.updateSelectionUI();
      roadSegmentManager.recalculate(this.tileMap);
      this.recomputeTransportRoutes();
      this.updateBuildingRoadConnections();
    }
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
    this.returningWorkers.clear();
    this.builderWorkers.clear();
    this.returningBuilders.clear();
    this.toolWorkers.clear();
    this.animationWorkers.clear();
    this.reservedTreeTiles.clear();
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
      this.builderWorkers.clear();
      this.returningBuilders.clear();
      this.returningWorkers.clear();
      this.toolWorkers.clear();
      this.animationWorkers.clear();
      this.reservedTreeTiles.clear();
      this.pendingBuildingPickups.clear();

      this.population = saveData.population || { current: 0, max: 0 };
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
            const center = roadSegmentManager.getCenterTile(seg);
            const worker = createWorker(center.x, center.y);
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
