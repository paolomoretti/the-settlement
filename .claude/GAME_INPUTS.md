# Game inputs & controls (player-facing reference)

**Purpose:** Single reference for **how the player interacts with the game** — mouse, keyboard, touch, and HUD. Use this when building in-game help, onboarding, or tooltips. Keep it in sync with `src/systems/InputSystem.ts`, `src/input/KeyboardShortcuts.ts`, `src/main.ts`, `src/systems/RenderSystem.ts` (minimap), and UI classes noted below.

**Related deep-dives:** [Keyboard shortcuts](KEYBOARD_SHORTCUTS.md) (hotkey implementation), [Alt / Option hover insight](HOVER_TOOLTIP.md) (grid + tooltips).

---

## Main map canvas (`#game-canvas`)

### Right mouse button (secondary / button 2)

- **Press + drag:** Pans the camera only. Does **not** place roads or buildings, erase, select entities, or move a dragged building — **regardless of the current input mode** (view, road, erase, building ghost, select).
- **Click (press + release with little or no movement):** Does nothing on the map (no selection, no placement).
- The browser context menu on the canvas is suppressed.

### Left mouse button (primary)

Behavior depends on **input mode** (toolbar, hotkeys, or post-placement return to view).

#### View mode (default)

- **Click** on a tile: Selects or toggles selection of a **building** under the cursor; special cases (e.g. base camp opens inventory, survey UI, empty ground) are handled in `Game.selectEntityAt`.
- **Drag** (movement past a small threshold): Pans the camera. If the pointer did not move enough to count as a drag, a **click** is sent on release (selection / survey flow as above).

#### Build road mode (`R` or **Build Road** toolbar)

- **Mouse down:** Places a road on the hovered cell (if valid).
- **Drag:** Continues placing road along the path (each new cell under the cursor).
- **Shift + drag:** Constrains placement to a **straight axis-aligned row** (horizontal or vertical in grid space) from the cell where the drag started — “build row” behavior. Release ends the stroke; see `InputSystem` + `RenderSystem.snapRoadHoverToAxisAlignedRow`.

#### Erase mode (`E` or **Erase** toolbar)

- **Mouse down / drag:** Erases roads, buildings, or other erasable tiles under the cursor (strip along drag), same as continuous erase while moving.

#### Building placement mode (after picking a building from the **Buildings** menu)

- **Click (release on same cell as press):** Attempts to place the chosen building at that grid cell. Failures show a toast at the hover position.
- **Road mode exception:** Roads use down + drag; other buildings use **click-to-place** on release.

#### Select mode (after selecting a movable building — drag to reposition)

- **Drag:** Moves the selected entity with the cursor (`drag:move` / `drag:end`).
- **Release:** Drops the building; mode returns to view.

### Mouse wheel

- **Scroll:** Zoom in/out, anchored to the cursor position (`RenderSystem.adjustZoom`).

### Spacebar (hold)

- While **Space** is held, the next pointer drag **only pans** the camera (same as treating the gesture as pan-only). Used when you do not want to interact with the map.
- Cursor shows grab / grabbing while active.

### Touch (canvas)

- **One finger:** Same logical path as mouse (primary pointer) — placement, erase, view clicks, etc.
- **Two fingers:** Pinch to zoom.
- Touch does not simulate a secondary button; there is no touch equivalent for “right-drag pan only” on the main canvas unless the OS/browser maps it.

---

## Minimap (`RenderSystem.setupMinimapInteraction`)

- **Mouse down** on the minimap: Centers the main view on that world position.
- **Drag** on the minimap: Continues to move the view as the pointer moves (same navigation as repeated clicks).

---

## Dock toolbar (in-game)

| Control | Action |
|--------|--------|
| **Build Road** `[R]` | Enter road building mode. |
| **Erase** `[E]` | Enter erase mode. |
| **Buildings** `[B]` | Open / toggle the building menu overlay. |
| **Save Game** `[S]` | Quick-save to the current slot, or open save dialog if none. |
| **Save As…** | Open save dialog to pick a slot and name. |
| **Load Game** | Open load / save dialog focused on loading. |

## Top-right chrome

| Control | Action |
|--------|--------|
| **Settings** (options icon) `[O]` | Toggle options overlay (when not blocked by stricter modal checks — see `KeyboardShortcuts`). |
| **Exit** | Flow to exit / save-and-exit dialogs. |

---

## Keyboard (summary)

Full table and extension notes: [KEYBOARD_SHORTCUTS.md](KEYBOARD_SHORTCUTS.md).

| Input | Typical action |
|-------|----------------|
| **H** | Center camera on base camp (view mode only; no modal). |
| **R** | Build road mode. |
| **E** | Erase mode. |
| **B** | Toggle building menu. |
| **O** | Toggle options. |
| **S** | Quick save. |
| **Arrow keys** | Pan camera (view mode only; no modal). |
| **V** / **Escape** | Close overlays in priority order, then return to view mode and clear map selection. |
| **Space** (hold) | Pan-only while dragging on the canvas. |

**Modal blocking:** Save/load dialog, exit dialog, and (for some keys) open options / inventory / building menu block or alter shortcut behavior — see `isModalOpen()` in `KeyboardShortcuts.ts`.

---

## Alt / Option (insight mode)

- **Hold Alt (Windows/Linux) or Option (macOS):** Shows the **tile grid** at any zoom.
- In **view** mode, with the pointer over **explored** cells: **Highlights** and **instant tooltips** for buildings, quarry rock, water (fish), per [HOVER_TOOLTIP.md](HOVER_TOOLTIP.md).
- Tooltip is suppressed while panning with Space, dragging an entity, or in non-view modes (details in hover doc).

---

## Panels & popovers

- **Base camp click** (view mode): Opens **inventory** (resources / population). Close via ✕, overlay click-outside, or Escape priority.
- **Building menu:** Tabs (residential / production / military / infrastructure); choosing a building enters the corresponding **build\_&lt;type&gt;** mode. Close via ✕ or overlay backdrop.
- **Building popover** (selected non–base-camp building): Shows production, buffers, delete control, etc. **Delete Building** runs the same demolition path as other delete flows where applicable.
- **Options:** Autosave, debug info, building labels, minimap navigator, sound — see `setupOptionsPanel` in `main.ts`.

---

## Welcome / meta UI

- **Start game / Load game** on welcome screen: Normal boot flow (not in-game canvas inputs).
- **Save/load dialog:** Slot list, naming, close ✕ — clicks are standard DOM.

---

## Implementation map (for maintainers)

| Concern | Primary code |
|--------|----------------|
| Canvas pointer modes, right-pan, road/erase/build | `src/systems/InputSystem.ts` |
| Hotkeys | `src/input/KeyboardShortcuts.ts`, `src/input/InsightAltKey.ts` |
| Selection, placement, survey, inventory open | `src/core/Game.ts` |
| Toolbar wiring | `src/main.ts` (`setupGameUI`) |
| Minimap | `src/systems/RenderSystem.ts` |
| Canvas hover tooltip (Alt) | `src/ui/CanvasHoverTooltip.ts`, `src/ui/hoverInsight/buildHoverLines.ts` |

When you change default behavior for clicks, modes, or shortcuts, **update this file** so future help text and AI context stay accurate.
