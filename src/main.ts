import { Game } from './core/Game';
import { eventBus } from './core/EventBus';
import { dataManager } from '@/data/DataManager';
import { BuildingMenu } from '@/ui/BuildingMenu';
import { BuildingPopover } from '@/ui/BuildingPopover';
import { CanvasHoverTooltip } from '@/ui/CanvasHoverTooltip';
import { setupKeyboardShortcuts } from '@/input/KeyboardShortcuts';
import { showToast, setupToastListener } from '@/ui/Toast';
import { audioManager } from '@/audio/AudioManager';
import { anySaveSlotsExist, GameSaveSession } from '@/save/GameSaveSession';
import tippy from 'tippy.js';
import 'tippy.js/dist/tippy.css';

let game: Game | null = null;
let buildingMenu: BuildingMenu | null = null;
let buildingPopover: BuildingPopover | null = null;
let canvasHoverTooltip: CanvasHoverTooltip | null = null;
let unregisterHoverFrameHook: (() => void) | null = null;

const OPTIONS_KEY = 'settler_options';

function loadOptions(): { autosave: boolean; debugInfo: boolean; buildingLabels: boolean; navigator: boolean; soundEffects: boolean } {
  const defaults = { autosave: true, debugInfo: true, buildingLabels: true, navigator: true, soundEffects: true };
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {}
  return defaults;
}

function saveOptions(opts: { autosave: boolean; debugInfo: boolean; buildingLabels: boolean; navigator: boolean; soundEffects: boolean }): void {
  localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts));
}

const saveSession = new GameSaveSession({
  getGame: () => game,
  isAutosaveEnabled: () => loadOptions().autosave,
  toast: showToast,
});

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  if (!canvas) {
    console.error('Canvas element not found!');
    return;
  }

  setupDialogs();

  document.getElementById('btn-start-game')?.addEventListener('click', () => {
    saveSession.clearResumeAndSlot();
    launchGame(canvas);
  });

  document.getElementById('btn-load-game-welcome')?.addEventListener('click', () => {
    saveSession.openLoadDialog((slotIndex) => {
      const slotData = saveSession.getFullSlotData(slotIndex);
      if (slotData) {
        saveSession.bindResumeSlot(slotIndex);
        launchGame(canvas, slotData.data);
      }
    });
  });

  const resumeIndex = saveSession.parseResumeSlotIndex();
  if (resumeIndex !== null) {
    const slotData = saveSession.getFullSlotData(resumeIndex);
    if (slotData) {
      saveSession.bindResumeSlot(resumeIndex);
      launchGame(canvas, slotData.data);
      return;
    }
    saveSession.clearStaleResumeKey();
  }

  showScreen('welcome');
});

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
  const btn = document.getElementById('btn-load-game-welcome') as HTMLButtonElement;
  if (btn) btn.disabled = !anySaveSlotsExist();
}

function launchGame(canvas: HTMLCanvasElement, saveData?: unknown): void {
  showScreen('game');

  if (!saveData) {
    saveSession.clearResumeAndSlot();
  }

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

  saveSession.registerUnloadHooksOnce();
  saveSession.startAutoSaveIfEnabled();
}

function exitToWelcome(): void {
  saveSession.clearResumeAndSlot();
  if (game) {
    game.stop();
  }
  showScreen('welcome');
}

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
    saveSession.openSaveDialog(() => {
      exitToWelcome();
    }, 'Save before exiting');
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
}

