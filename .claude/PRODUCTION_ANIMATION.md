# Production Animation System

Buildings with an `animation` config in `buildings.json` spawn a visual worker during production cycles. The animation happens DURING production — it does not affect ProductionSystem at all. The worker is purely visual + terrain modification.

## Flow

1. **ProductionSystem** starts a cycle (status = `'producing'`) — unchanged
2. **Game.ts** detects production started with no active animation worker → `spawnAnimationWorker()`
3. Worker spawns at building entrance carrying the building's `requiredTool` (e.g., axe)
4. Worker walks **off-road** (via `findOffRoadPath()`) to the nearest matching terrain tile
5. Worker "chops" — patrols adjacent tiles around target at slow speed (0.6 tiles/sec)
6. At **≥90% production progress**: terrain is reduced per `terrainTransition` (e.g., `tree→grass`, `forest→tree`), minimap updated, worker picks up `wood_log`
7. Worker walks back to entrance carrying `wood_log`
8. Worker arrives → entity destroyed, `animationWorkerId` cleared
9. ProductionSystem timer completes at 100% → output added normally (nothing changes here)
10. Next cycle starts → new worker spawns

## AnimationConfig (in buildings.json)

```json
"animation": {
  "type": "gather",
  "targetTerrain": ["tree", "forest"],
  "searchRadius": 10,
  "terrainTransition": { "tree": "grass", "forest": "tree" },
  "workerSpeed": 1.2
}
```

- `targetTerrain` — terrain types the worker walks to
- `searchRadius` — how far (Manhattan distance) to search for terrain
- `terrainTransition` — how terrain changes when chopped (at 90% progress)
- `workerSpeed` — worker movement speed in tiles/sec

### `gatherMode: "wild_hunt"` (Hunter’s Hut)

Uses the same gather state machine (`to_target → chopping → returning`) but targets **wild rabbits** from `Game.wildlife` instead of terrain. Output is applied on **return** (like quarry/fish), and `ProductionSystem` **pauses the timer** while the animation worker exists. See [.claude/WILDLIFE_RABBITS.md](WILDLIFE_RABBITS.md).

## Key Implementation Details

### Files Changed

- **`src/types/GameData.ts`** — `AnimationConfig` interface, `animation?` field on `BuildingDefinition`
- **`src/data/buildings.json`** — lumberjack has `animation` block, `productionTime` = 240s
- **`src/components/Building.ts`** — `animationWorkerId: number | null` tracks active animation worker
- **`src/map/TileMap.ts`** — `setTerrain()` for runtime terrain modification, `findNearbyTerrain()` for tree search
- **`src/pathfinding/AStar.ts`** — `findOffRoadPath()` now uses bounded grid with walkable non-road tiles
- **`src/core/Game.ts`** — `animationWorkers` Map, `reservedTreeTiles` Set, state machine (`to_target → chopping → returning`)

### Off-Road Pathfinding

`findOffRoadPath()` creates a bounded sub-grid (start↔end + 5 tile margin) where any walkable non-occupied tile is passable. This avoids allocating a full 1000×1000 grid.

### Reserved Trees

`reservedTreeTiles` Set prevents multiple lumberjacks from targeting the same tree. Released when worker returns or building is deleted.

### Population Accounting

Animation workers count against `getAvailablePopulation()`.

### Cleanup

Animation workers are cleaned up on:

- Building deletion (`deleteSelectedEntity`)
- New game (`resetForNewGame`)
- Save load (`loadSaveData`)
- Worker entity disappearing (e.g., bug)

### Map gather range and “out of resources”

- **`production.maxGatherRadius`** — search box radius (Manhattan) from the building **entrance** for candidate trees, rock, or water tiles.
- **`production.maxGatherWalkCells`** — max **off-road path steps** (`findOffRoadPath` length) from entrance to a candidate; defaults to `maxGatherRadius` or animation `searchRadius` if omitted.
- Candidates are tried in **order of increasing Manhattan distance** so a nearer tile with a short path wins over a farther tile with a long path.
- If **no** candidate has a path within the walk limit, `Building.outOfMapResources` is set, **production time is paused** (lumberjack / quarry / fisher), the **building popover** shows an extra warning under the description, and an **orange X** bobs above the roof in `RenderSystem`. A successful spawn clears the flag.

### Edge Cases

- **No reachable map sources** (nothing in radius, depleted rock/fish, or path longer than `maxGatherWalkCells`): no worker spawns; production pauses until terrain changes or limits are adjusted in `buildings.json`.
- **Building deleted while worker out**: worker entity removed, reserved tree released
- **Worker returns before timer**: fine — sits idle until next cycle
- **Worker still out when timer completes**: fine — output added normally, worker returns whenever
- **Save/load**: animation workers are ephemeral; on load, a new worker spawns when production is `'producing'`
