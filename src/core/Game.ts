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
import { Inventory, BuildingType } from '@/types/GameData';

// Entity factories
import { createWorker, createBuilding, createBaseCamp, createWarehouse } from '@/entities/EntityFactory';

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

    // Generic building handler for all building types
    const buildingTypes = [
      'warehouse', 'storehouse', 'hut', 'house',
      'lumberjack', 'sawmill', 'quarry', 'farm', 'mill', 'bakery', 'well', 'fisher',
      'coal_mine', 'iron_mine', 'iron_smelter', 'tool_smithy',
      'barracks'
    ];

    buildingTypes.forEach(type => {
      eventBus.on(`build:${type}`, (data) => this.buildGeneric(type as any, data.x, data.y));
    });

    eventBus.on('spawn:worker', () => this.spawnWorker());

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

    // Build base camp
    this.buildBaseCamp(centerX, centerY);

    // Spawn initial workers
    for (let i = 0; i < 3; i++) {
      this.spawnWorker();
    }

    // Build initial road network (cardinal directions only)
    // Main horizontal road (grid X axis)
    for (let i = -15; i <= 15; i++) {
      this.buildRoad(centerX + i, centerY);
    }

    // Main vertical road (grid Y axis)
    for (let i = -15; i <= 15; i++) {
      this.buildRoad(centerX, centerY + i);
    }

    // Connecting roads forming a grid
    for (let i = -10; i <= 10; i++) {
      this.buildRoad(centerX + i, centerY + 8);
      this.buildRoad(centerX + i, centerY - 8);
      this.buildRoad(centerX + 8, centerY + i);
      this.buildRoad(centerX - 8, centerY + i);
    }

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

  private buildRoad(x: number, y: number): void {
    if (!this.isAreaExplored(x, y)) {
      return;
    }

    if (this.tileMap.buildRoad(x, y)) {
      audioManager.playSound('build_placed');
      this.updateBuildingRoadConnections();
    }
  }

  private getBaseCampConnectedRoads(): Set<string> {
    const connected = new Set<string>();
    if (!this.baseCampEntity) return connected;

    const baseCampPos = this.baseCampEntity.getComponent(Position);
    const baseCampBuilding = this.baseCampEntity.getComponent(Building);
    if (!baseCampPos || !baseCampBuilding) return connected;

    const bx = baseCampPos.x;
    const by = baseCampPos.y;
    const bw = baseCampBuilding.width;
    const bh = baseCampBuilding.height;

    // Find road tiles adjacent to the base camp as BFS seeds
    const queue: { x: number; y: number }[] = [];
    for (let dy = -1; dy <= bh; dy++) {
      for (let dx = -1; dx <= bw; dx++) {
        const isInside = dx >= 0 && dx < bw && dy >= 0 && dy < bh;
        if (isInside) continue;
        const tile = this.tileMap.getTile(bx + dx, by + dy);
        if (tile && tile.hasRoad) {
          const key = `${bx + dx},${by + dy}`;
          if (!connected.has(key)) {
            connected.add(key);
            queue.push({ x: bx + dx, y: by + dy });
          }
        }
      }
    }

    // BFS flood-fill through connected road tiles
    while (queue.length > 0) {
      const { x, y } = queue.shift()!;
      const neighbors = this.tileMap.getNeighbors(x, y);
      for (const neighbor of neighbors) {
        if (neighbor.hasRoad) {
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
    const bx = pos.x;
    const by = pos.y;
    const bw = building.width;
    const bh = building.height;

    for (let dy = -1; dy <= bh; dy++) {
      for (let dx = -1; dx <= bw; dx++) {
        const isInsideFootprint = dx >= 0 && dx < bw && dy >= 0 && dy < bh;
        if (isInsideFootprint) continue;

        const key = `${bx + dx},${by + dy}`;
        if (connectedRoads.has(key)) return true;
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

  private occupyBuildingTiles(entityId: number, x: number, y: number, width: number, height: number): void {
    // Occupy all tiles the building uses and clear roads underneath
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const tile = this.tileMap.getTile(x + dx, y + dy);
        if (tile) {
          tile.occupy(entityId);
          // Remove road when building is placed on top
          // Workers can't walk through buildings
          if (tile.hasRoad) {
            tile.hasRoad = false;
          }
        }
      }
    }
  }

  private buildBaseCamp(x: number, y: number): void {
    const baseCamp = createBaseCamp(x, y);
    const building = baseCamp.getComponent(Building);

    if (!building) return;

    this.addEntity(baseCamp);
    this.occupyBuildingTiles(baseCamp.id, x, y, building.width, building.height);
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
    this.occupyBuildingTiles(entity.id, x, y, building.width, building.height);

    // Update population if residential
    if (buildingDef.population?.provides) {
      this.population.max += buildingDef.population.provides;
    }

    audioManager.playSound('build_placed');
    this.updateBuildingRoadConnections();
    eventBus.emit('build:success');
    console.log(`✅ ${buildingDef.name} (${building.width}x${building.height}) built at (${x}, ${y})`);
  }

  private buildWarehouse(x: number, y: number): void {
    this.buildGeneric('warehouse', x, y);
  }

  private spawnWorker(): void {
    // Spawn near warehouse (but not on it - warehouse is 3x3)
    const centerX = Math.floor(this.tileMap.width / 2);
    const centerY = Math.floor(this.tileMap.height / 2);

    // Spawn on the roads around the warehouse (further away to avoid warehouse footprint)
    const spawnOffsets = [
      { x: -5, y: 0 }, { x: 5, y: 0 },  // West/East on road
      { x: 0, y: -5 }, { x: 0, y: 5 },  // North/South on road
    ];

    const offset = spawnOffsets[Math.floor(Math.random() * spawnOffsets.length)];
    const spawnX = centerX + offset.x;
    const spawnY = centerY + offset.y;

    const worker = createWorker(spawnX, spawnY);

    this.addEntity(worker);
    audioManager.playSound('worker_spawn');
    console.log(`Worker spawned at (${spawnX}, ${spawnY})`);

    // Give worker a random path for testing
    setTimeout(() => this.giveWorkerRandomTask(worker), 1000);
  }

  private getRandomRoadTile(): { x: number; y: number } | null {
    // Find a random road tile
    const roadTiles: { x: number; y: number }[] = [];

    for (let y = 0; y < this.tileMap.height; y++) {
      for (let x = 0; x < this.tileMap.width; x++) {
        const tile = this.tileMap.getTile(x, y);
        if (tile && tile.hasRoad) {
          roadTiles.push({ x, y });
        }
      }
    }

    if (roadTiles.length === 0) return null;
    return roadTiles[Math.floor(Math.random() * roadTiles.length)];
  }

  private giveWorkerRandomTask(worker: Entity): void {
    const pos = worker.getComponent(Position);
    if (!pos) {
      console.warn('Worker has no position component');
      return;
    }

    // Find a random destination on a road
    const target = this.getRandomRoadTile();
    if (!target) {
      console.warn('No road tiles found!');
      return;
    }

    const startX = Math.floor(pos.x);
    const startY = Math.floor(pos.y);
    const targetX = target.x;
    const targetY = target.y;

    const path = this.pathFinder.findPath(
      new Position(startX, startY),
      new Position(targetX, targetY),
      this.tileMap
    );

    if (path.length > 0) {
      const movable = worker.getComponent(Movable);
      const workerComp = worker.getComponent(Worker);

      if (movable && workerComp) {
        movable.setPath(path);
        workerComp.setState('walking');

        // Give another task when done
        setTimeout(() => {
          if (worker.active) {
            this.giveWorkerRandomTask(worker);
          }
        }, path.length * 1000);
      }
    } else {
      console.warn('No path found, retrying with different destination...');
      setTimeout(() => {
        if (worker.active) {
          this.giveWorkerRandomTask(worker);
        }
      }, 2000);
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
      // Release occupied tiles
      for (let dy = 0; dy < building.height; dy++) {
        for (let dx = 0; dx < building.width; dx++) {
          const tile = this.tileMap.getTile(pos.x + dx, pos.y + dy);
          if (tile && tile.occupiedBy === this.selectedEntity.id) {
            tile.release();
          }
        }
      }

      resourceManager.onBuildingDestroyed(this.selectedEntity.id);
      console.log(`Deleted entity #${this.selectedEntity.id}`);
      this.removeEntity(this.selectedEntity);
      this.selectedEntity = null;
      this.syncInventory();
      this.updateSelectionUI();
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
        for (let dy = 0; dy < building.height; dy++) {
          for (let dx = 0; dx < building.width; dx++) {
            const tile = this.tileMap.getTile(pos.x + dx, pos.y + dy);
            if (tile && tile.occupiedBy === this.selectedEntity.id) {
              tile.release();
            }
          }
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
        this.occupyBuildingTiles(this.selectedEntity.id, x, y, building.width, building.height);
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
            building.height
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

        if (production) {
          data.production = production.serialize();
        }

        if (storage) {
          data.storage = storage.serialize();
        }

        return data;
      }),
      transportQueue: resourceManager.serialize(),
      inventory: this.inventory,
      population: this.population,
      timestamp: Date.now()
    };
  }

  resetForNewGame(): void {
    this.entities.forEach(e => e.destroy());
    this.entities = [];
    this.systems.forEach(system => system.cleanup());
    resourceManager.reset();

    this.tileMap = new TileMap(1000, 1000);
    this.renderSystem.updateTileMap(this.tileMap);

    this.selectedEntity = null;
    this.baseCampEntity = null;
    this.isDraggingEntity = false;
    this.dragPreviewPosition = null;
    this.lastExplorationPos = null;
    this.inventory = {};
    this.population = { current: 0, max: 0 };

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
          this.occupyBuildingTiles(entity.id, buildingData.x, buildingData.y, building.width, building.height);
        }
      }

      // Restore transport queue
      if (saveData.transportQueue) {
        resourceManager.deserialize(saveData.transportQueue);
      }

      this.syncInventory();

      for (let i = 0; i < 3; i++) {
        this.spawnWorker();
      }

      this.updateBuildingRoadConnections();
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
