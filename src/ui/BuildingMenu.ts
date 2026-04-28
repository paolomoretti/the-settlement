/**
 * BuildingMenu - UI for browsing and selecting buildings to construct
 */

import { Game } from '@/core/Game';
import { dataManager } from '@/data/DataManager';
import { BuildingDefinition, BuildingType } from '@/types/GameData';
import '@fortawesome/fontawesome-free/css/fontawesome.min.css';
import '@fortawesome/fontawesome-free/css/solid.min.css';

export class BuildingMenu {
  private game: Game;
  private panel: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private currentCategory: 'residential' | 'production' | 'military' | 'infrastructure' = 'production';

  constructor(game: Game) {
    this.game = game;
    this.setupUI();
  }

  private setupUI(): void {
    this.overlay = document.getElementById('building-menu-overlay');
    this.panel = document.getElementById('building-menu-panel');
    if (!this.panel || !this.overlay) return;

    // Tab buttons
    const tabs = ['residential', 'production', 'military', 'infrastructure'] as const;
    tabs.forEach(tab => {
      const btn = document.getElementById(`tab-${tab}`);
      btn?.addEventListener('click', () => this.switchCategory(tab));
    });

    // Close button
    const closeBtn = document.getElementById('btn-close-building-menu');
    closeBtn?.addEventListener('click', () => this.close());
  }

  open(): void {
    if (!this.overlay) return;
    this.overlay.classList.add('is-open');
    this.overlay.setAttribute('aria-hidden', 'false');
    this.refresh();
  }

  close(): void {
    if (!this.overlay) return;
    this.overlay.classList.remove('is-open');
    this.overlay.setAttribute('aria-hidden', 'true');
  }

  toggle(): void {
    if (!this.overlay) return;
    if (this.overlay.classList.contains('is-open')) {
      this.close();
    } else {
      this.open();
    }
  }

  private switchCategory(category: typeof this.currentCategory): void {
    this.currentCategory = category;

    // Update tab button states
    const tabs = ['residential', 'production', 'military', 'infrastructure'];
    tabs.forEach(tab => {
      const btn = document.getElementById(`tab-${tab}`);
      if (btn) {
        if (tab === category) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      }
    });

    this.refresh();
  }

  refresh(): void {
    const container = document.getElementById('building-cards-container');
    if (!container) return;

    container.innerHTML = '';

    // Get buildings for current category
    const buildings = dataManager.getBuildingsByCategory(this.currentCategory);

    // Filter out base camp
    const buildableBuildings = buildings.filter(b => !b.isHeadquarters);

    if (buildableBuildings.length === 0) {
      container.innerHTML = '<div style="padding: 20px; text-align: center; opacity: 0.6;">No buildings in this category yet</div>';
      return;
    }

    buildableBuildings.forEach(building => {
      const card = this.createBuildingCard(building);
      container.appendChild(card);
    });
  }

