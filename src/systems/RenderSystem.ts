/**
 * Render System - handles all rendering to canvas
 */

import { System } from '@/core/System';
import { Entity } from '@/core/Entity';
import { Position } from '@/components/Position';
import { Renderable } from '@/components/Renderable';
import { Building } from '@/components/Building';
import { Worker, IdleAnim } from '@/components/Worker';
import { Movable } from '@/components/Movable';
import { TileMap } from '@/map/TileMap';
import { Isometric } from '@/utils/Isometric';
import { Tile } from '@/map/Tile';
import { Production } from '@/components/Production';
import { dataManager } from '@/data/DataManager';
import { TerrainTextures } from '@/rendering/TerrainTextures';

// Construction phase sprites per building type (excluding the completed sprite).
// During build, total frames = stages.length + 1 (the completed sprite is the last frame).
const CONSTRUCTION_SPRITES: Record<string, string[]> = {
  warehouse: [
    '/assets/buildings/warehouse_build_0.png',
    '/assets/buildings/warehouse_build_1.png',
  ],
  lumberjack: [
    '/assets/buildings/lumberjack_build_0.png',
    '/assets/buildings/lumberjack_build_1.png',
    '/assets/buildings/lumberjack_build_2.png',
  ],
  sawmill: [
    '/assets/buildings/sawmill_build_0.png',
    '/assets/buildings/sawmill_build_1.png',
    '/assets/buildings/sawmill_build_2.png',
  ],
  forester: [
    '/assets/buildings/forester_build_0.png',
    '/assets/buildings/forester_build_1.png',
    '/assets/buildings/forester_build_2.png',
  ],
  quarry: [
    '/assets/buildings/quarry_build_0.png',
    '/assets/buildings/quarry_build_1.png',
    '/assets/buildings/quarry_build_2.png',
  ],
  hut: [
    '/assets/buildings/hut_build_0.png',
    '/assets/buildings/hut_build_1.png',
    '/assets/buildings/hut_build_2.png',
  ],
};

export class RenderSystem extends System {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private iso: Isometric;
  private camera = { x: 0, y: 0, zoom: 1 };
  public buildPreview: { mode: string; gridX: number; gridY: number } | null = null;
  public selectedEntityId: number | null = null;
  public dragPreviewPosition: { x: number; y: number } | null = null;
  private terrainTextures: TerrainTextures;
  private spriteCache = new Map<string, HTMLImageElement>();
  public hoveredEntityId: number | null = null;
  private toast: { text: string; x: number; y: number; startTime: number } | null = null;

  // Minimap
  private minimapCanvas: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D;
  private minimapOffscreen: HTMLCanvasElement;
  private minimapOffscreenCtx: CanvasRenderingContext2D;
  private minimapScale: number;

