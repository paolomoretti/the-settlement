import { Game } from './core/Game';
import { eventBus } from './core/EventBus';
import { dataManager } from '@/data/DataManager';
import { themeManager } from '@/data/ThemeManager';
import { BuildingMenu } from '@/ui/BuildingMenu';
import { BuildingPopover } from '@/ui/BuildingPopover';
import { GamePopover } from '@/ui/GamePopover';
import { CanvasHoverTooltip } from '@/ui/CanvasHoverTooltip';
import { Position } from '@/components/Position';
import { setupKeyboardShortcuts } from '@/input/KeyboardShortcuts';
import { showToast, setupToastListener } from '@/ui/Toast';
import { ConfirmDeleteDialog } from '@/ui/ConfirmDeleteDialog';
import { audioManager } from '@/audio/AudioManager';
import { anySaveSlotsExist, GameSaveSession } from '@/save/GameSaveSession';
import {
  setRoadRenderingMode,
  type RoadRenderingMode,
  setWaterRenderingMode,
  type WaterRenderingMode,
} from '@/debug/debugFlags';
import tippy from 'tippy.js';
import 'tippy.js/dist/tippy.css';

let game: Game | null = null;
let buildingMenu: BuildingMenu | null = null;
let buildingPopover: BuildingPopover | null = null;
let confirmDeleteDialog: ConfirmDeleteDialog | null = null;
let cellSurveyPopover: GamePopover | null = null;
let canvasHoverTooltip: CanvasHoverTooltip | null = null;
let roadWorkerPopover: GamePopover | null = null;
let roadWorkerPopoverEntityId: number | null = null;
let unregisterHoverFrameHook: (() => void) | null = null;
let inventoryActiveTab: 'resources' | 'workers' | 'production' = 'resources';

const OPTIONS_KEY = 'settler_options';
const NEW_GAME_LOADING_MESSAGE = 'Thinking about the land and placing rival villages...';
const MIN_NEW_GAME_LOADING_MS = 900;

type GameOptions = {
  autosave: boolean;
  debugInfo: boolean;
  buildingLabels: boolean;
  navigator: boolean;
  soundEffects: boolean;
  roadRenderingMode: RoadRenderingMode;
  waterRenderingMode: WaterRenderingMode;
  veganMode: boolean;
};

function normalizeRoadRenderingMode(value: unknown): RoadRenderingMode {
  return value === 'classic' ? 'classic' : 'vector';
}

function normalizeWaterRenderingMode(value: unknown): WaterRenderingMode {
  return value === 'classic' ? 'classic' : 'smooth';
}

function loadOptions(): GameOptions {
  const defaults: GameOptions = {
    autosave: true,
    debugInfo: true,
    buildingLabels: true,
    navigator: true,
    soundEffects: true,
    roadRenderingMode: 'vector',
    waterRenderingMode: 'smooth',
    veganMode: false,
  };
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GameOptions>;
      return {
        ...defaults,
        ...parsed,
        roadRenderingMode: normalizeRoadRenderingMode(parsed.roadRenderingMode),
        waterRenderingMode: normalizeWaterRenderingMode(parsed.waterRenderingMode),
      };
    }
  } catch {}
  return defaults;
}

function saveOptions(opts: GameOptions): void {
  localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts));
}

