import { Game } from '@/core/Game';
import { GamePopover } from './GamePopover';
import { Building } from '@/components/Building';
import { Production } from '@/components/Production';
import { Position } from '@/components/Position';
import { Entity } from '@/core/Entity';
import { dataManager } from '@/data/DataManager';
import { eventBus } from '@/core/EventBus';
import { BuildingType, BuildingDefinition } from '@/types/GameData';

export class BuildingPopover {
  private game: Game;
  private popover: GamePopover;
  private currentEntity: Entity | null = null;
  private progressBarFill: HTMLElement | null = null;
  private progressBarLabel: HTMLElement | null = null;
  private bufferContainer: HTMLElement | null = null;
  private productionTimeSec: number = 0;

  constructor(game: Game) {
    this.game = game;

    const container = document.getElementById('ui-overlay')!;
    this.popover = new GamePopover(container);

    this.popover.onClose = () => {
      if (this.currentEntity && this.game.selectedEntity === this.currentEntity) {
        this.game.selectedEntity = null;
      }
      this.currentEntity = null;
      this.progressBarFill = null;
      this.progressBarLabel = null;
      this.bufferContainer = null;
    };
  }

  show(entity: Entity): void {
    const building = entity.getComponent(Building);
    const pos = entity.getComponent(Position);
    if (!building || !pos) return;

    if (this.currentEntity === entity && this.popover.isVisible()) return;

    this.currentEntity = null;
    if (this.popover.isVisible()) {
      this.popover.hide();
    }

    this.currentEntity = entity;
    const def = dataManager.getBuilding(building.buildingType as BuildingType);
    this.productionTimeSec = def?.production?.productionTime || 0;
    const content = this.buildContent(building, def);
    const name = def?.name || building.buildingType;

    const getAnchor = () => {
      this.popover.setTemporaryHidden(this.game.isDraggingEntity);
      this.updateProgressBar();
      this.updateBufferDisplay();

      const p = entity.getComponent(Position);
      if (!p) return { x: 0, y: 0 };
      const cx = p.x + building.width / 2;
      const cy = p.y + building.height / 2;
      const screen = this.game.renderSystem.gridToScreen(cx, cy);
      const zoom = this.game.renderSystem.getZoom();
      return { x: screen.x, y: screen.y - building.buildingHeight * zoom };
    };

    this.popover.show(name, content, getAnchor);
  }

  hide(): void {
    this.currentEntity = null;
    this.progressBarFill = null;
    this.progressBarLabel = null;
    this.bufferContainer = null;
    this.popover.hide();
  }

  isVisible(): boolean {
    return this.popover.isVisible();
  }

  private updateProgressBar(): void {
    if (!this.progressBarFill || !this.progressBarLabel || !this.currentEntity) return;
    const building = this.currentEntity.getComponent(Building);
    if (!building || this.productionTimeSec <= 0) return;

    const progress = building.getProductionProgress(this.productionTimeSec);
    this.progressBarFill.style.width = `${progress * 100}%`;

    const remaining = Math.ceil(this.productionTimeSec * (1 - progress));
    this.progressBarLabel.textContent = `${remaining}s`;
  }

  private updateBufferDisplay(): void {
    if (!this.bufferContainer || !this.currentEntity) return;
    const production = this.currentEntity.getComponent(Production);
    if (!production) return;

    const totalBuffered = production.getTotalBuffered();
    if (totalBuffered === 0) {
      this.bufferContainer.style.display = 'none';
      return;
    }

    this.bufferContainer.style.display = '';
    const isFull = production.status === 'stopped_full';

    const items = Object.entries(production.outputBuffer)
      .filter(([, amt]) => amt > 0)
      .map(([id, amt]) => {
        const res = dataManager.getResource(id as any);
        return `${amt} ${res?.name || id}`;
      })
      .join(', ');

    this.bufferContainer.innerHTML =
      `<span class="popover-label">Buffer:</span> ` +
      `<span style="color:${isFull ? '#f44336' : '#4caf50'}">${totalBuffered}/${production.maxOutputBuffer}</span>` +
      `<span style="color:#aaa;margin-left:4px">(${items})</span>` +
      (isFull ? `<span style="color:#f44336;margin-left:4px">⚠ Full</span>` : '');
  }

