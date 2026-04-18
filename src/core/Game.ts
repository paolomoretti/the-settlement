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
    }, 200);
  }

  private buildRoad(x: number, y: number): void {
    if (!this.isAreaExplored(x, y)) {
      return;
    }

    const tile = this.tileMap.getTile(x, y);
    if (!tile) return;

    // Toggle: remove existing road (but not entrance roads inside buildings)
    if (tile.hasRoad && !tile.isOccupied()) {
      tile.hasRoad = false;
      roadSegmentManager.removeRoad(x, y);
      this.scheduleSegmentRecalc();
      this.updateBuildingRoadConnections();
      this.rerouteReturningWorkers();
      return;
    }

    if (!this.isRoadPlacementValid(x, y)) {
      return;
    }

    if (this.tileMap.buildRoad(x, y)) {
      audioManager.playSound('build_placed');
      roadSegmentManager.addRoad(x, y);
      this.scheduleSegmentRecalc();
      this.updateBuildingRoadConnections();
    }
  }

  private isRoadPlacementValid(x: number, y: number): boolean {
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dx, dy] of dirs) {
      const tile = this.tileMap.getTile(x + dx, y + dy);
      if (!tile) continue;
      if (tile.hasRoad) return true;
    }
    return false;
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

    this.addEntity(entity);
    this.occupyBuildingTiles(entity.id, x, y, building.width, building.height, building);

    // Update population if residential
    if (buildingDef.population?.provides) {
      this.population.max += buildingDef.population.provides;
    }

    audioManager.playSound('build_placed');
    this.updateBuildingRoadConnections();
    eventBus.emit('build:success');
    console.log(`✅ ${buildingDef.name} (${building.width}x${building.height}) built at (${x}, ${y})`);
  }

  public getAvailablePopulation(): number {
    return this.population.current - roadSegmentManager.getWorkerCount() - this.returningWorkers.size;
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

    // Update building construction progress
    this.updateConstruction();

    // Explore area around visible viewport
    this.exploreVisibleArea();

    // Update all systems
    this.systems.forEach(system => system.update(deltaTime));

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

      resourceManager.onBuildingDestroyed(this.selectedEntity.id);
      console.log(`Deleted entity #${this.selectedEntity.id}`);
      this.removeEntity(this.selectedEntity);
      this.selectedEntity = null;
      this.syncInventory();
      this.updateSelectionUI();
      roadSegmentManager.recalculate(this.tileMap);
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

        if (building?.constructionStartedAt) {
          data.constructionStartedAt = building.constructionStartedAt;
          data.buildTimeSec = building.buildTimeSec;
        }

        if (building?.completedAt) {
          data.completedAt = building.completedAt;
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
          if (buildingData.constructionStartedAt) {
            building.constructionStartedAt = buildingData.constructionStartedAt;
            building.buildTimeSec = buildingData.buildTimeSec;
            building.state = 'under_construction';
            building.updateConstruction();
          } else {
            building.state = 'complete';
            building.constructionStartedAt = null;
            building.completedAt = buildingData.completedAt || Date.now();
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