const saveSession = new GameSaveSession({
  getGame: () => game,
  isAutosaveEnabled: () => loadOptions().autosave,
  toast: showToast,
  saveToast: showSaveToast,
  onSlotsChanged: updateWelcomeLoadButton,
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
    saveSession.openLoadDialog(slotIndex => {
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

function showLoadingScreen(message: string): void {
  const welcomeScreen = document.getElementById('welcome-screen')!;
  const gameContainer = document.getElementById('game-container')!;
  const loadingScreen = document.getElementById('loading-screen')!;
  loadingScreen.textContent = message;
  loadingScreen.style.display = 'flex';
  welcomeScreen.style.display = 'none';
  gameContainer.style.display = 'none';
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function updateWelcomeLoadButton(): void {
  const btn = document.getElementById('btn-load-game-welcome') as HTMLButtonElement;
  if (btn) btn.disabled = !anySaveSlotsExist();
}

function openSaveSlotDialog(): void {
  saveSession.openSaveDialog(undefined, 'Save As — pick a slot');
}

function showSaveToast(): void {
  showToast('Game saved', {
    duration: 5000,
    messageAsButton: true,
    action: {
      label: '✎',
      title: 'Pick save slot',
      onClick: openSaveSlotDialog,
    },
  });
}

function manualSaveOrPickSlot(): void {
  const slot = saveSession.getCurrentSlot();
  if (slot !== null && saveSession.hasManualSaveSlot()) {
    const meta = saveSession.getSlotMeta(slot);
    if (meta && saveSession.saveToSlot(slot, meta.name, { manual: true })) {
      showSaveToast();
      return;
    }
  }
  saveSession.openSaveDialog(undefined, 'Save Game — pick a slot');
}

async function launchGame(canvas: HTMLCanvasElement, saveData?: unknown): Promise<void> {
  const isNewGame = !saveData;
  const loadingStartedAt = performance.now();

  if (isNewGame) {
    showLoadingScreen(NEW_GAME_LOADING_MESSAGE);
    await nextFrame();
  } else {
    showScreen('game');
  }

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

  if (isNewGame) {
    const remaining = MIN_NEW_GAME_LOADING_MS - (performance.now() - loadingStartedAt);
    if (remaining > 0) await wait(remaining);
    showScreen('game');
  }

  game.start();

  saveSession.registerUnloadHooksOnce();
  saveSession.startAutoSaveIfEnabled();
}

function exitToWelcome(): void {
  saveSession.stopAutoSave();
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
  saveLoadDialog.addEventListener('click', e => {
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

  exitDialog.addEventListener('click', e => {
    if (e.target === exitDialog) exitDialog.style.display = 'none';
  });
}

function setupGameUI(game: Game): void {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

  setupKeyboardShortcuts(game);
  setupToastListener();
  buildingMenu = new BuildingMenu(game);

  eventBus.on('input:mode_changed', mode => {
    const toolbarBtn = mode === 'build_road' ? 'btn-road' : mode === 'erase' ? 'btn-erase' : null;
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
    manualSaveOrPickSlot();
  });

  eventBus.on('open:save_dialog', () => {
    saveSession.openSaveDialog(undefined, 'Save Game — pick a slot');
  });

  eventBus.on('quick:save', () => {
    manualSaveOrPickSlot();
  });

  document.getElementById('btn-load')?.addEventListener('click', () => {
    saveSession.openLoadDialog(slotIndex => {
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

  const fastForwardButton = document.getElementById('btn-fast-forward') as HTMLButtonElement | null;
  const fastForwardIcon =
    fastForwardButton?.querySelector<HTMLImageElement>('.btn-fast-forward-icon') ?? null;
  const syncFastForwardButton = (): void => {
    if (!fastForwardButton) return;
    const fastEnabled = game.isFastForwardEnabled();
    const paused = game.isPaused();
    fastForwardButton.classList.toggle('is-active', fastEnabled || paused);
    fastForwardButton.classList.toggle('is-paused', paused);
    fastForwardButton.setAttribute('aria-pressed', paused || fastEnabled ? 'true' : 'false');
    fastForwardButton.setAttribute(
      'aria-label',
      paused
        ? 'Game paused (press P to resume)'
        : fastEnabled
          ? 'Disable fast forward'
          : 'Enable fast forward'
    );
    if (fastForwardIcon) {
      const normalSrc = fastForwardIcon.dataset.normalSrc ?? '/assets/ui/fast_forward.png';
      const activeSrc = fastForwardIcon.dataset.activeSrc ?? '/assets/ui/fast_forward_selected.png';
      const pausedSrc = fastForwardIcon.dataset.pausedSrc ?? '/assets/ui/pause.png';
      fastForwardIcon.src = paused ? pausedSrc : fastEnabled ? activeSrc : normalSrc;
    }
  };
  if (fastForwardButton) {
    tippy(fastForwardButton, {
      ...iconBarTippy,
      content: 'Fast forward (3x) [F] · Pause [P]',
    });
    fastForwardButton.addEventListener('click', () => {
      game.setFastForwardEnabled(!game.isFastForwardEnabled());
      syncFastForwardButton();
    });
    syncFastForwardButton();
  }
  eventBus.on('toggle:fast_forward', () => {
    game.setFastForwardEnabled(!game.isFastForwardEnabled());
    syncFastForwardButton();
  });
  eventBus.on('toggle:pause', () => {
    const next = !game.isPaused();
    game.setPaused(next);
    syncFastForwardButton();
    showToast(next ? 'Paused' : 'Resumed');
  });

  const optionsButton = document.getElementById('btn-options');
  if (optionsButton) {
    tippy(optionsButton, {
      ...iconBarTippy,
      content: 'Settings',
    });
  }

  setupOptionsPanel(game);

  buildingPopover = new BuildingPopover(game);
  confirmDeleteDialog = new ConfirmDeleteDialog();

  eventBus.on('confirm:delete_building', (data: { buildingName: string }) => {
    confirmDeleteDialog!.show(data.buildingName, () => {
      eventBus.emit('delete:selected');
    });
  });

  eventBus.on('confirm:erase_building', (data: { x: number; y: number; buildingName: string }) => {
    confirmDeleteDialog!.show(data.buildingName, () => {
      eventBus.emit('erase:building_confirmed', { x: data.x, y: data.y });
    });
  });

  cellSurveyPopover = new GamePopover(document.getElementById('ui-overlay')!);
  cellSurveyPopover.onClose = () => {
    if (game) game.cellSurveyMenuOpen = false;
    game?.setSurveyMenuHighlight(null);
    game?.clearSurveyPending();
  };

  eventBus.on('survey:cell_menu_close', () => {
    if (game) game.cellSurveyMenuOpen = false;
    game?.clearSurveyPending();
    cellSurveyPopover?.hide();
  });

  eventBus.on(
    'cell:empty_menu',
    (payload: { gridX: number; gridY: number; canSend: boolean; canSendExplorer: boolean }) => {
      if (!game) return;
      const gx = payload.gridX;
      const gy = payload.gridY;

      game.clearSurveyPending();
      game.setSurveyMenuHighlight({ x: gx, y: gy });

      // ── Build two specialist cards side by side ─────────────────────────
      const makeCard = (opts: {
        icon: string;
        label: string;
        description: string;
        disabledReason: string | null; // null = enabled
        btnText: string;
        onClick: () => void;
      }): HTMLElement => {
        const disabled = opts.disabledReason !== null;
        const card = document.createElement('div');
        card.style.cssText = [
          'display:flex',
          'flex-direction:column',
          'gap:8px',
          'padding:10px 12px',
          'border-radius:4px',
          'flex:1',
          `background:${disabled ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)'}`,
          `border:1px solid ${disabled ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.18)'}`,
          `opacity:${disabled ? '0.6' : '1'}`,
        ].join(';');

        const iconEl = document.createElement('div');
        iconEl.style.cssText = 'font-size:24px; line-height:1; text-align:center';
        iconEl.textContent = opts.icon;

        const labelEl = document.createElement('div');
        labelEl.style.cssText = 'font-size:12px; font-weight:bold; color:#fff; text-align:center';
        labelEl.textContent = opts.label;

        const descEl = document.createElement('div');
        descEl.style.cssText = [
          'font-size:11px',
          'line-height:1.4',
          'flex:1',
          `color:${disabled ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.75)'}`,
        ].join(';');
        descEl.textContent = disabled ? opts.disabledReason! : opts.description;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.style.cssText = 'width:100%; margin-top:4px';
        btn.textContent = opts.btnText;
        btn.disabled = disabled;
        btn.addEventListener('click', opts.onClick);

        card.append(iconEl, labelEl, descEl, btn);
        return card;
      };

      const content = document.createElement('div');
      content.style.cssText = 'display:flex; flex-direction:row; gap:10px; min-width:320px';

      content.appendChild(
        makeCard({
          icon: '⛏️',
          label: 'Surveyor',
          description:
            'Reads the soil for buried minerals. Plants field signs on each spot showing the richest find for a while.',
          disabledReason: payload.canSend
            ? null
            : 'No free worker, or the camp needs a road link. Wait until the signs are gone.',
          btnText: 'Send Surveyor',
          onClick: () => {
            cellSurveyPopover?.hide();
            game.setSurveyMenuHighlight(null);
            game.clearSurveyPending();
            if (game.surveys.tryDispatchSurveyor(gx, gy)) showToast('Surveyor dispatched');
          },
        })
      );

      content.appendChild(
        makeCard({
          icon: '🧭',
          label: 'Explorer',
          description:
            'Pushes back the fog of war around this cell. Patrols the area for 3 minutes, stopping to scan the horizon with binoculars.',
          disabledReason: payload.canSendExplorer
            ? null
            : 'No free settler available, or headquarters has no road exit.',
          btnText: 'Send Explorer',
          onClick: () => {
            cellSurveyPopover?.hide();
            game.setSurveyMenuHighlight(null);
            game.clearSurveyPending();
            if (game.tryDispatchExplorer(gx, gy)) showToast('Explorer dispatched');
          },
        })
      );

      cellSurveyPopover!.show('Dispatch', content, () => {
        // Integer grid = diamond center in this iso map (+0.5,+0.5 is the bottom vertex, not the center).
        const screen = game.renderSystem.gridToScreen(gx, gy);
        return { x: screen.x, y: screen.y };
      });
      game.cellSurveyMenuOpen = true;
    }
  );

  if (unregisterHoverFrameHook) {
    unregisterHoverFrameHook();
    unregisterHoverFrameHook = null;
  }
  canvasHoverTooltip?.destroy();
  canvasHoverTooltip = new CanvasHoverTooltip(canvas, {
    getGame: () => game,
    shouldSuppressBuildingHover: entity =>
      Boolean(buildingPopover?.isVisible() && game.selectedEntity === entity),
  });
  unregisterHoverFrameHook = game.registerFrameHook(() => {
    canvasHoverTooltip?.tick();
  });

  eventBus.on('building:selected', data => {
    hideRoadWorkerPopover();
    buildingPopover!.show(data.entity);
  });

  eventBus.on('building:deselected', () => {
    buildingPopover!.hide();
  });

  eventBus.on('road_worker:selected', data => {
    buildingPopover!.hide();
    showRoadWorkerPopover(data);
  });

  eventBus.on('road_worker:deselected', () => {
    hideRoadWorkerPopover();
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
  document.getElementById('inventory-tab-resources')?.addEventListener('click', () => {
    setInventoryTab('resources');
  });
  document.getElementById('inventory-tab-workers')?.addEventListener('click', () => {
    setInventoryTab('workers');
  });
  document.getElementById('inventory-tab-production')?.addEventListener('click', () => {
    setInventoryTab('production');
  });

  const inventoryOverlay = document.getElementById('inventory-overlay');
  inventoryOverlay?.addEventListener('click', e => {
    if (e.target === inventoryOverlay) hideInventoryPanel();
  });

  const buildingMenuOverlay = document.getElementById('building-menu-overlay');
  buildingMenuOverlay?.addEventListener('click', e => {
    if (e.target === buildingMenuOverlay) buildingMenu!.close();
  });

  eventBus.on('close:inventory', () => hideInventoryPanel());
  eventBus.on('close:building_menu', () => buildingMenu?.close());
  eventBus.on('close:options', () => closeOptionsOverlay());
}

function hideRoadWorkerPopover(): void {
  roadWorkerPopover?.hide();
  roadWorkerPopoverEntityId = null;
}

function showRoadWorkerPopover(data: any): void {
  if (!game) return;
  const entity = data.entity;
  const worker = data.worker;
  if (!entity || !worker) return;

  if (!roadWorkerPopover) {
    const container = document.getElementById('ui-overlay')!;
    roadWorkerPopover = new GamePopover(container);
    roadWorkerPopover.onClose = () => {
      if (game?.selectedEntity?.id === roadWorkerPopoverEntityId) {
        game.selectedEntity = null;
      }
      roadWorkerPopoverEntityId = null;
    };
  }

  roadWorkerPopoverEntityId = entity.id;
  const isDonkey = worker.carrierType === 'donkey';
  const capacity = worker.transportCarryCapacity ?? 1;
  const content = document.createElement('div');
  content.className = 'road-worker-popover-body';
  content.style.minWidth = '220px';

  const stats = document.createElement('div');
  stats.style.display = 'grid';
  stats.style.gap = '7px';
  stats.style.marginBottom = '10px';
  stats.appendChild(createRoadWorkerStat('HQ donkeys', `${data.donkeysAtHq ?? 0}`));
  stats.appendChild(createRoadWorkerStat('Carry capacity', `${capacity}`));

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = isDonkey ? 'Swap with normal worker' : 'Replace with donkey';
  btn.disabled = isDonkey ? !data.canReturnDonkeyToHq : !data.canReplaceWithDonkey;
  btn.style.width = '100%';
  btn.style.padding = '8px 10px';
  btn.style.border = '1px solid rgba(246, 210, 106, 0.75)';
  btn.style.borderRadius = '6px';
  btn.style.background = btn.disabled ? 'rgba(80, 70, 60, 0.8)' : '#8b5f2b';
  btn.style.color = '#fff8dc';
  btn.style.fontWeight = '700';
  btn.style.cursor = btn.disabled ? 'not-allowed' : 'pointer';
  btn.addEventListener('click', () => {
    eventBus.emit(isDonkey ? 'road_worker:return_donkey' : 'road_worker:replace_with_donkey', {
      entityId: entity.id,
    });
  });

  content.appendChild(stats);
  content.appendChild(btn);

  roadWorkerPopover.show(isDonkey ? 'Donkey Carrier' : 'Road Worker', content, () => {
    const pos = entity.getComponent(Position);
    if (!game || !pos) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    return game.renderSystem.gridToScreen(pos.x, pos.y);
  });
}

function createRoadWorkerStat(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.style.display = 'grid';
  row.style.gridTemplateColumns = '1fr auto';
  row.style.alignItems = 'center';
  row.style.gap = '7px';

  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  labelEl.style.opacity = '0.82';

  const valueEl = document.createElement('strong');
  valueEl.textContent = value;
  valueEl.style.color = '#fff2d0';

  row.appendChild(labelEl);
  row.appendChild(valueEl);
  return row;
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
  const veganModeToggle = document.getElementById('opt-vegan-mode') as HTMLInputElement;
  const roadRenderingButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-road-rendering]')
  );
  const waterRenderingButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-water-rendering]')
  );
  const opts = loadOptions();
  let roadRenderingMode = opts.roadRenderingMode;
  let waterRenderingMode = opts.waterRenderingMode;
  const syncRoadRenderingButtons = (): void => {
    for (const btn of roadRenderingButtons) {
      const active = btn.dataset.roadRendering === roadRenderingMode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  };
  const syncWaterRenderingButtons = (): void => {
    for (const btn of waterRenderingButtons) {
      const active = btn.dataset.waterRendering === waterRenderingMode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  };

  autosaveToggle.checked = opts.autosave;
  debugToggle.checked = opts.debugInfo;
  buildingLabelsToggle.checked = opts.buildingLabels;
  navigatorToggle.checked = opts.navigator;
  soundEffectsToggle.checked = opts.soundEffects;
  veganModeToggle.checked = opts.veganMode;
  roadRenderingMode = opts.roadRenderingMode;
  setRoadRenderingMode(roadRenderingMode);
  syncRoadRenderingButtons();
  waterRenderingMode = opts.waterRenderingMode;
  setWaterRenderingMode(waterRenderingMode);
  syncWaterRenderingButtons();

  if (!opts.debugInfo) document.getElementById('debug-info')!.style.display = 'none';
  if (!opts.buildingLabels) game.renderSystem.showBuildingLabels = false;
  if (!opts.navigator) document.getElementById('minimap')!.style.display = 'none';
  if (!opts.soundEffects) audioManager.toggle();

  const persistAll = () =>
    saveOptions({
      autosave: autosaveToggle.checked,
      debugInfo: debugToggle.checked,
      buildingLabels: buildingLabelsToggle.checked,
      navigator: navigatorToggle.checked,
      soundEffects: soundEffectsToggle.checked,
      roadRenderingMode,
      waterRenderingMode,
      veganMode: veganModeToggle.checked,
    });

  overlay.addEventListener('click', e => {
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

  veganModeToggle.addEventListener('change', () => {
    themeManager.setActiveTheme(veganModeToggle.checked ? 'vegan' : null);
    dataManager.invalidateThemedCaches();

    // Clear and reload sprites with new theme
    game.renderSystem.clearSpriteCache();

    // Refresh building menu if open to show updated names
    if (document.getElementById('building-menu-overlay')?.classList.contains('is-open')) {
      eventBus.emit('refresh:building_menu');
    }

    // Refresh inventory panel if open to show updated icons and names
    if (document.getElementById('inventory-overlay')?.classList.contains('is-open')) {
      showInventoryPanel(game);
    }

    persistAll();
  });

  for (const btn of roadRenderingButtons) {
    btn.addEventListener('click', () => {
      roadRenderingMode = normalizeRoadRenderingMode(btn.dataset.roadRendering);
      setRoadRenderingMode(roadRenderingMode);
      syncRoadRenderingButtons();
      persistAll();
    });
  }

  for (const btn of waterRenderingButtons) {
    btn.addEventListener('click', () => {
      waterRenderingMode = normalizeWaterRenderingMode(btn.dataset.waterRendering);
      setWaterRenderingMode(waterRenderingMode);
      syncWaterRenderingButtons();
      persistAll();
    });
  }
}

function makeResourceIconHtml(resourceId: string, className = 'resource-icon'): string {
  const resource = dataManager.getResource(resourceId as any);
  const src = resource?.icon || `/assets/resources/${resourceId}.png`;
  const fallback = `/assets/resources/${resourceId}.png`;
  // Apply theme transformation to both src and fallback
  const themedSrc = themeManager.transformSpritePath(src);
  const themedFallback = themeManager.transformSpritePath(fallback);
  const fallbackAttr = themedSrc === themedFallback ? '' : ` data-fallback="${themedFallback}"`;
  return `<img src="${themedSrc}" class="${className}"${fallbackAttr} onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;delete this.dataset.fallback;}else{this.style.display='none'}">`;
}

function updateProductionPriorityList(game: Game): void {
  const list = document.getElementById('production-priority-list');
  if (!list) return;
  list.innerHTML = '';

  // Build a map of building type → total placed count for the count badge
  const buildingCountMap = new Map<string, number>();
  for (const row of game.getBuildingOperationalSummary()) {
    buildingCountMap.set(row.buildingType, row.total);
  }

  const configurable = dataManager
    .getAllBuildings()
    .filter(building => building.production?.outputMode === 'weighted_random');
  const requiredTools = new Set(
    dataManager
      .getAllBuildings()
      .map(building => building.requiredTool)
      .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
  );

  if (configurable.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'inventory-item inventory-item--zero';
    empty.textContent = 'No production priorities available yet.';
    list.appendChild(empty);
    return;
  }

  for (const building of configurable) {
    const section = document.createElement('div');
    section.className = 'production-priority-building';

    const title = document.createElement('div');
    title.className = 'production-priority-building-title';
    title.textContent = building.id === 'metalworks' ? 'Tools' : building.name;
    section.appendChild(title);

    const hint = document.createElement('div');
    hint.className = 'production-priority-hint';
    hint.textContent = 'Each completed cycle picks one item at random using these weights.';
    section.appendChild(hint);

    const outputs = Object.entries(building.production!.outputs).filter(
      ([resourceId, amount]) => (amount ?? 0) > 0 && requiredTools.has(resourceId as any)
    );
    const priorityRows: Array<{
      resourceId: string;
      quantityEl: HTMLSpanElement;
      meterEl: HTMLDivElement;
      meterFillEl: HTMLSpanElement;
      meterLabelEl: HTMLSpanElement;
      minusBtn: HTMLButtonElement;
      plusBtn: HTMLButtonElement;
    }> = [];

    const refreshPriorities = () => {
      const totalPriority = outputs.reduce(
        (sum, [resourceId]) => sum + game.getProductionPriority(building.id, resourceId),
        0
      );
      for (const row of priorityRows) {
        const priority = game.getProductionPriority(building.id, row.resourceId);
        const percent = totalPriority > 0 ? Math.round((priority / totalPriority) * 100) : 0;
        row.quantityEl.textContent = `${priority}/10`;
        row.meterEl.setAttribute('aria-label', `${percent}% chance`);
        row.meterFillEl.style.width = `${priority * 10}%`;
        row.meterLabelEl.textContent = `${percent}%`;
        row.minusBtn.disabled = priority <= 1;
        row.plusBtn.disabled = priority >= 10;
      }
    };

    for (const [resourceId] of outputs) {
      const resource = dataManager.getResource(resourceId as any);

      const row = document.createElement('div');
      row.className = 'production-priority-row';

      const minus = document.createElement('button');
      minus.type = 'button';
      minus.className = 'production-priority-step';
      minus.textContent = '-';
      minus.addEventListener('click', () => {
        const priority = game.getProductionPriority(building.id, resourceId);
        game.setProductionPriority(building.id, resourceId, priority - 1);
        refreshPriorities();
      });

      const plus = document.createElement('button');
      plus.type = 'button';
      plus.className = 'production-priority-step';
      plus.textContent = '+';
      plus.addEventListener('click', () => {
        const priority = game.getProductionPriority(building.id, resourceId);
        game.setProductionPriority(building.id, resourceId, priority + 1);
        refreshPriorities();
      });

      const quantity = document.createElement('span');
      quantity.className = 'production-priority-quantity';

      const meter = document.createElement('div');
      meter.className = 'production-priority-meter';
      const meterFill = document.createElement('span');
      meterFill.className = 'production-priority-meter-fill';
      const meterLabel = document.createElement('span');
      meterLabel.className = 'production-priority-meter-label';
      meter.appendChild(meterFill);
      meter.appendChild(meterLabel);

      const toolCount = game.inventory[resourceId] ?? 0;
      row.innerHTML =
        `<div class="production-priority-name">` +
        `${makeResourceIconHtml(resourceId, 'resource-icon production-priority-icon')}` +
        `<span>${resource?.name || resourceId}</span>` +
        `<span class="production-priority-count">(${toolCount})</span>` +
        `</div>`;
      row.appendChild(quantity);
      row.appendChild(minus);
      row.appendChild(meter);
      row.appendChild(plus);
      section.appendChild(row);
      priorityRows.push({
        resourceId,
        quantityEl: quantity,
        meterEl: meter,
        meterFillEl: meterFill,
        meterLabelEl: meterLabel,
        minusBtn: minus,
        plusBtn: plus,
      });
    }

    refreshPriorities();
    list.appendChild(section);
  }

  const buildingSection = document.createElement('div');
  buildingSection.className = 'production-priority-building';

  const buildingTitle = document.createElement('div');
  buildingTitle.className = 'production-priority-building-title';
  buildingTitle.textContent = 'Buildings';
  buildingSection.appendChild(buildingTitle);

  const buildingHint = document.createElement('div');
  buildingHint.className = 'production-priority-hint';
  buildingHint.textContent =
    'Higher priority buildings receive construction materials and production inputs first when resources are scarce.';
  buildingSection.appendChild(buildingHint);

  const buildingPriorityRows: Array<{
    buildingType: string;
    quantityEl: HTMLSpanElement;
    meterEl: HTMLDivElement;
    meterFillEl: HTMLSpanElement;
    meterLabelEl: HTMLSpanElement;
    minusBtn: HTMLButtonElement;
    plusBtn: HTMLButtonElement;
  }> = [];

  const refreshBuildingPriorities = () => {
    for (const row of buildingPriorityRows) {
      const priority = game.getBuildingPriority(row.buildingType);
      row.quantityEl.textContent = `${priority}%`;
      row.meterEl.setAttribute('aria-label', `Building priority ${priority}%`);
      row.meterFillEl.style.width = `${priority}%`;
      row.meterLabelEl.textContent = `${priority}%`;
      row.minusBtn.disabled = priority <= 1;
      row.plusBtn.disabled = priority >= 100;
    }
  };

  const buildingRows = dataManager
    .getAllBuildings()
    .filter(building => building.id !== 'road' && building.id !== 'base_camp')
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const building of buildingRows) {
    const row = document.createElement('div');
    row.className = 'production-priority-row';

    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'production-priority-step';
    minus.textContent = '-';
    minus.addEventListener('click', () => {
      game.setBuildingPriority(building.id, game.getBuildingPriority(building.id) - 5);
      refreshBuildingPriorities();
    });

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'production-priority-step';
    plus.textContent = '+';
    plus.addEventListener('click', () => {
      game.setBuildingPriority(building.id, game.getBuildingPriority(building.id) + 5);
      refreshBuildingPriorities();
    });

    const quantity = document.createElement('span');
    quantity.className = 'production-priority-quantity';

    const meter = document.createElement('div');
    meter.className = 'production-priority-meter';
    const meterFill = document.createElement('span');
    meterFill.className = 'production-priority-meter-fill';
    const meterLabel = document.createElement('span');
    meterLabel.className = 'production-priority-meter-label';
    meter.appendChild(meterFill);
    meter.appendChild(meterLabel);

    const bldCount = buildingCountMap.get(building.id) ?? 0;
    row.innerHTML =
      `<div class="production-priority-name">` +
      `<span>${building.name}</span>` +
      `<span class="production-priority-count">(${bldCount})</span>` +
      `</div>`;
    row.appendChild(quantity);
    row.appendChild(minus);
    row.appendChild(meter);
    row.appendChild(plus);
    buildingSection.appendChild(row);
    buildingPriorityRows.push({
      buildingType: building.id,
      quantityEl: quantity,
      meterEl: meter,
      meterFillEl: meterFill,
      meterLabelEl: meterLabel,
      minusBtn: minus,
      plusBtn: plus,
    });
  }

  refreshBuildingPriorities();
  list.appendChild(buildingSection);
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
    const resources = dataManager.getResourcesByCategory(category).filter(r => !r.virtualOutput);
    resources.forEach(resource => {
      const count = game.inventory[resource.id] || 0;
      const item = document.createElement('div');
      item.className = 'inventory-item' + (count === 0 ? ' inventory-item--zero' : '');
      const iconPath = themeManager.transformSpritePath(`/assets/resources/${resource.id}.png`);
      item.innerHTML = `
          <span class="inventory-item-name"><img src="${iconPath}" class="resource-icon" onerror="this.style.display='none'">${resource.name}</span>
          <span class="inventory-item-count">${count}</span>
        `;
      inventoryList.appendChild(item);
    });
  });

  const workersList = document.getElementById('workers-list');
  if (workersList) {
    workersList.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'basecamp-tab-note';
    note.textContent =
      'Shown as employed / total. HQ-ready specialists count in total, but not employed.';
    workersList.appendChild(note);

    const specialistRows = game.getSpecializedWorkersSummary();
    specialistRows.forEach(row => {
      const item = document.createElement('div');
      const allEmployed = row.employed === row.total;
      item.className = 'worker-summary-item' + (allEmployed ? '' : ' worker-summary-item--idle');
      const icon = row.iconResourceId
        ? makeResourceIconHtml(row.iconResourceId, 'resource-icon worker-summary-icon')
        : '';
      item.innerHTML =
        `<span class="worker-summary-name">${icon}${row.label}</span>` +
        `<span class="worker-summary-count">${row.employed}/${row.total}</span>`;
      workersList.appendChild(item);
    });
  }

  updateProductionPriorityList(game);

  setInventoryTab(inventoryActiveTab);

  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
}

function hideInventoryPanel(): void {
  const overlay = document.getElementById('inventory-overlay');
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
}

function setInventoryTab(tab: 'resources' | 'workers' | 'production'): void {
  inventoryActiveTab = tab;
  const resBtn = document.getElementById('inventory-tab-resources');
  const workersBtn = document.getElementById('inventory-tab-workers');
  const productionBtn = document.getElementById('inventory-tab-production');
  const resSection = document.getElementById('inventory-section-resources');
  const workersSection = document.getElementById('inventory-section-workers');
  const productionSection = document.getElementById('inventory-section-production');
  resBtn?.classList.toggle('active', tab === 'resources');
  workersBtn?.classList.toggle('active', tab === 'workers');
  productionBtn?.classList.toggle('active', tab === 'production');
  resSection?.classList.toggle('active', tab === 'resources');
  workersSection?.classList.toggle('active', tab === 'workers');
  productionSection?.classList.toggle('active', tab === 'production');
}

function updateButtonStates(activeButtonId: string | null): void {
  const btnRoad = document.getElementById('btn-road');
  if (btnRoad) btnRoad.classList.toggle('selected', activeButtonId === 'btn-road');
  const btnErase = document.getElementById('btn-erase');
  if (btnErase) btnErase.classList.toggle('selected', activeButtonId === 'btn-erase');
}
