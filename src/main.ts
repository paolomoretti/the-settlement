/**
 * Main entry point - initializes and starts the game
 */

import { Game } from './core/Game';
import { eventBus } from './core/EventBus';
import { dataManager } from './data/DataManager';
import { BuildingMenu } from './ui/BuildingMenu';

// Wait for DOM to be ready
window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

  if (!canvas) {
    console.error('Canvas element not found!');
    return;
  }

  // Create and start game
  const game = new Game(canvas);
  game.start();

  console.log('🎮 Settler game started!');
  console.log('Controls:');
  console.log('  - Drag to pan camera');
  console.log('  - Click buttons to enter build mode');
  console.log('  - Click on map to place buildings/roads');

  // Setup UI controls
  setupUIControls(game);

  // Make game accessible for debugging
  (window as any).game = game;
});

function setupUIControls(game: Game): void {
  // Initialize building menu
  const buildingMenu = new BuildingMenu(game);

  // Listen to mode changes to update button states
  eventBus.on('input:mode_changed', (mode) => {
    const modeToButtonId: Record<string, string> = {
      'view': 'btn-view',
      'build_road': 'btn-road'
    };
    updateButtonStates(modeToButtonId[mode] || 'btn-view');

    // Refresh building menu when mode changes (to update affordability)
    if (document.getElementById('building-menu-panel')?.style.display === 'block') {
      buildingMenu.refresh();
    }
  });

  // View mode
  const btnView = document.getElementById('btn-view');
  btnView?.addEventListener('click', () => {
    game.inputSystem.setMode('view');
  });

  // Build road mode
  const btnRoad = document.getElementById('btn-road');
  btnRoad?.addEventListener('click', () => {
    game.inputSystem.setMode('build_road');
  });

  // Building menu button
  const btnBuildingMenu = document.getElementById('btn-building-menu');
  btnBuildingMenu?.addEventListener('click', () => {
    buildingMenu.toggle();
  });

  // Spawn worker
  const btnSpawnWorker = document.getElementById('btn-spawn-worker');
  btnSpawnWorker?.addEventListener('click', () => {
    eventBus.emit('spawn:worker');
  });

  // Save game
  const btnSave = document.getElementById('btn-save');
  btnSave?.addEventListener('click', () => {
    game.save();
    showMessage('Game saved!');
  });

  // Load game
  const btnLoad = document.getElementById('btn-load');
  btnLoad?.addEventListener('click', () => {
    if (game.load()) {
      showMessage('Game loaded!');
    } else {
      showMessage('No save data found');
    }
  });

  // Selection panel - Delete button
  const btnDelete = document.getElementById('btn-delete');
  btnDelete?.addEventListener('click', () => {
    eventBus.emit('delete:selected');
    showMessage('Building deleted');
  });

  // Inventory panel
  eventBus.on('open:inventory', () => {
    showInventoryPanel(game);
  });

  const btnCloseInventory = document.getElementById('btn-close-inventory');
  btnCloseInventory?.addEventListener('click', () => {
    hideInventoryPanel();
  });
}

function showInventoryPanel(game: Game): void {
  const panel = document.getElementById('inventory-panel');
  if (!panel) return;

  // Update population display
  const popDisplay = document.getElementById('population-display');
  if (popDisplay) {
    popDisplay.textContent = `${game.population.current}/${game.population.max}`;
  }

  // Update inventory list
  const inventoryList = document.getElementById('inventory-list');
  if (!inventoryList) return;

  inventoryList.innerHTML = '';

  // Group resources by category
  const categories = ['raw', 'refined', 'food', 'tool', 'weapon'] as const;

  categories.forEach(category => {
    const resources = dataManager.getResourcesByCategory(category);
    resources.forEach(resource => {
      const count = game.inventory[resource.id] || 0;

      // Only show resources that exist in inventory
      if (count > 0) {
        const item = document.createElement('div');
        item.className = 'inventory-item';
        item.innerHTML = `
          <span class="inventory-item-name">${resource.name}</span>
          <span class="inventory-item-count">${count}</span>
        `;
        inventoryList.appendChild(item);
      }
    });
  });

  panel.style.display = 'block';
}

function hideInventoryPanel(): void {
  const panel = document.getElementById('inventory-panel');
  if (panel) {
    panel.style.display = 'none';
  }
}

function updateButtonStates(activeButtonId: string): void {
  const buttons = ['btn-view', 'btn-road'];
  buttons.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      if (id === activeButtonId) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    }
  });
}

function showMessage(message: string): void {
  // Simple message display - could be enhanced with a proper toast system
  const modeElement = document.getElementById('current-mode');
  if (modeElement) {
    const originalText = modeElement.textContent;
    modeElement.textContent = message;
    setTimeout(() => {
      modeElement.textContent = originalText;
    }, 2000);
  }
}
