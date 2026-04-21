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
import { BuildingType } from '@/types/GameData';
import { TerrainTextures } from '@/rendering/TerrainTextures';
import { transportManager } from '@/economics/TransportManager';

/** World-space half-plane clip for long straight iso shores (same screen row / column of tile centers). */
type FlatShoreCut =
  | { axis: 'horizontal'; worldY: number; grassHalf: 'upper' | 'lower' }
  | { axis: 'vertical'; worldX: number; grassHalf: 'left' | 'right' };

const FLAT_SHORE_CLIP_EXTENT = 1_000_000;

// Construction phase sprites per building type (excluding the completed sprite).
// During build, total frames = stages.length + 1 (the completed sprite is the last frame).
const CONSTRUCTION_SPRITES: Record<string, string[]> = {
  storehouse: [
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
  fisher: [
    '/assets/buildings/fisher_build_0.png',
    '/assets/buildings/fisher_build_1.png',
    '/assets/buildings/fisher_build_2.png',
  ],
  well: [
    '/assets/buildings/well_build_0.png',
  ],
  // Stage 1 = site, 2 = frame, 3 = partial walls/roof; completed sprite is house.png (stage 4).
  house: [
    '/assets/buildings/house_build_0.png',
    '/assets/buildings/house_build_1.png',
    '/assets/buildings/house_build_2.png',
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
  public showBuildingLabels = true;
  private toast: { text: string; x: number; y: number; startTime: number } | null = null;
  private fishJumps: Array<{ x: number; y: number; startTime: number }> = [];
  private nextFishSpawn: number = 0;
  private eraseSmokePuffs: Array<{ gx: number; gy: number; start: number }> = [];

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

    // Minimap click & drag navigation
    this.setupMinimapInteraction();

    // Center camera on map
    this.centerCamera();

    // Preload all known building sprites (completed + construction phases)
    const allSprites = [
      '/assets/buildings/base_camp.png',
      '/assets/buildings/warehouse.png', // used for storehouse
      '/assets/buildings/lumberjack.png',
      '/assets/buildings/sawmill.png',
      '/assets/buildings/quarry.png',
      '/assets/buildings/farm.png',
      '/assets/buildings/house.png',
    ];
    for (const stages of Object.values(CONSTRUCTION_SPRITES)) {
      allSprites.push(...stages);
    }
    this.preloadSprites(allSprites);

    // Preload all known resource sprites (for production bubbles)
    this.preloadSprites([
      '/assets/resources/wood_log.png',
      '/assets/resources/wood_plank.png',
      '/assets/resources/stone.png',
      '/assets/resources/coal.png',
      '/assets/resources/iron_ore.png',
      '/assets/resources/gold_ore.png',
      '/assets/resources/granite.png',
      '/assets/resources/iron_bar.png',
      '/assets/resources/gold_coin.png',
      '/assets/resources/grain.png',
      '/assets/resources/flour.png',
      '/assets/resources/bread.png',
      '/assets/resources/water.png',
      '/assets/resources/fish.png',
      '/assets/resources/meat.png',
      '/assets/resources/ham.png',
      '/assets/resources/beer.png',
      '/assets/resources/hammer.png',
      '/assets/resources/axe.png',
      '/assets/resources/saw.png',
      '/assets/resources/pickaxe.png',
      '/assets/resources/shovel.png',
      '/assets/resources/fishing_rod.png',
      '/assets/resources/scythe.png',
      '/assets/resources/rolling_pin.png',
      '/assets/resources/crucible.png',
      '/assets/resources/tongs.png',
      '/assets/resources/cleaver.png',
      '/assets/resources/sword.png',
      '/assets/resources/shield.png',
      '/assets/resources/bow.png',
    ]);

    // Preload terrain sprites
    this.preloadSprites([
      '/assets/terrain/tree_single.png',
      '/assets/terrain/tree_forest.png',
      '/assets/terrain/rock_single_0.png',
      '/assets/terrain/rock_single_1.png',
      '/assets/terrain/rock_single_2.png',
      '/assets/terrain/mountain.png',
    ]);
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

  private setupMinimapInteraction(): void {
    let dragging = false;

    const navigateToMinimapPos = (e: MouseEvent) => {
      const rect = this.minimapCanvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      const scale = 200 / this.tileMap.width;
      const targetGridX = clickX / scale;
      const targetGridY = clickY / scale;

      const currentCenter = this.screenToWorld(this.canvas.width / 2, this.canvas.height / 2);
      const deltaX = targetGridX - currentCenter.x;
      const deltaY = targetGridY - currentCenter.y;

      const deltaWorld = this.iso.gridToScreen(deltaX, deltaY);
      const origin = this.iso.gridToScreen(0, 0);
      this.camera.x -= (deltaWorld.x - origin.x) * this.camera.zoom;
      this.camera.y -= (deltaWorld.y - origin.y) * this.camera.zoom;
    };

    this.minimapCanvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      navigateToMinimapPos(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      navigateToMinimapPos(e);
    });

    window.addEventListener('mouseup', () => {
      dragging = false;
    });
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
    this.renderFishJumps();

    // Get viewport bounds for entity culling
    const viewportBounds = this.getViewportBounds();

    // Filter entities to only those in or near viewport
    const visibleEntities = this.entities.filter(entity => {
      const pos = entity.getComponent(Position);
      if (!pos) return false;

      const building = entity.getComponent(Building);
      const width = building ? building.width : 1;
      const height = building ? building.height : 1;

      return pos.x + width >= viewportBounds.minX &&
             pos.x <= viewportBounds.maxX &&
             pos.y + height >= viewportBounds.minY &&
             pos.y <= viewportBounds.maxY;
    });

    // Sort entities by depth
    const sortedEntities = visibleEntities.sort((a, b) => {
      const posA = a.getComponent(Position)!;
      const posB = b.getComponent(Position)!;
      const buildingA = a.getComponent(Building);
      const buildingB = b.getComponent(Building);

      const depthA = posA.y + posA.x + (buildingA ? buildingA.width + buildingA.height - 2 : 0);
      const depthB = posB.y + posB.x + (buildingB ? buildingB.width + buildingB.height - 2 : 0);

      if (depthA !== depthB) return depthA - depthB;
      if (buildingA && !buildingB) return -1;
      if (!buildingA && buildingB) return 1;
      return 0;
    });

    // Render road stub for disconnected buildings (before depth-sorted pass)
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
      const entranceCenter = this.iso.gridToScreen(ex, ey);
      this.terrainTextures.drawRoad(this.ctx, 4, entranceCenter.x, entranceCenter.y);
      const outCenter = this.iso.gridToScreen(outX, outY);
      this.terrainTextures.drawRoad(this.ctx, 1, outCenter.x, outCenter.y);
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

    // Render junction items on road tiles
    this.renderJunctionItems(viewportBounds);

    // Depth-sorted rendering: interleave trees, mountains, and entities
    this.renderDepthSorted(sortedEntities, viewportBounds);

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

    this.renderEraseSmokeEffects();

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

    if (mode === 'erase') {
      this.renderErasePreview(gridX, gridY);
      return;
    }

    const buildingType = mode.replace('build_', '');
    const buildingDef = dataManager.getBuilding(buildingType as any);
    if (!buildingDef) return;

    const { size, visual } = buildingDef;
    const spritePath = `/assets/buildings/${buildingType}.png`;
    const sprite = this.loadSprite(spritePath);

    if (sprite) {
      this.renderSpritePreview(gridX, gridY, size.width, size.height, sprite, buildingType);
    } else {
      this.renderBuildingPreview(gridX, gridY, size.width, size.height, visual.buildingHeight, visual.color);
    }
  }

  private renderSpritePreview(
    gridX: number,
    gridY: number,
    width: number,
    depth: number,
    sprite: HTMLImageElement,
    buildingType?: string,
  ): void {
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
    const extra = this.getBuildingSpriteVisualScale(buildingType ?? '');
    const drawW = sprite.naturalWidth * scale * extra;
    const drawH = sprite.naturalHeight * scale * extra;
    const centerX = (width - depth) * tileW / 4;
    const frontY = (width + depth) * tileH / 2;

    this.ctx.drawImage(sprite, centerX - drawW / 2, frontY - drawH, drawW, drawH);
    this.ctx.restore();
  }

  public spawnEraseSmoke(gridX: number, gridY: number): void {
    this.eraseSmokePuffs.push({ gx: gridX, gy: gridY, start: performance.now() });
  }

  private findBuildingAtGrid(gx: number, gy: number): Entity | null {
    const hit = this.entities.find(entity => {
      const pos = entity.getComponent(Position);
      const building = entity.getComponent(Building);
      if (!pos || !building) return false;
      return gx >= pos.x && gx < pos.x + building.width &&
             gy >= pos.y && gy < pos.y + building.height;
    });
    return hit ?? null;
  }

  private renderErasePreview(gridX: number, gridY: number): void {
    const tile = this.tileMap.getTile(gridX, gridY);
    if (!tile || !tile.isExplored()) {
      this.strokeEraseTile(gridX, gridY, false);
      return;
    }

    const entity = this.findBuildingAtGrid(gridX, gridY);
    if (entity) {
      const building = entity.getComponent(Building);
      const pos = entity.getComponent(Position);
      const def = building ? dataManager.getBuilding(building.buildingType) : null;
      if (def?.isHeadquarters || !building || !pos) {
        this.strokeEraseTile(gridX, gridY, false);
        return;
      }
      this.highlightTiles(pos.x, pos.y, building.width, building.height, 'rgba(220, 70, 70, 0.38)');
      return;
    }

    const canErase =
      (tile.hasRoad && !tile.isOccupied()) ||
      tile.terrain === 'tree' ||
      tile.terrain === 'forest';
    this.strokeEraseTile(gridX, gridY, canErase);
  }

  private strokeEraseTile(gridX: number, gridY: number, valid: boolean): void {
    const corners = this.iso.getTileCorners(gridX, gridY);
    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y);
    corners.forEach(c => this.ctx.lineTo(c.x, c.y));
    this.ctx.closePath();
    if (valid) {
      this.ctx.fillStyle = 'rgba(230, 80, 80, 0.35)';
      this.ctx.fill();
      this.ctx.strokeStyle = 'rgba(255, 140, 120, 0.95)';
    } else {
      this.ctx.fillStyle = 'rgba(80, 40, 40, 0.25)';
      this.ctx.fill();
      this.ctx.strokeStyle = 'rgba(120, 80, 80, 0.6)';
    }
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
  }

  private renderEraseSmokeEffects(): void {
    const now = performance.now();
    const lifeMs = 480;
    const risePx = 40;
    this.eraseSmokePuffs = this.eraseSmokePuffs.filter(p => now - p.start < lifeMs);

    for (const p of this.eraseSmokePuffs) {
      const t = (now - p.start) / lifeMs;
      const ease = 1 - (1 - t) * (1 - t);
      const base = this.iso.gridToScreen(p.gx, p.gy);
      const lift = risePx * ease;
      const puffAlpha = (1 - t) * 0.65;

      this.ctx.save();
      this.ctx.globalAlpha = puffAlpha;
      const offsets = [-7, 0, 7];
      for (let i = 0; i < offsets.length; i++) {
        const ox = offsets[i];
        const radius = 4 + t * 4 + (i === 1 ? 1 : 0);
        this.ctx.fillStyle = i === 1 ? 'rgba(85, 85, 90, 0.95)' : 'rgba(110, 105, 100, 0.75)';
        this.ctx.beginPath();
        this.ctx.arc(base.x + ox, base.y - lift - t * 8, radius, 0, Math.PI * 2);
        this.ctx.fill();
      }
      this.ctx.restore();
    }
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

  private tileHash(x: number, y: number, salt: number = 0): number {
    let h = x * 374761393 + y * 668265263 + salt * 1274126177;
    h = ((h ^ (h >> 13)) * 1274126177) >>> 0;
    return h / 4294967296;
  }

  private findMountainBlocks(
    viewportBounds: { minX: number; maxX: number; minY: number; maxY: number }
  ): { blocks: { x: number; y: number }[]; covered: Set<string> } {
    const blocks: { x: number; y: number }[] = [];
    const covered = new Set<string>();
    const blockSize = 4;

    // Align scan to fixed grid so blocks don't shift when panning
    const startY = Math.floor(viewportBounds.minY / blockSize) * blockSize;
    const startX = Math.floor(viewportBounds.minX / blockSize) * blockSize;

    for (let y = startY; y <= viewportBounds.maxY - blockSize + 1; y += blockSize) {
      for (let x = startX; x <= viewportBounds.maxX - blockSize + 1; x += blockSize) {
        let allMountain = true;
        for (let dy = 0; dy < blockSize && allMountain; dy++) {
          for (let dx = 0; dx < blockSize && allMountain; dx++) {
            const tile = this.tileMap.getTile(x + dx, y + dy);
            if (!tile || tile.terrain !== 'mountain') allMountain = false;
          }
        }
        if (allMountain) {
          blocks.push({ x, y });
          for (let dy = 0; dy < blockSize; dy++) {
            for (let dx = 0; dx < blockSize; dx++) {
              covered.add(`${x + dx},${y + dy}`);
            }
          }
        }
      }
    }
    return { blocks, covered };
  }

  private renderMountainBlock(blockX: number, blockY: number): void {
    const sprite = this.loadSprite('/assets/terrain/mountain.png');
    if (!sprite || sprite.naturalWidth === 0) return;

    const blockSize = 4;
    const centerX = blockX + blockSize / 2;
    const centerY = blockY + blockSize / 2;
    const screen = this.iso.gridToScreen(centerX, centerY);

    const footprintW = (blockSize + blockSize) * 32;
    const drawW = footprintW;
    const drawH = (sprite.naturalHeight / sprite.naturalWidth) * drawW;

    this.ctx.drawImage(sprite, screen.x - drawW / 2, screen.y - drawH + this.iso.tileHeight * 0.5, drawW, drawH);
  }

  private renderDepthSorted(
    sortedEntities: Entity[],
    viewportBounds: { minX: number; maxX: number; minY: number; maxY: number }
  ): void {
    const minDepth = viewportBounds.minX + viewportBounds.minY;
    const maxDepth = viewportBounds.maxX + viewportBounds.maxY;

    const { blocks: mountainBlocks, covered: mountainCovered } = this.findMountainBlocks(viewportBounds);

    // Index mountain blocks by their back-corner depth for correct draw order
    const blocksByDepth = new Map<number, { x: number; y: number }[]>();
    for (const block of mountainBlocks) {
      const depth = block.x + block.y + 6;
      const list = blocksByDepth.get(depth);
      if (list) list.push(block);
      else blocksByDepth.set(depth, [block]);
    }

    // Index entities by integer depth
    const entitiesByDepth = new Map<number, Entity[]>();
    for (const entity of sortedEntities) {
      const pos = entity.getComponent(Position)!;
      const building = entity.getComponent(Building);
      const depth = Math.round(pos.y + pos.x + (building ? building.width + building.height - 2 : 0));
      const list = entitiesByDepth.get(depth);
      if (list) {
        list.push(entity);
      } else {
        entitiesByDepth.set(depth, [entity]);
      }
    }

    for (let d = minDepth; d <= maxDepth; d++) {
      const xMin = Math.max(viewportBounds.minX, d - viewportBounds.maxY);
      const xMax = Math.min(viewportBounds.maxX, d - viewportBounds.minY);

      // Mountains at this depth (single rocks only, skip covered tiles)
      for (let x = xMin; x <= xMax; x++) {
        const y = d - x;
        const tile = this.tileMap.getTile(x, y);
        if (!tile || !tile.isExplored() || tile.terrain !== 'mountain') continue;
        if (mountainCovered.has(`${x},${y}`)) continue;
        this.renderMountainTile(x, y);
      }

      // Mountain blocks at this depth
      const blocksAtDepth = blocksByDepth.get(d);
      if (blocksAtDepth) {
        for (const block of blocksAtDepth) {
          this.renderMountainBlock(block.x, block.y);
        }
      }

      // Trees at this depth
      for (let x = xMin; x <= xMax; x++) {
        const y = d - x;
        const tile = this.tileMap.getTile(x, y);
        if (!tile || !tile.isExplored()) continue;
        if (tile.terrain !== 'tree' && tile.terrain !== 'forest') continue;
        if (tile.isOccupied() || tile.hasRoad) continue;

        const center = this.iso.gridToScreen(x, y);
        const flatGrass = this.getGrassFlatShoreCut(x, y);
        if (flatGrass) this.ctx.save();
        if (flatGrass) this.applyFlatShoreGrassClip(flatGrass);
        if (tile.terrain === 'tree') {
          this.renderSingleTree(center.x, center.y, x, y);
        } else {
          this.renderForestCluster(center.x, center.y, x, y);
        }
        if (flatGrass) this.ctx.restore();
      }

      // Entities at this depth
      const entities = entitiesByDepth.get(d);
      if (entities) {
        for (const entity of entities) {
          this.renderEntity(entity);
        }
      }
    }
  }

  private getMountainHeight(tileX: number, tileY: number): number {
    const neighbors = this.tileMap.getNeighbors(tileX, tileY);
    const mountainNeighbors = neighbors.filter(t => t.terrain === 'mountain').length;
    if (mountainNeighbors <= 1) return 10;
    if (mountainNeighbors <= 3) return 16;
    return 22 + mountainNeighbors * 2;
  }

  private renderMountainTile(tileX: number, tileY: number): void {
    const ctx = this.ctx;
    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;
    const center = this.iso.gridToScreen(tileX, tileY);
    const cx = center.x;
    const cy = center.y;
    const h = this.getMountainHeight(tileX, tileY);
    const shade = this.tileHash(tileX, tileY, 100);

    const variant = Math.floor(this.tileHash(tileX, tileY, 110) * 3);
    const spritePath = `/assets/terrain/rock_single_${variant}.png`;
    const sprite = this.loadSprite(spritePath);
    if (sprite && sprite.naturalWidth > 0) {
      const scale = 1.6;
      const drawW = tileW * scale;
      const drawH = (sprite.naturalHeight / sprite.naturalWidth) * drawW;
      ctx.drawImage(sprite, cx - drawW / 2, cy - drawH / 2 - tileH * 0.15, drawW, drawH);
      return;
    }

    const radiusX = tileW * 0.4 + shade * 4;
    const radiusY = tileH * 0.35;

    // Shadow at base
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(cx + 2, cy + 2, radiusX, radiusY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Base color
    const baseR = 120 + shade * 30;
    const baseG = 115 + shade * 25;
    const baseB = 105 + shade * 20;

    // Bottom half (darker, the underside visible part)
    ctx.beginPath();
    ctx.ellipse(cx, cy, radiusX, radiusY, 0, 0, Math.PI);
    ctx.closePath();
    ctx.fillStyle = `rgb(${baseR * 0.65}, ${baseG * 0.62}, ${baseB * 0.58})`;
    ctx.fill();

    // Main boulder body — full ellipse shifted up for dome effect
    ctx.beginPath();
    ctx.ellipse(cx, cy - h * 0.25, radiusX, radiusY + h * 0.5, 0, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = `rgb(${baseR * 0.78}, ${baseG * 0.75}, ${baseB * 0.7})`;
    ctx.fill();

    // Upper dome highlight (lighter, top-left lit)
    ctx.beginPath();
    ctx.ellipse(cx - radiusX * 0.1, cy - h * 0.45, radiusX * 0.85, radiusY + h * 0.3, 0, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = `rgb(${baseR * 0.88}, ${baseG * 0.85}, ${baseB * 0.82})`;
    ctx.fill();

    // Top highlight (bright spot, top-left lighting)
    ctx.beginPath();
    ctx.ellipse(cx - radiusX * 0.2, cy - h * 0.55, radiusX * 0.5, (radiusY + h * 0.15) * 0.6, 0, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = `rgb(${Math.min(255, baseR + 25)}, ${Math.min(255, baseG + 22)}, ${Math.min(255, baseB + 18)})`;
    ctx.fill();

    // Cracks / rocky texture details
    const detailCount = h > 14 ? 4 : 2;
    for (let i = 0; i < detailCount; i++) {
      const dx = (this.tileHash(tileX, tileY, 110 + i) - 0.5) * radiusX * 1.2;
      const dy = (this.tileHash(tileX, tileY, 120 + i) - 0.5) * radiusY * 0.8;
      const dSize = 1.5 + this.tileHash(tileX, tileY, 130 + i) * 3;
      ctx.fillStyle = `rgba(60, 55, 48, ${0.15 + this.tileHash(tileX, tileY, 140 + i) * 0.2})`;
      ctx.beginPath();
      ctx.ellipse(cx + dx, cy - h * 0.3 + dy, dSize, dSize * 0.5, this.tileHash(tileX, tileY, 150 + i) * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private renderSingleTree(cx: number, cy: number, tileX: number, tileY: number): void {
    const sprite = this.loadSprite('/assets/terrain/tree_single.png');
    if (sprite && sprite.naturalWidth > 0) {
      const count = 1 + Math.floor(this.tileHash(tileX, tileY, 1) * 3);
      const tileW = this.iso.tileWidth;
      const tileH = this.iso.tileHeight;
      for (let i = 0; i < count; i++) {
        const ox = (this.tileHash(tileX, tileY, 10 + i) - 0.5) * tileW * 0.35;
        const oy = (this.tileHash(tileX, tileY, 20 + i) - 0.5) * tileH * 0.35;
        const s = 0.28 + this.tileHash(tileX, tileY, 30 + i) * 0.12;
        this.renderTreeSprite(cx + ox, cy + oy, sprite, s);
      }
      return;
    }

    const h = this.tileHash(tileX, tileY, 1);
    const scale = 1.8 + h * 0.6;
    const offsetX = (this.tileHash(tileX, tileY, 2) - 0.5) * 6;
    const offsetY = (this.tileHash(tileX, tileY, 3) - 0.5) * 3;
    this.renderTreePlaceholder(cx + offsetX, cy + offsetY, scale, h);
  }

  private renderForestCluster(cx: number, cy: number, tileX: number, tileY: number): void {
    const sprite = this.loadSprite('/assets/terrain/tree_single.png');
    if (sprite && sprite.naturalWidth > 0) {
      const count = 3 + Math.floor(this.tileHash(tileX, tileY, 10) * 3);
      const tileW = this.iso.tileWidth;
      const tileH = this.iso.tileHeight;
      for (let i = 0; i < count; i++) {
        const ox = (this.tileHash(tileX, tileY, 60 + i) - 0.5) * tileW * 0.4;
        const oy = (this.tileHash(tileX, tileY, 70 + i) - 0.5) * tileH * 0.4;
        const s = 0.25 + this.tileHash(tileX, tileY, 80 + i) * 0.15;
        this.renderTreeSprite(cx + ox, cy + oy, sprite, s);
      }
      return;
    }

    const count = 2 + Math.floor(this.tileHash(tileX, tileY, 10) * 3);
    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;

    for (let i = 0; i < count; i++) {
      const fx = this.tileHash(tileX, tileY, 20 + i) - 0.5;
      const fy = this.tileHash(tileX, tileY, 30 + i) - 0.5;
      const r = 0.35;
      const ox = fx * tileW * r;
      const oy = fy * tileH * r;
      const scale = 1.1 + this.tileHash(tileX, tileY, 40 + i) * 0.7;
      const shade = this.tileHash(tileX, tileY, 50 + i);
      this.renderTreePlaceholder(cx + ox, cy + oy, scale, shade);
    }
  }

  private renderTreeSprite(cx: number, cy: number, sprite: HTMLImageElement, scale: number): void {
    const drawW = this.iso.tileWidth * scale;
    const drawH = (sprite.naturalHeight / sprite.naturalWidth) * drawW;
    this.ctx.drawImage(sprite, cx - drawW / 2, cy - drawH + this.iso.tileHeight / 2, drawW, drawH);
  }

  private renderTreePlaceholder(x: number, y: number, scale: number, shade: number): void {
    const ctx = this.ctx;
    const s = scale;

    // Shadow
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(x, y, 5 * s, 2.5 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Trunk
    ctx.fillStyle = shade > 0.5 ? '#5d4037' : '#4e342e';
    ctx.fillRect(x - 1.5 * s, y - 10 * s, 3 * s, 10 * s);

    // Canopy: three stacked triangle layers
    const greens = shade > 0.5
      ? ['#1b5e20', '#2e7d32', '#388e3c']
      : ['#194d19', '#256b25', '#2e8b2e'];

    for (let i = 0; i < 3; i++) {
      const layerBottom = y - (8 + i * 6) * s;
      const layerTop = layerBottom - 10 * s;
      const layerW = (14 - i * 3) * s;

      ctx.fillStyle = greens[i];
      ctx.beginPath();
      ctx.moveTo(x, layerTop);
      ctx.lineTo(x - layerW / 2, layerBottom);
      ctx.lineTo(x + layerW / 2, layerBottom);
      ctx.closePath();
      ctx.fill();
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

  /** Diamond-adjacent water neighbors only (bits NW, NE, SE, SW); used for shore autotile + straight-run detection. */
  private getWaterCardinalsMask(x: number, y: number): number {
    let mask = 0;
    const nw = this.tileMap.getTile(x - 1, y);
    if (nw?.terrain === 'water') mask |= 1;
    const ne = this.tileMap.getTile(x, y - 1);
    if (ne?.terrain === 'water') mask |= 2;
    const se = this.tileMap.getTile(x + 1, y);
    if (se?.terrain === 'water') mask |= 4;
    const sw = this.tileMap.getTile(x, y + 1);
    if (sw?.terrain === 'water') mask |= 8;
    return mask;
  }

  private getWaterConfig(x: number, y: number): number {
    let config = this.getWaterCardinalsMask(x, y);
    if ((config & 3) === 3) {
      const d = this.tileMap.getTile(x - 1, y - 1);
      if (d?.terrain === 'water') config |= 16;
    }
    if ((config & 6) === 6) {
      const d = this.tileMap.getTile(x + 1, y - 1);
      if (d?.terrain === 'water') config |= 32;
    }
    if ((config & 12) === 12) {
      const d = this.tileMap.getTile(x + 1, y + 1);
      if (d?.terrain === 'water') config |= 64;
    }
    if ((config & 9) === 9) {
      const d = this.tileMap.getTile(x - 1, y + 1);
      if (d?.terrain === 'water') config |= 128;
    }
    return config;
  }

  /** Count set bits in the low nibble (0–4). */
  private popcountNibble(n: number): number {
    let v = n & 0xF;
    let c = 0;
    while (v) {
      v &= v - 1;
      c++;
    }
    return c;
  }

  /** Longest chain of water tiles from (x,y) along given steps sharing the same cardinal water mask. */
  private waterMaskRunLength(
    x: number, y: number, card: number, dirs: readonly (readonly [number, number])[], maxSpan: number = 48
  ): number {
    let best = 1;
    for (const [dx, dy] of dirs) {
      let len = 1;
      for (let k = 1; k < maxSpan; k++) {
        const t = this.tileMap.getTile(x + dx * k, y + dy * k);
        if (!t || t.terrain !== 'water') break;
        if (this.getWaterCardinalsMask(x + dx * k, y + dy * k) !== card) break;
        len++;
      }
      for (let k = 1; k < maxSpan; k++) {
        const t = this.tileMap.getTile(x - dx * k, y - dy * k);
        if (!t || t.terrain !== 'water') break;
        if (this.getWaterCardinalsMask(x - dx * k, y - dy * k) !== card) break;
        len++;
      }
      best = Math.max(best, len);
    }
    return best;
  }

  /**
   * Two or more water tiles in a row along grid x or y share the same shore neighbor mask:
   * use linearized shore SDF so the edge reads as one continuous line instead of a stair-step.
   *
   * Only applies when exactly one diamond neighbor is land (three are water): flat shores.
   * Skips tiles with two+ land sides (bays/corners need corner rounding) and tiles with four
   * water neighbors (diagonal land / inner curves use the normal SDF).
   */
  private getWaterShoreLinearized(x: number, y: number): boolean {
    const cfg = this.getWaterConfig(x, y);
    if (cfg === 255) return false;
    const card = cfg & 0xF;
    if (this.popcountNibble(card) !== 3) return false;
    const axisSteps = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    return this.waterMaskRunLength(x, y, card, axisSteps) >= 2;
  }

  /**
   * Straight world-space boundary between this water tile and its single land neighbor,
   * when water forms a diagonal run in grid ((1,-1) steps) or ((1,1)) matching constant
   * screen Y or X — removes W-shaped zigzag along those shores.
   */
  private tryWaterFlatShoreCut(wx: number, wy: number): FlatShoreCut | null {
    const cfg = this.getWaterConfig(wx, wy);
    if (cfg === 255) return null;
    const card = cfg & 0xF;
    if (this.popcountNibble(card) !== 3) return null;
    const landMask = (~card) & 0xF;
    const diagHR = [[1, -1], [-1, 1]] as const;
    const diagVR = [[1, 1], [-1, -1]] as const;

    if (landMask === 2) {
      if (this.waterMaskRunLength(wx, wy, card, diagHR) < 2) return null;
      const w = this.iso.gridToScreen(wx, wy);
      const l = this.iso.gridToScreen(wx, wy - 1);
      return { axis: 'horizontal', worldY: (w.y + l.y) * 0.5, grassHalf: 'upper' };
    }
    if (landMask === 8) {
      if (this.waterMaskRunLength(wx, wy, card, diagHR) < 2) return null;
      const w = this.iso.gridToScreen(wx, wy);
      const l = this.iso.gridToScreen(wx, wy + 1);
      return { axis: 'horizontal', worldY: (w.y + l.y) * 0.5, grassHalf: 'lower' };
    }
    if (landMask === 1) {
      if (this.waterMaskRunLength(wx, wy, card, diagVR) < 2) return null;
      const w = this.iso.gridToScreen(wx, wy);
      const l = this.iso.gridToScreen(wx - 1, wy);
      return { axis: 'vertical', worldX: (w.x + l.x) * 0.5, grassHalf: 'left' };
    }
    if (landMask === 4) {
      if (this.waterMaskRunLength(wx, wy, card, diagVR) < 2) return null;
      const w = this.iso.gridToScreen(wx, wy);
      const l = this.iso.gridToScreen(wx + 1, wy);
      return { axis: 'vertical', worldX: (w.x + l.x) * 0.5, grassHalf: 'right' };
    }
    return null;
  }

  private getGrassFlatShoreCut(gx: number, gy: number): FlatShoreCut | null {
    const fromWater = (wx: number, wy: number): FlatShoreCut | null => {
      const t = this.tileMap.getTile(wx, wy);
      if (!t || t.terrain !== 'water') return null;
      const cut = this.tryWaterFlatShoreCut(wx, wy);
      if (!cut) return null;
      if (cut.axis === 'horizontal') {
        if (cut.grassHalf === 'upper' && gx === wx && gy === wy - 1) return cut;
        if (cut.grassHalf === 'lower' && gx === wx && gy === wy + 1) return cut;
      } else {
        if (cut.grassHalf === 'left' && gx === wx - 1 && gy === wy) return cut;
        if (cut.grassHalf === 'right' && gx === wx + 1 && gy === wy) return cut;
      }
      return null;
    };
    return (
      fromWater(gx, gy + 1) ??
      fromWater(gx, gy - 1) ??
      fromWater(gx - 1, gy) ??
      fromWater(gx + 1, gy)
    );
  }

  private applyFlatShoreGrassClip(cut: FlatShoreCut): void {
    const M = FLAT_SHORE_CLIP_EXTENT;
    this.ctx.beginPath();
    if (cut.axis === 'horizontal') {
      if (cut.grassHalf === 'upper') {
        this.ctx.rect(-M, -M, 2 * M, cut.worldY + M);
      } else {
        this.ctx.rect(-M, cut.worldY, 2 * M, 2 * M);
      }
    } else if (cut.grassHalf === 'left') {
      this.ctx.rect(-M, -M, cut.worldX + M, 2 * M);
    } else {
      this.ctx.rect(cut.worldX, -M, 2 * M, 2 * M);
    }
    this.ctx.clip();
  }

  /** Water overlay / deep tint: half-plane opposite the grass side. */
  private applyFlatShoreWaterOverlayClip(cut: FlatShoreCut): void {
    const M = FLAT_SHORE_CLIP_EXTENT;
    this.ctx.beginPath();
    if (cut.axis === 'horizontal') {
      if (cut.grassHalf === 'upper') {
        this.ctx.rect(-M, cut.worldY, 2 * M, 2 * M);
      } else {
        this.ctx.rect(-M, -M, 2 * M, cut.worldY + M);
      }
    } else if (cut.grassHalf === 'left') {
      this.ctx.rect(cut.worldX, -M, 2 * M, 2 * M);
    } else {
      this.ctx.rect(-M, -M, cut.worldX + M, 2 * M);
    }
    this.ctx.clip();
  }

  private renderTile(tile: Tile): void {
    const center = this.iso.gridToScreen(tile.x, tile.y);
    if (!tile.isExplored()) {
      this.terrainTextures.drawTile(this.ctx, 'fog', tile.x, tile.y, center.x, center.y);
      return;
    }

    if (tile.terrain === 'water') {
      const flatCut = this.tryWaterFlatShoreCut(tile.x, tile.y);
      const waterConfig = this.getWaterConfig(tile.x, tile.y);
      const linearShore = !flatCut && this.getWaterShoreLinearized(tile.x, tile.y);

      if (flatCut) {
        this.ctx.save();
        this.applyFlatShoreGrassClip(flatCut);
        this.terrainTextures.drawTile(this.ctx, 'grass', tile.x, tile.y, center.x, center.y);
        this.ctx.restore();

        this.ctx.save();
        this.applyFlatShoreWaterOverlayClip(flatCut);
        this.terrainTextures.drawWater(this.ctx, waterConfig, tile.x, tile.y, center.x, center.y, linearShore);
        this.ctx.restore();
      } else {
        this.terrainTextures.drawTile(this.ctx, 'grass', tile.x, tile.y, center.x, center.y);
        this.terrainTextures.drawWater(this.ctx, waterConfig, tile.x, tile.y, center.x, center.y, linearShore);
      }

      if (tile.waterDepth > 1) {
        const darken = Math.min((tile.waterDepth - 1) * 0.04, 0.3);
        this.ctx.fillStyle = `rgba(0, 8, 25, ${darken})`;
        const c = this.iso.getTileCorners(tile.x, tile.y);
        this.ctx.beginPath();
        this.ctx.moveTo(c[0].x, c[0].y);
        this.ctx.lineTo(c[1].x, c[1].y);
        this.ctx.lineTo(c[2].x, c[2].y);
        this.ctx.lineTo(c[3].x, c[3].y);
        this.ctx.closePath();
        if (flatCut) {
          this.ctx.save();
          this.applyFlatShoreWaterOverlayClip(flatCut);
          this.ctx.fill();
          this.ctx.restore();
        } else {
          this.ctx.fill();
        }
      }
    } else {
      const flatGrass =
        (tile.terrain === 'grass' || tile.terrain === 'forest' || tile.terrain === 'tree')
          ? this.getGrassFlatShoreCut(tile.x, tile.y)
          : null;
      if (flatGrass) {
        this.ctx.save();
        this.applyFlatShoreGrassClip(flatGrass);
        this.terrainTextures.drawTile(this.ctx, tile.terrain, tile.x, tile.y, center.x, center.y);
        this.ctx.restore();
      } else {
        this.terrainTextures.drawTile(this.ctx, tile.terrain, tile.x, tile.y, center.x, center.y);
      }
      if (tile.forestDepth > 1) {
        const darken = Math.min((tile.forestDepth - 1) * 0.07, 0.35);
        this.ctx.fillStyle = `rgba(0, 12, 3, ${darken})`;
        const c = this.iso.getTileCorners(tile.x, tile.y);
        this.ctx.beginPath();
        this.ctx.moveTo(c[0].x, c[0].y);
        this.ctx.lineTo(c[1].x, c[1].y);
        this.ctx.lineTo(c[2].x, c[2].y);
        this.ctx.lineTo(c[3].x, c[3].y);
        this.ctx.closePath();
        if (flatGrass) {
          this.ctx.save();
          this.applyFlatShoreGrassClip(flatGrass);
          this.ctx.fill();
          this.ctx.restore();
        } else {
          this.ctx.fill();
        }
      }
    }

    if (tile.hasRoad) {
      const config = this.getRoadConfig(tile.x, tile.y);
      this.terrainTextures.drawRoad(this.ctx, config, center.x, center.y);
    }
  }

  private isDeepWater(x: number, y: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const t = this.tileMap.getTile(x + dx, y + dy);
        if (!t || t.terrain !== 'water') return false;
      }
    }
    return true;
  }

  private renderFishJumps(): void {
    const now = Date.now();
    const JUMP_DURATION = 1200;

    if (now >= this.nextFishSpawn) {
      this.spawnFish();
      this.nextFishSpawn = now + 5000 + Math.random() * 25000;
    }

    const bounds = this.getViewportBounds();
    for (let i = this.fishJumps.length - 1; i >= 0; i--) {
      const fish = this.fishJumps[i];
      const elapsed = now - fish.startTime;
      if (elapsed >= JUMP_DURATION) {
        this.fishJumps.splice(i, 1);
        continue;
      }
      if (fish.x < bounds.minX || fish.x > bounds.maxX ||
          fish.y < bounds.minY || fish.y > bounds.maxY) continue;
      const hash = ((fish.x * 7919 + fish.y * 104729 + 1) >>> 0) % 10000 / 10000;
      this.renderFish(fish.x, fish.y, elapsed / JUMP_DURATION, hash);
    }
  }

  private spawnFish(): void {
    const bounds = this.getViewportBounds();
    const w = bounds.maxX - bounds.minX + 1;
    const h = bounds.maxY - bounds.minY + 1;
    for (let attempt = 0; attempt < 15; attempt++) {
      const x = bounds.minX + Math.floor(Math.random() * w);
      const y = bounds.minY + Math.floor(Math.random() * h);
      const tile = this.tileMap.getTile(x, y);
      if (!tile || tile.terrain !== 'water' || !tile.isExplored()) continue;
      if (!this.isDeepWater(x, y)) continue;
      this.fishJumps.push({ x, y, startTime: Date.now() });
      return;
    }
  }

  private renderFish(tileX: number, tileY: number, progress: number, hash: number): void {
    const center = this.iso.gridToScreen(tileX, tileY);
    const ctx = this.ctx;
    const dir = hash > 0.01 ? 1 : -1;

    const baseX = center.x + (hash * 14 - 7) * dir;
    const baseY = center.y;
    const travelX = (progress - 0.5) * 14 * dir;
    const arcHeight = 16;
    const jumpY = -arcHeight * 4 * progress * (1 - progress);

    const fishX = baseX + travelX;
    const fishY = baseY + jumpY;

    const tangentY = -arcHeight * 4 * (1 - 2 * progress);
    const angle = Math.atan2(tangentY, 14 * dir);

    ctx.save();
    ctx.translate(fishX, fishY);
    ctx.rotate(angle);

    ctx.fillStyle = '#a0b5c5';
    ctx.beginPath();
    ctx.ellipse(0, 0, 5, 2, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#c5d4e0';
    ctx.beginPath();
    ctx.ellipse(0, 0.8, 4, 1, 0, 0, Math.PI);
    ctx.fill();

    ctx.fillStyle = '#8a9fb0';
    ctx.beginPath();
    ctx.moveTo(-5, 0);
    ctx.lineTo(-8, -2.5);
    ctx.lineTo(-8, 2.5);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(-1, -2);
    ctx.lineTo(2, -3.5);
    ctx.lineTo(2, -2);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(3, -0.5, 0.7, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    if (progress < 0.12 || progress > 0.88) {
      const entering = progress < 0.12;
      const sp = entering ? progress / 0.12 : (1 - progress) / 0.12;
      const splashX = entering ? baseX : baseX + 14 * dir;
      const r1 = 3 + sp * 6;
      ctx.strokeStyle = `rgba(200, 225, 245, ${(1 - sp) * 0.5})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.ellipse(splashX, baseY, r1, r1 * 0.35, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (sp > 0.3) {
        const r2 = 2 + sp * 9;
        ctx.strokeStyle = `rgba(200, 225, 245, ${(1 - sp) * 0.3})`;
        ctx.beginPath();
        ctx.ellipse(splashX, baseY, r2, r2 * 0.35, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
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
    const isUnderConstruction = building && (building.state === 'under_construction' || building.state === 'awaiting_materials');

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

    if (building && this.showBuildingLabels) {
      this.ctx.fillStyle = 'white';
      this.ctx.font = '10px monospace';
      this.ctx.textAlign = 'center';
      const buildingDef = dataManager.getBuilding(building.buildingType);
      this.ctx.fillText(buildingDef?.name || building.buildingType, 0, -building.height - 10);
    }

    // Reset filter before drawing status indicators
    if (isInactive) {
      this.ctx.filter = 'none';
    }

    // Construction overlay: bar + dust only while workers are actively building (not while waiting on materials)
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
    if ((building.state !== 'under_construction' && building.state !== 'awaiting_materials') || !renderable.spritePath) return renderable.spritePath;
    const stages = CONSTRUCTION_SPRITES[building.buildingType];
    if (!stages || stages.length === 0) return renderable.spritePath;
    const totalFrames = stages.length + 1;
    const frameIndex = Math.min(Math.floor(building.constructionProgress * totalFrames), stages.length);
    return frameIndex < stages.length ? stages[frameIndex] : renderable.spritePath;
  }

  private getBuildingSpriteVisualScale(buildingType: string): number {
    const def = dataManager.getBuilding(buildingType as BuildingType);
    const s = def?.visual?.spriteScale;
    return typeof s === 'number' && s > 0 && Number.isFinite(s) ? s : 1;
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
    const extra = this.getBuildingSpriteVisualScale(building.buildingType);
    const drawW = sprite.naturalWidth * scale * extra;
    const drawH = sprite.naturalHeight * scale * extra;

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

    const bubbleX = (building.width - 1) * tileW / 2;
    const bubbleY = (building.width - 1) * tileH / 2 - 12;

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

  private renderJunctionItems(viewportBounds: { minX: number; maxX: number; minY: number; maxY: number }): void {
    const junctionMap = transportManager.getJunctionItemsMap();
    const pendingMap = transportManager.getPendingPickupVisualsMap();

    const allKeys = new Set<string>();
    for (const key of junctionMap.keys()) allKeys.add(key);
    for (const key of pendingMap.keys()) allKeys.add(key);

    for (const key of allKeys) {
      const junctionItems = junctionMap.get(key) || [];
      const pendingItems = pendingMap.get(key) || [];
      const combined = [...junctionItems, ...pendingItems];
      if (combined.length === 0) continue;

      const [x, y] = key.split(',').map(Number);
      if (x < viewportBounds.minX || x > viewportBounds.maxX ||
          y < viewportBounds.minY || y > viewportBounds.maxY) continue;

      const center = this.iso.gridToScreen(x, y);
      const count = Math.min(combined.length, 5);

      const offsets = [
        { x: 0, y: -2 },
        { x: -8, y: 2 },
        { x: 8, y: 2 },
        { x: -4, y: -6 },
        { x: 5, y: -6 },
      ];

      for (let i = 0; i < count; i++) {
        const ix = center.x + offsets[i].x;
        const iy = center.y + offsets[i].y;

        const resSprite = this.loadSprite(`/assets/resources/${combined[i].resourceType}.png`);
        if (resSprite) {
          this.ctx.drawImage(resSprite, ix - 5, iy - 5, 10, 10);
        } else {
          this.ctx.fillStyle = '#6b5020';
          this.ctx.fillRect(ix - 4, iy - 1, 8, 4);
          this.ctx.fillStyle = '#8b6914';
          this.ctx.fillRect(ix - 4, iy - 4, 8, 4);
          this.ctx.fillStyle = '#a07818';
          this.ctx.fillRect(ix - 3, iy - 4, 6, 2);
          this.ctx.strokeStyle = '#4a3510';
          this.ctx.lineWidth = 0.5;
          this.ctx.strokeRect(ix - 4, iy - 4, 8, 7);
        }
      }
    }
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
    if (worker.visualActivity === 'production_well' && worker.state === 'working') {
      return;
    }
    if (
      worker.visualActivity === 'construct' &&
      worker.state === 'working' &&
      worker.hammerConstructionEnabled
    ) {
      return;
    }
    if (worker.heldItemStyle === 'side' && worker.carryingResource) {
      return;
    }
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

    const isCarrying = !!worker.carryingResource;
    const isHammerConstruct =
      isCarrying &&
      worker.carryingResource === 'hammer' &&
      worker.visualActivity === 'construct' &&
      worker.hammerConstructionEnabled &&
      worker.state === 'working' &&
      !isMoving;

    const isSideCarryTool =
      isCarrying && worker.heldItemStyle === 'side' && !isHammerConstruct;

    const isOverheadCarry = isCarrying && worker.heldItemStyle === 'overhead';

    /** Idle poses that need free hands — skip when holding a tool at the side. */
    const armAnim: IdleAnim =
      isSideCarryTool && anim !== 'look_around' && anim !== 'none' ? 'none' : anim;

    this.ctx.save();

    const px = (x: number, y: number, w: number, h: number, color: string) => {
      this.ctx.fillStyle = color;
      this.ctx.fillRect(x * s, y * s, w * s, h * s);
    };

    const mirror = facing === 1 || facing === 2;
    const showBack = facing === 2 || facing === 3;
    if (mirror) this.ctx.scale(-1, 1);

    const isWellDrawing =
      worker.visualActivity === 'production_well' &&
      worker.state === 'working' &&
      !isMoving &&
      worker.carryingResource === 'water';
    if (isWellDrawing) {
      const bob = Math.sin(now / 420) * 1.8;
      const sway = Math.sin(now / 510) * 0.5;
      this.ctx.translate(sway * s, bob * s);
    }

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

    let leftArmY = -8 + walkArmSwing;
    let rightArmY = -8 - walkArmSwing;
    let leftHandY = -5 + walkArmSwing;
    let rightHandY = -5 - walkArmSwing;
    let leftArmX = -4;
    let rightArmX = 3;
    let extraDraw: (() => void) | null = null;

    let hammerSwingT = 0;

    if (isHammerConstruct) {
      hammerSwingT = (Math.sin(now / 130) + 1) / 2;
      const strike = Math.floor(hammerSwingT * 8);
      leftArmX = -4;
      rightArmX = 4;
      leftArmY = -8;
      rightArmY = -7 - strike;
      leftHandY = -5;
      rightHandY = rightArmY + 3;
    } else if (isSideCarryTool) {
      const wobble = isMoving ? walkArmSwing * 0.5 : 0;
      leftArmX = -4;
      rightArmX = 4;
      leftArmY = -8 + wobble;
      rightArmY = -8 - wobble;
      leftHandY = -4 + wobble;
      rightHandY = -4 - wobble;
    } else if (
      isOverheadCarry &&
      worker.visualActivity === 'production_well' &&
      worker.carryingResource === 'water'
    ) {
      const pull = Math.sin(now / 200);
      const a1 = pull * 2.5;
      const a2 = -pull * 2.5;
      leftArmY = -12 + a1;
      rightArmY = -12 + a2;
      leftHandY = -14 + a1;
      rightHandY = -14 + a2;
      leftArmX = -3;
      rightArmX = 2;
    } else if (isOverheadCarry) {
      leftArmY = -13;
      rightArmY = -13;
      leftHandY = -15;
      rightHandY = -15;
      leftArmX = -3;
      rightArmX = 2;
    } else if (!isMoving) {
      if (armAnim === 'scratch_head') {
        rightArmY = -13;
        rightHandY = -14;
        rightArmX = 2;
        const wiggle = Math.sin(animT * Math.PI * 6) > 0 ? 1 : 0;
        rightHandY += wiggle;
      } else if (armAnim === 'hands_on_hips') {
        leftArmX = -3;
        rightArmX = 2;
        leftArmY = -7;
        rightArmY = -7;
        leftHandY = -5;
        rightHandY = -5;
      } else if (armAnim === 'stretch') {
        const lift = Math.sin(animT * Math.PI);
        leftArmY = -8 - Math.floor(lift * 5);
        rightArmY = -8 - Math.floor(lift * 5);
        leftHandY = leftArmY - 1;
        rightHandY = rightArmY - 1;
      } else if (armAnim === 'read') {
        leftArmX = -2;
        rightArmX = 1;
        leftArmY = -7;
        rightArmY = -7;
        leftHandY = -5;
        rightHandY = -5;
        if (!showBack) {
          extraDraw = () => {
            px(-1, -8, 4, 3, '#e8dcc8');
            px(-1, -8, 4, 1, '#c8b898');
          };
        }
      }
    }

    px(leftArmX, leftArmY, 2, 3, a.tunic);
    px(rightArmX, rightArmY, 2, 3, a.tunic);
    px(leftArmX, leftHandY, 2, 1, a.skin);
    px(rightArmX, rightHandY, 2, 1, a.skin);

    if (extraDraw) extraDraw();

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

    if (isCarrying && worker.carryingResource) {
      const resSprite = this.loadSprite(`/assets/resources/${worker.carryingResource}.png`);
      const drawFallback = () => {
        px(-2, -19, 5, 4, '#d4a03c');
        px(-1, -20, 3, 1, '#f0c060');
      };

      const toolDrawPx = 10;

      if (isHammerConstruct) {
        const strike = Math.floor(hammerSwingT * 8);
        const ty = -11 - strike;
        const tx = 0.5;
        if (resSprite) {
          this.ctx.drawImage(resSprite, tx * s, ty * s, toolDrawPx * s, toolDrawPx * s);
        } else {
          px(tx - 1, ty, 5, 5, '#8a7a68');
        }
      } else if (isSideCarryTool) {
        if (resSprite) {
          this.ctx.drawImage(resSprite, -0.5 * s, -11 * s, toolDrawPx * s, toolDrawPx * s);
        } else {
          px(-2, -20, 6, 5, '#d4a03c');
          px(-1, -21, 4, 1, '#f0c060');
        }
      } else if (
        isOverheadCarry &&
        worker.visualActivity === 'production_well' &&
        worker.carryingResource === 'water'
      ) {
        const wob = Math.sin(now / 200) * 1.2 * s;
        if (resSprite) {
          this.ctx.drawImage(resSprite, -4 * s, -22 * s + wob, 8 * s, 8 * s);
        } else {
          drawFallback();
        }
      } else if (isOverheadCarry) {
        if (resSprite) {
          this.ctx.drawImage(resSprite, -4 * s, -22 * s, 8 * s, 8 * s);
        } else {
          drawFallback();
        }
      }
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
    this.cachedViewportBounds = null;
    // Reset minimap offscreen canvas
    this.minimapOffscreenCtx.fillStyle = '#1a1a1a';
    this.minimapOffscreenCtx.fillRect(0, 0, 200, 200);
    this.minimapScale = 200 / this.tileMap.width;
  }
}
