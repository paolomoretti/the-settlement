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
  private currentOutputContainer: HTMLElement | null = null;
  private currentOutputKey: string | null = null;
  private stoppedLabel: HTMLElement | null = null;
  private bufferContainer: HTMLElement | null = null;
  private bufferDisplayKey: string | null = null;
  private storageContainer: HTMLElement | null = null;
  private storageDisplayKey: string | null = null;
  private requirementsContainer: HTMLElement | null = null;
  private gatherWarningEl: HTMLElement | null = null;
  private militaryPanelEl: HTMLElement | null = null;
  private staffingStatusEl: HTMLElement | null = null;
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
      this.currentOutputContainer = null;
      this.currentOutputKey = null;
      this.stoppedLabel = null;
      this.bufferContainer = null;
      this.bufferDisplayKey = null;
      this.storageContainer = null;
      this.storageDisplayKey = null;
      this.requirementsContainer = null;
      this.gatherWarningEl = null;
      this.militaryPanelEl = null;
      this.staffingStatusEl = null;
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
      this.updateCurrentOutputDisplay();
      this.updateBufferDisplay();
      this.updateStorageDisplay();
      this.updateRequirements();
      this.updateStaffingStatus();
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
    this.currentOutputContainer = null;
    this.currentOutputKey = null;
    this.stoppedLabel = null;
    this.bufferContainer = null;
    this.bufferDisplayKey = null;
    this.storageContainer = null;
    this.storageDisplayKey = null;
    this.requirementsContainer = null;
    this.gatherWarningEl = null;
    this.militaryPanelEl = null;
    this.staffingStatusEl = null;
    this.popover.hide();
  }

  isVisible(): boolean {
    return this.popover.isVisible();
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private getResourceName(resourceId: string): string {
    return dataManager.getResource(resourceId as any)?.name || resourceId;
  }

  private getWorkerLabel(def: BuildingDefinition): string {
    if (def.military?.soldierCapacity) return 'Soldier';
    const flavorByTool: Record<string, string> = {
      axe: 'Woodcutter',
      saw: 'Sawyer',
      pickaxe: def.id.includes('mine') ? 'Miner' : 'Stonemason',
      shovel: 'Forester',
      fishing_rod: 'Fisher',
      scythe: 'Farmer',
      hammer: 'Builder',
      rolling_pin: 'Baker',
      crucible: def.id === 'mint' ? 'Minter' : 'Smelter',
      tongs: 'Blacksmith',
      cleaver: 'Butcher',
      bow: def.id === 'lookout_tower' ? 'Scout' : 'Hunter',
    };
    return def.requiredTool ? flavorByTool[def.requiredTool] || 'Worker' : 'Worker';
  }

  private renderResourceIcon(resourceId: string, className: string = ''): string {
    const resource = dataManager.getResource(resourceId as any);
    const fallbackSrc = `/assets/resources/${resourceId}.png`;
    const primarySrc = resource?.icon || fallbackSrc;
    const fallbackAttr = primarySrc === fallbackSrc
      ? ''
      : ` data-fallback="${this.escapeHtml(fallbackSrc)}"`;
    const fallback = this.escapeHtml(this.getResourceName(resourceId).slice(0, 1).toUpperCase() || '?');
    return (
      `<span class="popover-resource-icon ${className}">` +
      `<span class="popover-resource-icon-fallback">${fallback}</span>` +
      `<img src="${this.escapeHtml(primarySrc)}" alt="" decoding="async"${fallbackAttr} onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;delete this.dataset.fallback;}else{this.remove();}">` +
      `</span>`
    );
  }

  private renderResourceChip(resourceId: string, amount?: number, extraClass: string = ''): string {
    const name = this.escapeHtml(this.getResourceName(resourceId));
    const amountText = amount && amount > 1 ? `<span class="popover-resource-amount">${amount}&times;</span>` : '';
    return (
      `<span class="popover-resource-chip ${extraClass}">` +
      this.renderResourceIcon(resourceId) +
      `<span class="popover-resource-name">${amountText}${name}</span>` +
      `</span>`
    );
  }

  private renderRecipeInputs(def: BuildingDefinition): string {
    const inputs = def.production?.inputs ? Object.entries(def.production.inputs) : [];
    const fixed = inputs
      .filter(([, amount]) => (amount ?? 0) > 0)
      .map(([id, amount]) => this.renderResourceChip(id, amount));
    const anyGroups = (def.production?.inputsAny ?? []).map(group => {
      const chips = group.resourceTypes
        .map(id => this.renderResourceChip(id, undefined, 'popover-resource-chip--compact'))
        .join('');
      return (
        `<span class="popover-any-input">` +
        `<span class="popover-any-input-label">${group.amount}&times; any</span>` +
        `<span class="popover-any-input-options">${chips}</span>` +
        `</span>`
      );
    });

    const all = [...fixed, ...anyGroups].join('');
    return all || '<span class="popover-empty-note">None</span>';
  }

  private renderRecipeOutputs(def: BuildingDefinition): string {
    const outputs = def.production ? Object.entries(def.production.outputs) : [];
    return outputs
      .filter(([, amount]) => (amount ?? 0) > 0)
      .map(([id, amount]) => this.renderResourceChip(id, amount))
      .join('') || '<span class="popover-empty-note">None</span>';
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

  private updateCurrentOutputDisplay(): void {
    if (!this.currentOutputContainer || !this.currentEntity) return;
    const building = this.currentEntity.getComponent(Building);
    const production = this.currentEntity.getComponent(Production);
    if (!building || !production) return;
    const isProducing = production.status === 'producing';
    const outputs = isProducing
      ? production.prepareCycleOutputs(
          building.buildingType as BuildingType,
          this.game.getProductionPriorities()
        )
      : production.currentCycleOutputs;
    const entries = outputs
      ? Object.entries(outputs).filter(([, amount]) => amount > 0)
      : [];

    if (!isProducing || entries.length === 0) {
      this.currentOutputContainer.style.display = 'none';
      this.currentOutputKey = null;
      return;
    }

    const key = entries.map(([id, amount]) => `${id}:${amount}`).join('|');
    this.currentOutputContainer.style.display = '';
    if (key === this.currentOutputKey) return;

    this.currentOutputKey = key;
    const chips = entries.map(([id, amount]) => this.renderResourceChip(id, amount)).join('');
    this.currentOutputContainer.innerHTML =
      `<span class="popover-label">Producing:</span>` +
      `<span class="popover-current-output-chips">${chips}</span>`;
  }

  private updateBufferDisplay(): void {
    if (!this.bufferContainer || !this.currentEntity) return;
    const production = this.currentEntity.getComponent(Production);
    if (!production) return;

    const totalBuffered = production.getTotalBuffered();
    if (totalBuffered === 0) {
      this.bufferContainer.style.display = 'none';
      this.bufferDisplayKey = null;
      return;
    }

    this.bufferContainer.style.display = '';
    const isFull = production.status === 'stopped_full';
    const bufferKey = JSON.stringify({
      totalBuffered,
      maxOutputBuffer: production.maxOutputBuffer,
      isFull,
      outputBuffer: Object.entries(production.outputBuffer).sort(([a], [b]) => a.localeCompare(b)),
    });
    if (bufferKey === this.bufferDisplayKey) return;
    this.bufferDisplayKey = bufferKey;

    const items = Object.entries(production.outputBuffer)
      .filter(([, amt]) => amt > 0)
      .map(([id, amt]) => this.renderResourceChip(id, amt))
      .join('');

    this.bufferContainer.innerHTML =
      `<div class="popover-section-title">Ready for pickup</div>` +
      `<div class="popover-storage-meta">` +
      `<span class="${isFull ? 'popover-status-bad' : 'popover-status-good'}">${totalBuffered}/${production.maxOutputBuffer}</span>` +
      (isFull ? `<span class="popover-status-bad">Full</span>` : '') +
      `</div>` +
      `<div class="popover-chip-row">${items}</div>`;
  }

  private updateStorageDisplay(): void {
    if (!this.storageContainer || !this.currentEntity) return;
    const storage = this.currentEntity.getComponent(Storage);
    if (!storage) {
      this.storageContainer.style.display = 'none';
      this.storageDisplayKey = null;
      return;
    }

    const totalStored = storage.getTotalStored();
    const capacity = storage.capacity;
    const isFull = storage.isFull();
    const slotCount = capacity <= 20 ? capacity : Math.min(10, capacity);
    const storageKey = JSON.stringify({
      items: Object.entries(storage.items).sort(([a], [b]) => a.localeCompare(b)),
      capacity,
      totalStored,
      isFull,
      slotCount,
      accepts: storage.accepts ?? null,
    });
    this.storageContainer.style.display = '';
    if (storageKey === this.storageDisplayKey) return;
    this.storageDisplayKey = storageKey;

    const expandedItems: string[] = [];
    for (const [id, amount] of Object.entries(storage.items)) {
      for (let i = 0; i < amount && expandedItems.length < slotCount; i++) {
        expandedItems.push(id);
      }
      if (expandedItems.length >= slotCount) break;
    }

    const cells = Array.from({ length: slotCount }, (_, idx) => {
      const id = expandedItems[idx];
      if (!id) return '<span class="popover-storage-cell"></span>';
      const title = this.escapeHtml(this.getResourceName(id));
      return (
        `<span class="popover-storage-cell popover-storage-cell--filled" title="${title}">` +
        this.renderResourceIcon(id, 'popover-resource-icon--slot popover-resource-icon--storage-slot') +
        `</span>`
      );
    }).join('');

    const accepts = storage.accepts?.length
      ? `<div class="popover-storage-accepts">Accepts ${storage.accepts
          .map(id => this.renderResourceChip(id, undefined, 'popover-resource-chip--compact'))
          .join('')}</div>`
      : '';
    const previewNote = capacity > slotCount
      ? `<span class="popover-empty-note">showing first ${slotCount}</span>`
      : '';

    this.storageContainer.innerHTML =
      `<div class="popover-section-title">Storage</div>` +
      `<div class="popover-storage-meta">` +
      `<span class="${isFull ? 'popover-status-bad' : 'popover-status-good'}">${totalStored}/${capacity}</span>` +
      (isFull ? `<span class="popover-status-bad">Full</span>` : previewNote) +
      `</div>` +
      `<div class="popover-storage-grid" style="--storage-slots:${slotCount}">${cells}</div>` +
      accepts;
  }

  private updateStaffingStatus(): void {
    if (!this.staffingStatusEl || !this.currentEntity) return;
    const building = this.currentEntity.getComponent(Building);
    if (!building) return;
    const def = dataManager.getBuilding(building.buildingType as BuildingType);
    if (!def?.population?.requires) return;

    const isWaitingForTool = building.isComplete() && !!def.requiredTool && !building.hasOperator;
    this.staffingStatusEl.className = isWaitingForTool
      ? 'popover-staff-status popover-status-warn'
      : 'popover-staff-status popover-status-good';
    this.staffingStatusEl.textContent = isWaitingForTool ? 'En route' : 'Assigned';
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
      prod.className = 'popover-detail-card popover-production';
      prod.innerHTML =
        `<div class="popover-section-title">Input</div>` +
        `<div class="popover-chip-row">${this.renderRecipeInputs(def)}</div>` +
        `<div class="popover-section-title popover-section-title--spaced">Output</div>` +
        `<div class="popover-chip-row">${this.renderRecipeOutputs(def)}</div>` +
        `<div class="popover-cycle-note">Cycle: ${def.production.productionTime}s</div>`;

      if (building.state === 'complete') {
        const currentOutput = document.createElement('div');
        currentOutput.className = 'popover-current-output';
        currentOutput.style.display = 'none';
        this.currentOutputContainer = currentOutput;
        prod.appendChild(currentOutput);

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
      bufferRow.className = 'popover-detail-card popover-runtime-buffer';
      bufferRow.style.display = 'none';
      this.bufferContainer = bufferRow;
      el.appendChild(bufferRow);
    }

    if (def?.population) {
      const pop = document.createElement('div');
      pop.className = 'popover-detail-card popover-staffing';
      if (def.population.provides) {
        pop.innerHTML =
          `<div class="popover-section-title">Population</div>` +
          `<div class="popover-staff-row">` +
          `<span class="popover-worker-name">Housing</span>` +
          `<span class="popover-staff-status popover-status-good">+${def.population.provides}</span>` +
          `</div>`;
      }
      if (def.population.requires) {
        const workerLabel = this.escapeHtml(this.getWorkerLabel(def));
        const tool = def.requiredTool
          ? this.renderResourceChip(def.requiredTool, undefined, 'popover-resource-chip--tool')
          : '<span class="popover-empty-note">No tool</span>';
        pop.innerHTML =
          `<div class="popover-section-title">Worker</div>` +
          `<div class="popover-staff-row">` +
          `<span class="popover-worker-name">${def.population.requires} ${workerLabel}</span>` +
          `<span class="popover-staff-tool">${tool}</span>` +
          `<span class="popover-staff-status"></span>` +
          `</div>`;
        this.staffingStatusEl = pop.querySelector('.popover-staff-status');
      }
      el.appendChild(pop);
    }

    if (def?.storage) {
      const storage = document.createElement('div');
      storage.className = 'popover-detail-card popover-storage-panel';
      this.storageContainer = storage;
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
