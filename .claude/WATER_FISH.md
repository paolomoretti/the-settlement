# Water fish (lake clusters)

Fish are **not** tracked per isolated water tile. They belong to a **lake cluster**: all **orthogonally** (4-way) connected `water` tiles form one body. The fisher only stands on the **shore**, but depletion and stock apply to the **whole pond**—fish are treated as moving within the same lake, so edge fishing can draw down the entire cluster (e.g. nine cells each rolled to 10 → **90** fish in one shared pool).

## Tile and map state

- **`Tile.waterClusterId`** — which cluster this water tile belongs to, set when the cluster is first built (lazy).
- **`Tile.waterFishSchoolMax` / `Tile.waterFishRemaining`** — **legacy only** (old saves). Cleared when a cluster is created from that lake.
- **`TileMap.waterFishClusterById`** — `Map<id, { remaining, max, cellCount }>`:
  - **`max`**: sum over every water cell in the cluster of that cell’s cap (deterministic **5–15** per cell via `rollWaterFishSchoolMax` in `src/map/waterFishSchool.ts`, seeded with map seed + cell coords).
  - **`remaining`**: shared count; decrements on each catch from any tile in the cluster.
  - **`cellCount`**: number of water tiles in the cluster (used for regen).

## Lazy initialization

`TileMap.ensureWaterFishClusterAt(wx, wy)` flood-fills cardinal water from that cell (cap **262144** cells per BFS for safety). If the tile already has `waterClusterId`, it returns immediately.

First touch can come from: fishing probes / gather (`getWaterFishRemainingAt`, `takeOneWaterFishAt`), decorative fish jumps (`RenderSystem.spawnFish`), or Alt hover (`buildWaterFishHoverLines` → `ensureWaterFishClusterAt`).

Helpers:

- `getWaterFishRemainingAt(x, y)` / `getWaterFishClusterMaxAt(x, y)` — ensure cluster, then read state.
- `takeOneWaterFishAt(x, y)` — ensure cluster, then `remaining--` if `remaining > 0`.

`TileMap.findNearestHarvestableWater` / `listHarvestableWaterSorted` use `getWaterFishRemainingAt` so any reachable shore tile on the lake sees the same pool.

## Fisher (unchanged layout rules)

- `src/map/fisherFishProbe.ts` only considers **shore** water: the fish tile must have at least one **cardinal** walkable non-water neighbor to stand on (no diagonal stands — they read as too far in iso). The off-road path ends on that **stand** tile (never on the water diamond). Middle-of-lake cells with no bank are still valid **water targets** for the shared stock as long as some shore cell in the radius can stand and path there.
- Picks are **random** among valid `(water, stand, path)` triples (not nearest-first).
- `ProductionSystem` throttles a reachability probe (~500 ms) so production time does not advance while **no** reachable shore fish exists (`Building.outOfMapResources`).
- Gather radius / walk cap: `src/data/buildings.json` (`maxGatherRadius` / `searchRadius` = 7, `maxGatherWalkCells` = 14).
- `GatherAnimState.fisherWaterTile` holds the water cell; `targetTile` is the stand tile. Fish depletion uses `fisherWaterTile` and **`takeOneWaterFishAt`** on the map.
- On reaching the stand, `idleFacing` is set from grid delta stand → water. Site time **40–50 s** per trip; seated fishing pose and bank nudge as implemented in `RenderSystem` / `WorkerSpritePainter` / `Worker.fisherTowardWater`.

## Regen

- `Game` accumulates `worldTimeSeconds`; every **7200** s (2 in-game hours) it calls `TileMap.applyWaterFishPopulationRegen()`.
- For **each cluster** that already exists: `remaining = min(max, remaining + cellCount)` — same total rate as the old “+1 per water tile per tick” model, but one update per lake instead of per tile.

## Decorative jumps

- `RenderSystem.renderFishJumps`: spawns use `getWaterFishRemainingAt` so jumps respect the **lake** stock.

## Save / load

- **New format:** `waterFishClusters: { r, m, cells: string[] }[]` where `cells` are `"x,y"` keys for every water tile in that cluster, `m` = cluster max, `r` = remaining. Written from `TileMap.serialize()` when any tile has `waterClusterId`.
- **Legacy:** `waterFish: { x, y, r, m }[]` per tile still loads. The next `ensureWaterFishClusterAt` on that lake merges the whole orthogonal component: per-tile caps and remainings are combined into one cluster, then per-tile fish fields are cleared.

## Hover

- `buildWaterFishHoverLines(tile, tileMap, gx, gy)` ensures the cluster and shows **lake-wide** totals (see `CanvasHoverTooltip`).
