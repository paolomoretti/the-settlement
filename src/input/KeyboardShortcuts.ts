import hotkeys from 'hotkeys-js';
import { Game } from '@/core/Game';
import { eventBus } from '@/core/EventBus';
import { Position } from '@/components/Position';
import { Building } from '@/components/Building';

const PAN_STEP = 200;

export interface ShortcutBinding {
  key: string;
  description: string;
  category: 'navigation' | 'building' | 'general';
}

export const SHORTCUT_BINDINGS: ShortcutBinding[] = [
  { key: 'H', description: 'Center on base camp', category: 'navigation' },
  { key: 'R', description: 'Build road mode', category: 'building' },
  { key: 'E', description: 'Erase tool (roads, buildings, trees)', category: 'building' },
  { key: 'B', description: 'Open building menu', category: 'building' },
  { key: 'O', description: 'Open options', category: 'general' },
  { key: 'S', description: 'Quick save', category: 'general' },
  { key: 'Arrow Up', description: 'Pan up', category: 'navigation' },
  { key: 'Arrow Down', description: 'Pan down', category: 'navigation' },
  { key: 'Arrow Left', description: 'Pan left', category: 'navigation' },
  { key: 'Arrow Right', description: 'Pan right', category: 'navigation' },
  { key: 'V', description: 'Return to view mode / Close dialog (same as Escape)', category: 'general' },
  { key: 'Escape', description: 'Return to view mode / Close dialog', category: 'general' },
  { key: 'Space (hold)', description: 'Pan mode (drag to pan)', category: 'navigation' },
];

function isModalOpen(): boolean {
  const ids = ['save-load-dialog', 'exit-dialog', 'options-panel'];
  return ids.some(id => {
    const el = document.getElementById(id);
    return el !== null && el.style.display !== 'none' && el.style.display !== '';
  });
}

/** Close the topmost overlay if any. Returns true if Escape/V should not fall through to view mode. */
function tryCloseTopOverlay(): boolean {
  const saveLoadDialog = document.getElementById('save-load-dialog');
  if (saveLoadDialog && saveLoadDialog.style.display !== 'none' && saveLoadDialog.style.display !== '') {
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

  const optionsPanel = document.getElementById('options-panel');
  if (optionsPanel && optionsPanel.style.display === 'block') {
    optionsPanel.style.display = 'none';
    return true;
  }

  const inventoryPanel = document.getElementById('inventory-panel');
  if (inventoryPanel && inventoryPanel.style.display === 'block') {
    inventoryPanel.style.display = 'none';
    return true;
  }

  return false;
}

export function setupKeyboardShortcuts(game: Game): void {
  const { inputSystem, renderSystem } = game;

  // H — Center on base camp
  hotkeys('h', (e) => {
    if (isModalOpen()) return;
    if (inputSystem.getMode() !== 'view') return;
    e.preventDefault();

    if (!game.baseCampEntity) return;
    const pos = game.baseCampEntity.getComponent(Position);
    const building = game.baseCampEntity.getComponent(Building);
    if (!pos || !building) return;

    renderSystem.centerOnGrid(
      pos.x + building.width / 2,
      pos.y + building.height / 2,
    );
  });

  // R — Build road mode
  hotkeys('r', (e) => {
    if (isModalOpen()) return;
    e.preventDefault();
    inputSystem.setMode('build_road');
  });

  // E — Erase tool
  hotkeys('e', (e) => {
    if (isModalOpen()) return;
    e.preventDefault();
    inputSystem.setMode('erase');
  });

  // B — Open building menu
  hotkeys('b', (e) => {
    if (isModalOpen()) return;
    e.preventDefault();
    eventBus.emit('toggle:building_menu');
  });

  // O — Toggle options
  hotkeys('o', (e) => {
    const optionsOpen = document.getElementById('options-panel')?.style.display === 'block';
    if (!optionsOpen && isModalOpen()) return;
    e.preventDefault();
    eventBus.emit('toggle:options');
  });

  // S — Quick save (auto-saves to last slot, or opens dialog if no previous save)
  hotkeys('s', (e) => {
    if (isModalOpen()) return;
    e.preventDefault();
    eventBus.emit('quick:save');
  });

  // Arrow keys — Pan camera
  hotkeys('up', (e) => {
    if (isModalOpen()) return;
    if (inputSystem.getMode() !== 'view') return;
    e.preventDefault();
    renderSystem.moveCamera(0, PAN_STEP);
  });

  hotkeys('down', (e) => {
    if (isModalOpen()) return;
    if (inputSystem.getMode() !== 'view') return;
    e.preventDefault();
    renderSystem.moveCamera(0, -PAN_STEP);
  });

  hotkeys('left', (e) => {
    if (isModalOpen()) return;
    if (inputSystem.getMode() !== 'view') return;
    e.preventDefault();
    renderSystem.moveCamera(PAN_STEP, 0);
  });

  hotkeys('right', (e) => {
    if (isModalOpen()) return;
    if (inputSystem.getMode() !== 'view') return;
    e.preventDefault();
    renderSystem.moveCamera(-PAN_STEP, 0);
  });

  // V — Same behavior as Escape: dismiss overlays in order, then view mode
  hotkeys('v', (e) => {
    e.preventDefault();
    if (tryCloseTopOverlay()) return;
    inputSystem.setMode('view');
  });

  // Escape — Close dialogs / return to view mode
  hotkeys('escape', (e) => {
    e.preventDefault();
    if (tryCloseTopOverlay()) return;
    inputSystem.setMode('view');
  });

  // Space (hold) — Pan mode
  hotkeys('space', { keyup: true }, (e) => {
    e.preventDefault();
    if (e.type === 'keydown') {
      if (!e.repeat) {
        inputSystem.setSpacebarPressed(true);
      }
    } else {
      inputSystem.setSpacebarPressed(false);
    }
  });
}