  private createBuildingCard(building: BuildingDefinition): HTMLElement {
    const card = document.createElement('div');
    card.className = 'building-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Build ${building.name}`);

    // Check affordability
    const canAfford = dataManager.canAfford(building.id, this.game.inventory);

    if (!canAfford) {
      card.classList.add('unaffordable');
    }

    // Building preview (sprite if available, colored square fallback)
    const spriteSrc = `/assets/buildings/${building.id}.png`;

    const preview = document.createElement('div');
    preview.className = 'building-preview';
    preview.style.backgroundImage = `url(${spriteSrc})`;

    const testImg = new Image();
    testImg.src = spriteSrc;
    testImg.onerror = () => {
      preview.style.backgroundImage = 'none';
      preview.style.backgroundColor = building.visual.color;
    };

    // Building name
    const name = document.createElement('div');
    name.className = 'building-name';
    name.textContent = building.name;

    // Description
    const desc = document.createElement('div');
    desc.className = 'building-description';
    desc.textContent = building.description;

    const metaRow = document.createElement('div');
    metaRow.className = 'building-meta-row';
    metaRow.appendChild(this.createMetaItem('fa-border-all', `${building.size.width}×${building.size.height}`, 'Size'));
    metaRow.appendChild(this.createMetaSeparator());
    metaRow.appendChild(this.createMetaItem('fa-clock', `${building.buildTime}s`, 'Build time'));
    metaRow.appendChild(this.createMetaSeparator());
    const costMeta = this.createMetaItem('fa-coins', '', 'Cost');
    const costChips = document.createElement('span');
    costChips.className = 'building-resource-chips';
    if (Object.keys(building.buildCost).length === 0) {
      costChips.textContent = 'Free';
    } else {
      Object.entries(building.buildCost).forEach(([resourceId, amount]) => {
        const resource = dataManager.getResource(resourceId as any);
        if (!resource) return;
        const available = this.game.inventory[resourceId] || 0;
        costChips.appendChild(this.createResourceChip(resourceId, amount, available >= amount));
      });
    }
    costMeta.appendChild(costChips);
    metaRow.appendChild(costMeta);

    // Production info
    const roleRow = document.createElement('div');
    roleRow.className = 'building-role-row';
    if (building.production) {
      const outputs = Object.entries(building.production.outputs)
        .filter(([id]) => !dataManager.getResource(id as any)?.virtualOutput);
      const inputs = building.production.inputs ? Object.entries(building.production.inputs) : [];
      const inputsAny = building.production.inputsAny ?? [];
      if (inputs.length > 0 || inputsAny.length > 0) {
        const inputRow = this.createRoleLine('is-requirement');
        inputRow.appendChild(this.createRoleLabel('Input'));
        inputRow.appendChild(this.createResourceChipGroup(inputs, inputsAny));
        roleRow.appendChild(inputRow);
      }
      const outputRow = this.createRoleLine();
      outputRow.appendChild(this.createRoleLabel('Output'));
      outputRow.appendChild(this.createOutputChipGroup(outputs, building));
      roleRow.appendChild(outputRow);
    } else if (building.storage) {
      const line = this.createRoleLine();
      line.appendChild(this.createRoleLabel('Stores'));
      const storesCoinsOnly =
        building.storage.accepts?.length === 1 && building.storage.accepts[0] === 'gold_coin';
      line.appendChild(this.createPlainRoleText(`${building.storage.capacity} ${storesCoinsOnly ? 'coins' : 'items'}`));
      roleRow.appendChild(line);
    } else if (building.military?.soldierCapacity) {
      const line = this.createRoleLine();
      line.appendChild(this.createRoleLabel('Garrisons'));
      line.appendChild(this.createPlainRoleText(`${building.military.soldierCapacity} soldiers`));
      roleRow.appendChild(line);
    } else if (building.population?.provides) {
      const line = this.createRoleLine();
      const popBadge = document.createElement('span');
      popBadge.className = 'building-pop-badge';
      popBadge.append(`+${building.population.provides}`);
      popBadge.appendChild(this.createInlineIcon('fa-user', 'population'));
      line.appendChild(popBadge);
      roleRow.appendChild(line);
    } else {
      const line = this.createRoleLine();
      line.appendChild(this.createRoleLabel('Role'));
      line.appendChild(this.createPlainRoleText(building.requiredTool ? 'Staffed workshop' : 'Utility building'));
      roleRow.appendChild(line);
    }

    // Population requirements
    if (building.population?.requires && !building.production) {
      const popBadge = document.createElement('span');
      popBadge.className = 'building-pop-badge';
      popBadge.append(`${building.population.requires}`);
      popBadge.appendChild(this.createInlineIcon('fa-user', 'population'));
      const firstLine = roleRow.querySelector('.building-role-line') ?? roleRow;
      firstLine.appendChild(popBadge);
    }

    card.addEventListener('click', () => {
      this.startBuilding(building.id);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.startBuilding(building.id);
    });

    // Assemble card
    card.appendChild(preview);
    card.appendChild(name);
    card.appendChild(desc);
    card.appendChild(metaRow);
    card.appendChild(roleRow);

    return card;
  }

  private createMetaItem(icon: string, text: string, label: string): HTMLElement {
    const item = document.createElement('span');
    item.className = 'building-meta-item';
    item.title = label;
    item.appendChild(this.createInlineIcon(icon, label));
    if (text) item.append(text);
    return item;
  }

