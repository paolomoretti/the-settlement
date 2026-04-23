# Canvas hover insight (Alt / Option + hover)

## Purpose

Hold **Alt** (Windows/Linux) or **Option** (macOS). A **tile grid** is drawn at **any zoom**. In **view** mode, with the pointer over an **explored** cell, **buildings**, **quarry rock tiles** (`mountain` / `hill`), and **water** get a **highlight** on the canvas and a **non-interactive tooltip** appears **immediately** near the cursor (no delay).

## Where it lives

- **`src/input/InsightAltKey.ts`** — global `AltLeft` / `AltRight` tracking (`isInsightAltHeld()`), `blur` clears state.
- **`src/ui/CanvasHoverTooltip.ts`** — tooltip when Alt held + view-mode hover on a valid target; DOM positioning (`fixed`, offset from client pointer).
- **`src/ui/hoverInsight/buildHoverLines.ts`** — pure string builders (`buildBuildingHoverLines`, `buildRockTileHoverLines`, **`buildWaterFishHoverLines`**, `getHoverTargetKey`). Add new exports here when extending to trees, roads, etc.
- **`src/main.ts`** — constructs `CanvasHoverTooltip`, registers `game.registerFrameHook(() => …tick())`, suppresses building hover when `BuildingPopover` is open on the same entity.
- **`src/core/Game.ts`** — each frame before render: **`showInsightGrid`**, **`insightHighlightEntityId`**, **`insightHighlightRock`**, **`insightHighlightWater`** on `RenderSystem`; **`registerFrameHook`** after `syncInventory`; **`getBuildingEntityAtGrid`** for UI.
- **`src/systems/InputSystem.ts`** — **`hoverClientPos`** for tooltip anchor; **`isSpacebarPanning()`** excludes pan mode.
- **`src/systems/RenderSystem.ts`** — **`shouldShowGrid()`** includes `showInsightGrid`; building sprite / iso mesh get gold strokes; rock tiles gold stroke; **water** cyan stroke when `insightHighlightWater` matches.

## When the tooltip does **not** show

- Alt / Option not held, or pointer left the canvas, or mouse button down after `mousedown` on canvas.
- Input mode other than `view`, or spacebar panning, or entity drag (`isDraggingEntity`).
- Tile not explored (fog of war).
- No recognised target at the cell (not a building footprint, not quarry rock, not water for fisher tooltip).
- Building popover is visible **and** that building is the selected entity (avoids duplicate UI).

The **grid** still draws whenever Alt is held (even in build/erase modes); **highlights** follow the stricter “view + hover + explored” rules above.

## Buildings

Lines mirror `BuildingPopover` semantics: construction / materials, road disconnected, waiting for tool worker, headquarters hint, production status (idle / producing with % and seconds left / stopped reasons), on-site production storage or output buffer fill.

## Rock tiles (`mountain`, `hill`)

Uses quarry config **`stonesPerRockTile`** (default 10). `Tile.rockHarvestsRemaining` is lazy until the first harvest; until then “full” capacity is assumed. Remaining percentage is `remaining / stonesPerRockTile * 100`.

## Water tiles (`water`)

Fisher **`water_depletion`** gather (see `GameWorkerRegistry`, `TileMap` lake clusters in `.claude/WATER_FISH.md`). Fish stock is **shared across the whole connected lake** (orthogonal water cells). Alt-hover calls `ensureWaterFishClusterAt` then shows **lake-wide** remaining fish and % of the cluster cap (`buildWaterFishHoverLines` in `buildHoverLines.ts`).

## Styling

CSS classes in `index.html`: `.canvas-hover-tooltip`, `.canvas-hover-tooltip-title`, `.canvas-hover-tooltip-line`.
