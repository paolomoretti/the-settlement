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
import { BuildingType, ResourceType } from '@/types/GameData';
import { TerrainTextures } from '@/rendering/TerrainTextures';
import { transportManager } from '@/economics/TransportManager';
import type { SurveyOverlayForRender } from '@/survey/SurveyCoordinator';
import {
  BUILDING_CONSTRUCTION_SPRITES,
  BUILDING_PRODUCTION_SPRITES,
  collectAllCataloguedBuildingSpritePaths,
} from '@/catalog/buildingSprites';
import {
  paintWorkerSpriteBody as paintWorkerBodyToCanvas,
  paintWorkerFloorNap,
} from '@/rendering/WorkerSpritePainter';
import { RABBIT_JUMP_DURATION_MS, type WildRabbit } from '@/wildlife/WildlifeCoordinator';
import { CORDON_POLE_STRIDE_CELLS, territoryKey } from '@/map/TerritoryCoordinator';
import { createChimneySmoke, type ChimneySmoke } from '@/rendering/chimneySmoke';

/** World-space half-plane clip for long straight iso shores (same screen row / column of tile centers). */
type FlatShoreCut =
  | { axis: 'horizontal'; worldY: number; grassHalf: 'upper' | 'lower' }
  | { axis: 'vertical'; worldX: number; grassHalf: 'left' | 'right' };

const FLAT_SHORE_CLIP_EXTENT = 1_000_000;

/** Uniform draw scale for `/assets/resources/*.png` on the main canvas (workers, junctions, map bubbles). */
const RESOURCE_ICON_DRAW_SCALE = 1.25;

/** TEMP (visual QA): time between decorative fish jumps — restore to `30_000` / `300_000` when done. */
const FISH_SPAWN_GAP_MIN_MS = 400;
const FISH_SPAWN_GAP_MAX_MS = 2_000;
const CONSTRUCTION_SMOKE_ON_SEC = 15;
const CONSTRUCTION_SMOKE_OFF_MIN_SEC = 3;
const CONSTRUCTION_SMOKE_OFF_MAX_SEC = 5;

function nextFishSpawnGapMs(): number {
  return FISH_SPAWN_GAP_MIN_MS + Math.random() * (FISH_SPAWN_GAP_MAX_MS - FISH_SPAWN_GAP_MIN_MS);
}

type ConstructionSmokeState = {
  smoke: ChimneySmoke;
  phase: 'on' | 'off';
  phaseRemainingSec: number;
};

export class RenderSystem extends System {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private iso: Isometric;
  private camera = { x: 0, y: 0, zoom: 1 };
  /** Optional hooks from `Game` for fog + settlement placement previews. */
  public placementPreviewHooks: {
    canPlaceBuildingPreview?: (type: string, gx: number, gy: number, w: number, h: number) => boolean;
    canPlaceRoadPreview?: (gx: number, gy: number) => boolean;
  } = {};

  /** Supplier for cordon overlay (frontier tiles + union), owned by `Game`. */
  public getTerritoryCordonOverlay?: () => {
    frontier: ReadonlySet<string>;
    unionU: ReadonlySet<string>;
  } | null;

  public buildPreview: {
    mode: string;
    gridX: number;
    gridY: number;
    /** Straight row preview (Shift + road drag): all tiles that would be built. */
    roadLineTiles?: { x: number; y: number }[];
    /** Locked while dragging a road stroke; otherwise inferred from tile under cursor (matches `Game.buildRoad`). */
    roadDragIntent?: 'create' | 'delete';
  } | null = null;
  public selectedEntityId: number | null = null;
  public dragPreviewPosition: { x: number; y: number } | null = null;
  private terrainTextures: TerrainTextures;
  private spriteCache = new Map<string, HTMLImageElement>();
  public hoveredEntityId: number | null = null;
  /** While Alt/Option is held: draw the tile grid at any zoom (see Game insight sync). */
  public showInsightGrid = false;
  /** Alt+hover in view mode: outline this building sprite. */
  public insightHighlightEntityId: number | null = null;
  /** Alt+hover on a quarry rock tile (mountain / hill). */
  public insightHighlightRock: { x: number; y: number } | null = null;
  /** Alt+hover on a water tile (fisher fish school). */
  public insightHighlightWater: { x: number; y: number } | null = null;
  public showBuildingLabels = true;
  private toast: { text: string; x: number; y: number; startTime: number } | null = null;
  private fishJumps: Array<{ x: number; y: number; startTime: number }> = [];
  private nextFishSpawn: number = 0;
  private eraseSmokePuffs: Array<{ gx: number; gy: number; start: number }> = [];
  /** Per-building chimney smoke (entity id → instance). */
  private chimneySmokes = new Map<number, ChimneySmoke>();
  /** Per-building construction smoke with on/off pulse phases. */
  private constructionSmokes = new Map<number, ConstructionSmokeState>();
  /** Survey flag + dominant-ore hint icons (world space; cleared when null). */
  private surveyOverlay: SurveyOverlayForRender | null = null;
  /** Tile outline while the grass “Send Surveyor” menu is open. */
  private surveyMenuHighlight: { x: number; y: number } | null = null;
  /** Grass tile selected for survey: outline until the player taps the center options icon. */
  private surveyPendingTile: { x: number; y: number } | null = null;
  /** Surveyor workers drawn again after survey overlays so they stay on top. */
  private surveyWorkerDrawOnTopIds = new Set<number>();

  /** When set, rabbits are drawn in the depth-sorted pass (see `Game.wildlife`). */
  private getWildRabbits: (() => readonly WildRabbit[]) | null = null;

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

    this.nextFishSpawn = Date.now() + nextFishSpawnGapMs();

    this.preloadSprites(collectAllCataloguedBuildingSpritePaths());

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

  /** Hook from `Game` so rabbits sort with terrain without being ECS entities. */
  setWildRabbitSupplier(supplier: (() => readonly WildRabbit[]) | null): void {
    this.getWildRabbits = supplier;
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

  /** Advance chimney particles; drive emitters from production or optional schedule override. */
  private updateChimneySmokes(dt: number): void {
    const validIds = new Set<number>();

    for (const entity of this.entities) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (!building) continue;

      const def = dataManager.getBuilding(building.buildingType);
      const cfg = def?.chimneySmoke;
      if (!cfg) continue;

      validIds.add(entity.id);

      let smoke = this.chimneySmokes.get(entity.id);
      if (!smoke) {
        smoke = createChimneySmoke({
          x: cfg.offsetX,
          y: cfg.offsetY,
          density: cfg.density ?? 1,
          duration: cfg.duration ?? Infinity,
        });
        this.chimneySmokes.set(entity.id, smoke);
      } else {
        smoke.setPosition(cfg.offsetX, cfg.offsetY);
        if (cfg.density !== undefined) smoke.setDensity(cfg.density);
      }

      const isBuildReady = building.isComplete() && building.state === 'complete' && building.isActive;
      let shouldEmit = false;
      if (isBuildReady && cfg.schedule) {
        const everySec = Math.max(0.01, cfg.schedule.everySec);
        const onSec = Math.max(0, Math.min(cfg.schedule.onSec, everySec));
        const phaseOffsetSec = cfg.schedule.phaseOffsetSec ?? 0;
        const nowSec = performance.now() / 1000;
        const cyclePos = ((nowSec + phaseOffsetSec) % everySec + everySec) % everySec;
        shouldEmit = cyclePos < onSec;
      } else {
        const production = entity.getComponent(Production) ?? null;
        shouldEmit =
          isBuildReady &&
          production !== null &&
          production.status === 'producing';
      }

      if (shouldEmit) {
        if (!smoke.emitting) smoke.start();
      } else {
        smoke.stop();
      }

      smoke.update(dt);
    }

    for (const id of this.chimneySmokes.keys()) {
      if (!validIds.has(id)) {
        this.chimneySmokes.delete(id);
      }
    }
  }

  update(_deltaTime: number): void {
    this.updateChimneySmokes(_deltaTime);
    this.updateConstructionSmokes(_deltaTime);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.ctx.save();
    this.ctx.translate(this.camera.x, this.camera.y);
    this.ctx.scale(this.camera.zoom, this.camera.zoom);

    // Render tiles
    this.renderTiles();
    this.renderFishJumps();

    const cordonPack = this.getTerritoryCordonOverlay?.() ?? null;

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

    // Sort entities by isometric draw depth (float); workers tie-break on top of buildings
    const sortedEntities = visibleEntities.sort((a, b) => this.compareEntityDrawOrder(a, b));

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

    // Depth-sorted rendering: interleave trees, mountains, and entities (cordon ropes sort with depth)
    this.renderDepthSorted(sortedEntities, viewportBounds, cordonPack);

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

    this.renderSurveyOverlays();
    this.renderSurveyorWorkersOnTop();

    this.ctx.restore();

    // Render toast message (screen-space, after ctx.restore)
    this.renderToast();

    // Render minimap
    this.renderMinimap();
  }