  constructor(canvas: HTMLCanvasElement, private tileMap: TileMap) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.iso = new Isometric(64, 32);
    this.terrainTextures = new TerrainTextures();
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());

    // Setup minimap with offscreen canvas for caching
    this.minimapCanvas = document.getElementById('minimap-canvas') as HTMLCanvasElement;
    this.minimapCtx = this.minimapCanvas.getContext('2d')!;

    // Create offscreen canvas for minimap caching
    this.minimapOffscreen = document.createElement('canvas');
    this.minimapOffscreen.width = 200;
    this.minimapOffscreen.height = 200;
    this.minimapOffscreenCtx = this.minimapOffscreen.getContext('2d')!;
    this.minimapScale = 200 / this.tileMap.width;

    // Initialize minimap with black (unexplored)
    this.minimapOffscreenCtx.fillStyle = '#1a1a1a';
    this.minimapOffscreenCtx.fillRect(0, 0, 200, 200);

    // Minimap click navigation
    this.minimapCanvas.addEventListener('click', (e) => this.handleMinimapClick(e));

    // Center camera on map
    this.centerCamera();

    // Preload all known building sprites (completed + construction phases)
    const allSprites = [
      '/assets/buildings/base_camp.png',
      '/assets/buildings/warehouse.png',
      '/assets/buildings/lumberjack.png',
      '/assets/buildings/sawmill.png',
      '/assets/buildings/quarry.png',
      '/assets/buildings/farm.png',
    ];
    for (const stages of Object.values(CONSTRUCTION_SPRITES)) {
      allSprites.push(...stages);
    }
    this.preloadSprites(allSprites);
  }

  private preloadSprites(paths: string[]): void {
    for (const path of paths) {
      const img = new Image();
      img.src = path;
      this.spriteCache.set(path, img);
    }
  }

  private loadSprite(path: string): HTMLImageElement | null {
    const cached = this.spriteCache.get(path);
    if (cached) return (cached.complete && cached.naturalWidth > 0) ? cached : null;

    const img = new Image();
    img.src = path;
    this.spriteCache.set(path, img);
    return null;
  }

  private handleMinimapClick(e: MouseEvent): void {
    const rect = this.minimapCanvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Convert minimap click to grid coordinates
    const minimapSize = 200;
    const scale = minimapSize / this.tileMap.width;
    const gridX = clickX / scale;
    const gridY = clickY / scale;

    // Move camera to center on this grid position
    const worldPos = this.iso.gridToScreen(gridX, gridY);
    this.camera.x = this.canvas.width / 2 - worldPos.x;
    this.camera.y = this.canvas.height / 2 - worldPos.y;
  }

  private resizeCanvas(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  private centerCamera(): void {
    const mapCenter = this.iso.gridToScreen(
      this.tileMap.width / 2,
      this.tileMap.height / 2
    );
    this.camera.x = this.canvas.width / 2 - mapCenter.x;
    this.camera.y = this.canvas.height / 2 - mapCenter.y - 100;
  }

  shouldProcessEntity(entity: Entity): boolean {
    return entity.hasComponent(Position) && entity.hasComponent(Renderable);
  }

  update(_deltaTime: number): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.ctx.save();
    this.ctx.translate(this.camera.x, this.camera.y);
    this.ctx.scale(this.camera.zoom, this.camera.zoom);

    // Render tiles
    this.renderTiles();

    // Get viewport bounds for entity culling
    const viewportBounds = this.getViewportBounds();

    // Filter entities to only those in or near viewport
    const visibleEntities = this.entities.filter(entity => {
      const pos = entity.getComponent(Position);
      if (!pos) return false;

      const building = entity.getComponent(Building);
      const width = building ? building.width : 1;
      const height = building ? building.height : 1;

      // Check if entity is within viewport bounds (with padding)
      return pos.x + width >= viewportBounds.minX &&
             pos.x <= viewportBounds.maxX &&
             pos.y + height >= viewportBounds.minY &&
             pos.y <= viewportBounds.maxY;
    });

    // Sort for isometric depth: higher x+y = closer to camera = drawn later.
    // Buildings sort by their front tile edge. Workers at the same depth draw
    // on top of buildings so they remain visible on roads in front of structures.
    const sortedEntities = visibleEntities.sort((a, b) => {
      const posA = a.getComponent(Position)!;
      const posB = b.getComponent(Position)!;
      const buildingA = a.getComponent(Building);
      const buildingB = b.getComponent(Building);

      const depthA = posA.y + posA.x + (buildingA ? buildingA.width + buildingA.height - 2 : 0);
      const depthB = posB.y + posB.x + (buildingB ? buildingB.width + buildingB.height - 2 : 0);

      if (depthA !== depthB) return depthA - depthB;
      // At same depth, workers draw on top of buildings
      if (buildingA && !buildingB) return -1;
      if (!buildingA && buildingB) return 1;
      return 0;
    });

    // Render road stub for disconnected buildings (before entities so it's behind sprites)
    for (const entity of visibleEntities) {
      const building = entity.getComponent(Building);
      if (!building || building.isActive) continue;
      const entrance = building.getEntranceOffset();
      if (!entrance) continue;
      const pos = entity.getComponent(Position)!;
      const ex = pos.x + entrance.dx;
      const ey = pos.y + entrance.dy;
      const outX = ex + 1;
      const outY = ey;
      // Draw road on entrance tile (will be hidden under sprite)
      const entranceCenter = this.iso.gridToScreen(ex, ey);
      this.terrainTextures.drawRoad(this.ctx, 4, entranceCenter.x, entranceCenter.y);
      // Draw road on out tile connecting back to entrance
      const outCenter = this.iso.gridToScreen(outX, outY);
      this.terrainTextures.drawRoad(this.ctx, 1, outCenter.x, outCenter.y);
      // Subtle highlight on the out tile
      const corners = this.iso.getTileCorners(outX, outY);
      this.ctx.beginPath();
      this.ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i++) {
        this.ctx.lineTo(corners[i].x, corners[i].y);
      }
      this.ctx.closePath();
      this.ctx.fillStyle = 'rgba(200, 60, 60, 0.2)';
      this.ctx.fill();
    }

    // Render entities
    sortedEntities.forEach(entity => this.renderEntity(entity));

    // Render selection outline for selected entity
    if (this.selectedEntityId !== null) {
      const selectedEntity = sortedEntities.find(e => e.id === this.selectedEntityId);
      if (selectedEntity) {
        this.renderSelectionOutline(selectedEntity);
      }
    }

    // Render build preview
    if (this.buildPreview) {
      this.renderBuildPreview(this.buildPreview);
    }

    this.ctx.restore();

    // Render toast message (screen-space, after ctx.restore)
    this.renderToast();

    // Render minimap
    this.renderMinimap();
  }

  // Update specific tiles on the minimap (called when tiles are explored)
  public updateMinimapTiles(tiles: { x: number; y: number }[]): void {
    for (const { x, y } of tiles) {
      const tile = this.tileMap.getTile(x, y);
      if (!tile) continue;

      const px = x * this.minimapScale;
      const py = y * this.minimapScale;

      if (!tile.isExplored()) {
        this.minimapOffscreenCtx.fillStyle = '#1a1a1a';
      } else if (tile.terrain === 'water') {
        this.minimapOffscreenCtx.fillStyle = '#2196f3'; // Bright blue
      } else if (tile.terrain === 'mountain') {
        this.minimapOffscreenCtx.fillStyle = '#9e9e9e'; // Light grey
      } else if (tile.terrain === 'forest') {
        this.minimapOffscreenCtx.fillStyle = '#1b5e20'; // Very dark green
      } else if (tile.terrain === 'tree') {
        this.minimapOffscreenCtx.fillStyle = '#388e3c'; // Medium green
      } else if (tile.terrain === 'hill') {
        this.minimapOffscreenCtx.fillStyle = '#9ccc65'; // Light green
      } else {
        this.minimapOffscreenCtx.fillStyle = '#7cb342'; // Grass green
      }

      this.minimapOffscreenCtx.fillRect(px, py, Math.max(1, this.minimapScale), Math.max(1, this.minimapScale));
    }
  }

  private renderMinimap(): void {
    const minimapSize = 200;

    // Clear and copy the cached minimap
    this.minimapCtx.clearRect(0, 0, minimapSize, minimapSize);
    this.minimapCtx.drawImage(this.minimapOffscreen, 0, 0);

    // Draw viewport indicator
    const viewportWidth = (this.canvas.width / this.camera.zoom) / this.iso.tileWidth;
    const viewportHeight = (this.canvas.height / this.camera.zoom) / this.iso.tileHeight;

    // Get current center of view
    const centerGridPos = this.screenToWorld(this.canvas.width / 2, this.canvas.height / 2);

    const vpX = (centerGridPos.x - viewportWidth / 2) * this.minimapScale;
    const vpY = (centerGridPos.y - viewportHeight / 2) * this.minimapScale;
    const vpW = viewportWidth * this.minimapScale;
    const vpH = viewportHeight * this.minimapScale;

    this.minimapCtx.strokeStyle = '#ffff00';
    this.minimapCtx.lineWidth = 2;
    this.minimapCtx.strokeRect(vpX, vpY, vpW, vpH);
  }

  private renderSelectionOutline(entity: Entity): void {
    const pos = entity.getComponent(Position);
    const building = entity.getComponent(Building);

    if (!pos || !building) return;

    // Use drag preview position if dragging
    const baseX = this.dragPreviewPosition ? this.dragPreviewPosition.x : pos.x;
    const baseY = this.dragPreviewPosition ? this.dragPreviewPosition.y : pos.y;

    // Highlight the tiles occupied by this building
    for (let dy = 0; dy < building.height; dy++) {
      for (let dx = 0; dx < building.width; dx++) {
        const x = baseX + dx;
        const y = baseY + dy;
        const corners = this.iso.getTileCorners(x, y);

        this.ctx.beginPath();
        this.ctx.moveTo(corners[0].x, corners[0].y);
        corners.forEach(corner => this.ctx.lineTo(corner.x, corner.y));
        this.ctx.closePath();

        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        this.ctx.lineWidth = 1.5;
        this.ctx.stroke();

        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
        this.ctx.fill();
      }
    }
  }

  private renderBuildPreview(preview: { mode: string; gridX: number; gridY: number }): void {
    const { mode, gridX, gridY } = preview;

    if (mode === 'build_road') {
      this.renderRoadPreview(gridX, gridY);
      return;
    }

    const buildingType = mode.replace('build_', '');
    const buildingDef = dataManager.getBuilding(buildingType as any);
    if (!buildingDef) return;

    const { size, visual } = buildingDef;
    const spritePath = `/assets/buildings/${buildingType}.png`;
    const sprite = this.loadSprite(spritePath);

    if (sprite) {
      this.renderSpritePreview(gridX, gridY, size.width, size.height, sprite);
    } else {
      this.renderBuildingPreview(gridX, gridY, size.width, size.height, visual.buildingHeight, visual.color);
    }
  }

  private renderSpritePreview(gridX: number, gridY: number, width: number, depth: number, sprite: HTMLImageElement): void {
    const canPlace = this.canPlacePreview(gridX, gridY, width, depth);
    const tileHighlight = canPlace ? 'rgba(255, 255, 255, 0.2)' : 'rgba(200, 50, 50, 0.35)';

    this.highlightTiles(gridX, gridY, width, depth, tileHighlight);

    const screenPos = this.iso.gridToScreen(gridX, gridY);
    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;

    this.ctx.save();
    this.ctx.globalAlpha = canPlace ? 0.6 : 0.4;
    if (!canPlace) this.ctx.filter = 'saturate(0.3) brightness(0.8)';
    this.ctx.translate(screenPos.x, screenPos.y - this.iso.tileHeight / 2);

    if (width > 1 || depth > 1) {
      const cx = (width - depth) * tileW / 4;
      const cy = (width + depth) * tileH / 4;
      const maxDim = Math.max(width, depth);
      const spriteScale = maxDim >= 5 ? 0.72 : 0.85;
      this.ctx.translate(cx, cy);
      this.ctx.scale(spriteScale, spriteScale);
      this.ctx.translate(-cx, -cy);
    }

    const footprintW = (width + depth) * tileW / 2;
    const scale = footprintW / sprite.naturalWidth;
    const drawW = sprite.naturalWidth * scale;
    const drawH = sprite.naturalHeight * scale;
    const centerX = (width - depth) * tileW / 4;
    const frontY = (width + depth) * tileH / 2;

    this.ctx.drawImage(sprite, centerX - drawW / 2, frontY - drawH, drawW, drawH);
    this.ctx.restore();
  }

  private renderRoadPreview(gridX: number, gridY: number): void {
    const tile = this.tileMap.getTile(gridX, gridY);
    const isExistingRoad = tile && tile.hasRoad && !tile.isOccupied();
    const canBuild = tile && tile.walkable && !tile.isOccupied() && !tile.hasRoad;
    const corners = this.iso.getTileCorners(gridX, gridY);

    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y);
    corners.forEach(corner => this.ctx.lineTo(corner.x, corner.y));
    this.ctx.closePath();

    if (isExistingRoad) {
      this.ctx.fillStyle = 'rgba(200, 50, 50, 0.35)';
      this.ctx.fill();
      this.ctx.strokeStyle = 'rgba(200, 50, 50, 0.9)';
    } else if (canBuild) {
      this.ctx.fillStyle = 'rgba(196, 165, 114, 0.7)';
      this.ctx.fill();
      this.ctx.strokeStyle = 'rgba(166, 138, 90, 0.9)';
    } else {
      this.ctx.fillStyle = 'rgba(200, 50, 50, 0.5)';
      this.ctx.fill();
      this.ctx.strokeStyle = 'rgba(200, 50, 50, 0.9)';
    }
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
  }

  private canPlacePreview(gridX: number, gridY: number, width: number, depth: number): boolean {
    for (let dy = 0; dy < depth; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const tile = this.tileMap.getTile(gridX + dx, gridY + dy);
        if (!tile || !tile.walkable || tile.isOccupied()) return false;
      }
    }
    return true;
  }

  private renderBuildingPreview(gridX: number, gridY: number, width: number, depth: number, height: number, color: string): void {
    const canPlace = this.canPlacePreview(gridX, gridY, width, depth);

    const previewColor = canPlace ? color : '#cc3333';
    const tileHighlight = canPlace ? 'rgba(255, 255, 255, 0.2)' : 'rgba(200, 50, 50, 0.35)';
    const outlineColor = canPlace ? 'rgba(255, 255, 255, 0.8)' : 'rgba(255, 80, 80, 0.9)';

    // Highlight tiles underneath
    this.highlightTiles(gridX, gridY, width, depth, tileHighlight);

    // Render semi-transparent building
    const screenPos = this.iso.gridToScreen(gridX, gridY);
    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;

    this.ctx.save();
    this.ctx.globalAlpha = canPlace ? 0.6 : 0.5;
    this.ctx.translate(screenPos.x, screenPos.y - this.iso.tileHeight / 2);

    if (width > 1 || depth > 1) {
      const cx = (width - depth) * tileW / 4;
      const cy = (width + depth) * tileH / 4;
      const maxDim = Math.max(width, depth);
      const spriteScale = maxDim >= 5 ? 0.72 : 0.85;
      this.ctx.translate(cx, cy);
      this.ctx.scale(spriteScale, spriteScale);
      this.ctx.translate(-cx, -cy);
    }

    // Calculate base corners (bottom face)
    const baseCorners = [
      { x: 0, y: 0 },                                           // Back (top)
      { x: width * tileW / 2, y: width * tileH / 2 },          // Right
      { x: (width - depth) * tileW / 2, y: (width + depth) * tileH / 2 }, // Front (bottom)
      { x: -depth * tileW / 2, y: depth * tileH / 2 }          // Left
    ];

    // Calculate top corners
    const topCorners = baseCorners.map(c => ({
      x: c.x,
      y: c.y - height
    }));

    // Draw front face (right side)
    this.ctx.beginPath();
    this.ctx.moveTo(baseCorners[1].x, baseCorners[1].y);
    this.ctx.lineTo(topCorners[1].x, topCorners[1].y);
    this.ctx.lineTo(topCorners[2].x, topCorners[2].y);
    this.ctx.lineTo(baseCorners[2].x, baseCorners[2].y);
    this.ctx.closePath();
    this.ctx.fillStyle = this.darkenColor(previewColor, 0.7);
    this.ctx.fill();
    this.ctx.strokeStyle = outlineColor;
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    // Draw left face
    this.ctx.beginPath();
    this.ctx.moveTo(baseCorners[3].x, baseCorners[3].y);
    this.ctx.lineTo(topCorners[3].x, topCorners[3].y);
    this.ctx.lineTo(topCorners[2].x, topCorners[2].y);
    this.ctx.lineTo(baseCorners[2].x, baseCorners[2].y);
    this.ctx.closePath();
    this.ctx.fillStyle = this.darkenColor(previewColor, 0.5);
    this.ctx.fill();
    this.ctx.strokeStyle = outlineColor;
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    // Draw top face
    this.ctx.beginPath();
    this.ctx.moveTo(topCorners[0].x, topCorners[0].y);
    this.ctx.lineTo(topCorners[1].x, topCorners[1].y);
    this.ctx.lineTo(topCorners[2].x, topCorners[2].y);
    this.ctx.lineTo(topCorners[3].x, topCorners[3].y);
    this.ctx.closePath();
    this.ctx.fillStyle = previewColor;
    this.ctx.fill();
    this.ctx.strokeStyle = outlineColor;
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    this.ctx.restore();
  }

  private highlightTiles(startX: number, startY: number, width: number, height: number, color: string): void {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const x = startX + dx;
        const y = startY + dy;
        const tile = this.tileMap.getTile(x, y);

        if (tile) {
          const corners = this.iso.getTileCorners(x, y);

          this.ctx.beginPath();
          this.ctx.moveTo(corners[0].x, corners[0].y);
          corners.forEach(corner => this.ctx.lineTo(corner.x, corner.y));
          this.ctx.closePath();

          this.ctx.fillStyle = color;
          this.ctx.fill();
          this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
          this.ctx.lineWidth = 2;
          this.ctx.stroke();
        }
      }
    }
  }

  private shouldShowGrid(): number {
    // Build or drag mode — full grid
    if (this.buildPreview || this.dragPreviewPosition) return 0.35;
    // Near max zoom (max is 2) — fade in grid between 1.7 and 2.0
    if (this.camera.zoom > 1.7) return (this.camera.zoom - 1.7) / 0.3 * 0.25;
    return 0;
  }

  private renderTiles(): void {
    const viewportBounds = this.getViewportBounds();

    for (let y = viewportBounds.minY; y <= viewportBounds.maxY; y++) {
      for (let x = viewportBounds.minX; x <= viewportBounds.maxX; x++) {
        const tile = this.tileMap.getTile(x, y);
        if (tile) {
          this.renderTile(tile);
        }
      }
    }

    // Grid overlay
    const gridAlpha = this.shouldShowGrid();
    if (gridAlpha > 0) {
      this.ctx.strokeStyle = `rgba(255, 255, 255, ${gridAlpha})`;
      this.ctx.lineWidth = 0.5;
      for (let y = viewportBounds.minY; y <= viewportBounds.maxY; y++) {
        for (let x = viewportBounds.minX; x <= viewportBounds.maxX; x++) {
          const tile = this.tileMap.getTile(x, y);
          if (!tile || !tile.isExplored()) continue;
          const corners = this.iso.getTileCorners(x, y);
          this.ctx.beginPath();
          this.ctx.moveTo(corners[0].x, corners[0].y);
          for (let i = 1; i < corners.length; i++) {
            this.ctx.lineTo(corners[i].x, corners[i].y);
          }
          this.ctx.closePath();
          this.ctx.stroke();
        }
      }
    }
  }

  private cachedViewportBounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
  private lastCameraBounds = { x: 0, y: 0, zoom: 1 };

  private getViewportBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    // Cache viewport bounds if camera hasn't moved (optimization)
    if (this.cachedViewportBounds &&
        this.lastCameraBounds.x === this.camera.x &&
        this.lastCameraBounds.y === this.camera.y &&
        this.lastCameraBounds.zoom === this.camera.zoom) {
      return this.cachedViewportBounds;
    }

    // Calculate which tiles are visible in the current viewport
    const padding = 10; // Extra tiles to render outside viewport to avoid pop-in

    // Get corners of viewport in world space
    const topLeft = this.screenToWorld(0, 0);
    const topRight = this.screenToWorld(this.canvas.width, 0);
    const bottomLeft = this.screenToWorld(0, this.canvas.height);
    const bottomRight = this.screenToWorld(this.canvas.width, this.canvas.height);

    // Find min/max grid coordinates
    const minX = Math.max(0, Math.floor(Math.min(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x)) - padding);
    const maxX = Math.min(this.tileMap.width - 1, Math.ceil(Math.max(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x)) + padding);
    const minY = Math.max(0, Math.floor(Math.min(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y)) - padding);
    const maxY = Math.min(this.tileMap.height - 1, Math.ceil(Math.max(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y)) + padding);

    // Cache the result
    this.cachedViewportBounds = { minX, maxX, minY, maxY };
    this.lastCameraBounds = { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom };

    return this.cachedViewportBounds;
  }

  private getRoadConfig(x: number, y: number): number {
    let config = 0;
    const nw = this.tileMap.getTile(x - 1, y);
    if (nw?.hasRoad) config |= 1;
    const ne = this.tileMap.getTile(x, y - 1);
    if (ne?.hasRoad) config |= 2;
    const se = this.tileMap.getTile(x + 1, y);
    if (se?.hasRoad) config |= 4;
    const sw = this.tileMap.getTile(x, y + 1);
    if (sw?.hasRoad) config |= 8;
    return config;
  }

  private getWaterConfig(x: number, y: number): number {
    let config = 0;
    const nw = this.tileMap.getTile(x - 1, y);
    if (nw?.terrain === 'water') config |= 1;
    const ne = this.tileMap.getTile(x, y - 1);
    if (ne?.terrain === 'water') config |= 2;
    const se = this.tileMap.getTile(x + 1, y);
    if (se?.terrain === 'water') config |= 4;
    const sw = this.tileMap.getTile(x, y + 1);
    if (sw?.terrain === 'water') config |= 8;
    return config;
  }

  private renderTile(tile: Tile): void {
    const center = this.iso.gridToScreen(tile.x, tile.y);
    if (!tile.isExplored()) {
      this.terrainTextures.drawTile(this.ctx, 'fog', tile.x, tile.y, center.x, center.y);
      return;
    }

    if (tile.terrain === 'water') {
      this.terrainTextures.drawTile(this.ctx, 'grass', tile.x, tile.y, center.x, center.y);
      const waterConfig = this.getWaterConfig(tile.x, tile.y);
      this.terrainTextures.drawWater(this.ctx, waterConfig, tile.x, tile.y, center.x, center.y);
    } else {
      this.terrainTextures.drawTile(this.ctx, tile.terrain, tile.x, tile.y, center.x, center.y);
    }

    if (tile.hasRoad) {
      const config = this.getRoadConfig(tile.x, tile.y);
      this.terrainTextures.drawRoad(this.ctx, config, center.x, center.y);
    }
  }


  private renderEntity(entity: Entity): void {
    const pos = entity.getComponent(Position)!;
    const renderable = entity.getComponent(Renderable)!;
    const building = entity.getComponent(Building);

    // Check if this entity is selected
    const isSelected = this.selectedEntityId === entity.id;

    // Use drag preview position if dragging this entity
    const renderX = (isSelected && this.dragPreviewPosition) ? this.dragPreviewPosition.x : pos.x;
    const renderY = (isSelected && this.dragPreviewPosition) ? this.dragPreviewPosition.y : pos.y;

    const screenPos = this.iso.gridToScreen(renderX, renderY);
    const offsetY = renderable.offsetY;

    this.ctx.save();

    const isInactive = building && !building.isActive;
    const isUnderConstruction = building && building.state === 'under_construction';

    // Apply fade effect for selected buildings
    if (isSelected && building) {
      this.ctx.globalAlpha = 0.7;
    }

    // Apply opacity fade for under-construction buildings without construction sprites
    if (isUnderConstruction && !CONSTRUCTION_SPRITES[building!.buildingType]) {
      this.ctx.globalAlpha = 0.4 + 0.6 * building!.constructionProgress;
    }

    // Apply grayscale + dim for inactive buildings
    if (isInactive && !isUnderConstruction) {
      this.ctx.filter = 'grayscale(85%) brightness(0.65)';
    }

    // Buildings anchor at the top corner of their starting tile (isometric back corner)
    // gridToScreen gives us tile CENTER, but building corners are calculated from TOP corner
    if (building && building.buildingHeight > 0) {
      // Offset from tile center to tile top corner
      this.ctx.translate(screenPos.x, screenPos.y - this.iso.tileHeight / 2 + offsetY);
    } else {
      // Non-buildings render at tile center
      this.ctx.translate(screenPos.x, screenPos.y + offsetY);
    }

    if (building) {
      const entrance = building.getEntranceOffset();
      if (entrance) {
        const tileW = this.iso.tileWidth;
        const tileH = this.iso.tileHeight;
        const cx = (building.width - building.height) * tileW / 4;
        const cy = (building.width + building.height) * tileH / 4;
        const maxDim = Math.max(building.width, building.height);
        const spriteScale = maxDim >= 5 ? 0.72 : 0.85;
        this.ctx.save();
        this.ctx.translate(cx, cy);
        this.ctx.scale(spriteScale, spriteScale);
        this.ctx.translate(-cx, -cy);
      }

      if (renderable.spritePath) {
        this.renderBuildingSprite(building, renderable, isSelected);
      } else {
        this.renderIsometricBuilding(building, renderable, isSelected);
      }

      if (entrance) {
        this.ctx.restore();
      }
    } else if (entity.hasComponent(Worker)) {
      const movable = entity.getComponent(Movable) ?? null;
      const worker = entity.getComponent(Worker)!;
      this.renderWorkerSprite(movable, worker);
    } else {
      switch (renderable.type) {
        case 'circle':
          this.renderCircle(renderable);
          break;
        case 'rectangle':
          this.renderRectangle(renderable);
          break;
        case 'triangle':
          this.renderTriangle(renderable);
          break;
      }
    }

    // Debug: render building type
    if (building) {
      this.ctx.fillStyle = 'white';
      this.ctx.font = '10px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(building.buildingType, 0, -building.height - 10);
    }

    // Reset filter before drawing status indicators
    if (isInactive) {
      this.ctx.filter = 'none';
    }

    // Construction overlay for buildings under construction
    if (building && building.state === 'under_construction') {
      this.ctx.globalAlpha = 1;
      this.renderConstructionOverlay(building);
    }

    // Status bubble for inactive buildings (only when complete)
    if (isInactive && building && building.isComplete()) {
      const hovered = entity.id === this.hoveredEntityId;
      this.renderStatusBubble(
        building, hovered,
        () => this.drawRoadMissingIcon(),
        'No road connection'
      );
    } else if (building && building.isComplete()) {
      const production = entity.getComponent(Production);
      if (production) {
        const buffered = production.getTotalBuffered();
        if (production.status === 'stopped_full') {
          this.renderProductionBubble(building, production, true);
        } else if (buffered > 0) {
          this.renderProductionBubble(building, production, false);
        }
      }
    }

    this.ctx.restore();
  }

  private getConstructionSpritePath(building: Building, renderable: Renderable): string | undefined {
    if (building.state !== 'under_construction' || !renderable.spritePath) return renderable.spritePath;
    const stages = CONSTRUCTION_SPRITES[building.buildingType];
    if (!stages || stages.length === 0) return renderable.spritePath;
    const totalFrames = stages.length + 1;
    const frameIndex = Math.min(Math.floor(building.constructionProgress * totalFrames), stages.length);
    return frameIndex < stages.length ? stages[frameIndex] : renderable.spritePath;
  }

  private renderBuildingSprite(building: Building, renderable: Renderable, isSelected: boolean = false): void {
    const spritePath = this.getConstructionSpritePath(building, renderable);
    const sprite = spritePath ? this.loadSprite(spritePath) : null;
    if (!sprite) return;

    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;
    const width = building.width;
    const depth = building.height;

    const footprintW = (width + depth) * tileW / 2;
    const scale = footprintW / sprite.naturalWidth;
    const drawW = sprite.naturalWidth * scale;
    const drawH = sprite.naturalHeight * scale;

    const centerX = (width - depth) * tileW / 4;
    const frontY = (width + depth) * tileH / 2;

    this.ctx.drawImage(sprite, centerX - drawW / 2, frontY - drawH, drawW, drawH);

    if (isSelected) {
      const baseCorners = [
        { x: 0, y: 0 },
        { x: width * tileW / 2, y: width * tileH / 2 },
        { x: (width - depth) * tileW / 2, y: (width + depth) * tileH / 2 },
        { x: -depth * tileW / 2, y: depth * tileH / 2 }
      ];
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      baseCorners.forEach((corner, i) => {
        if (i === 0) this.ctx.moveTo(corner.x, corner.y);
        else this.ctx.lineTo(corner.x, corner.y);
      });
      this.ctx.closePath();
      this.ctx.stroke();
    }
  }

  private renderIsometricBuilding(building: Building, renderable: Renderable, isSelected: boolean = false): void {
    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;

    // Building dimensions in tiles
    const width = building.width;
    const depth = building.height; // Using height property as depth
    const height = building.buildingHeight; // 3D height

    // In isometric view, buildings are anchored at their back (top) corner
    // The current position (0,0) is the center of the first tile
    // We need to offset to the back corner of the building's footprint

    // Calculate base corners (bottom face) starting from back corner
    // Back corner is at the top of the diamond
    const baseCorners = [
      { x: 0, y: 0 },                                           // Back (top)
      { x: width * tileW / 2, y: width * tileH / 2 },          // Right
      { x: (width - depth) * tileW / 2, y: (width + depth) * tileH / 2 }, // Front (bottom)
      { x: -depth * tileW / 2, y: depth * tileH / 2 }          // Left
    ];

    // Calculate top corners (offset by building height)
    const topCorners = baseCorners.map(c => ({
      x: c.x,
      y: c.y - height
    }));

    // Draw front face (right side)
    this.ctx.beginPath();
    this.ctx.moveTo(baseCorners[1].x, baseCorners[1].y);
    this.ctx.lineTo(topCorners[1].x, topCorners[1].y);
    this.ctx.lineTo(topCorners[2].x, topCorners[2].y);
    this.ctx.lineTo(baseCorners[2].x, baseCorners[2].y);
    this.ctx.closePath();
    this.ctx.fillStyle = this.darkenColor(renderable.color, 0.7);
    this.ctx.fill();
    this.ctx.strokeStyle = '#000';
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();

    // Draw left face
    this.ctx.beginPath();
    this.ctx.moveTo(baseCorners[3].x, baseCorners[3].y);
    this.ctx.lineTo(topCorners[3].x, topCorners[3].y);
    this.ctx.lineTo(topCorners[2].x, topCorners[2].y);
    this.ctx.lineTo(baseCorners[2].x, baseCorners[2].y);
    this.ctx.closePath();
    this.ctx.fillStyle = this.darkenColor(renderable.color, 0.5);
    this.ctx.fill();
    this.ctx.strokeStyle = '#000';
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();

    // Draw top face
    this.ctx.beginPath();
    this.ctx.moveTo(topCorners[0].x, topCorners[0].y);
    this.ctx.lineTo(topCorners[1].x, topCorners[1].y);
    this.ctx.lineTo(topCorners[2].x, topCorners[2].y);
    this.ctx.lineTo(topCorners[3].x, topCorners[3].y);
    this.ctx.closePath();
    this.ctx.fillStyle = renderable.color;
    this.ctx.fill();

    if (isSelected) {
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      this.ctx.lineWidth = 2;
    } else {
      this.ctx.strokeStyle = '#000';
      this.ctx.lineWidth = 1.5;
    }
    this.ctx.stroke();
  }

  private renderStatusBubble(
    building: Building,
    isHovered: boolean,
    drawIcon: () => void,
    hoverText: string
  ): void {
    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;

    const centerX = ((building.width - building.height) * tileW / 2) / 2;
    const centerY = ((building.width + building.height) * tileH / 2) / 2;
    const bubbleX = centerX;
    const bubbleY = centerY - building.buildingHeight - 40;

    const bubbleW = isHovered ? 160 : 44;
    const bubbleH = isHovered ? 34 : 40;
    const radius = 8;

    const bob = Math.sin(Date.now() * 0.003) * 2;

    this.ctx.save();
    this.ctx.translate(bubbleX, bubbleY + bob);

    // Bubble shape with pointer
    this.ctx.beginPath();
    this.ctx.moveTo(-bubbleW / 2 + radius, -bubbleH / 2);
    this.ctx.lineTo(bubbleW / 2 - radius, -bubbleH / 2);
    this.ctx.arcTo(bubbleW / 2, -bubbleH / 2, bubbleW / 2, -bubbleH / 2 + radius, radius);
    this.ctx.lineTo(bubbleW / 2, bubbleH / 2 - radius);
    this.ctx.arcTo(bubbleW / 2, bubbleH / 2, bubbleW / 2 - radius, bubbleH / 2, radius);
    this.ctx.lineTo(7, bubbleH / 2);
    this.ctx.lineTo(0, bubbleH / 2 + 10);
    this.ctx.lineTo(-7, bubbleH / 2);
    this.ctx.lineTo(-bubbleW / 2 + radius, bubbleH / 2);
    this.ctx.arcTo(-bubbleW / 2, bubbleH / 2, -bubbleW / 2, bubbleH / 2 - radius, radius);
    this.ctx.lineTo(-bubbleW / 2, -bubbleH / 2 + radius);
    this.ctx.arcTo(-bubbleW / 2, -bubbleH / 2, -bubbleW / 2 + radius, -bubbleH / 2, radius);
    this.ctx.closePath();

    this.ctx.fillStyle = 'rgba(40, 40, 40, 0.92)';
    this.ctx.fill();
    this.ctx.strokeStyle = '#cc3333';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    if (isHovered) {
      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = 'bold 12px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(hoverText, 0, 0);
    } else {
      drawIcon();
    }

    this.ctx.restore();
  }

  private renderProductionBubble(
    building: Building,
    production: Production,
    isFull: boolean
  ): void {
    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;
    const buffered = production.getTotalBuffered();
    const maxBuffer = production.maxOutputBuffer;

    const bubbleX = building.width * tileW / 2 + 2;
    const bubbleY = building.width * tileH / 2 - building.buildingHeight - 2;

    const primaryOutput = Object.keys(production.outputs)[0];
    const icon = primaryOutput ? this.loadSprite(`/assets/resources/${primaryOutput}.png`) : null;

    const r = 10;
    const hasIcon = !!icon;
    const pillW = hasIcon ? 34 : 20;
    const pillH = 20;

    this.ctx.save();
    this.ctx.translate(bubbleX, bubbleY);

    this.ctx.beginPath();
    this.ctx.moveTo(-pillW / 2 + r, -pillH / 2);
    this.ctx.lineTo(pillW / 2 - r, -pillH / 2);
    this.ctx.arc(pillW / 2 - r, 0, pillH / 2, -Math.PI / 2, Math.PI / 2);
    this.ctx.lineTo(-pillW / 2 + r, pillH / 2);
    this.ctx.arc(-pillW / 2 + r, 0, pillH / 2, Math.PI / 2, -Math.PI / 2);
    this.ctx.closePath();

    this.ctx.fillStyle = 'rgba(30, 30, 30, 0.88)';
    this.ctx.fill();
    this.ctx.strokeStyle = isFull ? '#cc3333' : '#5a8a4a';
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();

    if (hasIcon) {
      this.ctx.drawImage(icon!, -pillW / 2 + 3, -7, 14, 14);
      this.ctx.fillStyle = isFull ? '#ff6666' : '#ffffff';
      this.ctx.font = 'bold 9px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(`${buffered}`, pillW / 2 - 8, 0);
    } else {
      this.ctx.fillStyle = isFull ? '#ff6666' : '#ffffff';
      this.ctx.font = 'bold 9px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(`${buffered}`, 0, 0);
    }

    this.ctx.restore();
  }

  private renderConstructionOverlay(building: Building): void {
    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;
    const width = building.width;
    const depth = building.height;

    const centerX = ((width - depth) * tileW / 2) / 2;
    const frontY = (width + depth) * tileH / 2;

    // Progress bar at the bottom of the building footprint
    const barWidth = (width + depth) * tileW / 3;
    const barHeight = 4;
    const barX = centerX - barWidth / 2;
    const barY = frontY + 4;

    // Red background
    this.ctx.fillStyle = '#882222';
    this.ctx.fillRect(barX, barY, barWidth, barHeight);

    // Green progress fill
    this.ctx.fillStyle = '#44aa44';
    this.ctx.fillRect(barX, barY, barWidth * building.constructionProgress, barHeight);

    // Thin border
    this.ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    this.ctx.lineWidth = 0.5;
    this.ctx.strokeRect(barX, barY, barWidth, barHeight);

    // Dust particle effect
    const now = Date.now();
    const dustCount = 10;
    const cycleDuration = 2200;
    const spreadX = (width + depth) * tileW / 3;
    const baseY = frontY / 2 - building.buildingHeight / 4;

    for (let i = 0; i < dustCount; i++) {
      const seed = i * 137.5;
      const t = ((now + seed * 7) % cycleDuration) / cycleDuration;
      if (t > 0.85) continue;
      const fade = t < 0.15 ? t / 0.15 : 1 - (t / 0.85);
      const px = centerX + Math.sin(seed) * spreadX * (0.3 + 0.7 * Math.sin(seed * 2.3));
      const py = baseY - t * 40 + Math.sin(seed * 3.7) * 8;
      const radius = 3 + t * 6;
      this.ctx.globalAlpha = fade * 0.65;
      this.ctx.fillStyle = '#d4c4a0';
      this.ctx.beginPath();
      this.ctx.arc(px, py, radius, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
  }

  private drawRoadMissingIcon(): void {
    // Isometric road diamond
    const dw = 14;
    const dh = 7;

    this.ctx.beginPath();
    this.ctx.moveTo(0, -dh);
    this.ctx.lineTo(dw, 0);
    this.ctx.lineTo(0, dh);
    this.ctx.lineTo(-dw, 0);
    this.ctx.closePath();
    this.ctx.fillStyle = '#c4a572';
    this.ctx.fill();
    this.ctx.strokeStyle = '#a68a5a';
    this.ctx.lineWidth = 1;
    this.ctx.stroke();

    // X over the road
    this.ctx.beginPath();
    this.ctx.moveTo(-7, -7);
    this.ctx.lineTo(7, 7);
    this.ctx.moveTo(7, -7);
    this.ctx.lineTo(-7, 7);
    this.ctx.strokeStyle = '#ff4444';
    this.ctx.lineWidth = 3;
    this.ctx.stroke();
  }

  public showToast(text: string, screenX: number, screenY: number): void {
    this.toast = { text, x: screenX, y: screenY - 30, startTime: Date.now() };
  }

  private renderToast(): void {
    if (!this.toast) return;

    const elapsed = Date.now() - this.toast.startTime;
    const duration = 1500;
    if (elapsed > duration) {
      this.toast = null;
      return;
    }

    const fadeStart = duration * 0.6;
    const alpha = elapsed > fadeStart ? 1 - (elapsed - fadeStart) / (duration - fadeStart) : 1;
    const rise = elapsed * 0.02;

    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.ctx.font = 'bold 13px monospace';
    this.ctx.textAlign = 'center';

    const tx = this.toast.x;
    const ty = this.toast.y - rise;
    const textWidth = this.ctx.measureText(this.toast.text).width;
    const pad = 10;

    // Background
    this.ctx.fillStyle = 'rgba(40, 40, 40, 0.9)';
    this.ctx.beginPath();
    this.ctx.roundRect(tx - textWidth / 2 - pad, ty - 12, textWidth + pad * 2, 24, 6);
    this.ctx.fill();
    this.ctx.strokeStyle = '#cc3333';
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();

    // Text
    this.ctx.fillStyle = '#ffffff';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(this.toast.text, tx, ty);

    this.ctx.restore();
  }

  private darkenColor(color: string, factor: number): string {
    // Simple color darkening
    const hex = color.replace('#', '');
    const r = Math.floor(parseInt(hex.substr(0, 2), 16) * factor);
    const g = Math.floor(parseInt(hex.substr(2, 2), 16) * factor);
    const b = Math.floor(parseInt(hex.substr(4, 2), 16) * factor);
    return `rgb(${r}, ${g}, ${b})`;
  }

  private updateIdleAnimation(worker: Worker): void {
    const now = Date.now();
    if (worker.idleAnim !== 'none') {
      if (now > worker.idleAnimStart + worker.idleAnimDuration) {
        worker.idleAnim = 'none';
        worker.nextIdleCheck = now + 3000 + Math.random() * 6000;
      }
      return;
    }
    if (now < worker.nextIdleCheck) return;

    const anims: { anim: IdleAnim; duration: number; weight: number }[] = [
      { anim: 'look_around', duration: 1800 + Math.random() * 1200, weight: 4 },
      { anim: 'scratch_head', duration: 1500 + Math.random() * 800, weight: 2 },
      { anim: 'hands_on_hips', duration: 2500 + Math.random() * 2000, weight: 2 },
      { anim: 'stretch', duration: 1200 + Math.random() * 600, weight: 1 },
      { anim: 'read', duration: 3000 + Math.random() * 2000, weight: 1 },
    ];
    const totalWeight = anims.reduce((s, a) => s + a.weight, 0);
    let r = Math.random() * totalWeight;
    for (const entry of anims) {
      r -= entry.weight;
      if (r <= 0) {
        worker.idleAnim = entry.anim;
        worker.idleAnimStart = now;
        worker.idleAnimDuration = entry.duration;
        if (entry.anim === 'look_around') {
          worker.idleFacing = (worker.idleFacing + 1 + Math.floor(Math.random() * 3)) % 4;
        }
        return;
      }
    }
  }

  private renderWorkerSprite(movable: Movable | null, worker: Worker): void {
    let dirX = 0;
    let dirY = 1;
    let isMoving = false;

    if (movable && movable.isMoving) {
      const target = movable.getCurrentTarget();
      if (target) {
        dirX = target.x - movable.segmentStartX;
        dirY = target.y - movable.segmentStartY;
        isMoving = true;
      }
    }

    let facing: number;
    if (isMoving) {
      if (dirX > 0 && dirY >= 0) facing = 0;
      else if (dirX <= 0 && dirY > 0) facing = 1;
      else if (dirX < 0 && dirY <= 0) facing = 2;
      else facing = 3;
      worker.idleAnim = 'none';
      worker.nextIdleCheck = Date.now() + 2000 + Math.random() * 4000;
    } else {
      this.updateIdleAnimation(worker);
      facing = worker.idleFacing;
    }

    const now = Date.now();
    const frame = isMoving ? Math.floor(now / 200) % 4 : 0;
    const s = 2;
    const a = worker.appearance;
    const anim = worker.idleAnim;
    const animT = anim !== 'none' ? (now - worker.idleAnimStart) / worker.idleAnimDuration : 0;

    this.ctx.save();

    const px = (x: number, y: number, w: number, h: number, color: string) => {
      this.ctx.fillStyle = color;
      this.ctx.fillRect(x * s, y * s, w * s, h * s);
    };

    const mirror = facing === 1 || facing === 2;
    const showBack = facing === 2 || facing === 3;
    if (mirror) this.ctx.scale(-1, 1);

    const legOffsets = [[0, 0], [-1, 1], [0, 0], [1, -1]];
    const [leftLeg, rightLeg] = legOffsets[frame];
    const walkArmSwing = isMoving ? (frame === 1 ? 1 : frame === 3 ? -1 : 0) : 0;

    // Shadow
    this.ctx.globalAlpha = 0.2;
    this.ctx.fillStyle = '#000';
    this.ctx.beginPath();
    this.ctx.ellipse(0, 0, 4 * s, 1.5 * s, 0, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.globalAlpha = 1;

    const isDress = a.variant === 'dress';

    if (isDress) {
      px(-1 + leftLeg, -1, 1, 1, a.boots);
      px(1 + rightLeg, -1, 1, 1, a.boots);
      px(-3, -9, 7, 8, a.tunic);
      px(-3, -2, 7, 1, this.darkenColor(a.tunic, 0.8));
      if (!showBack) {
        px(-1, -7, 4, 5, '#d8cbb8');
      }
    } else {
      px(-2 + leftLeg, -2, 2, 2, a.boots);
      px(1 + rightLeg, -2, 2, 2, a.boots);
      px(-2 + leftLeg, -4, 2, 2, a.pants);
      px(1 + rightLeg, -4, 2, 2, a.pants);
      px(-2, -9, 5, 5, a.tunic);
      px(-2, -5, 5, 1, '#2a1f14');
    }

    // Arms — vary by idle animation
    let leftArmY = -8 + walkArmSwing;
    let rightArmY = -8 - walkArmSwing;
    let leftHandY = -5 + walkArmSwing;
    let rightHandY = -5 - walkArmSwing;
    let leftArmX = -4;
    let rightArmX = 3;
    let extraDraw: (() => void) | null = null;

    if (!isMoving) {
      if (anim === 'scratch_head') {
        // Right arm raised to head
        rightArmY = -13;
        rightHandY = -14;
        rightArmX = 2;
        // Slight hand wiggle
        const wiggle = Math.sin(animT * Math.PI * 6) > 0 ? 1 : 0;
        rightHandY += wiggle;
      } else if (anim === 'hands_on_hips') {
        leftArmX = -3;
        rightArmX = 2;
        leftArmY = -7;
        rightArmY = -7;
        leftHandY = -5;
        rightHandY = -5;
      } else if (anim === 'stretch') {
        // Both arms up
        const lift = Math.sin(animT * Math.PI);
        leftArmY = -8 - Math.floor(lift * 5);
        rightArmY = -8 - Math.floor(lift * 5);
        leftHandY = leftArmY - 1;
        rightHandY = rightArmY - 1;
      } else if (anim === 'read') {
        // Both arms in front holding something
        leftArmX = -2;
        rightArmX = 1;
        leftArmY = -7;
        rightArmY = -7;
        leftHandY = -5;
        rightHandY = -5;
        if (!showBack) {
          extraDraw = () => {
            // Little paper/scroll
            px(-1, -8, 4, 3, '#e8dcc8');
            px(-1, -8, 4, 1, '#c8b898');
          };
        }
      }
    }

    // Draw arms
    px(leftArmX, leftArmY, 2, 3, a.tunic);
    px(rightArmX, rightArmY, 2, 3, a.tunic);
    px(leftArmX, leftHandY, 2, 1, a.skin);
    px(rightArmX, rightHandY, 2, 1, a.skin);

    if (extraDraw) extraDraw();

    // Head — look_around shifts head position
    let headShift = 0;
    if (anim === 'look_around') {
      headShift = Math.round(Math.sin(animT * Math.PI * 2) * 1.5);
    }

    if (showBack) {
      if (a.variant === 'hat') {
        px(-2 + headShift, -14, 5, 5, a.hair);
        px(-4 + headShift, -14, 9, 1, '#c8a868');
        px(-3 + headShift, -15, 7, 1, '#c8a868');
        px(-1 + headShift, -16, 3, 1, '#b89858');
      } else if (isDress) {
        px(-2 + headShift, -14, 5, 5, a.hair);
        px(-1 + headShift, -9, 3, 2, a.hair);
      } else {
        px(-2 + headShift, -14, 5, 5, a.hair);
        px(0 + headShift, -15, 1, 1, a.hair);
      }
    } else {
      px(-2 + headShift, -13, 5, 4, a.skin);

      if (a.variant === 'hat') {
        px(-4 + headShift, -14, 9, 1, '#c8a868');
        px(-3 + headShift, -15, 7, 1, '#c8a868');
        px(-1 + headShift, -16, 3, 1, '#b89858');
        px(-3 + headShift, -14, 7, 1, '#7a5a30');
      } else if (isDress) {
        px(-2 + headShift, -15, 5, 3, a.hair);
        px(-3 + headShift, -13, 1, 3, a.hair);
        px(3 + headShift, -13, 1, 3, a.hair);
      } else {
        px(-2 + headShift, -15, 5, 3, a.hair);
        px(-2 + headShift, -13, 5, 1, '#3a2a1a');
      }
      px(1 + headShift, -12, 1, 1, '#1a1008');
    }

    this.ctx.restore();
  }

  private renderCircle(renderable: Renderable): void {
    this.ctx.beginPath();
    this.ctx.arc(0, 0, renderable.size.width / 2, 0, Math.PI * 2);
    this.ctx.fillStyle = renderable.color;
    this.ctx.fill();
    this.ctx.strokeStyle = '#000';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
  }

  private renderRectangle(renderable: Renderable): void {
    const hw = renderable.size.width / 2;
    const hh = renderable.size.height / 2;

    this.ctx.fillStyle = renderable.color;
    this.ctx.fillRect(-hw, -hh, renderable.size.width, renderable.size.height);
    this.ctx.strokeStyle = '#000';
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(-hw, -hh, renderable.size.width, renderable.size.height);
  }

  private renderTriangle(renderable: Renderable): void {
    const size = renderable.size.width;

    this.ctx.beginPath();
    this.ctx.moveTo(0, -size / 2);
    this.ctx.lineTo(size / 2, size / 2);
    this.ctx.lineTo(-size / 2, size / 2);
    this.ctx.closePath();

    this.ctx.fillStyle = renderable.color;
    this.ctx.fill();
    this.ctx.strokeStyle = '#000';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
  }

  // Camera controls
  moveCamera(dx: number, dy: number): void {
    this.camera.x += dx;
    this.camera.y += dy;
  }

  centerOnGrid(gridX: number, gridY: number): void {
    const worldPos = this.iso.gridToScreen(gridX, gridY);
    this.camera.x = this.canvas.width / 2 - worldPos.x * this.camera.zoom;
    this.camera.y = this.canvas.height / 2 - worldPos.y * this.camera.zoom;
  }

  getCamera(): { x: number; y: number; zoom: number } {
    return { ...this.camera };
  }

  setCamera(cam: { x: number; y: number; zoom: number }): void {
    this.camera.x = cam.x;
    this.camera.y = cam.y;
    this.camera.zoom = Math.max(0.5, Math.min(2, cam.zoom));
  }

  getZoom(): number {
    return this.camera.zoom;
  }

  setZoom(zoom: number): void {
    this.camera.zoom = Math.max(0.5, Math.min(2, zoom));
  }

  adjustZoom(zoomDelta: number, screenX: number, screenY: number): void {
    const oldZoom = this.camera.zoom;
    const newZoom = Math.max(0.5, Math.min(2, oldZoom * zoomDelta));

    if (oldZoom === newZoom) return; // No change

    // Get the world position under the cursor before zoom
    const worldX = (screenX - this.camera.x) / oldZoom;
    const worldY = (screenY - this.camera.y) / oldZoom;

    // Update zoom
    this.camera.zoom = newZoom;

    // Adjust camera position so the world point stays under the cursor
    this.camera.x = screenX - worldX * newZoom;
    this.camera.y = screenY - worldY * newZoom;
  }

  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const worldX = (screenX - this.camera.x) / this.camera.zoom;
    const worldY = (screenY - this.camera.y) / this.camera.zoom;
    return this.iso.screenToGrid(worldX, worldY);
  }

  gridToScreen(gridX: number, gridY: number): { x: number; y: number } {
    const worldPos = this.iso.gridToScreen(gridX, gridY);
    return {
      x: worldPos.x * this.camera.zoom + this.camera.x,
      y: worldPos.y * this.camera.zoom + this.camera.y
    };
  }

  // Update tilemap reference (used when loading a saved game)
  updateTileMap(newTileMap: TileMap): void {
    this.tileMap = newTileMap;
    // Reset minimap offscreen canvas
    this.minimapOffscreenCtx.fillStyle = '#1a1a1a';
    this.minimapOffscreenCtx.fillRect(0, 0, 200, 200);
    this.minimapScale = 200 / this.tileMap.width;
  }
}