function setupGameUI(game: Game): void {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

  setupKeyboardShortcuts(game);
  setupToastListener();
  buildingMenu = new BuildingMenu(game);

  eventBus.on('input:mode_changed', (mode) => {
    const toolbarBtn =
      mode === 'build_road' ? 'btn-road' :
      mode === 'erase' ? 'btn-erase' : null;
    updateButtonStates(toolbarBtn);

    if (mode === 'view') {
      buildingMenu!.close();
    } else if (document.getElementById('building-menu-overlay')?.classList.contains('is-open')) {
      buildingMenu!.refresh();
    }
  });

  document.getElementById('btn-road')?.addEventListener('click', () => {
    game.inputSystem.setMode('build_road');
  });

  document.getElementById('btn-erase')?.addEventListener('click', () => {
    game.inputSystem.setMode('erase');
  });

  document.getElementById('btn-building-menu')?.addEventListener('click', () => {
    buildingMenu!.toggle();
  });

  eventBus.on('toggle:building_menu', () => {
    buildingMenu!.toggle();
  });

  document.getElementById('btn-save')?.addEventListener('click', () => {
    const slot = saveSession.getCurrentSlot();
    if (slot !== null) {
      const meta = saveSession.getSlotMeta(slot);
      if (meta && saveSession.saveToSlot(slot, meta.name)) {
        showToast('Game saved!');
        return;
      }
    }
    saveSession.openSaveDialog(undefined, 'Save Game — pick a slot');
  });

  document.getElementById('btn-save-as')?.addEventListener('click', () => {
    saveSession.openSaveDialog(undefined, 'Save As — pick a slot');
  });

  eventBus.on('open:save_dialog', () => {
    saveSession.openSaveDialog(undefined, 'Save Game — pick a slot');
  });

  eventBus.on('quick:save', () => {
    const slot = saveSession.getCurrentSlot();
    if (slot !== null) {
      const meta = saveSession.getSlotMeta(slot);
      if (meta && saveSession.saveToSlot(slot, meta.name)) {
        showToast('Game saved!');
        return;
      }
    }
    saveSession.openSaveDialog(undefined, 'Save Game — pick a slot');
  });

  document.getElementById('btn-load')?.addEventListener('click', () => {
    saveSession.openLoadDialog((slotIndex) => {
      const slotData = saveSession.getFullSlotData(slotIndex);
      if (slotData && game) {
        game.loadSaveData(slotData.data);
        saveSession.bindResumeSlot(slotIndex);
        showToast('Game loaded!');
      }
    });
  });

  document.getElementById('btn-exit')?.addEventListener('click', () => {
    document.getElementById('exit-dialog')!.style.display = 'flex';
  });

  const iconBarTippy = {
    placement: 'bottom' as const,
    animation: 'fade' as const,
    duration: [180, 120] as [number, number],
    arrow: true,
    touch: ['hold', 400] as ['hold', number],
  };

  const exitButton = document.getElementById('btn-exit');
  if (exitButton) {
    tippy(exitButton, {
      ...iconBarTippy,
      content: 'Exit to menu',
    });
  }

  const optionsButton = document.getElementById('btn-options');
  if (optionsButton) {
    tippy(optionsButton, {
      ...iconBarTippy,
      content: 'Settings',
    });
  }

  setupOptionsPanel(game);

  buildingPopover = new BuildingPopover(game);

  if (unregisterHoverFrameHook) {
    unregisterHoverFrameHook();
    unregisterHoverFrameHook = null;
  }
  canvasHoverTooltip?.destroy();
  canvasHoverTooltip = new CanvasHoverTooltip(canvas, {
    getGame: () => game,
    shouldSuppressBuildingHover: (entity) =>
      Boolean(buildingPopover?.isVisible() && game.selectedEntity === entity),
  });
  unregisterHoverFrameHook = game.registerFrameHook(() => {
    canvasHoverTooltip?.tick();
  });

  eventBus.on('building:selected', (data) => {
    buildingPopover!.show(data.entity);
  });

  eventBus.on('building:deselected', () => {
    buildingPopover!.hide();
  });

  eventBus.on('delete:selected', () => {
    showToast('Building deleted');
  });

  eventBus.on('open:inventory', () => {
    showInventoryPanel(game);
  });

  document.getElementById('btn-close-inventory')?.addEventListener('click', () => {
    hideInventoryPanel();
  });

  const inventoryOverlay = document.getElementById('inventory-overlay');
  inventoryOverlay?.addEventListener('click', (e) => {
    if (e.target === inventoryOverlay) hideInventoryPanel();
  });

  const buildingMenuOverlay = document.getElementById('building-menu-overlay');
  buildingMenuOverlay?.addEventListener('click', (e) => {
    if (e.target === buildingMenuOverlay) buildingMenu!.close();
  });

  eventBus.on('close:inventory', () => hideInventoryPanel());
  eventBus.on('close:building_menu', () => buildingMenu?.close());
  eventBus.on('close:options', () => closeOptionsOverlay());
}

