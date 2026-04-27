# Territory, fog, and the cordon

## Goals

- **Fog (`tile.explored`)** only grows from settlement vision (HQ disk + completed military posts with `military.territoryVisionRadius`) plus a **preview band** (5 Chebyshev cells beyond each disk). Panning the camera does **not** reveal terrain.
- **Once seen, terrain stays visible** if a military post is removed: buildable **interior** can shrink, but fog does not return over those tiles.
- **Roads and buildings** (including military with `territoryVisionRadius`) may only occupy **interior** cells: inside the union of disks but **not** on the **frontier** (cordon / rope tiles). Completing a military post still adds its vision disk to the union.
- **Military post territory is established on first occupation.** After a soldier first enters a post, that post continues projecting territory even if its garrison temporarily leaves or dies. Ownership change/destruction is what removes or transfers that held ground.
- **Territory conflicts** use one winning faction per cell. Military sources get a strength bonus inside their radius, so a captured or enemy military building can carve a local block of territory even when it sits close to a headquarters' larger disk. Exact ties resolve to the player in this prototype; there are no shared/contested owner cells.
- **Cordon rendering**: **vertical sticks** on frontier cells where `(x+y) % CORDON_POLE_STRIDE_CELLS === 0` (default stride **2** so long `x+y` constant diagonals are not all the same parity). **Rope**: one sagging quadratic per **cardinal or diagonal** link between two frontier cells (full cordon mesh, including bends). Rope endpoints use the same stick-top height as poles on every frontier cell so segments meet cleanly. Sticks draw in `renderDepthSorted` **before** trees; ropes **after** trees on the **rear** depth (`min(x+y)` of the endpoints) and **before** entities.
- **Save/load**: explored tiles remain in `TileMap.serialize()` as before, so vision from navigation and outposts persists.

## Code map

| Piece | Location |
|--------|-----------|
| Disk union, frontier, interior, fog reveal | `src/map/TerritoryCoordinator.ts` |
| When to rebuild / apply fog | `Game.markTerritoryDirty`, `Game.refreshTerritoryIfDirty`, construction complete / destroy / drag-drop / load |
| Build + road rules | `Game.buildGeneric`, `Game.buildRoad`, `Game.dropEntity` |
| Build/road **preview** tint | `RenderSystem.placementPreviewHooks`, `RenderSystem.canPreviewAddRoadAt`, `RenderSystem.canPlacePreview` |
| Cordon draw | `RenderSystem.renderDepthSorted` — sticks before trees, ropes after rear-depth trees (`buildCordonGeometry`, `renderCordonRopeBetweenCellTops`) |
| Data | `buildings.json` → `military.territoryVisionRadius` (Chebyshev cells from **footprint center**); HQ radius from `game-config.json` → `starting.exploration.initialRadius` |
| Types | `GameData.BuildingDefinition.military.territoryVisionRadius?` |

## Future: scouts / spies

`TerritoryCoordinator.revealCellsWithoutTerritory` is a **no-op stub**. A future unit can:

1. Mark specific tiles with `tile.explore()` and call `renderSystem.updateMinimapTiles` for those coords.
2. **Not** add a disk to the union used for build rules unless you extend `rebuildFrom` with another source type (e.g. timed scout radius).

## Tuning

- Preview band: `TERRITORY_PREVIEW_BAND_CELLS` in `TerritoryCoordinator.ts`.
- Pole spacing: `CORDON_POLE_STRIDE_CELLS`.
- Military claim priority: `MILITARY_CLAIM_STRENGTH_BONUS`.
- Per-building vision: `territoryVisionRadius` in `buildings.json` (catapult and other non-expanders omit the field).
