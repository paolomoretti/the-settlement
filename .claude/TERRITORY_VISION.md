# Territory, fog, and the cordon

## Goals

- **Fog (`tile.explored`)** only grows from settlement vision (HQ disk + completed military posts with `military.territoryVisionRadius`) plus a **preview band** (5 Chebyshev cells beyond each disk). Panning the camera does **not** reveal terrain.
- **Once seen, terrain stays visible** if a military post is removed: buildable **interior** can shrink, but fog does not return over those tiles.
- **Roads and buildings** (including military with `territoryVisionRadius`) may only occupy **interior** cells: inside the union of disks but **not** on the **frontier** (cordon / rope tiles). Completing a military post still adds its vision disk to the union.
- **Frontier cleanup** removes road tiles and loose transport items from all faction frontier cells after territory recalculation, so player and enemy road networks cannot connect through cordon/boundary cells.
- **Military post territory is established on first occupation.** After a soldier first enters a post, that post continues projecting territory even if its garrison temporarily leaves or dies. Ownership change/destruction is what removes or transfers that held ground.
- **Territory conflicts** use one winning faction per cell. Military sources get a strength bonus inside their radius, so a captured or enemy military building can carve a local block of territory even when it sits close to a headquarters' larger disk. Exact ties resolve to the player in this prototype; there are no shared/contested owner cells.
- **Cordon rendering**: **vertical sticks** on frontier cells where `(x+y) % CORDON_POLE_STRIDE_CELLS === 0` (default stride **2** so long `x+y` constant diagonals are not all the same parity). **Rope**: one sagging quadratic per **cardinal or diagonal** link between two frontier cells (full cordon mesh, including bends). Rope endpoints use the same stick-top height as poles on every frontier cell so segments meet cleanly. Sticks draw in `renderDepthSorted` **before** trees; ropes **after** trees on the **rear** depth (`min(x+y)` of the endpoints) and **before** entities.
- **Save/load**: explored tiles remain in `TileMap.serialize()` as before, so vision from navigation and outposts persists.

## Code map

| Piece                                      | Location                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disk union, frontier, interior, fog reveal | `src/map/TerritoryCoordinator.ts`                                                                                                                                    |
| When to rebuild / apply fog                | `Game.markTerritoryDirty`, `Game.refreshTerritoryIfDirty`, construction complete / destroy / drag-drop / load                                                        |
| Build + road rules                         | `Game.buildGeneric`, `Game.buildRoad`, `Game.dropEntity`                                                                                                             |
| Build/road **preview** tint                | `RenderSystem.placementPreviewHooks`, `RenderSystem.canPreviewAddRoadAt`, `RenderSystem.canPlacePreview`                                                             |
| Cordon draw                                | `RenderSystem.renderDepthSorted` — sticks before trees, ropes after rear-depth trees (`buildCordonGeometry`, `renderCordonRopeBetweenCellTops`)                      |
| Data                                       | `buildings.json` → `military.territoryVisionRadius` (Chebyshev cells from **footprint center**); HQ radius from `GAME_CONFIG` → `starting.exploration.initialRadius` |
| Types                                      | `GameData.BuildingDefinition.military.territoryVisionRadius?`                                                                                                        |

## Future: scouts / spies

`TerritoryCoordinator.revealCellsWithoutTerritory` is a **no-op stub**. A future unit can:

1. Mark specific tiles with `tile.explore()` and call `renderSystem.updateMinimapTiles` for those coords.
2. **Not** add a disk to the union used for build rules unless you extend `rebuildFrom` with another source type (e.g. timed scout radius).

## Territory expansion tiers (garrison buildings)

| Building   | Garrison | `territoryVisionRadius` | Shown in menu    |
| ---------- | -------- | ----------------------- | ---------------- |
| Barracks   | 2        | **8**                   | Low expansion    |
| Guardhouse | 3        | **10**                  | Medium expansion |
| Watchtower | 6        | **12**                  | High expansion   |
| Fortress   | 9        | **12**                  | High expansion   |

The building menu shows a colour-coded badge (yellow / orange / red) derived from the radius. The exact cell count is intentionally hidden from the player.

## Lookout Tower — fog-only reveal (no territory expansion)

The **Lookout Tower** has been moved to the **residential** category. It no longer carries `military.territoryVisionRadius` and therefore does **not** expand territory ownership or the cordon.

Instead it uses `fogRevealRadius: 14` (Chebyshev cells) applied by `Game.tickLookoutTowerFogReveal()` every 5 s of simulation time **while a scout operator is stationed inside**. The scout is a `lookout_scout` `interior_operator` worker dispatched from HQ, visually identical to the field Explorer (wide-brim hat, forest-green uniform, `Worker.isExplorer = true`). No tool is required — any available settler slot is used.

Key rules:

- Lookout Tower **does not** contribute to `TerritoryCoordinator` disks.
- Fog revealed by the tower is permanent (tiles stay explored).
- Building the tower inside your territory but near the frontier lets you see the terrain beyond the cordon without pushing the border.

## Tuning

- Preview band: `TERRITORY_PREVIEW_BAND_CELLS` in `TerritoryCoordinator.ts`.
- Pole spacing: `CORDON_POLE_STRIDE_CELLS`.
- Military claim priority: `MILITARY_CLAIM_STRENGTH_BONUS`.
- Per-garrison vision: `territoryVisionRadius` in `buildings.json`.
- Lookout Tower reveal radius: `fogRevealRadius` in `buildings.json`; interval: `Game.LOOKOUT_REVEAL_INTERVAL_MS`.
