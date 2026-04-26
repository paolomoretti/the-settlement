# Geological survey (surveyor)

## Purpose

Players probe **bare grass** tiles for underground deposits. Minerals are **lazy-assigned** per tile (`Tile.cellMinerals`: coal, iron_ore, gold_ore, stone; **10 units total** per cell once rolled). A survey does **not** change amounts after assignment.

## UI behaviour

- **Two-step grass flow:** first click on eligible explored grass sets **pending survey** (tile outline + small **options** icon at tile center). A **second** click must land on that icon (screen-space hit) to open the Surveyor popover (`cell:empty_menu`). Pending state clears when you click a building, an ineligible tile, when the menu opens, or when the menu closes.
- While the Surveyor popover is open, the **next map click** (building, grass, or empty) **only closes** the menu; it does **not** open the menu on another tile. A **second** click on eligible grass starts pending again (then icon → menu).
- **Panning** the map (left-drag in view mode once movement exceeds a few pixels, or **Space + drag**) does **not** count as a click: no selection / survey menu from that gesture.

## Eligibility

- **Menu / dispatch:** cell must be **only grass**: no water, mountain, trees, forest, hill, desert; no road; not `occupiedBy`; no building footprint (`Game.findBuildingEntityAt`).
- In **view mode**, `InputSystem` emits `select:entity` with grid + **client** coords on same-cell click; `Game.selectEntityAt` sets pending or emits `cell:empty_menu` when the icon is hit on a pending eligible tile.

## Area lock

- A survey is anchored at **center** `(cx, cy)`.
- **No new survey** may start on a center whose Manhattan distance to an active session’s center is **≤ `SURVEY_MAX_MANHATTAN_STEPS` (4)** while the session is still **blocking** (surveyor traveling/working **or** label TTL not yet expired).
- **Flag** is shown while the surveyor is in **travel** or **sequential** work at that center.
- **Dominant ore labels** appear on up to **10** cells: all lie within Manhattan **≤ 4** of the flag, **sorted by distance** from the center (closest first), so sampling stays near where the survey started.
- **Labels last 30 minutes** (`SURVEY_LABEL_TTL_MS`). When the last label expires and `areaBlockUntil` has passed, the session is removed and the disk can be surveyed again.

## Pathing

- Surveyor spawns at **`GameWorkerRegistry.getBaseCampSpawnTile()`** (HQ road network).
- Path = **road A\*** to a **nearest HQ-network road** within 96 Manhattan rings of the target (if any), then **`findOffRoadPath`** from that anchor to the flag tile center. If no anchor, **full off-road** from spawn to target.

## On-site sequence

- After the surveyor reaches the **flag** tile, a **queue of up to 10 cells** is built (center included, distance-sorted within the disk).
- For each cell: **walk** off-road to tile center → **dig** (`SURVEY_DIG_PER_CELL_MS`, shovel bash via `Worker.visualActivity === 'survey_dig'`) → **lazy minerals** + **dominant-ore label** (per-cell **30 min** TTL from placement).
- **Progress bar** + **current-cell outline** are drawn at the flag while `phase === 'sequential'`.
- When the queue finishes, the **flag hides** and the surveyor **walks back** to `getBaseCampSpawnTile()`; on arrival the entity is removed.

## Code map

- `src/map/CellMinerals.ts` — roll, dominant type, `ensureCellMinerals`.
- `src/map/Tile.ts` — optional `cellMinerals`.
- `src/map/TileMap.ts` — serialize / deserialize sparse `cellMinerals`.
- `src/survey/SurveyCoordinator.ts` — sessions, dispatch, tick, overlay state.
- `src/core/Game.ts` — constructs `surveys`, `tick`, `selectEntityAt` → `cell:empty_menu`.
- `src/workers/GameWorkerRegistry.ts` — `surveyorWorkers` reserved peasant slot.
- `src/systems/RenderSystem.ts` — `setSurveyOverlay`, pending highlight + center icon, menu outline, flag, progress bar, labels (**drawn back-to-front** by `x + y` for iso depth), then **surveyor sprite drawn again** on top via `setSurveyWorkerIdsOnTop`.
- `src/main.ts` — `GamePopover` for `cell:empty_menu`.
- Autosave: `survey:session_updated` in `GameSaveSession` debounce list.

## Save / load

- **Minerals** persist with the map.
- **In-flight survey state** is not serialized; `surveys.reset()` runs on load / new game. Mid-flight surveyors in memory are dropped (same as other ephemeral workers not in building save).

## Future (not implemented here)

- Typed mines, miner dig animation, food for miners, red cross when no ore in range — design only; survey lays groundwork via `cellMinerals`.
