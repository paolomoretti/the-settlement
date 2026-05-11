import hotkeys from 'hotkeys-js';
import { Game } from '@/core/Game';
import { eventBus } from '@/core/EventBus';
import { registerInsightAltKeyListeners } from '@/input/InsightAltKey';
import { Position } from '@/components/Position';
import { Building } from '@/components/Building';

const PAN_STEP = 200;

export interface ShortcutBinding {
  key: string;
  description: string;
  category: 'navigation' | 'building' | 'general';
}

export const SHORTCUT_BINDINGS: ShortcutBinding[] = [
  {
    key: 'H',
    description: 'Center on base camp (press again to cycle through all HQs)',
    category: 'navigation',
  },
  { key: 'I', description: 'Open base camp details', category: 'general' },
  { key: 'R', description: 'Build road mode', category: 'building' },
  { key: 'E', description: 'Erase tool (roads, buildings, trees)', category: 'building' },
  { key: 'B', description: 'Open building menu', category: 'building' },
  { key: 'O', description: 'Open options', category: 'general' },
  { key: 'S', description: 'Quick save', category: 'general' },
  { key: 'F', description: 'Toggle fast-forward (3x)', category: 'general' },
  { key: 'P', description: 'Toggle pause (freeze gameplay)', category: 'general' },
  { key: 'Arrow Up', description: 'Pan up', category: 'navigation' },
  { key: 'Arrow Down', description: 'Pan down', category: 'navigation' },
  { key: 'Arrow Left', description: 'Pan left', category: 'navigation' },
  { key: 'Arrow Right', description: 'Pan right', category: 'navigation' },
  { key: '-', description: 'Zoom out', category: 'navigation' },
  { key: '+ / =', description: 'Zoom in', category: 'navigation' },
  {
    key: 'V',
    description: 'Return to view mode / Close dialog (same as Escape)',
    category: 'general',
  },
  { key: 'Escape', description: 'Return to view mode / Close dialog', category: 'general' },
  { key: 'Space (hold)', description: 'Pan mode (drag to pan)', category: 'navigation' },
  {
    key: 'Alt / Option (hold)',
    description: 'Show tile grid; hover buildings or rock for instant info + highlight',
    category: 'navigation',
  },
];

function isGamePanelOverlayOpen(overlayId: string): boolean {
  return document.getElementById(overlayId)?.classList.contains('is-open') ?? false;
}

function isModalOpen(): boolean {
  const saveLoad = document.getElementById('save-load-dialog');
  if (saveLoad && saveLoad.style.display !== 'none' && saveLoad.style.display !== '') return true;
  const exit = document.getElementById('exit-dialog');
  if (exit && exit.style.display !== 'none' && exit.style.display !== '') return true;
  if (isGamePanelOverlayOpen('options-overlay')) return true;
  if (isGamePanelOverlayOpen('inventory-overlay')) return true;
  if (isGamePanelOverlayOpen('building-menu-overlay')) return true;
  return false;
}

/** Close the topmost overlay if any. Returns true if Escape/V should not fall through to view mode. */
function tryCloseTopOverlay(): boolean {
  const saveLoadDialog = document.getElementById('save-load-dialog');
  if (
    saveLoadDialog &&
    saveLoadDialog.style.display !== 'none' &&
    saveLoadDialog.style.display !== ''
  ) {
    if (!saveLoadDialog.querySelector('.editing')) {
      saveLoadDialog.style.display = 'none';
    }
    return true;
  }

  const exitDialog = document.getElementById('exit-dialog');
  if (exitDialog && exitDialog.style.display !== 'none' && exitDialog.style.display !== '') {
    exitDialog.style.display = 'none';
    return true;
  }

  if (isGamePanelOverlayOpen('options-overlay')) {
    eventBus.emit('close:options');
    return true;
  }

  if (isGamePanelOverlayOpen('building-menu-overlay')) {
    eventBus.emit('close:building_menu');
    return true;
  }

  if (isGamePanelOverlayOpen('inventory-overlay')) {
    eventBus.emit('close:inventory');
    return true;
  }

  return false;
}

