# Construction Material Delivery

How buildings are constructed: resources are physically delivered from base camp, then a builder worker constructs the building.

**Status**: IMPLEMENTED
**Last Updated**: 2026-04-19

---

## Overview

When a building is placed, it immediately becomes a construction site even if headquarters cannot currently afford its materials. Available resources are deducted later by the periodic construction-material pass, highest building priority first, and dispatched as junction items at the base camp entrance. A builder worker (carrying a hammer) walks from base camp only after all materials for that site have arrived. When both materials and builder arrive, construction begins. When complete, the builder walks back to base camp.

---

## Construction Flow

```
1. Player places building
   → Building enters 'awaiting_materials' state (shows first construction sprite)
   → Materials are requested, but not necessarily available yet

2. Material recheck pays for and dispatches resources when HQ has them
   → Sites are scanned by building priority
   → Materials dispatched as junction items at base camp entrance
   → Road workers relay materials through road network to construction site
   → Each material arrival calls building.deliverMaterial()
   → Tracked in building.materialsDelivered

3. As soon as HQ dispatches the first material (building.hasMaterialsBeenDispatched()):
   → Builder worker is ALSO spawned at base camp and walks to site in parallel
   → Builder may arrive before all materials; it waits on-site until ready
   → For buildings with no build cost the builder is sent immediately

4. When BOTH builder has arrived AND all materials are delivered (canStartConstruction()):
   → building.beginConstruction() starts the build timer
   → State transitions to 'under_construction'

5. Build timer completes:
   → State transitions to 'complete'
   → Builder walks back to base camp and is removed
   → Production routes computed if building has inputs
```

### Example: Sawmill (cost: 2 boards)

1. Player places sawmill → site appears even if boards are not currently available
2. When HQ has boards, up to 2 wood_plank are deducted by priority and queued at base camp (destination = sawmill entity)
3. Road workers carry the 2 wood_plank to sawmill's entrance
4. Builder spawns at base camp, walks to sawmill's adjacent road tile
5. Builder arrived → construction timer starts (30 sec)
6. Timer completes → sawmill operational, builder walks back

---

## Building States

```
'awaiting_materials' → 'under_construction' → 'complete'
```

- **awaiting_materials**: Building placed, first construction sprite shown (progress 0). Waiting for materials; once materials are delivered, waiting for builder.
- **under_construction**: Builder and materials present. Wall-clock timer running. Construction overlay with progress bar plus centered pulsed smoke (15s on, 3–5s off) for all building sizes.
- **complete**: Building operational. Builder returned to base camp.

---

## Building Component Fields

```typescript
// Set during awaiting_materials state
constructionMaterials: Record<string, number> | null; // Required amounts (from buildCost)
materialsSent: Record<string, number>; // Dispatched as junction items
materialsDelivered: Record<string, number>; // Arrived at construction site
builderEntityId: number | null; // Builder worker entity
builderArrived: boolean; // Builder reached the site
```

All cleared when `beginConstruction()` is called.

---

## Transport Integration

- Materials are dispatched as junction items at the base camp entrance with `destinationEntityId` set to the construction site entity
- `TransportManager.computeRoutesToBuilding()` computes BFS direction maps for construction sites (same as production buildings)
- `recomputeTransportRoutes()` includes construction sites in its route computation
- In `advanceTransport()`, the `to_dropoff` phase checks if the destination building is in `awaiting_materials` state and calls `building.deliverMaterial()` instead of storage deposit

---

## Builder Worker

- Regular worker entity with `carryingResource = 'hammer'` for visual
- Spawned at base camp spawn tile after all materials are delivered, pathfinds to construction site's adjacent road tile
- If a higher-priority fully supplied site needs a builder, a builder assigned to a lower-priority waiting site can be retargeted before construction starts
- Tracked in `Game.builderWorkers` map (builderEntityId → buildingEntityId)
- Position verified on arrival (must be at the target tile)
- When construction completes, builder keeps hammer and walks back to base camp (`Game.returningBuilders`)
- Removed when reaching base camp

---

## Tool Worker (Operator)

After construction completes, buildings with `requiredTool` need an operator before production starts:

1. Construction completes → `building.hasOperator = false`
2. `updateConstructionDelivery()` spawns a tool worker at base camp carrying the required tool (e.g., saw for sawmill)
3. Tool worker walks to the building's adjacent road tile
4. On arrival → `building.hasOperator = true`, worker entity removed (enters building)
5. `ProductionSystem` only runs production when `building.hasOperator` is true

Tracked in `Game.toolWorkers` map (toolWorkerEntityId → buildingEntityId). On building deletion, in-transit tool workers are removed.

Buildings without `requiredTool` (huts, storehouses, etc.) have `hasOperator = true` by default.

---

## Cancellation / Deletion

When a building in `awaiting_materials` is deleted:

1. **Unpaid materials** remain unowned and are not refunded
2. **Delivered materials** (materialsDelivered) refunded to base camp storage
3. **In-transit materials** (junction items) are orphaned — workers reroute them back to base camp automatically
4. Builder entity removed immediately
5. Tool worker removed if in transit

---

## Road Connectivity

- Builder only spawns when a valid path exists from base camp to the construction site
- If no road connection, `updateConstructionDelivery()` retries each frame
- Junction items at base camp entrance wait until routes are computed (items with no valid direction are skipped by workers)
- When road is built → `recomputeTransportRoutes()` adds the construction site → items start flowing
- Placement previews and disconnected-building hints show the two preferred road start cells on the building's right/front edge: one to the right of the entrance row and one below the rightmost/front column. Either side-road can activate the building because road connectivity checks any cardinal road touching the footprint.

---

## Disconnected Road Worker Fix

Road workers are only spawned on road segments connected to base camp. `spawnSegmentWorker()` checks `getBaseCampConnectedRoads()` and skips segments with no connected tiles.

---

## Save/Load

- `awaiting_materials` state saved with: constructionMaterials, materialsSent, materialsDelivered, builderArrived
- Builder entity not saved (re-spawned by `updateConstructionDelivery()` on load)
- Junction items saved/loaded via TransportManager serialization

---

## File Map

| File                            | Change                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/components/Building.ts`    | `awaiting_materials` state, material tracking fields, builder tracking                                           |
| `src/core/Game.ts`              | `buildGeneric()` dispatch, `updateConstructionDelivery()`, builder spawn/return, `deleteSelectedEntity()` refund |
| `src/entities/EntityFactory.ts` | Don't auto-start construction (store buildTimeSec only)                                                          |
| `src/systems/RenderSystem.ts`   | Show construction sprite for `awaiting_materials` state                                                          |
