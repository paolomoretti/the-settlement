import { Game } from '@/core/Game';
import { GamePopover } from './GamePopover';
import { Building } from '@/components/Building';
import { Production } from '@/components/Production';
import { Storage } from '@/components/Storage';
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
  private progressContainer: HTMLElement | null = null;
  private stoppedLabel: HTMLElement | null = null;
  private bufferContainer: HTMLElement | null = null;
  private requirementsContainer: HTMLElement | null = null;
  private gatherWarningEl: HTMLElement | null = null;
  private militaryPanelEl: HTMLElement | null = null;
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
      this.progressContainer = null;
      this.stoppedLabel = null;
      this.bufferContainer = null;
      this.requirementsContainer = null;
      this.gatherWarningEl = null;
      this.militaryPanelEl = null;
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
      this.updateRequirements();
      this.updateGatherWarning();
      this.updateMilitaryPanel();

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
    this.progressContainer = null;
    this.stoppedLabel = null;
    this.bufferContainer = null;
    this.requirementsContainer = null;
    this.gatherWarningEl = null;
    this.militaryPanelEl = null;
    this.popover.hide();
  }

  isVisible(): boolean {
    return this.popover.isVisible();
  }

  private updateMilitaryPanel(): void {
    if (!this.militaryPanelEl || !this.currentEntity) return;
    const building = this.currentEntity.getComponent(Building);
    const def = dataManager.getBuilding(building!.buildingType as BuildingType);
    const cap = def?.military?.soldierCapacity;
    if (typeof cap !== 'number' || cap <= 0 || !building) return;
    if (building.isComplete()) {
      building.initMilitaryGarrison(cap);
    }
    if (!building.militaryGarrison) return;
    const filled = building.getMilitaryGarrisonFilledCount();
    const ranks = building.militaryGarrison.map(s => (s ? `R${s.rank}` : '—')).join(' ');
    this.militaryPanelEl.innerHTML =
      `<span class="popover-label">Garrison:</span> ${filled}/${cap} <span style="color:#aaa;font-size:10px">${ranks}</span>` +
      `<div style="color:#888;font-size:10px;margin-top:4px">Settlers march from HQ when you have 1+ sword &amp; shield <b>in HQ storage</b> and a road path. Auto-fill runs every few seconds.</div>`;
  }

  private updateGatherWarning(): void {
    if (!this.gatherWarningEl || !this.currentEntity) return;
    const building = this.currentEntity.getComponent(Building);
    const production = this.currentEntity.getComponent(Production);
    if (!building || !production) return;

    const def = dataManager.getBuilding(building.buildingType);
    const mapGather = def?.animation?.type === 'gather';
    const wellExhausted =
      building.buildingType === 'well' && building.outOfMapResources && production.status === 'producing';
    if ((!mapGather && !wellExhausted) || !building.outOfMapResources || production.status !== 'producing') {
      this.gatherWarningEl.style.display = 'none';
      return;
    }

    const gatherAnim = def?.animation?.type === 'gather' ? def.animation : null;
    this.gatherWarningEl.style.display = '';
    this.gatherWarningEl.textContent = wellExhausted
      ? 'Underground water exhausted — this well will be abandoned.'
      : gatherAnim?.gatherMode === 'mine_site'
        ? 'No dig site next to the mine entrance — clear a walkable tile beside the door.'
        : 'Nothing to gather within reach of this building.';
  }

  private updateProgressBar(): void {
    if (!this.currentEntity || !this.progressContainer || !this.stoppedLabel) return;
    const building = this.currentEntity.getComponent(Building);
    const production = this.currentEntity.getComponent(Production);
    if (!building || this.productionTimeSec <= 0) return;

    const isStopped =
      production &&
      (production.status === 'stopped_full' ||
        production.status === 'stopped_no_inputs' ||
        production.status === 'stopped_no_road');
    const isProducing = production && production.status === 'producing';

    if (isStopped) {
      this.progressContainer.style.display = 'none';
      this.stoppedLabel.style.display = '';
      if (production!.status === 'stopped_full') {
        this.stoppedLabel.textContent = 'Production stopped — buffer full';
      } else if (production!.status === 'stopped_no_inputs') {
        this.stoppedLabel.textContent = 'Production stopped — missing inputs';
      } else if (production!.status === 'stopped_no_road') {
        this.stoppedLabel.textContent = 'Production stopped — no road';
      }
    } else if (isProducing) {
      this.progressContainer.style.display = '';
      this.stoppedLabel.style.display = 'none';
      if (this.progressBarFill && this.progressBarLabel && production) {
        const progress = production.getProgress();
        this.progressBarFill.style.width = `${progress * 100}%`;
        const remaining = Math.ceil(this.productionTimeSec * (1 - progress));
        this.progressBarLabel.textContent = `${remaining}s`;
      }
    } else {
      this.progressContainer.style.display = 'none';
      this.stoppedLabel.style.display = 'none';
    }
  }

  private updateBufferDisplay(): void {
    if (!this.bufferContainer || !this.currentEntity) return;
    const production = this.currentEntity.getComponent(Production);
    if (!production) return;

    const storage = this.currentEntity.getComponent(Storage);
    if (storage && storage.isProductionStorage) {
      const totalStored = storage.getTotalStored();
      const totalBuffered = production.getTotalBuffered();
      if (totalStored === 0 && totalBuffered === 0) {
        this.bufferContainer.style.display = 'none';
        return;
      }
      this.bufferContainer.style.display = '';
      const ingredientLine =
        totalStored > 0
          ? (() => {
              const isFull = storage.isFull();
              const items = Object.entries(storage.items)
                .filter(([, amt]) => amt > 0)
                .map(([id, amt]) => {
                  const res = dataManager.getResource(id as any);
                  return `<img src="/assets/resources/${id}.png" class="resource-icon" onerror="this.style.display='none'">${amt} ${res?.name || id}`;
                })
                .join(', ');
              return (
                `<div><span class="popover-label">Ingredients:</span> ` +
                `<span style="color:${isFull ? '#f44336' : '#4caf50'}">${totalStored}/${storage.capacity}</span>` +
                `<span style="color:#aaa;margin-left:4px">(${items})</span>` +
                (isFull ? `<span style="color:#f44336;margin-left:4px">⚠ Full</span>` : '') +
                `</div>`
              );
            })()
          : '';
      const bufFull = production.status === 'stopped_full';
      const pickupLine =
        totalBuffered > 0
          ? (() => {
              const items = Object.entries(production.outputBuffer)
                .filter(([, amt]) => amt > 0)
                .map(([id, amt]) => {
                  const res = dataManager.getResource(id as any);
                  return `<img src="/assets/resources/${id}.png" class="resource-icon" onerror="this.style.display='none'">${amt} ${res?.name || id}`;
                })
                .join(', ');
              return (
                `<div><span class="popover-label">Outside (pickup):</span> ` +
                `<span style="color:${bufFull ? '#f44336' : '#4caf50'}">${totalBuffered}/${production.maxOutputBuffer}</span>` +
                `<span style="color:#aaa;margin-left:4px">(${items})</span>` +
                (bufFull ? `<span style="color:#f44336;margin-left:4px">⚠ Full</span>` : '') +
                `</div>`
              );
            })()
          : '';
      this.bufferContainer.innerHTML = ingredientLine + pickupLine;
      return;
    }

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
        return `<img src="/assets/resources/${id}.png" class="resource-icon" onerror="this.style.display='none'">${amt} ${res?.name || id}`;
      })
      .join(', ');

    this.bufferContainer.innerHTML =
      `<span class="popover-label">Buffer:</span> ` +
      `<span style="color:${isFull ? '#f44336' : '#4caf50'}">${totalBuffered}/${production.maxOutputBuffer}</span>` +
      `<span style="color:#aaa;margin-left:4px">(${items})</span>` +
      (isFull ? `<span style="color:#f44336;margin-left:4px">⚠ Full</span>` : '');
  }

  private updateRequirements(): void {
    if (!this.requirementsContainer || !this.currentEntity) return;
    const building = this.currentEntity.getComponent(Building);
    if (!building) return;
    const def = dataManager.getBuilding(building.buildingType as BuildingType);

    const lines: string[] = [];
    const isMilitaryPost = typeof def?.military?.soldierCapacity === 'number' && (def?.military?.soldierCapacity ?? 0) > 0;

    if (!isMilitaryPost && building.state === 'awaiting_materials' && building.constructionMaterials) {
      for (const [res, required] of Object.entries(building.constructionMaterials)) {
        const delivered = building.materialsDelivered[res] || 0;
        const resName = dataManager.getResource(res as any)?.name || res;
        const done = delivered >= required;
        const color = done ? '#4caf50' : '#ffb74d';
        lines.push(`<span style="color:${color}">${resName}: ${delivered}/${required}</span>`);
      }
      const builderColor = building.builderArrived ? '#4caf50' : '#ffb74d';
      const builderText = building.builderArrived ? 'Builder: Arrived' : 'Builder: En route...';
      lines.push(`<span style="color:${builderColor}">${builderText}</span>`);
    }

    if (building.isComplete() && !building.hasOperator && def?.requiredTool) {
      const toolName = dataManager.getResource(def.requiredTool as any)?.name || def.requiredTool;
      lines.push(`<span style="color:#ffb74d">${toolName} worker: En route...</span>`);
    }

    if (lines.length === 0) {
      this.requirementsContainer.style.display = 'none';
      return;
    }

    this.requirementsContainer.style.display = '';
    this.requirementsContainer.innerHTML =
      `<span class="popover-label">Needs:</span><br>` +
      lines.map(l => `&nbsp;&nbsp;${l}`).join('<br>');
  }

  private buildContent(building: Building, def?: BuildingDefinition): HTMLElement {
    const el = document.createElement('div');
    const militaryCap = def?.military?.soldierCapacity ?? 0;
    const isMilitaryPost = militaryCap > 0;

    if (def?.description) {
      const desc = document.createElement('div');
      desc.className = 'popover-desc';
      desc.textContent = def.description;
      el.appendChild(desc);
    }

    const gatherWarn = document.createElement('div');
    gatherWarn.className = 'popover-gather-warning';
    gatherWarn.style.display = 'none';
    gatherWarn.style.color = '#ffb74d';
    gatherWarn.style.fontSize = '11px';
    gatherWarn.style.marginTop = '8px';
    gatherWarn.style.lineHeight = '1.4';
    this.gatherWarningEl = gatherWarn;
    el.appendChild(gatherWarn);

    const status = document.createElement('div');
    status.className = 'popover-row';
    if (building.state === 'awaiting_materials' && !isMilitaryPost) {
      status.innerHTML = `<span class="popover-label">Status:</span> <span style="color:#ffb74d">Awaiting materials</span>`;
    } else if (building.state === 'under_construction') {
      const pct = Math.floor(building.constructionProgress * 100);
      status.innerHTML = `<span class="popover-label">Status:</span> Under construction (${pct}%)`;
    } else if (isMilitaryPost) {
      const filled = building.getMilitaryGarrisonFilledCount();
      const color = filled > 0 ? '#4caf50' : '#ffb74d';
      const text = filled > 0 ? 'Garrisoned' : 'Awaiting garrison';
      status.innerHTML = `<span class="popover-label">Status:</span> <span style="color:${color}">${text} (${filled}/${militaryCap})</span>`;
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

    const reqRow = document.createElement('div');
    reqRow.className = 'popover-row';
    reqRow.style.display = 'none';
    reqRow.style.fontSize = '11px';
    reqRow.style.lineHeight = '1.5';
    this.requirementsContainer = reqRow;
    el.appendChild(reqRow);

    if (def?.production) {
      const prod = document.createElement('div');
      prod.className = 'popover-production';

      const outputs = Object.entries(def.production.outputs);
      const inputs = def.production.inputs ? Object.entries(def.production.inputs) : [];
      const inputsAny = def.production.inputsAny ?? [];

      if (inputs.length > 0 || inputsAny.length > 0) {
        const fixedParts = inputs
          .filter(([, n]) => (n ?? 0) > 0)
          .map(([id]) => {
            const res = dataManager.getResource(id as any);
            return res?.name || id;
          });
        const anyParts = inputsAny.map(g => {
          const names = g.resourceTypes
            .map(id => dataManager.getResource(id)?.name ?? id)
            .join(' / ');
          return g.amount > 1 ? `${g.amount}× (${names})` : `(${names})`;
        });
        const inputStr = [...fixedParts, ...anyParts].join(' + ');
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
        this.progressContainer = barContainer;

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

        const stopped = document.createElement('div');
        stopped.className = 'popover-row';
        stopped.style.display = 'none';
        stopped.style.color = '#f44336';
        stopped.style.fontSize = '11px';
        this.stoppedLabel = stopped;
        prod.appendChild(stopped);
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
      const accepts = def.storage.accepts?.length
        ? ` (accepts: ${def.storage.accepts.join(', ')})`
        : '';
      storage.innerHTML = `<span class="popover-label">Storage:</span> ${def.storage.capacity} slots${accepts}`;
      el.appendChild(storage);
    }

    if (isMilitaryPost) {
      const mil = document.createElement('div');
      mil.className = 'popover-row';
      mil.style.fontSize = '11px';
      mil.style.lineHeight = '1.5';
      this.militaryPanelEl = mil;
      el.appendChild(mil);
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
