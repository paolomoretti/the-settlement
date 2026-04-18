import { Game } from './core/Game';
import { eventBus } from './core/EventBus';
import { dataManager } from './data/DataManager';
import { BuildingMenu } from './ui/BuildingMenu';
import { BuildingPopover } from './ui/BuildingPopover';

let game: Game | null = null;
let buildingMenu: BuildingMenu | null = null;
let buildingPopover: BuildingPopover | null = null;

const SAVE_SLOT_PREFIX = 'settler_save_';
const LAST_SAVE_KEY = 'settler_last_save_slot';

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  if (!canvas) {
    console.error('Canvas element not found!');
    return;
  }

  setupDialogs();

  document.getElementById('btn-start-game')?.addEventListener('click', () => {
    launchGame(canvas);
  });

  document.getElementById('btn-load-game-welcome')?.addEventListener('click', () => {
    openLoadDialog((slotIndex) => {
      const slotData = getFullSlotData(slotIndex);
      if (slotData) {
        localStorage.setItem(LAST_SAVE_KEY, slotIndex.toString());
        launchGame(canvas, slotData.data);
      }
    });
  });

  const lastSlot = localStorage.getItem(LAST_SAVE_KEY);
  if (lastSlot !== null) {
    const slotData = getFullSlotData(parseInt(lastSlot));
    if (slotData) {
      launchGame(canvas, slotData.data);
      return;
    }
  }

  showScreen('welcome');
});

// --- Screen Management ---

function showScreen(screen: 'welcome' | 'game'): void {
  const welcomeScreen = document.getElementById('welcome-screen')!;
  const gameContainer = document.getElementById('game-container')!;
  const loadingScreen = document.getElementById('loading-screen')!;

  loadingScreen.style.display = 'none';

  if (screen === 'welcome') {
    welcomeScreen.style.display = 'flex';
    gameContainer.style.display = 'none';
    updateWelcomeLoadButton();
  } else {
    welcomeScreen.style.display = 'none';
    gameContainer.style.display = '';
  }
}

function updateWelcomeLoadButton(): void {
  const hasAnySave = Array.from({ length: 10 }, (_, i) =>
    localStorage.getItem(`${SAVE_SLOT_PREFIX}${i}`)
  ).some(Boolean);
  const btn = document.getElementById('btn-load-game-welcome') as HTMLButtonElement;
  if (btn) btn.disabled = !hasAnySave;
}

function launchGame(canvas: HTMLCanvasElement, saveData?: any): void {
  showScreen('game');

  if (!game) {
    if (saveData) {
      game = new Game(canvas, true);
      game.loadSaveData(saveData);
    } else {
      game = new Game(canvas);
    }
    setupGameUI(game);
    (window as any).game = game;
  } else {
    if (saveData) {
      game.loadSaveData(saveData);
    } else {
      game.resetForNewGame();
    }
  }

  game.start();
}

function exitToWelcome(): void {
  localStorage.removeItem(LAST_SAVE_KEY);
  if (game) {
    game.stop();
  }
  showScreen('welcome');
}

// --- Save/Load Slot Management ---

