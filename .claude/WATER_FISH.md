# Water fish schools

## Tile state

- `Tile.waterFishSchoolMax` and `Tile.waterFishRemaining` (see `src/map/Tile.ts`).
- Lazy roll **5–15** fish per water cell on first use (`ensureWaterFishSchool` in `src/map/waterFishSchool.ts`): fishing reachability checks, decorative jumps (`RenderSystem.spawnFish`), or Alt-hover tooltip after a school already exists from save.
- Saves store `{ x, y, r, m }` (`r` remaining, `m` cap). Legacy saves with only `f` load as `r=f`, `m=15`.

## Fisher

- `src/map/fisherFishProbe.ts` only considers **shore** water: the fish tile must have at least one **cardinal** walkable non-water neighbor to stand on (no diagonal stands — they read as too far in iso). The off-road path ends on that **stand** tile (never on the water diamond). Middle-of-lake cells with no bank are skipped.
- Picks are **random** among valid `(water, stand, path)` triples (not nearest-first).
- `ProductionSystem` throttles a reachability probe (~500 ms) so production time does not advance while **no** reachable shore fish exists (`Building.outOfMapResources`).
- Gather radius / walk cap: `src/data/buildings.json` (`maxGatherRadius` / `searchRadius` = 7, `maxGatherWalkCells` = 14).
- `GatherAnimState.fisherWaterTile` holds the water cell; `targetTile` is the stand tile. Fish depletion uses `fisherWaterTile`.
- On reaching the stand, `idleFacing` is set from grid delta stand → water (same convention as walking facing in `RenderSystem`).
- Site time: **40–50 s** per trip (`GameWorkerRegistry` random `digSec`); `digAtSiteSec` in JSON is a ceiling for the depart buffer. Production pacing: `productionTime` and `walkLeadSec` in JSON.
- If the worker arrives after fish were depleted, they retarget a few times, then abort and set `outOfMapResources`.
- Seated fishing pose: `isFisherFishing` in `WorkerSpritePainter` / `RenderSystem` (rod + lower/crossed legs). `Worker.fisherTowardWater` stores stand→water grid delta; while fishing, `RenderSystem` applies a small iso nudge (~26% toward the water center) plus a slight extra squat so the figure reads closer to the bank without changing pathfinding tiles.

## Regen

- `Game` accumulates `worldTimeSeconds`; every **7200** s (2 in-game hours) it calls `TileMap.applyWaterFishPopulationRegen()`, which does `remaining = min(max, remaining + 1)` only on water tiles that **already** have `waterFishSchoolMax` set (no mass lazy-init of the whole map).

## Decorative jumps

- `RenderSystem.renderFishJumps`: one jump at a time in the viewport, **30 s–5 min** between spawns, any explored **water** tile with remaining fish > 0 (no “deep water only” filter).
