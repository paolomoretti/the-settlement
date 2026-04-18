# Keyboard Shortcuts System

All keyboard shortcuts are defined and registered in `src/input/KeyboardShortcuts.ts` using the `hotkeys-js` library.

## Architecture

- **KeyboardShortcuts.ts** — single source of truth for all keyboard bindings
- **InputSystem.ts** — handles mouse/touch only; exposes `setSpacebarPressed()` for the spacebar hold state
- **RenderSystem.ts** — exposes `centerOnGrid(x, y)` and `moveCamera(dx, dy)` for camera control
- **hotkeys-js** — lightweight (~6 KB) library for registering key handlers with keyup support

`setupKeyboardShortcuts(game)` is called once from `setupGameUI()` in `main.ts`.

## Current Shortcuts

| Key | Condition | Action |
|-----|-----------|--------|
| **H** | view mode, no modal dialog | Center camera on base camp |
| **R** | view mode, no modal dialog | Enter build road mode |
| **B** | view mode, no modal dialog | Toggle building menu |
| **S** | no modal dialog | Open save game dialog |
| **Arrow Up** | view mode, no modal dialog | Pan camera up |
| **Arrow Down** | view mode, no modal dialog | Pan camera down |
| **Arrow Left** | view mode, no modal dialog | Pan camera left |
| **Arrow Right** | view mode, no modal dialog | Pan camera right |
| **Escape** | always | Close topmost dialog, or return to view mode |
| **Space (hold)** | always | Enter pan mode (drag to pan camera) |

## Adding New Shortcuts

1. Register the handler in `setupKeyboardShortcuts()` using `hotkeys('key', handler)`
2. Add a `ShortcutBinding` entry to `SHORTCUT_BINDINGS` (used by the future settings page)
3. Guard with `isModalOpen()` and mode checks as needed

## Modal vs Non-Modal

`isModalOpen()` checks `save-load-dialog` and `exit-dialog`. These block all gameplay shortcuts. In-game panels (inventory, building menu, popover) are not considered modal — they close via Escape priority or mode changes.

## Escape Priority

1. Close save/load dialog (if not editing a slot name)
2. Close exit dialog
3. Close inventory panel
4. Return to view mode (which also closes building menu and popover)