function getFullSlotData(index: number): { name: string; timestamp: number; data: any } | null {
  const raw = localStorage.getItem(`${SAVE_SLOT_PREFIX}${index}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getSlotMeta(index: number): { name: string; timestamp: number } | null {
  const data = getFullSlotData(index);
  if (!data) return null;
  return { name: data.name, timestamp: data.timestamp };
}

function saveToSlot(index: number, name: string): void {
  if (!game) return;
  const gameData = game.getSaveData();
  const slotData = { name, timestamp: Date.now(), data: gameData };
  localStorage.setItem(`${SAVE_SLOT_PREFIX}${index}`, JSON.stringify(slotData));
  localStorage.setItem(LAST_SAVE_KEY, index.toString());
}

// --- Dialogs ---

function setupDialogs(): void {
  const saveLoadDialog = document.getElementById('save-load-dialog')!;
  const exitDialog = document.getElementById('exit-dialog')!;

  document.getElementById('btn-close-save-load')?.addEventListener('click', () => {
    saveLoadDialog.style.display = 'none';
  });
  saveLoadDialog.addEventListener('click', (e) => {
    if (e.target === saveLoadDialog) saveLoadDialog.style.display = 'none';
  });

  document.getElementById('btn-save-and-exit')?.addEventListener('click', () => {
    exitDialog.style.display = 'none';
    openSaveDialog(() => {
      exitToWelcome();
    });
  });

  document.getElementById('btn-exit-no-save')?.addEventListener('click', () => {
    exitDialog.style.display = 'none';
    exitToWelcome();
  });

  document.getElementById('btn-cancel-exit')?.addEventListener('click', () => {
    exitDialog.style.display = 'none';
  });

  exitDialog.addEventListener('click', (e) => {
    if (e.target === exitDialog) exitDialog.style.display = 'none';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    if (saveLoadDialog.style.display !== 'none') {
      if (!saveLoadDialog.querySelector('.editing')) {
        saveLoadDialog.style.display = 'none';
        e.stopPropagation();
      }
    } else if (exitDialog.style.display !== 'none') {
      exitDialog.style.display = 'none';
      e.stopPropagation();
    }
  });
}

function openSaveDialog(onComplete?: () => void): void {
  const dialog = document.getElementById('save-load-dialog')!;
  const title = document.getElementById('save-load-title')!;
  const slotsContainer = document.getElementById('save-load-slots')!;

  title.textContent = 'Save Game';
  renderSlots(slotsContainer, 'save', (slotIndex, name) => {
    saveToSlot(slotIndex, name!);
    dialog.style.display = 'none';
    showMessage('Game saved!');
    onComplete?.();
  });

  dialog.style.display = 'flex';
}

function openLoadDialog(onLoad: (slotIndex: number) => void): void {
  const dialog = document.getElementById('save-load-dialog')!;
  const title = document.getElementById('save-load-title')!;
  const slotsContainer = document.getElementById('save-load-slots')!;

  title.textContent = 'Load Game';
  renderSlots(slotsContainer, 'load', (slotIndex) => {
    dialog.style.display = 'none';
    onLoad(slotIndex);
  });

  dialog.style.display = 'flex';
}

function renderSlots(
  container: HTMLElement,
  mode: 'save' | 'load',
  onAction: (slotIndex: number, name?: string) => void,
  editingIndex: number | null = null
): void {
  container.innerHTML = '';

  for (let i = 0; i < 10; i++) {
    const meta = getSlotMeta(i);
    const slot = document.createElement('div');

    if (mode === 'save' && editingIndex === i) {
      slot.className = 'save-slot editing';
      slot.innerHTML = `
        <span class="slot-number">${i + 1}.</span>
        <input type="text" class="slot-name-input" value="${escapeAttr(meta?.name || '')}" placeholder="Enter save name..." />
      `;
    } else {
      slot.className = 'save-slot' + (meta ? ' filled' : '');
      if (meta) {
        const date = new Date(meta.timestamp);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        slot.innerHTML = `
          <span class="slot-number">${i + 1}.</span>
          <span class="slot-name">${escapeHtml(meta.name)}</span>
          <span class="slot-date">${dateStr}</span>
          ${mode === 'save' ? '<span class="slot-edit-btn" title="Rename">&#9998;</span>' : ''}
        `;
      } else {
        slot.innerHTML = `
          <span class="slot-number">${i + 1}.</span>
          <span class="slot-name empty-label">Empty</span>
          <span class="slot-date"></span>
        `;
      }
    }

    container.appendChild(slot);

    if (mode === 'save' && editingIndex === i) {
      const input = slot.querySelector('.slot-name-input') as HTMLInputElement;
      requestAnimationFrame(() => { input.focus(); input.select(); });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.stopPropagation();
          onAction(i, input.value.trim() || `Save ${i + 1}`);
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          renderSlots(container, mode, onAction);
        }
      });
    } else if (mode === 'save' && meta) {
      slot.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('slot-edit-btn')) {
          renderSlots(container, mode, onAction, i);
        } else {
          onAction(i, meta.name);
        }
      });
    } else if (mode === 'save') {
      slot.addEventListener('click', () => {
        renderSlots(container, mode, onAction, i);
      });
    } else if (mode === 'load' && meta) {
      slot.addEventListener('click', () => onAction(i));
    } else if (mode === 'load') {
      slot.classList.add('disabled');
    }
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str: string): string {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- Game UI ---

function setupGameUI(game: Game): void {
  buildingMenu = new BuildingMenu(game);

  eventBus.on('input:mode_changed', (mode) => {
    const modeToButtonId: Record<string, string> = {
      'view': 'btn-view',
      'build_road': 'btn-road'
    };
    updateButtonStates(modeToButtonId[mode] || 'btn-view');

    if (mode === 'view') {
      buildingMenu!.close();
    } else if (document.getElementById('building-menu-panel')?.style.display === 'block') {
      buildingMenu!.refresh();
    }
  });

  document.getElementById('btn-view')?.addEventListener('click', () => {
    game.inputSystem.setMode('view');
  });

  document.getElementById('btn-road')?.addEventListener('click', () => {
    game.inputSystem.setMode('build_road');
  });

  document.getElementById('btn-building-menu')?.addEventListener('click', () => {
    buildingMenu!.toggle();
  });

  document.getElementById('btn-spawn-worker')?.addEventListener('click', () => {
    eventBus.emit('spawn:worker');
  });

  document.getElementById('btn-save')?.addEventListener('click', () => {
    openSaveDialog();
  });

  document.getElementById('btn-load')?.addEventListener('click', () => {
    openLoadDialog((slotIndex) => {
      const slotData = getFullSlotData(slotIndex);
      if (slotData) {
        game.loadSaveData(slotData.data);
        localStorage.setItem(LAST_SAVE_KEY, slotIndex.toString());
        showMessage('Game loaded!');
      }
    });
  });

  document.getElementById('btn-exit')?.addEventListener('click', () => {
    document.getElementById('exit-dialog')!.style.display = 'flex';
  });

  buildingPopover = new BuildingPopover(game);

  eventBus.on('building:selected', (data) => {
    buildingPopover!.show(data.entity);
  });

  eventBus.on('building:deselected', () => {
    buildingPopover!.hide();
  });

  eventBus.on('delete:selected', () => {
    showMessage('Building deleted');
  });

  eventBus.on('open:inventory', () => {
    showInventoryPanel(game);
  });

  document.getElementById('btn-close-inventory')?.addEventListener('click', () => {
    hideInventoryPanel();
  });
}

function showInventoryPanel(game: Game): void {
  const panel = document.getElementById('inventory-panel');
  if (!panel) return;

  const popDisplay = document.getElementById('population-display');
  if (popDisplay) {
    popDisplay.textContent = `${game.population.current}/${game.population.max}`;
  }

  const inventoryList = document.getElementById('inventory-list');
  if (!inventoryList) return;

  inventoryList.innerHTML = '';

  const categories = ['raw', 'refined', 'food', 'tool', 'weapon'] as const;
  categories.forEach(category => {
    const resources = dataManager.getResourcesByCategory(category);
    resources.forEach(resource => {
      const count = game.inventory[resource.id] || 0;
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
  if (panel) panel.style.display = 'none';
}

function updateButtonStates(activeButtonId: string): void {
  const buttons = ['btn-view', 'btn-road'];
  buttons.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('selected', id === activeButtonId);
  });
}

function showMessage(message: string): void {
  const modeElement = document.getElementById('current-mode');
  if (modeElement) {
    const originalText = modeElement.textContent;
    modeElement.textContent = message;
    setTimeout(() => {
      modeElement.textContent = originalText;
    }, 2000);
  }
}