export function setupKeyboardShortcuts(game: Game): void {
  const { inputSystem, renderSystem } = game;

  // H — Cycle through player HQs (main base camp first, then auxiliary; cycles back)
  hotkeys('h', e => {
    if (isModalOpen()) return;
    if (inputSystem.getMode() !== 'view') return;
    e.preventDefault();

    // Build ordered list: main base camp first, then any captured auxiliary HQs.
    const allHqs = game.getPlayerHqEntities();
    if (allHqs.length === 0) return;
    const mainHq = game.baseCampEntity;
    const ordered = mainHq ? [mainHq, ...allHqs.filter(e => e !== mainHq)] : allHqs;

    // Find which HQ (if any) the camera is already centred on.
    const currentIndex = ordered.findIndex(hqEntity => {
      const pos = hqEntity.getComponent(Position);
      const building = hqEntity.getComponent(Building);
      if (!pos || !building) return false;
      return renderSystem.isCenteredOnGrid(pos.x + building.width / 2, pos.y + building.height / 2);
    });

    // If not centred on any HQ → jump to main (index 0).
    // If already centred on one → advance to the next, cycling back to main.
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % ordered.length;
    const target = ordered[nextIndex];

    const pos = target.getComponent(Position);
    const building = target.getComponent(Building);
    if (!pos || !building) return;
    renderSystem.centerOnGrid(pos.x + building.width / 2, pos.y + building.height / 2);
  });

  // I — Open base camp details
  hotkeys('i', e => {
    if (isModalOpen()) return;
    e.preventDefault();
    eventBus.emit('open:inventory');
  });

  // R — Build road mode
  hotkeys('r', e => {
    if (isModalOpen()) return;
    e.preventDefault();
    inputSystem.setMode('build_road');
  });

  // E — Erase tool
  hotkeys('e', e => {
    if (isModalOpen()) return;
    e.preventDefault();
    inputSystem.setMode('erase');
  });

  // B — Open building menu
  hotkeys('b', e => {
    if (isModalOpen()) return;
    e.preventDefault();
    eventBus.emit('toggle:building_menu');
  });

  // O — Toggle options
  hotkeys('o', e => {
    const optionsOpen = isGamePanelOverlayOpen('options-overlay');
    if (!optionsOpen && isModalOpen()) return;
    e.preventDefault();
    eventBus.emit('toggle:options');
  });

  // S — Quick save (auto-saves to last slot, or opens dialog if no previous save)
  hotkeys('s', e => {
    if (isModalOpen()) return;
    e.preventDefault();
    eventBus.emit('quick:save');
  });

  // Arrow keys — Pan camera
  hotkeys('up', e => {
    if (isModalOpen()) return;
    if (inputSystem.getMode() !== 'view') return;
    e.preventDefault();
    renderSystem.moveCamera(0, PAN_STEP);
  });

  hotkeys('down', e => {
    if (isModalOpen()) return;
    if (inputSystem.getMode() !== 'view') return;
    e.preventDefault();
    renderSystem.moveCamera(0, -PAN_STEP);
  });

  hotkeys('left', e => {
    if (isModalOpen()) return;
    if (inputSystem.getMode() !== 'view') return;
    e.preventDefault();
    renderSystem.moveCamera(PAN_STEP, 0);
  });

  hotkeys('right', e => {
    if (isModalOpen()) return;
    if (inputSystem.getMode() !== 'view') return;
    e.preventDefault();
    renderSystem.moveCamera(-PAN_STEP, 0);
  });

  // - / + / = — Zoom
  hotkeys('-', e => {
    if (isModalOpen()) return;
    if (inputSystem.getMode() !== 'view') return;
    e.preventDefault();
    renderSystem.adjustZoom(0.9, window.innerWidth / 2, window.innerHeight / 2);
  });

  hotkeys('+,=', e => {
    if (isModalOpen()) return;
    if (inputSystem.getMode() !== 'view') return;
    e.preventDefault();
    renderSystem.adjustZoom(1.1, window.innerWidth / 2, window.innerHeight / 2);
  });

  // V — Same behavior as Escape: dismiss overlays in order, then view mode
  hotkeys('v', e => {
    e.preventDefault();
    if (tryCloseTopOverlay()) return;
    inputSystem.setMode('view');
    game.clearMapSelection();
  });

  // Escape — Close dialogs / return to view mode
  hotkeys('escape', e => {
    e.preventDefault();
    if (tryCloseTopOverlay()) return;
    inputSystem.setMode('view');
    game.clearMapSelection();
  });

  // Space (hold) — Pan mode
  hotkeys('space', { keyup: true }, e => {
    e.preventDefault();
    if (e.type === 'keydown') {
      if (!e.repeat) {
        inputSystem.setSpacebarPressed(true);
      }
    } else {
      inputSystem.setSpacebarPressed(false);
    }
  });

  // F — Toggle fast-forward
  hotkeys('f', e => {
    e.preventDefault();
    eventBus.emit('toggle:fast_forward');
  });

  // P — Toggle pause
  hotkeys('p', e => {
    if (isModalOpen()) return;
    e.preventDefault();
    eventBus.emit('toggle:pause');
  });

  registerInsightAltKeyListeners();
}
