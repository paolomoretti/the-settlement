/**
 * BuildingMenu - UI for browsing and selecting buildings to construct
 */

import { Game } from '@/core/Game';
import { dataManager } from '@/data/DataManager';
import { BuildingDefinition, BuildingType } from '@/types/GameData';

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

    // Check affordability
    const canAfford = dataManager.canAfford(building.id, this.game.inventory);

    if (!canAfford) {
      card.classList.add('unaffordable');
    }

    // Building preview (sprite if available, colored square fallback)
    const spriteSrc = `/assets/buildings/${building.id}.png`;

    const preview = document.createElement('div');
    preview.className = 'building-preview';
    preview.style.width = '80px';
    preview.style.height = '60px';
    preview.style.borderRadius = '4px';
    preview.style.marginBottom = '8px';
    preview.style.backgroundImage = `url(${spriteSrc})`;
    preview.style.backgroundSize = 'cover';
    preview.style.backgroundPosition = 'center';
    preview.style.backgroundRepeat = 'no-repeat';

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

    // Size info
    const sizeInfo = document.createElement('div');
    sizeInfo.className = 'building-info';
    sizeInfo.textContent = `Size: ${building.size.width}×${building.size.height}  ·  Build time: ${building.buildTime}s`;

    // Build cost
    const costSection = document.createElement('div');
    costSection.className = 'building-cost';
    costSection.innerHTML = '<strong>Cost:</strong>';

    const costList = document.createElement('div');
    costList.style.marginTop = '4px';

    if (Object.keys(building.buildCost).length === 0) {
      costList.textContent = 'Free';
    } else {
      Object.entries(building.buildCost).forEach(([resourceId, amount]) => {
        const resource = dataManager.getResource(resourceId as any);
        if (!resource) return;

        const costItem = document.createElement('div');
        costItem.className = 'cost-item';

        const available = this.game.inventory[resourceId] || 0;
        const hasEnough = available >= amount;

        costItem.innerHTML = `
          <span style="color: ${hasEnough ? '#4caf50' : '#f44336'}">
            ${hasEnough ? '✓' : '✗'}
          </span>
          <img src="/assets/resources/${resourceId}.png" class="resource-icon" onerror="this.style.display='none'">
          <span>${resource.name}: ${amount}</span>
          ${!hasEnough ? `<span style="color: #f44336; font-size: 10px;"> (need ${amount - available})</span>` : ''}
        `;

        costList.appendChild(costItem);
      });
    }

    costSection.appendChild(costList);

    // Production info
    if (building.production) {
      const prodSection = document.createElement('div');
      prodSection.className = 'building-production';

      const outputs = Object.entries(building.production.outputs);
      const inputs = building.production.inputs ? Object.entries(building.production.inputs) : [];
      const inputsAny = building.production.inputsAny ?? [];

      if (inputs.length > 0 || inputsAny.length > 0) {
        // Conversion
        const fixedParts = inputs
          .filter(([, n]) => (n ?? 0) > 0)
          .map(([id]) => {
            const res = dataManager.getResource(id as any);
            return `${res?.name || id}`;
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

        prodSection.innerHTML = `<strong>Converts:</strong><br>${inputStr} → ${outputStr}`;
      } else {
        // Production
        const outputStr = outputs.map(([id, amt]) => {
          const res = dataManager.getResource(id as any);
          return `${amt} ${res?.name || id}`;
        }).join(', ');

        prodSection.innerHTML = `<strong>Produces:</strong><br>${outputStr} every ${building.production.productionTime}s`;
      }

      costSection.appendChild(prodSection);
    }

    // Population requirements
    if (building.population) {
      const popSection = document.createElement('div');
      popSection.className = 'building-info';

      if (building.population.provides) {
        popSection.innerHTML = `<strong>Housing:</strong> +${building.population.provides} population`;
      }
      if (building.population.requires) {
        popSection.innerHTML = `<strong>Workers:</strong> ${building.population.requires} needed`;
      }

      costSection.appendChild(popSection);
    }

    // Build button
    const buildBtn = document.createElement('button');
    buildBtn.className = 'build-button';
    buildBtn.textContent = canAfford ? 'Build' : 'Place Site';

    buildBtn.addEventListener('click', () => {
      this.startBuilding(building.id);
    });

    // Assemble card
    card.appendChild(preview);
    card.appendChild(name);
    card.appendChild(desc);
    card.appendChild(sizeInfo);
    card.appendChild(costSection);
    card.appendChild(buildBtn);

    return card;
  }

  private startBuilding(buildingType: BuildingType): void {
    this.close();
    this.game.inputSystem.setMode(`build_${buildingType}`);
  }
}
