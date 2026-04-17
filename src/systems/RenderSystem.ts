/**
 * Render System - handles all rendering to canvas
 */

import { System } from '@/core/System';
import { Entity } from '@/core/Entity';
import { Position } from '@/components/Position';
import { Renderable } from '@/components/Renderable';
import { Building } from '@/components/Building';
import { Worker } from '@/components/Worker';
import { TileMap } from '@/map/TileMap';
import { Isometric } from '@/utils/Isometric';
import { Tile } from '@/map/Tile';

export class RenderSystem extends System {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private iso: Isometric;
  private camera = { x: 0, y: 0, zoom: 1 };
  public buildPreview: { mode: string; gridX: number; gridY: number } | null = null;
  public selectedEntityId: number | null = null;
  public dragPreviewPosition: { x: number; y: number } | null = null;

  // Minimap
  private minimapCanvas: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D;
  private minimapOffscreen: HTMLCanvasElement;
  private minimapOffscreenCtx: CanvasRenderingContext2D;
  private minimapScale: number;
  private minimapNeedsRedraw = true;

  constructor(canvas: HTMLCanvasElement, private tileMap: TileMap) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.iso = new Isometric(64, 32);
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

  update(deltaTime: number): void {
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

    // Sort only visible entities for proper isometric depth sorting
    // Entities further "back" (lower Y+X) draw first, so they appear behind
    const sortedEntities = visibleEntities.sort((a, b) => {
      const posA = a.getComponent(Position)!;
      const posB = b.getComponent(Position)!;
      const buildingA = a.getComponent(Building);
      const buildingB = b.getComponent(Building);

      // For buildings, use the FRONT corner for sorting (back position + size)
      const sortKeyA = posA.y + posA.x + (buildingA ? buildingA.width + buildingA.height : 0);
      const sortKeyB = posB.y + posB.x + (buildingB ? buildingB.width + buildingB.height : 0);

      return sortKeyA - sortKeyB;
    });

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

        // Yellow outline for selection
        this.ctx.strokeStyle = '#ffff00';
        this.ctx.lineWidth = 3;
        this.ctx.stroke();

        // Semi-transparent yellow fill
        this.ctx.fillStyle = 'rgba(255, 255, 0, 0.15)';
        this.ctx.fill();
      }
    }
  }

  private renderBuildPreview(preview: { mode: string; gridX: number; gridY: number }): void {
    const { mode, gridX, gridY } = preview;

    if (mode === 'build_road') {
      // Show road preview
      this.renderRoadPreview(gridX, gridY);
    } else if (mode === 'build_warehouse') {
      // Show warehouse preview (3x3)
      this.renderBuildingPreview(gridX, gridY, 3, 3, 80, '#d4a574');
    } else if (mode === 'build_lumberjack') {
      // Show lumberjack preview (2x2)
      this.renderBuildingPreview(gridX, gridY, 2, 2, 60, '#8b4513');
    }
  }

  private renderRoadPreview(gridX: number, gridY: number): void {
    const corners = this.iso.getTileCorners(gridX, gridY);

    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y);
    corners.forEach(corner => this.ctx.lineTo(corner.x, corner.y));
    this.ctx.closePath();

    // Semi-transparent road preview
    this.ctx.fillStyle = 'rgba(196, 165, 114, 0.7)';
    this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(166, 138, 90, 0.9)';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
  }

  private renderBuildingPreview(gridX: number, gridY: number, width: number, depth: number, height: number, color: string): void {
    // Highlight tiles underneath
    this.highlightTiles(gridX, gridY, width, depth, 'rgba(255, 255, 255, 0.2)');

    // Render semi-transparent building
    const screenPos = this.iso.gridToScreen(gridX, gridY);
    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;

    this.ctx.save();
    this.ctx.globalAlpha = 0.6;
    this.ctx.translate(screenPos.x, screenPos.y - this.iso.tileHeight / 2);

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
    this.ctx.fillStyle = this.darkenColor(color, 0.7);
    this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    // Draw left face
    this.ctx.beginPath();
    this.ctx.moveTo(baseCorners[3].x, baseCorners[3].y);
    this.ctx.lineTo(topCorners[3].x, topCorners[3].y);
    this.ctx.lineTo(topCorners[2].x, topCorners[2].y);
    this.ctx.lineTo(baseCorners[2].x, baseCorners[2].y);
    this.ctx.closePath();
    this.ctx.fillStyle = this.darkenColor(color, 0.5);
    this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    // Draw top face
    this.ctx.beginPath();
    this.ctx.moveTo(topCorners[0].x, topCorners[0].y);
    this.ctx.lineTo(topCorners[1].x, topCorners[1].y);
    this.ctx.lineTo(topCorners[2].x, topCorners[2].y);
    this.ctx.lineTo(topCorners[3].x, topCorners[3].y);
    this.ctx.closePath();
    this.ctx.fillStyle = color;
    this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
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

  private renderTiles(): void {
    // Only render tiles visible in viewport (performance optimization)
    const viewportBounds = this.getViewportBounds();

    for (let y = viewportBounds.minY; y <= viewportBounds.maxY; y++) {
      for (let x = viewportBounds.minX; x <= viewportBounds.maxX; x++) {
        const tile = this.tileMap.getTile(x, y);
        if (tile) {
          this.renderTile(tile);
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

  private renderTile(tile: Tile): void {
    // If not explored, render fog of war
    if (!tile.isExplored()) {
      this.renderFog(tile);
      return;
    }

    // Render terrain based on type
    if (tile.terrain === 'mountain') {
      this.renderMountain(tile);
    } else if (tile.terrain === 'hill') {
      this.renderHill(tile);
    } else if (tile.terrain === 'water') {
      this.renderWater(tile);
    } else if (tile.terrain === 'forest') {
      this.renderForest(tile);
    } else if (tile.terrain === 'tree') {
      this.renderTree(tile);
    } else {
      this.renderGrass(tile);
    }

    // Road overlay - roads are more visible and distinct
    if (tile.hasRoad) {
      const corners = this.iso.getTileCorners(tile.x, tile.y);
      this.ctx.beginPath();
      this.ctx.moveTo(corners[0].x, corners[0].y);
      corners.forEach(corner => this.ctx.lineTo(corner.x, corner.y));
      this.ctx.closePath();

      this.ctx.fillStyle = '#c4a572';
      this.ctx.fill();
      this.ctx.strokeStyle = '#a68a5a';
      this.ctx.lineWidth = 1.5;
      this.ctx.stroke();
    }
  }

  private renderFog(tile: Tile): void {
    const corners = this.iso.getTileCorners(tile.x, tile.y);

    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y);
    corners.forEach(corner => this.ctx.lineTo(corner.x, corner.y));
    this.ctx.closePath();

    // Dark grey fog of war
    this.ctx.fillStyle = '#2a2a2a';
    this.ctx.fill();
    this.ctx.strokeStyle = '#1a1a1a';
    this.ctx.lineWidth = 1;
    this.ctx.stroke();
  }

  private renderGrass(tile: Tile): void {
    const corners = this.iso.getTileCorners(tile.x, tile.y);

    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y);
    corners.forEach(corner => this.ctx.lineTo(corner.x, corner.y));
    this.ctx.closePath();

    // Brighter, more vibrant grass
    this.ctx.fillStyle = '#7cb342';
    this.ctx.fill();
    this.ctx.strokeStyle = '#689f38';
    this.ctx.lineWidth = 1;
    this.ctx.stroke();
  }

  private renderWater(tile: Tile): void {
    const corners = this.iso.getTileCorners(tile.x, tile.y);

    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y);
    corners.forEach(corner => this.ctx.lineTo(corner.x, corner.y));
    this.ctx.closePath();

    // Animated water color
    const time = Date.now() * 0.001;
    const wave = Math.sin(tile.x * 0.5 + tile.y * 0.5 + time) * 0.05 + 0.95;
    const blue = Math.floor(226 * wave);

    this.ctx.fillStyle = `rgb(74, 144, ${blue})`;
    this.ctx.fill();
    this.ctx.strokeStyle = '#3a70b2';
    this.ctx.lineWidth = 1;
    this.ctx.stroke();
  }

  private renderMountain(tile: Tile): void {
    const center = this.iso.gridToScreen(tile.x, tile.y);
    const height = 40;

    // Mountain as a 3D pyramid
    const corners = this.iso.getTileCorners(tile.x, tile.y);
    const peak = { x: center.x, y: center.y - height };

    // Back face (darker)
    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y); // top
    this.ctx.lineTo(peak.x, peak.y); // peak
    this.ctx.lineTo(corners[3].x, corners[3].y); // left
    this.ctx.closePath();
    this.ctx.fillStyle = '#6b5d4f';
    this.ctx.fill();
    this.ctx.strokeStyle = '#4a3f33';
    this.ctx.lineWidth = 1;
    this.ctx.stroke();

    // Right face (lighter)
    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y); // top
    this.ctx.lineTo(peak.x, peak.y); // peak
    this.ctx.lineTo(corners[1].x, corners[1].y); // right
    this.ctx.closePath();
    this.ctx.fillStyle = '#8b7d6f';
    this.ctx.fill();
    this.ctx.strokeStyle = '#6b5d4f';
    this.ctx.lineWidth = 1;
    this.ctx.stroke();

    // Snow cap on peak
    this.ctx.beginPath();
    this.ctx.arc(peak.x, peak.y, 4, 0, Math.PI * 2);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fill();
  }

  private renderHill(tile: Tile): void {
    const center = this.iso.gridToScreen(tile.x, tile.y);
    const height = 20;

    const corners = this.iso.getTileCorners(tile.x, tile.y);
    const peak = { x: center.x, y: center.y - height };

    // Gentle hill
    this.ctx.beginPath();
    this.ctx.moveTo(corners[3].x, corners[3].y); // left
    this.ctx.lineTo(corners[0].x, corners[0].y); // top
    this.ctx.lineTo(peak.x, peak.y); // peak
    this.ctx.closePath();
    this.ctx.fillStyle = '#6a9c4a';
    this.ctx.fill();

    this.ctx.beginPath();
    this.ctx.moveTo(corners[1].x, corners[1].y); // right
    this.ctx.lineTo(corners[0].x, corners[0].y); // top
    this.ctx.lineTo(peak.x, peak.y); // peak
    this.ctx.closePath();
    this.ctx.fillStyle = '#7aac5a';
    this.ctx.fill();

    // Base
    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y);
    corners.forEach(corner => this.ctx.lineTo(corner.x, corner.y));
    this.ctx.closePath();
    this.ctx.strokeStyle = '#5a8c3a';
    this.ctx.lineWidth = 1;
    this.ctx.stroke();
  }

  private renderForest(tile: Tile): void {
    // Dark green forest base
    const corners = this.iso.getTileCorners(tile.x, tile.y);

    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y);
    corners.forEach(corner => this.ctx.lineTo(corner.x, corner.y));
    this.ctx.closePath();

    this.ctx.fillStyle = '#2d5016';
    this.ctx.fill();
    this.ctx.strokeStyle = '#1d4006';
    this.ctx.lineWidth = 1;
    this.ctx.stroke();

    // Add some tree shapes on top
    const center = this.iso.gridToScreen(tile.x, tile.y);
    for (let i = 0; i < 3; i++) {
      const offsetX = (i - 1) * 12;
      const offsetY = Math.sin(i) * 8;
      this.drawSimpleTree(center.x + offsetX, center.y + offsetY, 8);
    }
  }

  private renderTree(tile: Tile): void {
    // Grass base with single tree
    this.renderGrass(tile);

    const center = this.iso.gridToScreen(tile.x, tile.y);
    this.drawSimpleTree(center.x, center.y, 10);
  }

  private drawSimpleTree(x: number, y: number, size: number): void {
    // Tree trunk
    this.ctx.fillStyle = '#5d4037';
    this.ctx.fillRect(x - 2, y, 4, size);

    // Tree canopy (simple triangle)
    this.ctx.beginPath();
    this.ctx.moveTo(x, y - size);
    this.ctx.lineTo(x - size / 2, y);
    this.ctx.lineTo(x + size / 2, y);
    this.ctx.closePath();
    this.ctx.fillStyle = '#2d5016';
    this.ctx.fill();
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

    // Apply fade effect for selected buildings
    if (isSelected && building) {
      this.ctx.globalAlpha = 0.7;
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

    // Render buildings as isometric 3D boxes
    if (building) {
      // Special rendering for base camp (pyramid)
      if (building.buildingType === 'base_camp') {
        this.renderBaseCampPyramid(building, renderable, isSelected);
      } else {
        this.renderIsometricBuilding(building, renderable, isSelected);
      }
    } else {
      // Render non-building entities with their normal shapes
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

    // Debug: render worker state
    if (entity.hasComponent(Worker)) {
      const worker = entity.getComponent(Worker)!;
      this.ctx.fillStyle = 'white';
      this.ctx.font = '10px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(worker.state, 0, -40);

      if (worker.carryingResource) {
        this.ctx.fillText(`[${worker.carryingResource}]`, 0, -30);
      }
    }

    // Debug: render building type
    if (building) {
      this.ctx.fillStyle = 'white';
      this.ctx.font = '10px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(building.buildingType, 0, -building.height - 10);
    }

    this.ctx.restore();
  }

  private renderBaseCampPyramid(building: Building, renderable: Renderable, isSelected: boolean = false): void {
    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;

    // Building dimensions
    const width = building.width;
    const depth = building.height;
    const height = building.buildingHeight;

    // Calculate the center of the base
    const baseCenter = {
      x: (width * tileW / 2 - depth * tileW / 2) / 2,
      y: (width * tileH / 2 + depth * tileH / 2) / 2
    };

    // Peak of the pyramid
    const peak = { x: baseCenter.x, y: baseCenter.y - height };

    // Base corners
    const baseCorners = [
      { x: 0, y: 0 },                                           // Back (top)
      { x: width * tileW / 2, y: width * tileH / 2 },          // Right
      { x: (width - depth) * tileW / 2, y: (width + depth) * tileH / 2 }, // Front (bottom)
      { x: -depth * tileW / 2, y: depth * tileH / 2 }          // Left
    ];

    // Back face (darkest - dark red)
    this.ctx.beginPath();
    this.ctx.moveTo(baseCorners[0].x, baseCorners[0].y); // back
    this.ctx.lineTo(peak.x, peak.y); // peak
    this.ctx.lineTo(baseCorners[3].x, baseCorners[3].y); // left
    this.ctx.closePath();
    this.ctx.fillStyle = '#5a0a0a';
    this.ctx.fill();
    this.ctx.strokeStyle = '#3a0000';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    // Right face (medium red)
    this.ctx.beginPath();
    this.ctx.moveTo(baseCorners[0].x, baseCorners[0].y); // back
    this.ctx.lineTo(peak.x, peak.y); // peak
    this.ctx.lineTo(baseCorners[1].x, baseCorners[1].y); // right
    this.ctx.closePath();
    this.ctx.fillStyle = '#8b1a1a';
    this.ctx.fill();
    this.ctx.strokeStyle = '#6b0000';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    // Left face (lighter red)
    this.ctx.beginPath();
    this.ctx.moveTo(baseCorners[3].x, baseCorners[3].y); // left
    this.ctx.lineTo(peak.x, peak.y); // peak
    this.ctx.lineTo(baseCorners[2].x, baseCorners[2].y); // front
    this.ctx.closePath();
    this.ctx.fillStyle = '#a52a2a';
    this.ctx.fill();
    this.ctx.strokeStyle = '#8b0000';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    // Front face (lightest red)
    this.ctx.beginPath();
    this.ctx.moveTo(baseCorners[1].x, baseCorners[1].y); // right
    this.ctx.lineTo(peak.x, peak.y); // peak
    this.ctx.lineTo(baseCorners[2].x, baseCorners[2].y); // front
    this.ctx.closePath();
    this.ctx.fillStyle = '#cd5c5c';
    this.ctx.fill();
    this.ctx.strokeStyle = '#a52a2a';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    // Cap at peak (golden)
    this.ctx.beginPath();
    this.ctx.arc(peak.x, peak.y, 6, 0, Math.PI * 2);
    this.ctx.fillStyle = '#ffd700';
    this.ctx.fill();
    this.ctx.strokeStyle = '#daa520';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();

    // Glow effect if selected
    if (isSelected) {
      this.ctx.strokeStyle = '#ffff00';
      this.ctx.lineWidth = 4;
      this.ctx.beginPath();
      baseCorners.forEach((corner, i) => {
        if (i === 0) {
          this.ctx.moveTo(corner.x, corner.y);
        } else {
          this.ctx.lineTo(corner.x, corner.y);
        }
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

    // Thicker yellow stroke if selected
    if (isSelected) {
      this.ctx.strokeStyle = '#ffff00';
      this.ctx.lineWidth = 3;
    } else {
      this.ctx.strokeStyle = '#000';
      this.ctx.lineWidth = 1.5;
    }
    this.ctx.stroke();
  }

  private darkenColor(color: string, factor: number): string {
    // Simple color darkening
    const hex = color.replace('#', '');
    const r = Math.floor(parseInt(hex.substr(0, 2), 16) * factor);
    const g = Math.floor(parseInt(hex.substr(2, 2), 16) * factor);
    const b = Math.floor(parseInt(hex.substr(4, 2), 16) * factor);
    return `rgb(${r}, ${g}, ${b})`;
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

  // Update tilemap reference (used when loading a saved game)
  updateTileMap(newTileMap: TileMap): void {
    this.tileMap = newTileMap;
    // Reset minimap offscreen canvas
    this.minimapOffscreenCtx.fillStyle = '#1a1a1a';
    this.minimapOffscreenCtx.fillRect(0, 0, 200, 200);
    this.minimapScale = 200 / this.tileMap.width;
  }
}
