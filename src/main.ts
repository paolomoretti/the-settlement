/**
 * Main entry point - initializes and starts the game
 */

import { Game } from './core/Game';
import { eventBus } from './core/EventBus';

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
  // Listen to mode changes to update button states
  eventBus.on('input:mode_changed', (mode) => {
    const modeToButtonId: Record<string, string> = {
      'view': 'btn-view',
      'build_road': 'btn-road',
      'build_warehouse': 'btn-warehouse',
      'build_lumberjack': 'btn-lumberjack'
    };
    updateButtonStates(modeToButtonId[mode] || 'btn-view');
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

  // Build warehouse mode
  const btnWarehouse = document.getElementById('btn-warehouse');
  btnWarehouse?.addEventListener('click', () => {
    game.inputSystem.setMode('build_warehouse');
  });

  // Build lumberjack mode
  const btnLumberjack = document.getElementById('btn-lumberjack');
  btnLumberjack?.addEventListener('click', () => {
    game.inputSystem.setMode('build_lumberjack');
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
}

function updateButtonStates(activeButtonId: string): void {
  const buttons = ['btn-view', 'btn-road', 'btn-warehouse', 'btn-lumberjack'];
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