  private nextConstructionSmokeOffSec(): number {
    return CONSTRUCTION_SMOKE_OFF_MIN_SEC +
      Math.random() * (CONSTRUCTION_SMOKE_OFF_MAX_SEC - CONSTRUCTION_SMOKE_OFF_MIN_SEC);
  }

  /** Center-biased smoke origin in building-local render space. */
  private getConstructionSmokeOrigin(building: Building): { x: number; y: number } {
    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;
    const centerX = ((building.width - building.height) * tileW) / 4;
    const centerY = ((building.width + building.height) * tileH) / 4;
    const lift = Math.max(16, building.buildingHeight * 0.35);
    return { x: centerX, y: centerY - lift };
  }

  /**
   * Construction smoke for all active builds:
   * 15s emit, then 3–5s pause, looping while `under_construction`.
   */
  private updateConstructionSmokes(dt: number): void {
    const validIds = new Set<number>();

    for (const entity of this.entities) {
      if (!entity.active) continue;
      const building = entity.getComponent(Building);
      if (!building) continue;
      if (building.state !== 'under_construction') continue;

      validIds.add(entity.id);
      const origin = this.getConstructionSmokeOrigin(building);

      let state = this.constructionSmokes.get(entity.id);
      if (!state) {
        const smoke = createChimneySmoke({ x: origin.x, y: origin.y, density: 1.2 });
        state = {
          smoke,
          phase: 'on',
          phaseRemainingSec: CONSTRUCTION_SMOKE_ON_SEC,
        };
        this.constructionSmokes.set(entity.id, state);
      }

      state.smoke.setPosition(origin.x, origin.y);

      if (state.phase === 'on') {
        if (!state.smoke.emitting) state.smoke.start();
      } else {
        state.smoke.stop();
      }

      state.smoke.update(dt);
      state.phaseRemainingSec -= dt;

      if (state.phaseRemainingSec <= 0) {
        if (state.phase === 'on') {
          state.phase = 'off';
          state.phaseRemainingSec = this.nextConstructionSmokeOffSec();
          state.smoke.stop();
        } else {
          state.phase = 'on';
          state.phaseRemainingSec = CONSTRUCTION_SMOKE_ON_SEC;
          state.smoke.start();
        }
      }
    }

    for (const id of this.constructionSmokes.keys()) {
      if (!validIds.has(id)) this.constructionSmokes.delete(id);
    }
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

  private renderBuildPreview(preview: {
    mode: string;
    gridX: number;
    gridY: number;
    roadLineTiles?: { x: number; y: number }[];
    roadDragIntent?: 'create' | 'delete';
  }): void {
    const { mode, gridX, gridY, roadLineTiles, roadDragIntent } = preview;

    if (mode === 'build_road') {
      this.renderRoadPreview(gridX, gridY, roadLineTiles, roadDragIntent ?? 'create');
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
      this.renderSpritePreview(
        gridX,
        gridY,
        size.width,
        size.height,
        sprite,
        buildingType,
        visual.offsetX ?? 0,
        visual.offsetY ?? 0
      );
    } else {
      this.renderBuildingPreview(
        gridX,
        gridY,
        size.width,
        size.height,
        visual.buildingHeight,
        visual.color,
        visual.offsetX ?? 0,
        visual.offsetY ?? 0
      );
    }
  }

  private renderSpritePreview(
    gridX: number,
    gridY: number,
    width: number,
    depth: number,
    sprite: HTMLImageElement,
    buildingType?: string,
    offsetX: number = 0,
    offsetY: number = 0
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
    this.ctx.translate(screenPos.x + offsetX, screenPos.y - this.iso.tileHeight / 2 + offsetY);

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

  setSurveyOverlay(overlay: SurveyOverlayForRender | null): void {
    this.surveyOverlay = overlay;
  }

  setSurveyMenuHighlight(tile: { x: number; y: number } | null): void {
    this.surveyMenuHighlight = tile;
  }

  setSurveyPendingTile(tile: { x: number; y: number } | null): void {
    this.surveyPendingTile = tile;
  }

  setSurveyWorkerIdsOnTop(ids: number[]): void {
    this.surveyWorkerDrawOnTopIds.clear();
    for (const id of ids) {
      this.surveyWorkerDrawOnTopIds.add(id);
    }
  }

  private renderSurveyorWorkersOnTop(): void {
    if (this.surveyWorkerDrawOnTopIds.size === 0) return;
    const ids = [...this.surveyWorkerDrawOnTopIds];
    ids.sort((a, b) => {
      const ea = this.entities.find(e => e.id === a);
      const eb = this.entities.find(e => e.id === b);
      if (!ea) return 1;
      if (!eb) return -1;
      return this.compareEntityDrawOrder(ea, eb);
    });
    for (const id of ids) {
      const ent = this.entities.find(e => e.id === id && e.active);
      if (ent) this.renderEntity(ent);
    }
  }

  private renderSurveyOverlays(): void {
    const o = this.surveyOverlay;
    const vb = this.getViewportBounds();
    const pad = 3;
    const th = this.iso.tileHeight;

    const drawSurveyPendingOptionIcon = (): void => {
      const pt = this.surveyPendingTile;
      if (!pt) return;
      const px = pt.x;
      const py = pt.y;
      if (px < vb.minX - pad || px > vb.maxX + pad || py < vb.minY - pad || py > vb.maxY + pad) return;
      const t = this.tileMap.getTile(px, py);
      if (!t?.isExplored()) return;

      const c = this.iso.gridToScreen(px, py);
      const r = th * 0.2;
      this.ctx.save();
      this.ctx.fillStyle = 'rgba(245, 236, 220, 0.96)';
      this.ctx.strokeStyle = 'rgba(78, 52, 34, 0.95)';
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      this.ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.fillStyle = 'rgba(62, 39, 24, 0.92)';
      const dotR = r * 0.12;
      const gap = r * 0.28;
      for (let i = -1; i <= 1; i++) {
        this.ctx.beginPath();
        this.ctx.arc(c.x + i * gap, c.y, dotR, 0, Math.PI * 2);
        this.ctx.fill();
      }
      this.ctx.restore();
    };

    if (this.surveyPendingTile) {
      const px = this.surveyPendingTile.x;
      const py = this.surveyPendingTile.y;
      if (px >= vb.minX - pad && px <= vb.maxX + pad && py >= vb.minY - pad && py <= vb.maxY + pad) {
        const tile = this.tileMap.getTile(px, py);
        if (tile?.isExplored()) {
          const corners = this.iso.getTileCorners(px, py);
          this.ctx.save();
          this.ctx.beginPath();
          this.ctx.moveTo(corners[0].x, corners[0].y);
          for (let i = 1; i < corners.length; i++) {
            this.ctx.lineTo(corners[i].x, corners[i].y);
          }
          this.ctx.closePath();
          this.ctx.strokeStyle = 'rgba(139, 90, 43, 0.92)';
          this.ctx.lineWidth = 2.5;
          this.ctx.stroke();
          this.ctx.fillStyle = 'rgba(101, 67, 33, 0.14)';
          this.ctx.fill();
          this.ctx.restore();
        }
      }
    }

    if (this.surveyMenuHighlight) {
      const hx = this.surveyMenuHighlight.x;
      const hy = this.surveyMenuHighlight.y;
      if (hx >= vb.minX - pad && hx <= vb.maxX + pad && hy >= vb.minY - pad && hy <= vb.maxY + pad) {
        const tile = this.tileMap.getTile(hx, hy);
        if (tile?.isExplored()) {
          const corners = this.iso.getTileCorners(hx, hy);
          this.ctx.save();
          this.ctx.beginPath();
          this.ctx.moveTo(corners[0].x, corners[0].y);
          for (let i = 1; i < corners.length; i++) {
            this.ctx.lineTo(corners[i].x, corners[i].y);
          }
          this.ctx.closePath();
          this.ctx.strokeStyle = 'rgba(255, 220, 120, 0.95)';
          this.ctx.lineWidth = 3;
          this.ctx.stroke();
          this.ctx.fillStyle = 'rgba(255, 210, 90, 0.12)';
          this.ctx.fill();
          this.ctx.restore();
        }
      }
    }

    if (!o) {
      drawSurveyPendingOptionIcon();
      return;
    }

    for (const f of o.flags) {
      if (f.x < vb.minX - pad || f.x > vb.maxX + pad || f.y < vb.minY - pad || f.y > vb.maxY + pad) {
        continue;
      }
      const tile = this.tileMap.getTile(f.x, f.y);
      if (!tile?.isExplored()) continue;

      const c = this.iso.gridToScreen(f.x, f.y);
      this.ctx.save();
      this.ctx.strokeStyle = '#5c4030';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(c.x, c.y + th * 0.1);
      this.ctx.lineTo(c.x, c.y - th * 0.55);
      this.ctx.stroke();
      this.ctx.fillStyle = '#c62828';
      this.ctx.beginPath();
      this.ctx.moveTo(c.x + 1, c.y - th * 0.85);
      this.ctx.lineTo(c.x + th * 0.35, c.y - th * 0.55);
      this.ctx.lineTo(c.x + 1, c.y - th * 0.38);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.strokeStyle = '#3e2723';
      this.ctx.lineWidth = 1;
      this.ctx.stroke();
      this.ctx.restore();
    }

    if (o.progress) {
      const pr = o.progress;
      const cx = pr.centerX;
      const cy = pr.centerY;
      if (cx >= vb.minX - pad && cx <= vb.maxX + pad && cy >= vb.minY - pad && cy <= vb.maxY + pad) {
        const c = this.iso.gridToScreen(cx, cy);
        const barW = 88;
        const barH = 7;
        const bx = c.x - barW / 2;
        const by = c.y - th * 1.15;
        this.ctx.save();
        this.ctx.fillStyle = 'rgba(0,0,0,0.45)';
        this.ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.roundRect(bx, by, barW, barH, 3);
        this.ctx.fill();
        this.ctx.stroke();
        this.ctx.fillStyle = 'rgba(120, 200, 255, 0.85)';
        this.ctx.beginPath();
        this.ctx.roundRect(bx + 1, by + 1, (barW - 2) * pr.progress01, barH - 2, 2);
        this.ctx.fill();
        this.ctx.restore();
      }

      if (pr.currentCell) {
        const tx = pr.currentCell.x;
        const ty = pr.currentCell.y;
        if (tx >= vb.minX - pad && tx <= vb.maxX + pad && ty >= vb.minY - pad && ty <= vb.maxY + pad) {
          const corners = this.iso.getTileCorners(tx, ty);
          this.ctx.save();
          this.ctx.beginPath();
          this.ctx.moveTo(corners[0].x, corners[0].y);
          for (let i = 1; i < corners.length; i++) {
            this.ctx.lineTo(corners[i].x, corners[i].y);
          }
          this.ctx.closePath();
          this.ctx.strokeStyle = 'rgba(100, 200, 255, 0.75)';
          this.ctx.lineWidth = 2.5;
          this.ctx.stroke();
          this.ctx.restore();
        }
      }
    }

    const tagW = 18;
    const tagH = 15;
    const stickAbove = th * 0.52;

    const labelsSorted = [...o.labels].sort((a, b) => a.x + a.y - (b.x + b.y));

    for (const lab of labelsSorted) {
      if (lab.x < vb.minX - pad || lab.x > vb.maxX + pad || lab.y < vb.minY - pad || lab.y > vb.maxY + pad) {
        continue;
      }
      const tile = this.tileMap.getTile(lab.x, lab.y);
      if (!tile?.isExplored()) continue;

      const def = dataManager.getResource(lab.resource as ResourceType);
      const resPath = `/assets/resources/${lab.resource}.png`;
      const uiPath = def?.icon ?? `/assets/ui/icons/${lab.resource}.png`;
      let img = this.loadSprite(resPath);
      if (!img || img.naturalWidth === 0) {
        img = this.loadSprite(uiPath);
      }
      const ground = this.iso.gridToScreen(lab.x, lab.y);
      const tagCx = ground.x;
      const tagCy = ground.y - stickAbove;
      this.ctx.save();
      this.ctx.strokeStyle = '#5d4037';
      this.ctx.lineWidth = 1.75;
      this.ctx.lineCap = 'round';
      this.ctx.beginPath();
      this.ctx.moveTo(tagCx, tagCy + tagH * 0.45);
      this.ctx.lineTo(ground.x, ground.y - th * 0.04);
      this.ctx.stroke();
      const rx = tagCx - tagW / 2;
      const ry = tagCy - tagH / 2;
      this.ctx.fillStyle = '#f3ebe0';
      this.ctx.strokeStyle = 'rgba(78, 52, 34, 0.88)';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.roundRect(rx, ry, tagW, tagH, 2.5);
      this.ctx.fill();
      this.ctx.stroke();
      if (img && img.naturalWidth > 0) {
        const iw = tagW - 5;
        const ih = tagH - 5;
        this.ctx.drawImage(img, tagCx - iw / 2, tagCy - ih / 2, iw, ih);
      } else {
        this.ctx.fillStyle = '#b08d55';
        this.ctx.fillRect(tagCx - 4, tagCy - 4, 8, 8);
      }
      this.ctx.restore();
    }

    drawSurveyPendingOptionIcon();
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

  private renderRoadPreview(
    gridX: number,
    gridY: number,
    roadLineTiles: { x: number; y: number }[] | undefined,
    roadDragIntent: 'create' | 'delete'
  ): void {
    const addKeys = new Set<string>();
    const removeKeys = new Set<string>();

    if (roadDragIntent === 'delete') {
      removeKeys.add(`${gridX},${gridY}`);
    } else {
      const tiles =
        roadLineTiles && roadLineTiles.length > 0
          ? roadLineTiles
          : [{ x: gridX, y: gridY }];
      for (const t of tiles) {
        addKeys.add(`${t.x},${t.y}`);
      }
    }

    const topologyKeys = this.collectRoadTopologyPreviewKeys(addKeys, removeKeys);

    // Ghost road atlas on preview topology (neighbors included so T-junctions read correctly).
    // Only tiles in `addKeys` are visually emphasized (rim below); neighbor overlays stay softer.
    for (const key of topologyKeys) {
      const [x, y] = key.split(',').map(Number);
      if (!this.tileMap.isInBounds(x, y)) continue;
      if (!this.effectiveRoadForPreview(x, y, addKeys, removeKeys)) continue;
      const mask = this.getRoadMaskForPreview(x, y, addKeys, removeKeys);
      const center = this.iso.gridToScreen(x, y);
      const inAdd = addKeys.has(key);
      let alpha: number;
      if (roadDragIntent === 'delete') {
        alpha = 0.88;
      } else {
        alpha = inAdd ? 0.94 : 0.74;
      }
      this.ctx.save();
      this.ctx.globalAlpha = alpha;
      this.terrainTextures.drawRoad(this.ctx, mask, center.x, center.y);
      this.ctx.restore();
    }

    // Gold rim only on tiles you are placing (hover or shift row), not on adjacent retiles.
    if (roadDragIntent === 'create') {
      for (const key of addKeys) {
        const [x, y] = key.split(',').map(Number);
        if (!this.tileMap.isInBounds(x, y)) continue;
        if (!this.effectiveRoadForPreview(x, y, addKeys, removeKeys)) continue;
        const corners = this.iso.getTileCorners(x, y);
        this.ctx.beginPath();
        this.ctx.moveTo(corners[0].x, corners[0].y);
        corners.forEach(c => this.ctx.lineTo(c.x, c.y));
        this.ctx.closePath();
        this.ctx.strokeStyle = 'rgba(255, 224, 150, 0.92)';
        this.ctx.lineWidth = 2.6;
        this.ctx.lineJoin = 'round';
        this.ctx.stroke();
      }
    }

    if (roadDragIntent === 'create') {
      for (const key of addKeys) {
        const [x, y] = key.split(',').map(Number);
        if (!this.tileMap.isInBounds(x, y)) continue;
        if (this.canPreviewAddRoadAt(x, y)) continue;
        this.strokeRoadPreviewInvalidTile(x, y);
      }
    } else {
      this.strokeRoadPreviewDeleteTarget(gridX, gridY);
    }
  }

  private collectRoadTopologyPreviewKeys(
    addKeys: Set<string>,
    removeKeys: Set<string>
  ): Set<string> {
    const out = new Set<string>();
    const add = (gx: number, gy: number): void => {
      if (!this.tileMap.isInBounds(gx, gy)) return;
      out.add(`${gx},${gy}`);
      const neigh: [number, number][] = [
        [gx - 1, gy],
        [gx, gy - 1],
        [gx + 1, gy],
        [gx, gy + 1],
      ];
      for (const [nx, ny] of neigh) {
        if (this.tileMap.isInBounds(nx, ny)) out.add(`${nx},${ny}`);
      }
    };
    for (const k of addKeys) {
      const [sx, sy] = k.split(',').map(Number);
      add(sx, sy);
    }
    for (const k of removeKeys) {
      const [sx, sy] = k.split(',').map(Number);
      add(sx, sy);
    }
    return out;
  }

  /** Same placement rules as `TileMap.buildRoad` + fog + settlement interior (preview only). */
  private canPreviewAddRoadAt(x: number, y: number): boolean {
    const tile = this.tileMap.getTile(x, y);
    if (
      !(
        tile &&
        tile.isExplored() &&
        !tile.hasRoad &&
        tile.terrain !== 'water' &&
        tile.terrain !== 'mountain' &&
        !tile.isOccupied()
      )
    ) {
      return false;
    }
    const hook = this.placementPreviewHooks.canPlaceRoadPreview;
    if (hook && !hook(x, y)) return false;
    return true;
  }

  private effectiveRoadForPreview(
    x: number,
    y: number,
    addKeys: Set<string>,
    removeKeys: Set<string>
  ): boolean {
    const key = `${x},${y}`;
    const tile = this.tileMap.getTile(x, y);
    if (!tile) return false;
    if (removeKeys.has(key)) return false;
    if (addKeys.has(key)) {
      if (tile.hasRoad && !tile.isOccupied()) return true;
      return this.canPreviewAddRoadAt(x, y);
    }
    return !!tile.hasRoad;
  }

  private getRoadMaskForPreview(
    gx: number,
    gy: number,
    addKeys: Set<string>,
    removeKeys: Set<string>
  ): number {
    const hasRoadAt = (nx: number, ny: number): boolean =>
      this.effectiveRoadForPreview(nx, ny, addKeys, removeKeys);
    let config = 0;
    if (hasRoadAt(gx - 1, gy)) config |= 1;
    if (hasRoadAt(gx, gy - 1)) config |= 2;
    if (hasRoadAt(gx + 1, gy)) config |= 4;
    if (hasRoadAt(gx, gy + 1)) config |= 8;
    return config;
  }

  private strokeRoadPreviewInvalidTile(gridX: number, gridY: number): void {
    const corners = this.iso.getTileCorners(gridX, gridY);
    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y);
    corners.forEach(c => this.ctx.lineTo(c.x, c.y));
    this.ctx.closePath();
    this.ctx.fillStyle = 'rgba(200, 50, 50, 0.22)';
    this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(200, 50, 50, 0.85)';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
  }

  private strokeRoadPreviewDeleteTarget(gridX: number, gridY: number): void {
    const tile = this.tileMap.getTile(gridX, gridY);
    if (!tile || !tile.hasRoad || tile.isOccupied()) {
      this.strokeRoadPreviewInvalidTile(gridX, gridY);
      return;
    }
    const corners = this.iso.getTileCorners(gridX, gridY);
    this.ctx.beginPath();
    this.ctx.moveTo(corners[0].x, corners[0].y);
    corners.forEach(c => this.ctx.lineTo(c.x, c.y));
    this.ctx.closePath();
    this.ctx.fillStyle = 'rgba(220, 60, 60, 0.18)';
    this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(255, 120, 110, 0.95)';
    this.ctx.lineWidth = 2.5;
    this.ctx.stroke();
  }

  private canPlacePreview(gridX: number, gridY: number, width: number, depth: number): boolean {
    for (let dy = 0; dy < depth; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const tile = this.tileMap.getTile(gridX + dx, gridY + dy);
        if (!tile || !tile.walkable || tile.isOccupied()) return false;
      }
    }
    const mode = this.buildPreview?.mode;
    if (mode && mode.startsWith('build_')) {
      const type = mode.slice('build_'.length);
      const hook = this.placementPreviewHooks.canPlaceBuildingPreview;
      if (hook && !hook(type, gridX, gridY, width, depth)) return false;
    }
    return true;
  }

  private renderBuildingPreview(
    gridX: number,
    gridY: number,
    width: number,
    depth: number,
    height: number,
    color: string,
    offsetX: number = 0,
    offsetY: number = 0
  ): void {
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
    this.ctx.translate(screenPos.x + offsetX, screenPos.y - this.iso.tileHeight / 2 + offsetY);

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
    // Alt/Option insight — full grid at any zoom
    if (this.showInsightGrid) return 0.34;
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

  private cordonStickFootAndTop(gx: number, gy: number): {
    foot: { x: number; y: number };
    top: { x: number; y: number };
  } {
    const h = this.iso.tileHeight * 0.56;
    const foot = this.iso.gridToScreen(gx, gy);
    return { foot, top: { x: foot.x, y: foot.y - h } };
  }

  private renderCordonStickAt(gx: number, gy: number): void {
    const zoom = Math.max(0.35, this.camera.zoom);
    const { foot, top } = this.cordonStickFootAndTop(gx, gy);
    this.ctx.save();
    this.ctx.lineCap = 'round';
    this.ctx.strokeStyle = 'rgba(48, 30, 14, 0.96)';
    this.ctx.lineWidth = 3.2 / zoom;
    this.ctx.beginPath();
    this.ctx.moveTo(foot.x, foot.y);
    this.ctx.lineTo(top.x, top.y);
    this.ctx.stroke();
    this.ctx.strokeStyle = 'rgba(110, 72, 38, 0.75)';
    this.ctx.lineWidth = 1.25 / zoom;
    this.ctx.beginPath();
    this.ctx.moveTo(foot.x, foot.y);
    this.ctx.lineTo(top.x, top.y);
    this.ctx.stroke();
    this.ctx.restore();
  }

  /** One sagging arc between two cordon cell stick tops (single quadratic). */
  private renderCordonRopeBetweenCellTops(
    ax: number,
    ay: number,
    bx: number,
    by: number
  ): void {
    const zoom = Math.max(0.35, this.camera.zoom);
    const a = this.cordonStickFootAndTop(ax, ay).top;
    const b = this.cordonStickFootAndTop(bx, by).top;
    const midX = (a.x + b.x) * 0.5;
    const midY = (a.y + b.y) * 0.5;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const sag = Math.min(16, 5 + dist * 0.2);
    this.ctx.save();
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = 'rgba(101, 67, 33, 0.92)';
    this.ctx.lineWidth = 2.35 / zoom;
    this.ctx.beginPath();
    this.ctx.moveTo(a.x, a.y);
    this.ctx.quadraticCurveTo(midX, midY + sag, b.x, b.y);
    this.ctx.stroke();
    this.ctx.restore();
  }

  /**
   * Pole cells (sparse sticks) + rope segments along the full cordon graph:
   * every cardinal and diagonal link between two frontier cells gets one sagging arc
   * (so bends and diagonals are closed; not only straight pole-to-pole rays).
   */
  private buildCordonGeometry(frontier: ReadonlySet<string>): {
    poleKeys: Set<string>;
    ropes: Array<{ ax: number; ay: number; bx: number; by: number; dBack: number }>;
  } {
    const stride = CORDON_POLE_STRIDE_CELLS;
    const poleKeys = new Set<string>();
    for (const k of frontier) {
      const [xs, ys] = k.split(',');
      const x = Number(xs);
      const y = Number(ys);
      if (((x + y) % stride + stride) % stride === 0) {
        poleKeys.add(k);
      }
    }

    const directions: readonly [number, number][] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ];
    const ropes: Array<{ ax: number; ay: number; bx: number; by: number; dBack: number }> = [];
    const seenEdge = new Set<string>();
    const edgeKey = (x0: number, y0: number, x1: number, y1: number): string => {
      const a = territoryKey(x0, y0);
      const b = territoryKey(x1, y1);
      return a < b ? `${a}|${b}` : `${b}|${a}`;
    };

    for (const k of frontier) {
      const [xs, ys] = k.split(',');
      const x = Number(xs);
      const y = Number(ys);
      for (const [dx, dy] of directions) {
        const nx = x + dx;
        const ny = y + dy;
        if (!frontier.has(territoryKey(nx, ny))) continue;
        const ek = edgeKey(x, y, nx, ny);
        if (seenEdge.has(ek)) continue;
        seenEdge.add(ek);
        const dBack = Math.min(x + y, nx + ny);
        ropes.push({ ax: x, ay: y, bx: nx, by: ny, dBack });
      }
    }

    return { poleKeys, ropes };
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

  /**
   * Iso draw depth: larger value = closer to the camera = should be drawn later (on top).
   * Buildings use the front corner of the footprint; walkers use fractional tile position while moving.
   */
  private getEntityDrawDepthFloat(entity: Entity): number {
    const pos = entity.getComponent(Position);
    if (!pos) return 0;
    const building = entity.getComponent(Building);
    if (building && !entity.getComponent(Worker)) {
      return pos.x + pos.y + building.width + building.height - 2;
    }
    return pos.x + pos.y;
  }

  /**
   * Depth used for ordering and diagonal buckets. Must match `compareEntityDrawOrder`.
   *
   * **Footprint awareness (buildings):** We sort each building using one number: the grid
   * `x+y` of its **front** (south-most) footprint tile — same as `pos + width + height - 2`
   * from the placement anchor. The PNG also draws **upward** in pixels; that does not change
   * ground depth (things “above” the base don’t need a separate z unless we split the mesh).
   *
   * **Workers vs that metric:** `Position` is interpolated along paths, so `pos.x+pos.y` can
   * stay a fraction **behind** the façade while the sprite is already on a **forward** tile
   * (larger `x+y` = lower on screen in this projection). We therefore clamp walker sort depth
   * to at least the **south-east step** of the tile they are standing in: `floor(x)+floor(y)+1`.
   * That matches “lower on screen ⇒ drawn later” with how buildings are keyed.
   */
  private getEntityDrawDepthForSort(entity: Entity): number {
    const base = this.getEntityDrawDepthFloat(entity);
    if (!entity.hasComponent(Worker)) return base;
    const pos = entity.getComponent(Position);
    if (!pos) return base;
    const southCellSum = Math.floor(pos.x) + Math.floor(pos.y) + 1;
    return Math.max(base, southCellSum);
  }

  /** Primary: float depth; tie: workers render after buildings so carriers are not hidden by facades. */
  private compareEntityDrawOrder(a: Entity, b: Entity): number {
    const da = this.getEntityDrawDepthForSort(a);
    const db = this.getEntityDrawDepthForSort(b);
    if (da < db) return -1;
    if (da > db) return 1;
    const wa = a.hasComponent(Worker);
    const wb = b.hasComponent(Worker);
    const bb = !!b.getComponent(Building);
    const ba = !!a.getComponent(Building);
    if (wa && !wb && bb) return 1;
    if (wb && !wa && ba) return -1;
    return 0;
  }

  /** Logical/render grid position during a jump arc (matches `renderWildRabbit`). */
  private getWildRabbitGridPosition(rabbit: WildRabbit): { gx: number; gy: number } {
    const j = rabbit.jumping;
    let gx = rabbit.x;
    let gy = rabbit.y;
    if (j) {
      const nowMs = Date.now();
      const rawT = (nowMs - j.startMs) / RABBIT_JUMP_DURATION_MS;
      const t = Math.max(0, Math.min(1, rawT));
      const u = 1 - (1 - t) * (1 - t);
      gx = j.fromX + (j.toX - j.fromX) * u;
      gy = j.fromY + (j.toY - j.fromY) * u;
    }
    return { gx, gy };
  }

  /**
   * Same rule as walkers in `getEntityDrawDepthForSort` so rabbits interleave with trees/entities by iso depth.
   */
  private getWildRabbitDrawDepthForSort(rabbit: WildRabbit): number {
    const { gx, gy } = this.getWildRabbitGridPosition(rabbit);
    const base = gx + gy;
    const southCellSum = Math.floor(gx) + Math.floor(gy) + 1;
    return Math.max(base, southCellSum);
  }

  private compareEntityOrRabbitDrawOrder(
    a: { kind: 'entity'; entity: Entity } | { kind: 'rabbit'; rabbit: WildRabbit },
    b: { kind: 'entity'; entity: Entity } | { kind: 'rabbit'; rabbit: WildRabbit }
  ): number {
    const da = a.kind === 'entity' ? this.getEntityDrawDepthForSort(a.entity) : this.getWildRabbitDrawDepthForSort(a.rabbit);
    const db = b.kind === 'entity' ? this.getEntityDrawDepthForSort(b.entity) : this.getWildRabbitDrawDepthForSort(b.rabbit);
    if (da < db) return -1;
    if (da > db) return 1;
    if (a.kind !== b.kind) {
      // Tie: draw rabbits before entities so workers/buildings stay visually in front when co-depth.
      if (a.kind === 'rabbit' && b.kind === 'entity') return -1;
      return 1;
    }
    if (a.kind === 'entity' && b.kind === 'entity') {
      return this.compareEntityDrawOrder(a.entity, b.entity);
    }
    if (a.kind === 'rabbit' && b.kind === 'rabbit') {
      return a.rabbit.x - b.rabbit.x || a.rabbit.y - b.rabbit.y || a.rabbit.id - b.rabbit.id;
    }
    return 0;
  }

  /**
   * Procedural rabbit: elliptical body, two axis-aligned hind-foot rectangles, head/eyes/nose tilted ~45°;
   * nose below eyes and offset sideways (3/4 turn); ears tight; tail fluff; jump unchanged.
   */
  private renderWildRabbit(rabbit: WildRabbit): void {
    const ctx = this.ctx;
    const nowMs = Date.now();
    const j = rabbit.jumping;
    const { gx, gy } = this.getWildRabbitGridPosition(rabbit);
    let jumpArcPx = 0;
    if (j) {
      const rawT = (nowMs - j.startMs) / RABBIT_JUMP_DURATION_MS;
      const t = Math.max(0, Math.min(1, rawT));
      jumpArcPx = -Math.sin(Math.PI * t) * 34;
    }

    const base = this.iso.gridToScreen(gx, gy);
    const cx = base.x;
    const cy = base.y + jumpArcPx - this.iso.tileHeight * 0.12;

    const bodyFill =
      rabbit.variant === 'white'
        ? '#ebe4dc'
        : rabbit.variant === 'beige'
          ? '#c9b89a'
          : '#7a5e3d';
    const footFill =
      rabbit.variant === 'white' ? '#cfc7be' : rabbit.variant === 'beige' ? '#a8987a' : '#5c472e';

    let leftLift = 0;
    let rightLift = 0;
    if (j) {
      const rawT = (nowMs - j.startMs) / RABBIT_JUMP_DURATION_MS;
      const t = Math.max(0, Math.min(1, rawT));
      const kick = Math.sin(Math.PI * t) * 3.5;
      leftLift = kick;
      rightLift = -kick;
    }

    const mirrorHead = Math.floor(nowMs / 680 + rabbit.animSeed * 0.37) % 2 === 0;
    const RABBIT_VISUAL_SCALE = 0.7;
    const tailOnRight = (Math.floor(rabbit.animSeed * 7.13) & 1) === 0;
    /** Nose sits on this side of the muzzle (suggests head turned); flips with mirror. */
    const noseSide = tailOnRight ? 1 : -1;

    /** Tilt head / face plane (~45°) for a three-quarter read. */
    const HEAD_TILT = -Math.PI / 4;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(RABBIT_VISUAL_SCALE, RABBIT_VISUAL_SCALE);

    /** Ellipse matches prior triangle footprint (~22 wide × ~9 tall). */
    const bodyCx = 2;
    const bodyCy = -9;
    const bodyRx = 7;
    const bodyRy = 8;
    const bodyBaseY = bodyCy + bodyRy;

    const tailCx = tailOnRight ? bodyRx + 2.5 : -bodyRx - 2.5;
    const tailCy = bodyCy + bodyRy * 0.35;
    const fluff: Array<[number, number, number, string]> = [
      [0, 0, 4.2, 'rgba(255,248,245,0.92)'],
      [-2.2, 1.1, 3.2, 'rgba(255,230,235,0.75)'],
      [2.4, 0.8, 3.4, 'rgba(248,236,255,0.7)'],
      [-1.2, -2.0, 2.6, 'rgba(255,255,255,0.55)'],
      [1.8, -1.4, 2.8, 'rgba(255,220,230,0.65)'],
    ];
    for (const [ox, oy, rad, col] of fluff) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(tailCx + ox, tailCy + oy, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = bodyFill;
    ctx.beginPath();
    ctx.ellipse(bodyCx, bodyCy, bodyRx, bodyRy, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = footFill;
    const footW = 8;
    const footH = 3;
    const footGap = 0;
    const footTop = bodyBaseY - 0.35;
    const footTiltRad = ((35 * (tailOnRight ? -1 : 1)) * Math.PI) / 180;
    const drawFoot = (x0: number, y0: number): void => {
      ctx.save();
      ctx.translate(x0 + footW / 2 + 5, y0);
      ctx.rotate(footTiltRad);
      ctx.fillRect(-footW / 2, 0, footW, footH);
      ctx.restore();
    };
    drawFoot(-bodyRx + footGap, footTop + leftLift);
    drawFoot(bodyRx - footGap - footW, footTop + rightLift);

    const neckY = bodyCy - bodyRy + 0.45;
    ctx.save();
    ctx.translate(0, neckY);
    ctx.rotate(HEAD_TILT);
    ctx.scale(mirrorHead ? 1 : -1, 1);

    ctx.fillStyle = bodyFill;
    ctx.fillRect(-2.4, -11.2, 2.1, 7.8);
    ctx.fillRect(0.35, -11.2, 2.1, 7.8);

    ctx.beginPath();
    ctx.arc(0, -2.2, 5.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#2a2218';
    ctx.beginPath();
    ctx.arc(-1.55, -0.2, 0.95, 0, Math.PI * 2);
    ctx.arc(1.55, -0.2, 0.95, 0, Math.PI * 2);
    ctx.fill();

    const nx = noseSide * 2.85;
    const ny = 2.1;
    ctx.fillStyle = '#f4a8c8';
    ctx.beginPath();
    ctx.moveTo(nx, ny);
    ctx.lineTo(nx - 1.35, ny + 2.35);
    ctx.lineTo(nx + 1.35, ny + 2.35);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    ctx.restore();
  }

  private collectVisibleWildRabbits(viewportBounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  }): WildRabbit[] {
    if (!this.getWildRabbits) return [];
    const list: WildRabbit[] = [];
    for (const rabbit of this.getWildRabbits()) {
      const j = rabbit.jumping;
      const inVp =
        rabbit.x >= viewportBounds.minX &&
        rabbit.x <= viewportBounds.maxX &&
        rabbit.y >= viewportBounds.minY &&
        rabbit.y <= viewportBounds.maxY;
      const inVpJumpTo =
        !!j &&
        j.toX >= viewportBounds.minX &&
        j.toX <= viewportBounds.maxX &&
        j.toY >= viewportBounds.minY &&
        j.toY <= viewportBounds.maxY;
      if (!inVp && !inVpJumpTo) continue;
      const rt = this.tileMap.getTile(rabbit.x, rabbit.y);
      if (!rt?.isExplored()) continue;
      list.push(rabbit);
    }
    list.sort((a, b) => a.x + a.y - (b.x + b.y) || a.x - b.x);
    return list;
  }

  private renderDepthSorted(
    sortedEntities: Entity[],
    viewportBounds: { minX: number; maxX: number; minY: number; maxY: number },
    cordonPack: { frontier: ReadonlySet<string>; unionU: ReadonlySet<string> } | null
  ): void {
    const minDepth = viewportBounds.minX + viewportBounds.minY;
    const maxDepth = viewportBounds.maxX + viewportBounds.maxY;

    const cordonGeo =
      cordonPack && cordonPack.frontier.size > 0
        ? this.buildCordonGeometry(cordonPack.frontier)
        : null;

    const { blocks: mountainBlocks, covered: mountainCovered } = this.findMountainBlocks(viewportBounds);

    // Index mountain blocks by their back-corner depth for correct draw order
    const blocksByDepth = new Map<number, { x: number; y: number }[]>();
    for (const block of mountainBlocks) {
      const depth = block.x + block.y + 6;
      const list = blocksByDepth.get(depth);
      if (list) list.push(block);
      else blocksByDepth.set(depth, [block]);
    }

    // Index entities by integer depth slice (floor of sort depth — must match compareEntityDrawOrder)
    const entitiesByDepth = new Map<number, Entity[]>();
    for (const entity of sortedEntities) {
      const d = Math.floor(this.getEntityDrawDepthForSort(entity));
      const list = entitiesByDepth.get(d);
      if (list) {
        list.push(entity);
      } else {
        entitiesByDepth.set(d, [entity]);
      }
    }

    for (const list of entitiesByDepth.values()) {
      list.sort((a, b) => this.compareEntityDrawOrder(a, b));
    }

    const rabbitsByDepth = new Map<number, WildRabbit[]>();
    for (const rabbit of this.collectVisibleWildRabbits(viewportBounds)) {
      const d = Math.floor(this.getWildRabbitDrawDepthForSort(rabbit));
      const list = rabbitsByDepth.get(d);
      if (list) list.push(rabbit);
      else rabbitsByDepth.set(d, [rabbit]);
    }
    for (const list of rabbitsByDepth.values()) {
      list.sort((a, b) => a.x + a.y - (b.x + b.y) || a.x - b.x || a.id - b.id);
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

      // Cordon sticks at this depth (behind trees/rocks on the same tile)
      if (cordonGeo) {
        for (let x = xMin; x <= xMax; x++) {
          const y = d - x;
          const k = territoryKey(x, y);
          if (!cordonGeo.poleKeys.has(k)) continue;
          const t = this.tileMap.getTile(x, y);
          if (!t?.isExplored()) continue;
          this.renderCordonStickAt(x, y);
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

      // Cordon ropes: one arc per pole-to-pole chain; draw after the rear (min depth) tile's trees
      if (cordonGeo) {
        for (const seg of cordonGeo.ropes) {
          if (seg.dBack !== d) continue;
          this.renderCordonRopeBetweenCellTops(seg.ax, seg.ay, seg.bx, seg.by);
        }
      }

      // Entities and wild rabbits at this depth (same float-depth rules as walkers vs trees)
      const entities = entitiesByDepth.get(d);
      const rabbitsHere = rabbitsByDepth.get(d);
      const merged: Array<
        { kind: 'entity'; entity: Entity } | { kind: 'rabbit'; rabbit: WildRabbit }
      > = [];
      if (entities) {
        for (const entity of entities) {
          if (this.surveyWorkerDrawOnTopIds.has(entity.id)) continue;
          merged.push({ kind: 'entity', entity });
        }
      }
      if (rabbitsHere) {
        for (const rabbit of rabbitsHere) {
          merged.push({ kind: 'rabbit', rabbit });
        }
      }
      if (merged.length > 0) {
        merged.sort((a, b) => this.compareEntityOrRabbitDrawOrder(a, b));
        for (const item of merged) {
          if (item.kind === 'entity') this.renderEntity(item.entity);
          else this.renderWildRabbit(item.rabbit);
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

    if (
      this.insightHighlightRock &&
      this.insightHighlightRock.x === tile.x &&
      this.insightHighlightRock.y === tile.y &&
      tile.isExplored()
    ) {
      const c = this.iso.getTileCorners(tile.x, tile.y);
      this.ctx.save();
      this.ctx.strokeStyle = 'rgba(255, 215, 100, 0.98)';
      this.ctx.lineWidth = 2.5;
      this.ctx.shadowColor = 'rgba(255, 190, 60, 0.75)';
      this.ctx.shadowBlur = 12;
      this.ctx.beginPath();
      this.ctx.moveTo(c[0].x, c[0].y);
      for (let i = 1; i < c.length; i++) {
        this.ctx.lineTo(c[i].x, c[i].y);
      }
      this.ctx.closePath();
      this.ctx.stroke();
      this.ctx.restore();
    }

    if (
      this.insightHighlightWater &&
      this.insightHighlightWater.x === tile.x &&
      this.insightHighlightWater.y === tile.y &&
      tile.isExplored() &&
      tile.terrain === 'water'
    ) {
      const c = this.iso.getTileCorners(tile.x, tile.y);
      this.ctx.save();
      this.ctx.strokeStyle = 'rgba(120, 200, 255, 0.95)';
      this.ctx.lineWidth = 2.5;
      this.ctx.shadowColor = 'rgba(80, 160, 255, 0.65)';
      this.ctx.shadowBlur = 12;
      this.ctx.beginPath();
      this.ctx.moveTo(c[0].x, c[0].y);
      for (let i = 1; i < c.length; i++) {
        this.ctx.lineTo(c[i].x, c[i].y);
      }
      this.ctx.closePath();
      this.ctx.stroke();
      this.ctx.restore();
    }
  }

  private renderFishJumps(): void {
    const now = Date.now();
    const JUMP_DURATION = 1200;

    if (now >= this.nextFishSpawn) {
      this.spawnFish();
      this.nextFishSpawn = now + nextFishSpawnGapMs();
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
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = bounds.minX + Math.floor(Math.random() * w);
      const y = bounds.minY + Math.floor(Math.random() * h);
      const tile = this.tileMap.getTile(x, y);
      if (!tile || tile.terrain !== 'water' || !tile.isExplored()) continue;
      if (this.tileMap.getWaterFishRemainingAt(x, y) <= 0) continue;
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
      const splashX = entering ? baseX : baseX + 8 * dir;
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
    const offsetX = renderable.offsetX;
    const offsetY = renderable.offsetY;

    this.ctx.save();

    const isInactive = building && !building.isActive;
    const isUnderConstruction = building && (building.state === 'under_construction' || building.state === 'awaiting_materials');

    // Apply fade effect for selected buildings
    if (isSelected && building) {
      this.ctx.globalAlpha = 0.7;
    }

    // Apply opacity fade for under-construction buildings without construction sprites
    if (isUnderConstruction && !BUILDING_CONSTRUCTION_SPRITES[building!.buildingType]) {
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
      this.ctx.translate(screenPos.x + offsetX, screenPos.y - this.iso.tileHeight / 2 + offsetY);
    } else {
      // Non-buildings render at tile center
      this.ctx.translate(screenPos.x + offsetX, screenPos.y + offsetY);
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

      const insightHighlight = entity.id === this.insightHighlightEntityId;
      const production = entity.getComponent(Production) ?? null;
      if (renderable.spritePath) {
        this.renderBuildingSprite(building, renderable, production, isSelected, insightHighlight);
      } else {
        this.renderIsometricBuilding(building, renderable, isSelected, insightHighlight);
      }

      const chimneyCfg = dataManager.getBuilding(building.buildingType)?.chimneySmoke;
      if (chimneyCfg && building.isComplete() && building.state === 'complete') {
        const chimneySmoke = this.chimneySmokes.get(entity.id);
        if (chimneySmoke) chimneySmoke.draw(this.ctx);
      }
      if (building.state === 'under_construction') {
        const constructionSmoke = this.constructionSmokes.get(entity.id);
        if (constructionSmoke) constructionSmoke.smoke.draw(this.ctx);
      }

      if (entrance) {
        this.ctx.restore();
      }
    } else if (entity.hasComponent(Worker)) {
      const movable = entity.getComponent(Movable) ?? null;
      const worker = entity.getComponent(Worker)!;
      if (worker.concealedInBuildingId == null) {
        const tw = worker.fisherTowardWater;
        if (
          tw &&
          worker.carryingResource === 'fishing_rod' &&
          worker.visualActivity === 'production_gather' &&
          worker.state === 'working' &&
          movable &&
          !movable.isMoving
        ) {
          const gx = Math.floor(renderX);
          const gy = Math.floor(renderY);
          const pStand = this.iso.gridToScreen(gx, gy);
          const pWater = this.iso.gridToScreen(gx + tw.dx, gy + tw.dy);
          const k = 0.26;
          this.ctx.translate((pWater.x - pStand.x) * k, (pWater.y - pStand.y) * k);
        }
        this.renderWorkerSprite(movable, worker);
      }
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
      if (building.getMilitaryGarrisonFilledCount() > 0) {
        this.renderGarrisonStarMarker(building);
      }
      if (building.isActive && building.outOfMapResources) {
        const bd = dataManager.getBuilding(building.buildingType);
        if (bd?.animation?.type === 'gather' || building.buildingType === 'well') {
          this.renderMapResourcesExhaustedMarker(building);
        }
      }
    }

    this.ctx.restore();
  }

  /** Orange X above roof when lumberjack / quarry / fisher cannot reach any map source, or a well’s aquifer is dry. */
  private renderMapResourcesExhaustedMarker(building: Building): void {
    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;
    const centerX = ((building.width - building.height) * tileW) / 4;
    const centerY = ((building.width + building.height) * tileH) / 4;
    const bob = Math.sin(Date.now() * 0.004) * 2.5;
    const y = centerY - building.buildingHeight - 28 + bob;
    const size = 11;

    this.ctx.save();
    this.ctx.translate(centerX, y);
    this.ctx.strokeStyle = '#ff7043';
    this.ctx.lineWidth = 3;
    this.ctx.lineCap = 'round';
    this.ctx.beginPath();
    this.ctx.moveTo(-size, -size);
    this.ctx.lineTo(size, size);
    this.ctx.moveTo(size, -size);
    this.ctx.lineTo(-size, size);
    this.ctx.stroke();
    this.ctx.restore();
  }

  /** Gold star on the right/front side for military posts with at least one garrisoned soldier. */
  private renderGarrisonStarMarker(building: Building): void {
    const tileW = this.iso.tileWidth;
    const tileH = this.iso.tileHeight;
    const centerX = ((building.width - building.height) * tileW) / 4;
    const frontY = ((building.width + building.height) * tileH) / 2;
    const markerX = centerX + building.width * (tileW / 4) + 16;
    const markerY = frontY - building.buildingHeight * 0.35 - 6;
    const outer = 8;
    const inner = 3.5;

    this.ctx.save();
    this.ctx.translate(markerX, markerY);
    this.ctx.fillStyle = '#ffd54f';
    this.ctx.strokeStyle = 'rgba(70, 45, 0, 0.95)';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const angle = -Math.PI / 2 + i * (Math.PI / 5);
      const r = i % 2 === 0 ? outer : inner;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    }
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.restore();
  }

  private getConstructionSpritePath(building: Building, renderable: Renderable): string | undefined {
    if ((building.state !== 'under_construction' && building.state !== 'awaiting_materials') || !renderable.spritePath) return renderable.spritePath;
    const stages = BUILDING_CONSTRUCTION_SPRITES[building.buildingType];
    if (!stages || stages.length === 0) return renderable.spritePath;
    const totalFrames = stages.length + 1;
    const frameIndex = Math.min(Math.floor(building.constructionProgress * totalFrames), stages.length);
    return frameIndex < stages.length ? stages[frameIndex] : renderable.spritePath;
  }

  private getProductionSpritePath(
    building: Building,
    renderable: Renderable,
    production?: Production | null
  ): string | undefined {
    if (!renderable.spritePath || !production) return renderable.spritePath;
    if (!building.isComplete()) return renderable.spritePath;
    if (building.state !== 'complete') return renderable.spritePath;
    if (production.status !== 'producing') return renderable.spritePath;
    if (production.productionTime <= 0) return renderable.spritePath;

    const stages = BUILDING_PRODUCTION_SPRITES[building.buildingType];
    if (!stages || stages.length === 0) return renderable.spritePath;

    const progress = Math.max(0, Math.min(0.999999, production.getProgress()));
    const totalSlices = stages.length + 2;
    const slice = Math.floor(progress * totalSlices);
    const stageIndex = Math.min(slice, stages.length - 1);
    return stages[stageIndex] ?? renderable.spritePath;
  }

  private getBuildingSpritePath(
    building: Building,
    renderable: Renderable,
    production?: Production | null
  ): string | undefined {
    if (building.state === 'under_construction' || building.state === 'awaiting_materials') {
      return this.getConstructionSpritePath(building, renderable);
    }
    return this.getProductionSpritePath(building, renderable, production);
  }

  private getBuildingSpriteVisualScale(buildingType: string): number {
    const def = dataManager.getBuilding(buildingType as BuildingType);
    const s = def?.visual?.spriteScale;
    return typeof s === 'number' && s > 0 && Number.isFinite(s) ? s : 1;
  }

  private renderBuildingSprite(
    building: Building,
    renderable: Renderable,
    production: Production | null,
    isSelected: boolean = false,
    insightHighlight: boolean = false
  ): void {
    const spritePath = this.getBuildingSpritePath(building, renderable, production);
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

    const baseCorners = [
      { x: 0, y: 0 },
      { x: width * tileW / 2, y: width * tileH / 2 },
      { x: (width - depth) * tileW / 2, y: (width + depth) * tileH / 2 },
      { x: -depth * tileW / 2, y: depth * tileH / 2 }
    ];

    if (isSelected) {
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

    if (insightHighlight) {
      this.ctx.save();
      this.ctx.strokeStyle = 'rgba(255, 220, 120, 0.98)';
      this.ctx.lineWidth = isSelected ? 3.5 : 4;
      this.ctx.shadowColor = 'rgba(255, 200, 70, 0.85)';
      this.ctx.shadowBlur = 14;
      this.ctx.beginPath();
      baseCorners.forEach((corner, i) => {
        if (i === 0) this.ctx.moveTo(corner.x, corner.y);
        else this.ctx.lineTo(corner.x, corner.y);
      });
      this.ctx.closePath();
      this.ctx.stroke();
      this.ctx.restore();
    }
  }

  private renderIsometricBuilding(
    building: Building,
    renderable: Renderable,
    isSelected: boolean = false,
    insightHighlight: boolean = false
  ): void {
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

    if (insightHighlight) {
      this.ctx.save();
      this.ctx.strokeStyle = 'rgba(255, 215, 100, 0.98)';
      this.ctx.lineWidth = 3;
      this.ctx.shadowColor = 'rgba(255, 190, 60, 0.8)';
      this.ctx.shadowBlur = 12;
      this.ctx.beginPath();
      baseCorners.forEach((corner, i) => {
        if (i === 0) this.ctx.moveTo(corner.x, corner.y);
        else this.ctx.lineTo(corner.x, corner.y);
      });
      this.ctx.closePath();
      this.ctx.stroke();
      this.ctx.beginPath();
      topCorners.forEach((corner, i) => {
        if (i === 0) this.ctx.moveTo(corner.x, corner.y);
        else this.ctx.lineTo(corner.x, corner.y);
      });
      this.ctx.closePath();
      this.ctx.stroke();
      this.ctx.restore();
    }
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
    const iconDraw = 14 * RESOURCE_ICON_DRAW_SCALE;
    const pillW = hasIcon ? Math.round(34 * RESOURCE_ICON_DRAW_SCALE) : 20;
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
      this.ctx.drawImage(icon!, -pillW / 2 + 3, -iconDraw / 2 - 0.5, iconDraw, iconDraw);
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
        const jw = 10 * RESOURCE_ICON_DRAW_SCALE;
        const jHalf = jw / 2;
        if (resSprite) {
          this.ctx.drawImage(resSprite, ix - jHalf, iy - jHalf, jw, jw);
        } else {
          this.ctx.fillStyle = '#6b5020';
          this.ctx.fillRect(ix - 4 * RESOURCE_ICON_DRAW_SCALE, iy - 1 * RESOURCE_ICON_DRAW_SCALE, 8 * RESOURCE_ICON_DRAW_SCALE, 4 * RESOURCE_ICON_DRAW_SCALE);
          this.ctx.fillStyle = '#8b6914';
          this.ctx.fillRect(ix - 4 * RESOURCE_ICON_DRAW_SCALE, iy - 4 * RESOURCE_ICON_DRAW_SCALE, 8 * RESOURCE_ICON_DRAW_SCALE, 4 * RESOURCE_ICON_DRAW_SCALE);
          this.ctx.fillStyle = '#a07818';
          this.ctx.fillRect(ix - 3 * RESOURCE_ICON_DRAW_SCALE, iy - 4 * RESOURCE_ICON_DRAW_SCALE, 6 * RESOURCE_ICON_DRAW_SCALE, 2 * RESOURCE_ICON_DRAW_SCALE);
          this.ctx.strokeStyle = '#4a3510';
          this.ctx.lineWidth = 0.5;
          this.ctx.strokeRect(ix - 4 * RESOURCE_ICON_DRAW_SCALE, iy - 4 * RESOURCE_ICON_DRAW_SCALE, 8 * RESOURCE_ICON_DRAW_SCALE, 7 * RESOURCE_ICON_DRAW_SCALE);
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

  private syncWorkerIdleNapClock(worker: Worker, _movable: Movable | null, isMoving: boolean): void {
    if (worker.concealedInBuildingId != null) {
      worker.idleContinuousSinceMs = null;
      worker.floorSleepUntilMs = null;
      worker.floorSleepStartedAtMs = null;
      worker.nextFloorSleepProbeMs = null;
      return;
    }
    if (isMoving || worker.state !== 'idle' || worker.carryingResource) {
      worker.idleContinuousSinceMs = null;
      worker.floorSleepUntilMs = null;
      worker.floorSleepStartedAtMs = null;
      worker.nextFloorSleepProbeMs = null;
      return;
    }
    const now = Date.now();
    if (worker.idleContinuousSinceMs == null) {
      worker.idleContinuousSinceMs = now;
    }
  }

  /** Standing still long enough before floor-nap rolls (ms). */
  private static readonly FLOOR_NAP_MIN_IDLE_MS = 95_000;
  /** Floor nap length range (ms). */
  private static readonly FLOOR_NAP_MS_MIN = 52_000;
  private static readonly FLOOR_NAP_MS_MAX = 118_000;
  /** Per probe, chance to start a nap once idle threshold is met. */
  private static readonly FLOOR_NAP_ROLL = 0.052;

  private updateIdleAnimation(worker: Worker): void {
    const now = Date.now();
    if (
      (worker.visualActivity === 'production_well' || worker.visualActivity === 'production_mill') &&
      worker.state === 'working'
    ) {
      return;
    }
    if (worker.visualActivity === 'production_plant' && worker.state === 'working') {
      return;
    }
    if (
      worker.visualActivity === 'production_gather' &&
      worker.state === 'working' &&
      worker.carryingResource === 'pickaxe'
    ) {
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

    if (worker.floorSleepUntilMs != null) {
      if (now >= worker.floorSleepUntilMs) {
        worker.floorSleepUntilMs = null;
        worker.floorSleepStartedAtMs = null;
        worker.idleContinuousSinceMs = now;
        worker.nextIdleCheck = now + 2000 + Math.random() * 5000;
        worker.nextFloorSleepProbeMs = now + 18_000 + Math.random() * 42_000;
      } else {
        return;
      }
    }

    if (
      worker.state === 'idle' &&
      !worker.carryingResource &&
      worker.idleContinuousSinceMs != null &&
      now - worker.idleContinuousSinceMs >= RenderSystem.FLOOR_NAP_MIN_IDLE_MS
    ) {
      if (worker.nextFloorSleepProbeMs == null) {
        worker.nextFloorSleepProbeMs = now + 7000 + Math.random() * 11_000;
      }
      if (now >= worker.nextFloorSleepProbeMs) {
        worker.nextFloorSleepProbeMs = now + 11_000 + Math.random() * 19_000;
        if (Math.random() < RenderSystem.FLOOR_NAP_ROLL) {
          worker.floorSleepStartedAtMs = now;
          worker.floorSleepUntilMs =
            now +
            RenderSystem.FLOOR_NAP_MS_MIN +
            Math.random() * (RenderSystem.FLOOR_NAP_MS_MAX - RenderSystem.FLOOR_NAP_MS_MIN);
          worker.idleAnim = 'none';
          return;
        }
      }
    } else {
      worker.nextFloorSleepProbeMs = null;
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

  private paintWorkerSpriteBody(p: {
    worker: Worker;
    s: number;
    facing: number;
    isMoving: boolean;
    frame: number;
    now: number;
    anim: IdleAnim;
    animT: number;
    isCarrying: boolean;
    isHammerConstruct: boolean;
    isPlantDigging: boolean;
    isFisherFishing: boolean;
    isStoneGathering: boolean;
    isSideCarryTool: boolean;
    isOverheadCarry: boolean;
    armAnim: IdleAnim;
    drawRoundFootShadow: boolean;
    napPillowArms: boolean;
  }): void {
    paintWorkerBodyToCanvas(this.ctx, (path) => this.loadSprite(path), p);
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

    this.syncWorkerIdleNapClock(worker, movable, isMoving);

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
    // Keep military close to civilian size; body proportions are normalized in painter.
    const s = worker.role === 'military' ? 2.05 : 2;
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

    const isPlantDigging =
      isCarrying &&
      worker.carryingResource === 'shovel' &&
      (worker.visualActivity === 'production_plant' || worker.visualActivity === 'survey_dig') &&
      worker.state === 'working' &&
      !isMoving;

    const isStoneGathering =
      isCarrying &&
      worker.carryingResource === 'pickaxe' &&
      worker.visualActivity === 'production_gather' &&
      worker.state === 'working' &&
      !isMoving;

    const isFisherFishing =
      isCarrying &&
      worker.carryingResource === 'fishing_rod' &&
      worker.visualActivity === 'production_gather' &&
      worker.state === 'working' &&
      !isMoving;

    const isSideCarryTool =
      isCarrying &&
      worker.heldItemStyle === 'side' &&
      !isHammerConstruct &&
      !isPlantDigging &&
      !isStoneGathering &&
      !isFisherFishing;

    const isOverheadCarry = isCarrying && worker.heldItemStyle === 'overhead';

    /** Idle poses that need free hands — skip when holding a tool at the side. */
    const armAnim: IdleAnim =
      isSideCarryTool && anim !== 'look_around' && anim !== 'none' ? 'none' : anim;

    const bodyArgs = {
      worker,
      s,
      facing,
      isMoving,
      frame,
      now,
      anim,
      animT,
      isCarrying,
      isHammerConstruct,
      isPlantDigging,
      isFisherFishing,
      isStoneGathering,
      isSideCarryTool,
      isOverheadCarry,
      armAnim,
    };

    if (
      !isMoving &&
      worker.state === 'idle' &&
      worker.floorSleepUntilMs != null &&
      now < worker.floorSleepUntilMs
    ) {
      paintWorkerFloorNap(this.ctx, (path) => this.loadSprite(path), worker, now, s, facing);
      return;
    }

    this.paintWorkerSpriteBody({
      ...bodyArgs,
      drawRoundFootShadow: true,
      napPillowArms: false,
    });
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

  /**
   * Canvas buffer coordinates (0 … canvas.width/height) → grid cell.
   * For browser pointer coordinates use `clientToGrid`.
   */
  screenToWorld(canvasX: number, canvasY: number): { x: number; y: number } {
    const worldX = (canvasX - this.camera.x) / this.camera.zoom;
    const worldY = (canvasY - this.camera.y) / this.camera.zoom;
    return this.iso.screenToGridNearest(worldX, worldY);
  }

  /** Viewport client coordinates → canvas pixels → nearest grid cell. */
  clientToGrid(clientX: number, clientY: number): { x: number; y: number } {
    const { x: canvasX, y: canvasY } = this.clientToCanvas(clientX, clientY);
    return this.screenToWorld(canvasX, canvasY);
  }

  private clientToCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / Math.max(rect.width, 1e-6);
    const scaleY = this.canvas.height / Math.max(rect.height, 1e-6);
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  /** Pointer in iso world plane (before camera), for road-row snapping. */
  pointerToIsoWorld(clientX: number, clientY: number): { wx: number; wy: number } {
    const { x: canvasX, y: canvasY } = this.clientToCanvas(clientX, clientY);
    return {
      wx: (canvasX - this.camera.x) / this.camera.zoom,
      wy: (canvasY - this.camera.y) / this.camera.zoom,
    };
  }

  /**
   * Lock free hover to horizontal or vertical row from anchor (same x or same y),
   * picking whichever axis passes closer to the pointer in screen space.
   */
  snapRoadHoverToAxisAlignedRow(
    anchorX: number,
    anchorY: number,
    hoverX: number,
    hoverY: number,
    clientX: number,
    clientY: number
  ): { x: number; y: number } {
    const { wx, wy } = this.pointerToIsoWorld(clientX, clientY);
    const h = this.iso.gridToScreen(hoverX, anchorY);
    const v = this.iso.gridToScreen(anchorX, hoverY);
    const dh = (h.x - wx) ** 2 + (h.y - wy) ** 2;
    const dv = (v.x - wx) ** 2 + (v.y - wy) ** 2;
    return dh <= dv ? { x: hoverX, y: anchorY } : { x: anchorX, y: hoverY };
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
    this.surveyOverlay = null;
    this.surveyMenuHighlight = null;
    this.surveyPendingTile = null;
    this.surveyWorkerDrawOnTopIds.clear();
    this.cachedViewportBounds = null;
    // Reset minimap offscreen canvas
    this.minimapOffscreenCtx.fillStyle = '#1a1a1a';
    this.minimapOffscreenCtx.fillRect(0, 0, 200, 200);
    this.minimapScale = 200 / this.tileMap.width;
  }
}