function closeOptionsOverlay(): void {
  const overlay = document.getElementById('options-overlay');
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
}

function toggleOptionsOverlay(): void {
  const overlay = document.getElementById('options-overlay');
  if (!overlay) return;
  const open = !overlay.classList.contains('is-open');
  overlay.classList.toggle('is-open', open);
  overlay.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function setupOptionsPanel(game: Game): void {
  const overlay = document.getElementById('options-overlay')!;
  const autosaveToggle = document.getElementById('opt-autosave') as HTMLInputElement;
  const debugToggle = document.getElementById('opt-debug-info') as HTMLInputElement;
  const buildingLabelsToggle = document.getElementById('opt-building-labels') as HTMLInputElement;
  const navigatorToggle = document.getElementById('opt-navigator') as HTMLInputElement;
  const soundEffectsToggle = document.getElementById('opt-sound-effects') as HTMLInputElement;

  const opts = loadOptions();
  autosaveToggle.checked = opts.autosave;
  debugToggle.checked = opts.debugInfo;
  buildingLabelsToggle.checked = opts.buildingLabels;
  navigatorToggle.checked = opts.navigator;
  soundEffectsToggle.checked = opts.soundEffects;

  if (!opts.debugInfo) document.getElementById('debug-info')!.style.display = 'none';
  if (!opts.buildingLabels) game.renderSystem.showBuildingLabels = false;
  if (!opts.navigator) document.getElementById('minimap')!.style.display = 'none';
  if (!opts.soundEffects) audioManager.toggle();

  const persistAll = () => saveOptions({
    autosave: autosaveToggle.checked,
    debugInfo: debugToggle.checked,
    buildingLabels: buildingLabelsToggle.checked,
    navigator: navigatorToggle.checked,
    soundEffects: soundEffectsToggle.checked,
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeOptionsOverlay();
  });

  document.getElementById('btn-options')?.addEventListener('click', () => {
    toggleOptionsOverlay();
  });

  document.getElementById('btn-close-options')?.addEventListener('click', () => {
    closeOptionsOverlay();
  });

  eventBus.on('toggle:options', () => {
    toggleOptionsOverlay();
  });

  autosaveToggle.addEventListener('change', () => {
    if (autosaveToggle.checked) {
      saveSession.startAutoSave();
    } else {
      saveSession.stopAutoSave();
    }
    persistAll();
  });

  debugToggle.addEventListener('change', () => {
    const debugInfo = document.getElementById('debug-info');
    if (debugInfo) debugInfo.style.display = debugToggle.checked ? '' : 'none';
    persistAll();
  });

  buildingLabelsToggle.addEventListener('change', () => {
    game.renderSystem.showBuildingLabels = buildingLabelsToggle.checked;
    persistAll();
  });

  navigatorToggle.addEventListener('change', () => {
    const minimap = document.getElementById('minimap');
    if (minimap) minimap.style.display = navigatorToggle.checked ? '' : 'none';
    persistAll();
  });

  soundEffectsToggle.addEventListener('change', () => {
    audioManager.toggle();
    persistAll();
  });
}

function showInventoryPanel(game: Game): void {
  const overlay = document.getElementById('inventory-overlay');
  if (!overlay) return;

  const popDisplay = document.getElementById('population-display');
  if (popDisplay) {
    const available = game.getAvailablePopulation();
    popDisplay.textContent = `${available} available / ${game.population.max} max`;
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
          <span class="inventory-item-name"><img src="/assets/resources/${resource.id}.png" class="resource-icon" onerror="this.style.display='none'">${resource.name}</span>
          <span class="inventory-item-count">${count}</span>
        `;
        inventoryList.appendChild(item);
      }
    });
  });

  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
}

function hideInventoryPanel(): void {
  const overlay = document.getElementById('inventory-overlay');
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
}

function updateButtonStates(activeButtonId: string | null): void {
  const btnRoad = document.getElementById('btn-road');
  if (btnRoad) btnRoad.classList.toggle('selected', activeButtonId === 'btn-road');
  const btnErase = document.getElementById('btn-erase');
  if (btnErase) btnErase.classList.toggle('selected', activeButtonId === 'btn-erase');
}
