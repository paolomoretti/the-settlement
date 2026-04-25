# Worker spawn rules (population & believability)

Workers represent people from your settlement. **They must not pop into existence at the job site** when the assignment comes from headquarters population (builders, tool delivery, dedicated building operators such as the well).

## Hard rule (HQ-assigned workers)

For any worker that **consumes `getAvailablePopulation()`** and is **sent from the base camp** to staff or supply a building:

1. **Spawn position** — `createWorker` at `findBaseCampSpawnTile()` (or the same road tile logic used there), never at the building footprint or idle tile beside it.
2. **First movement** — assign a **road** path via `pathFinder.findPath` from that spawn tile to a sensible road goal near the building (same pattern as `spawnBuilder` / `spawnToolWorker`: typically `findBuildingAdjacentRoadTile`).
3. **Last mile** — if the final idle/work position is off-road, use `findOffRoadPath` **after** the worker has arrived on the road network (existing well-operator `idle_left` / `pathToIdle` logic).
4. **Street-entry cadence** — newly created HQ workers must be handed to `GameWorkerRegistry.queueHqStreetEntry(...)`, not given their first path directly. The queue conceals them inside HQ and releases them at least 500ms apart so they do not visibly overlap on the base-camp road tile.

Violations look like workers **teleporting** next to the well or hut; that must never ship.

## Reference implementations

| Role | Method | Spawn |
|------|--------|--------|
| Road segment worker | `spawnSegmentWorker` | Base camp road → segment center, via `queueHqStreetEntry` |
| Builder | `spawnBuilder` | Base camp road → road near site, via `queueHqStreetEntry` |
| Tool delivery | `spawnToolWorker` | Base camp road → road near building, via `queueHqStreetEntry` |
| Soldier dispatch | `Game.tryDispatchSoldierToMilitaryBuilding` | Base camp road → military post, via `queueHqStreetEntry` |
| Surveyor | `SurveyCoordinator.tryDispatchSurveyor` | Base camp road → survey site, via `queueHqStreetEntry` |
| Well operator / `interior_operator` (workshop) | `spawnSiteOperator` | Base camp → road near building via `queueHqStreetEntry` → idle tile → door → concealed inside for cycle slice (well: custom adjacent “draw” instead) |

Details: `.claude/BUILDING_WORKERS.md`.

## Gather animation (woodcutter)

`spawnAnimationWorker` (gather) intentionally spawns at the **building entrance** then walks **off-road** to the tree. That worker is tied to a production cycle at the building, not a generic “HQ posted me here” beat; document when changing gather flow so it stays intentional.

## Save/load caveat

Road segment workers may be re-created at segment centers when deserializing old saves (`loadSaveData`). That is persistence repair, not a new HQ assignment.

## When adding new workers

Before merging:

- [ ] If the worker uses population from the camp, spawn at **base camp road**, not at the target tile.
- [ ] If the worker starts at HQ, use `queueHqStreetEntry(...)` so visible departures remain at least 500ms apart.
- [ ] First leg on **roads** unless you have an explicit design reason and doc update.
- [ ] No `createWorker(x, y)` where `(x,y)` is the job idle tile for HQ-assigned roles.