  private buildContent(building: Building, def?: BuildingDefinition): HTMLElement {
    const el = document.createElement('div');

    if (def?.description) {
      const desc = document.createElement('div');
      desc.className = 'popover-desc';
      desc.textContent = def.description;
      el.appendChild(desc);
    }

    const status = document.createElement('div');
    status.className = 'popover-row';
    if (building.state === 'under_construction') {
      const pct = Math.floor(building.constructionProgress * 100);
      status.innerHTML = `<span class="popover-label">Status:</span> Under construction (${pct}%)`;
    } else {
      status.innerHTML = `<span class="popover-label">Status:</span> <span style="color:#4caf50">Complete</span>`;
    }
    el.appendChild(status);

    if (building.requiresRoad) {
      const road = document.createElement('div');
      road.className = 'popover-row';
      road.innerHTML = building.isActive
        ? '<span class="popover-label">Road:</span> <span style="color:#4caf50">Connected</span>'
        : '<span class="popover-label">Road:</span> <span style="color:#f44336">Not connected</span>';
      el.appendChild(road);
    }

    if (def?.production) {
      const prod = document.createElement('div');
      prod.className = 'popover-production';

      const outputs = Object.entries(def.production.outputs);
      const inputs = def.production.inputs ? Object.entries(def.production.inputs) : [];

      if (inputs.length > 0) {
        const inputStr = inputs.map(([id]) => {
          const res = dataManager.getResource(id as any);
          return res?.name || id;
        }).join(', ');
        const outputStr = outputs.map(([id, amt]) => {
          const res = dataManager.getResource(id as any);
          return `${amt} ${res?.name || id}`;
        }).join(', ');
        prod.innerHTML = `<span class="popover-label">Converts:</span> ${inputStr} &rarr; ${outputStr}`;
      } else {
        const outputStr = outputs.map(([id, amt]) => {
          const res = dataManager.getResource(id as any);
          return `${amt} ${res?.name || id}`;
        }).join(', ');
        prod.innerHTML = `<span class="popover-label">Produces:</span> ${outputStr}<br><span class="popover-label">Every:</span> ${def.production.productionTime}s`;
      }

      if (building.state === 'complete') {
        const barContainer = document.createElement('div');
        barContainer.className = 'popover-progress';

        const barTrack = document.createElement('div');
        barTrack.className = 'popover-progress-track';

        const barFill = document.createElement('div');
        barFill.className = 'popover-progress-fill';
        this.progressBarFill = barFill;

        const barLabel = document.createElement('span');
        barLabel.className = 'popover-progress-label';
        this.progressBarLabel = barLabel;

        barTrack.appendChild(barFill);
        barContainer.appendChild(barTrack);
        barContainer.appendChild(barLabel);
        prod.appendChild(barContainer);
      }

      el.appendChild(prod);

      const bufferRow = document.createElement('div');
      bufferRow.className = 'popover-row';
      bufferRow.style.display = 'none';
      this.bufferContainer = bufferRow;
      el.appendChild(bufferRow);
    }

    if (def?.population) {
      const pop = document.createElement('div');
      pop.className = 'popover-row';
      if (def.population.provides) {
        pop.innerHTML = `<span class="popover-label">Housing:</span> +${def.population.provides} population`;
      }
      if (def.population.requires) {
        pop.innerHTML = `<span class="popover-label">Workers:</span> ${def.population.requires} needed`;
      }
      el.appendChild(pop);
    }

    if (def?.storage) {
      const storage = document.createElement('div');
      storage.className = 'popover-row';
      storage.innerHTML = `<span class="popover-label">Storage:</span> ${def.storage.capacity} slots`;
      el.appendChild(storage);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'popover-delete-btn';
    deleteBtn.textContent = 'Delete Building';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      eventBus.emit('delete:selected');
    });
    el.appendChild(deleteBtn);

    return el;
  }
}
