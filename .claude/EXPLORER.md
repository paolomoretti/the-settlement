# Explorer Feature

## Overview

An **Explorer** is a scout worker dispatched from HQ to push back the fog of war. The player triggers dispatch from the single-cell menu (same popover used for the Surveyor). The explorer walks toward unexplored territory for 3 in-game minutes, then returns to HQ.

## Key Files

| File                                           | Role                                                        |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `src/explorer/ExplorerCoordinator.ts`          | State machine + tick logic for all active explorers         |
| `src/components/Worker.ts`                     | `WorkerVisualActivity` union includes `'explore_scout'`     |
| `src/rendering/workerV2/actions/jobs.ts`       | `workBinocularsAction` — both-arms-raised pose              |
| `src/rendering/workerV2/WorkerBodyRenderer.ts` | `explore_scout` arm-raise branch in `computeWorkerV2State`  |
| `src/workers/GameWorkerRegistry.ts`            | `explorerWorkers` set — population reservation              |
| `src/core/Game.ts`                             | `explorers: ExplorerCoordinator` field; tick + reset wiring |
| `src/main.ts`                                  | 🧭 "Send Explorer" button in `cell:empty_menu` handler      |

## Lifecycle

```
[Player clicks cell menu → Send Explorer]
        │
        ▼
ExplorerCoordinator.tryDispatchExplorer(gx, gy)
  • A* off-road path from HQ spawn tile → target cell
  • createWorker → addEntity → queueHqStreetEntry (queued behind other HQ dispatches)
  • attachExplorerWorker → counts toward reserved population
  • ActiveExplorer pushed: phase = 'travel'
        │
        ▼
phase: 'travel'
  • Walk along initial path (queued by queueHqStreetEntry)
  • Continuously reveal EXPLORE_REVEAL_RADIUS = 5 Chebyshev tiles around current pos
  • On movable.isMoving = false → switch to 'exploring', reset startedAt
        │
        ▼
phase: 'exploring'   (lasts EXPLORE_DURATION_MS = 3 min)
  • Always reveal EXPLORE_REVEAL_RADIUS = 5 tiles/frame around pos
  • Every BINOCULARS_INTERVAL_MS = 22 s (while not moving):
      – Set state=working, visualActivity='explore_scout'
      – Reveal BINOCULARS_REVEAL_RADIUS = 14 Chebyshev tiles (large burst)
      – Hold for BINOCULARS_DURATION_MS = 4.5 s then resume walking
  • While not binocularing and not moving:
      – Debounced (WAYPOINT_DEBOUNCE_MS = 500 ms) waypoint search
      – Scan WAYPOINT_SEARCH_RADIUS = 20 tiles for nearest unexplored walkable cell
      – Try A* for up to 10 nearest candidates; set first successful path
  • When nowMs >= startedAt + EXPLORE_DURATION_MS → 'return_home'
        │
        ▼
phase: 'return_home'
  • A* off-road path back to HQ spawn tile
  • On movable.isMoving = false → detachExplorerWorker + removeEntity + splice active[]
```

## Binoculars Animation

- `Worker.visualActivity = 'explore_scout'` + `Worker.state = 'working'` (not carrying)
- `WorkerBodyRenderer.computeWorkerV2State` maps this to `workBinocularsAction`
- Both arms raise to eye level (`dy: -6`), head sweeps left then right over 3 s loop
- No tool is held (explorer carries nothing)

## Population

- `GameWorkerRegistry.explorerWorkers` (Set\<number\>) is added to `getReservedPopulationCount()`
- Max 2 simultaneous explorers (`MAX_ACTIVE_EXPLORERS = 2`)
- Explorer is freed from population count when it despawns at HQ

## Reveal Mechanic

- `ExplorerCoordinator.deps.revealTiles(cells)` calls `Game.revealCells()` (private, accessed via closure)
- `revealCells` marks tiles as explored and refreshes the minimap

## Constraints

- Explorer is **NOT saved** to localStorage (same as SurveyCoordinator). On load, `explorers.reset()` is called.
- HQ must have a road exit (spawn tile required); fails gracefully with a `build:failed` event if no path found.
- Dispatch is gated by available population (`getAvailablePopulation() > 0`).
- At most 2 explorers may be active simultaneously.

## Constants (all in `ExplorerCoordinator.ts`)

| Constant                   | Value      | Meaning                                           |
| -------------------------- | ---------- | ------------------------------------------------- |
| `EXPLORE_DURATION_MS`      | 180 000 ms | Time in exploring phase before return             |
| `EXPLORE_REVEAL_RADIUS`    | 5          | Chebyshev radius revealed each tick while walking |
| `BINOCULARS_REVEAL_RADIUS` | 14         | Chebyshev radius revealed on binoculars stop      |
| `BINOCULARS_INTERVAL_MS`   | 22 000 ms  | Gap between binoculars pauses                     |
| `BINOCULARS_DURATION_MS`   | 4 500 ms   | Duration of each binoculars pause                 |
| `WAYPOINT_SEARCH_RADIUS`   | 20         | Tile scan radius for next unexplored waypoint     |
| `MAX_ACTIVE_EXPLORERS`     | 2          | Maximum simultaneous explorers                    |
| `WAYPOINT_DEBOUNCE_MS`     | 500 ms     | Minimum interval between waypoint re-picks        |