  private createMetaSeparator(): HTMLElement {
    const sep = document.createElement('span');
    sep.className = 'building-meta-separator';
    sep.textContent = '·';
    return sep;
  }

  private createInlineIcon(icon: string, label: string): HTMLElement {
    const i = document.createElement('i');
    i.className = `fa-solid ${icon}`;
    i.setAttribute('aria-hidden', 'true');
    i.title = label;
    return i;
  }

  private createRoleLine(extraClass = ''): HTMLElement {
    const line = document.createElement('div');
    line.className = `building-role-line${extraClass ? ` ${extraClass}` : ''}`;
    return line;
  }

  private createResourceChip(resourceId: string, amount?: number, ok = true): HTMLElement {
    const resource = dataManager.getResource(resourceId as any);
    const chip = document.createElement('span');
    chip.className = `building-resource-chip${ok ? '' : ' is-missing'}`;
    chip.title = resource?.name ?? resourceId;

    const img = document.createElement('img');
    const fallbackSrc = `/assets/resources/${resourceId}.png`;
    const primarySrc = resource?.icon || fallbackSrc;
    img.src = primarySrc;
    img.className = 'building-resource-icon';
    const fallback = document.createElement('span');
    fallback.className = 'building-resource-fallback';
    fallback.textContent = this.getResourceFallbackText(resource?.name ?? resourceId);
    fallback.hidden = true;
    img.onload = () => { fallback.hidden = true; };
    img.onerror = () => {
      if (img.src !== new URL(fallbackSrc, window.location.origin).href) {
        img.src = fallbackSrc;
        return;
      }
      img.remove();
      fallback.hidden = false;
    };
    chip.appendChild(img);
    chip.appendChild(fallback);

    if (typeof amount === 'number') {
      const badge = document.createElement('span');
      badge.className = 'building-resource-amount';
      badge.textContent = `×${amount}`;
      chip.appendChild(badge);
    }

    return chip;
  }

  private getResourceFallbackText(name: string): string {
    return name
      .split(/[\s_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0]?.toUpperCase() ?? '')
      .join('') || '?';
  }

  private createRoleLabel(text: string): HTMLElement {
    const label = document.createElement('span');
    label.className = 'building-role-label';
    label.textContent = text;
    return label;
  }

  private createPlainRoleText(text: string): HTMLElement {
    const value = document.createElement('span');
    value.className = 'building-role-text';
    value.textContent = text;
    return value;
  }

  private createResourceChipGroup(
    inputs: [string, number][],
    inputsAny: NonNullable<BuildingDefinition['production']>['inputsAny']
  ): HTMLElement {
    const group = document.createElement('span');
    group.className = 'building-resource-chips';

    inputs
      .filter(([, amount]) => amount > 0)
      .forEach(([id, amount]) => group.appendChild(this.createResourceChip(id, amount)));

    for (const anyGroup of inputsAny ?? []) {
      const anyWrap = document.createElement('span');
      anyWrap.className = 'building-any-resource-group';
      anyGroup.resourceTypes.forEach((id, index) => {
        if (index > 0) {
          const slash = document.createElement('span');
          slash.className = 'building-any-separator';
          slash.textContent = '/';
          anyWrap.appendChild(slash);
        }
        anyWrap.appendChild(this.createResourceChip(id, anyGroup.amount));
      });
      group.appendChild(anyWrap);
    }

    return group;
  }

  private createOutputChipGroup(outputs: [string, number][], building: BuildingDefinition): HTMLElement {
    const group = document.createElement('span');
    group.className = 'building-resource-chips building-output-chips';
    outputs.forEach(([id, amount]) => group.appendChild(this.createResourceChip(id, amount)));
    if (outputs.length === 0) {
      const outputIds = Object.keys(building.production?.outputs ?? {});
      const text = outputIds.includes('planted_tree') ? 'Plant trees' : 'Map effect';
      group.appendChild(this.createPlainRoleText(text));
    }
    return group;
  }

  private startBuilding(buildingType: BuildingType): void {
    this.close();
    this.game.inputSystem.setMode(`build_${buildingType}`);
  }
}
