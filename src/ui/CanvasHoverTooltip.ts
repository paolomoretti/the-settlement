import { Game } from '@/core/Game';
import { Entity } from '@/core/Entity';
import {
  buildBuildingHoverLines,
  buildRockTileHoverLines,
  buildWaterFishHoverLines,
  getHoverTargetKey,
} from '@/ui/hoverInsight/buildHoverLines';
import { isInsightAltHeld } from '@/input/InsightAltKey';

const OFFSET_X = 14;
const OFFSET_Y = 18;

export interface CanvasHoverTooltipOptions {
  getGame: () => Game | null;
  /** When the building popover is open on the same entity, skip redundant building hover. */
  shouldSuppressBuildingHover: (entity: Entity) => boolean;
}

/**
 * While **Alt / Option** is held and the pointer hovers an insight target in **view** mode,
 * shows the tooltip immediately (no delay). Grid and sprite highlights are driven from {@link Game}.
 */
export class CanvasHoverTooltip {
  private readonly el: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private visible = false;
  private pointerInside = true;
  private pointerDown = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: CanvasHoverTooltipOptions
  ) {
    const root = document.getElementById('ui-overlay') ?? document.body;
    this.el = document.createElement('div');
    this.el.className = 'canvas-hover-tooltip';
    this.el.style.display = 'none';

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'canvas-hover-tooltip-title';

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'canvas-hover-tooltip-body';

    this.el.appendChild(this.titleEl);
    this.el.appendChild(this.bodyEl);
    root.appendChild(this.el);

    this.canvas.addEventListener('mouseleave', () => {
      this.pointerInside = false;
      this.hide();
    });
    this.canvas.addEventListener('mouseenter', () => {
      this.pointerInside = true;
    });
    this.canvas.addEventListener('mousedown', () => {
      this.pointerDown = true;
      this.hide();
    });
    this.canvas.addEventListener('mouseup', () => {
      this.pointerDown = false;
    });
  }

  destroy(): void {
    this.el.remove();
  }

  tick(): void {
    const game = this.options.getGame();
    if (!game || !this.pointerInside || !isInsightAltHeld()) {
      this.hide();
      return;
    }

    if (this.pointerDown) {
      this.hide();
      return;
    }

    const mode = game.inputSystem.getMode();
    if (mode !== 'view' || game.isDraggingEntity || game.inputSystem.isSpacebarPanning()) {
      this.hide();
      return;
    }

    const hp = game.inputSystem.hoverGridPos;
    const client = game.inputSystem.getHoverClientPos();
    if (!hp || !client) {
      this.hide();
      return;
    }

    const tile = game.tileMap.getTile(hp.x, hp.y);
    if (!tile || !tile.isExplored()) {
      this.hide();
      return;
    }

    const buildingEntity = game.getBuildingEntityAtGrid(hp.x, hp.y);
    if (buildingEntity && this.options.shouldSuppressBuildingHover(buildingEntity)) {
      this.hide();
      return;
    }

    if (!getHoverTargetKey(game, hp.x, hp.y)) {
      this.hide();
      return;
    }

    if (!this.visible) {
      this.visible = true;
      this.el.style.display = 'block';
    }
    this.applyContent(game, hp.x, hp.y);
    this.positionNear(client.x, client.y);
  }

  private hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.style.display = 'none';
  }

  private applyContent(game: Game, gx: number, gy: number): void {
    const building = game.getBuildingEntityAtGrid(gx, gy);
    if (building) {
      const insight = buildBuildingHoverLines(building);
      if (insight) {
        this.titleEl.textContent = insight.title;
        this.bodyEl.innerHTML = insight.lines.map(l => `<div class="canvas-hover-tooltip-line">${escapeHtml(l)}</div>`).join('');
        return;
      }
    }

    const t = game.tileMap.getTile(gx, gy);
    if (t) {
      const rock = buildRockTileHoverLines(t);
      if (rock) {
        this.titleEl.textContent = rock.title;
        this.bodyEl.innerHTML = rock.lines.map(l => `<div class="canvas-hover-tooltip-line">${escapeHtml(l)}</div>`).join('');
        return;
      }
      const water = buildWaterFishHoverLines(t);
      if (water) {
        this.titleEl.textContent = water.title;
        this.bodyEl.innerHTML = water.lines.map(l => `<div class="canvas-hover-tooltip-line">${escapeHtml(l)}</div>`).join('');
        return;
      }
    }

    this.titleEl.textContent = '';
    this.bodyEl.textContent = '';
  }

  private positionNear(clientX: number, clientY: number): void {
    this.el.style.left = `${clientX + OFFSET_X}px`;
    this.el.style.top = `${clientY + OFFSET_Y}px`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
