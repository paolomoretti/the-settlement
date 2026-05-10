# Road segment worker dispatch

Dispatch, validation, and homing for **HQ road-segment peasants** (one worker per corridor segment, walks to segment duty rest). Segment **geometry** (nodes, traces, transport endpoints) lives in [.claude/TRANSPORT.md](TRANSPORT.md); this file covers **GameWorkerRegistry** + **RoadSegmentManager** reconcile timing and edge cases.

## HQ release queue

Workers spawn **concealed** at HQ and enter `pendingHqStreetEntries` so they do not stack on the spawn tile (`queueHqStreetEntry`). `processHqStreetEntries()` (inside `updateConstructionDelivery`) releases them on `HQ_STREET_DISPATCH_SPACING_MS`.

`Game` debounces `roadSegmentManager.recalculate` (~200 ms), so the **tile map** can change before reconcile runs. `updateConstructionDelivery` runs **after** movement each frame and must not apply stale paths.

## `freeSegmentWorker`

When a segment job ends (reconcile `onFreeWorker`, validation, or heal):

- **Queued at HQ, never walked:** cancel pending street entry; remove entity if still concealed with an empty path.
- **Otherwise:** cancel transport side-effects if any, then route to HQ: nearest open road within 8 cells → road path to spawn tile, else off-road to spawn, else `removeEntity` (stranded).

## `updateConstructionDelivery` — road segment order

1. **`validatePendingRoadSegmentDispatch`** — Queued road carriers: if the segment is missing or its tiles are not all valid open roads on the live map, drop the pending entry and `freeSegmentWorker`.
2. **`validateMovingRoadSegmentCarriers`** — Active `roadSegmentWorkers` (skip `returningWorkers` and HQ-concealed):
   - Missing / broken segment assignment → `freeSegmentWorker`.
   - **Idle** on a cell that is not `hasRoad && walkable` (stale path finished on grass) → `freeSegmentWorker`.
   - **Moving:** any **remaining** waypoint fails the same `hasRoad && walkable` rule as `PathFinder.findPath` → `freeSegmentWorker` (abort stale tail before walking onto deleted tiles).
   - **Idle** on-road but off current `getCenterRestPosition` → `moveSegmentWorker` **only when not** `transportTask` (otherwise the goal is building pickup / dropoff, not segment rest).
   - **Moving** with valid waypoints but path end far from segment rest → `moveSegmentWorker` **only when not** `transportTask` (same reason — transport paths end at endpoints, not the corridor center).
3. **`enforceRoadSegmentWorkerRegistryConsistency`** — Orphan ids in `roadSegmentWorkers` not listed as any segment’s `assignedWorkerId` → `freeSegmentWorker`. If a connected segment has no worker and no road workers are homing, `scheduleRoadFillCheck?.()` (avoids stacking spawns while returns are in flight).
4. **`processHqStreetEntries`** — On release, rebuild HQ→segment path with `buildHqToSegmentRestStreetPath(segment)` (do not replay the queued snapshot).
5. **`healRoadDispatchStaleAssignments`** — Throttled (~`ROAD_DISPATCH_HEAL_INTERVAL_MS`): same assignment/tile integrity checks as a backup when recalc lags behind edits.

## Spawn during `reconcile`

`onSpawnWorker` runs **before** `RoadSegmentManager` swaps `this.segments` to the new graph. `getSegments()` would still be the **previous** list (often empty after a full strip), which broke the “single corridor + homing carrier” spawn guard.

**`getSegmentsGraphForWorkerCallbacks()`** exposes the **new** segment list for the duration of `reconcile` (see `roadWorkerSpawnNoPile.spec.ts`).

**Spawn guard:** On the only HQ-connected corridor, if nobody is in `roadSegmentWorkers` but a road worker is already homing (`returningRoadWorkers`), do not spawn a replacement — avoids duplicate peasants when population caps stay loose.

## Tests

| Spec | Intent |
|------|--------|
| `roadWorkerSpawnNoPile.spec.ts` | Strip + restore single corridor; no second spawn while first homing |
| `roadWorkerTmergeDuty.spec.ts` | T-junction merge, duty rest sync, mid-walk abort on deleted spine |
| `roadWorkerTransportPathRegression.spec.ts` | `transportTask` + segment carrier: pickup path must not be replaced by duty `moveSegmentWorker` |
| `roadWorkerStaleDispatch.spec.ts` | Pending / moving / heal vs debounced recalc |
| `roadWorkerReturn.spec.ts` | Population reserved until HQ conceal completes |
| `roadWorkerCorridorCount.spec.ts` | Orphan carriers after T → line |
