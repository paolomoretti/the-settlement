# Transport & Road Workers System

How road segments are computed and workers are assigned to them. Settlers II style: every segment of road gets exactly one worker standing at its center.

**Last Updated**: 2026-04-19

---

## Road Segments

A **segment** is a continuous stretch of road tiles between two **nodes**. A node is any road tile that is:

- A **dead end** — has 0 or 1 cardinal road neighbors
- A **junction** — has 3+ cardinal road neighbors
- **Building-adjacent** — cardinally adjacent to a building **entrance tile** (occupied + hasRoad)

Tiles with exactly 2 cardinal road neighbors and no adjacent buildings are **corridor tiles** — they're interior to a segment, not boundaries.

### Example

```
[BaseCamp] — road — road — road — [Building] — road — road — [dead end]
              segment 1                         segment 2
```

The building splits the road into 2 segments. Each gets one worker.

### Segment Computation Algorithm

1. Collect all road tile positions (tracked incrementally via `addRoad`/`removeRoad`)
2. Classify each road tile: node or corridor (using 4-directional road neighbors + 4-directional entrance adjacency)
3. From each node, trace outward along each branch through corridor tiles until hitting another node
4. Each trace = one segment (ordered tile list + two endpoint nodes)
5. Deduplicate via edge tracking so each segment is only created once

Road neighbors use **4-directional** (cardinal only) to match the pathfinding system (`allowDiagonal: false`).

---

## Worker Assignment

### Lifecycle

1. Player places a road tile
2. `RoadSegmentManager.recalculate()` computes new segments
3. New segments are compared with old segments:
   - **Exact match** (same tiles) → keep existing worker
   - **Fuzzy match** (most tile overlap) → reuse worker, pathfind to new center
   - **No match** → spawn new worker from base camp
4. Old segments with no matching new segment → worker walks back to base camp and is removed on arrival

### Spawning

When a new segment needs a worker:
1. Check available population (`population.current - roadWorkerCount - returningWorkerCount`)
2. If no population available, segment gets no worker
3. Find the road tile cardinally adjacent to the base camp entrance
4. Create worker entity there
5. Pathfind to the segment's center tile
6. Worker walks there and stays

### Freeing (Road Deletion)

When a road is deleted and a segment's worker is freed:
1. Worker pathfinds from their current position back to the base camp entrance
2. Worker walks along the remaining road network
3. On arrival at base camp, the worker entity is removed and population is restored
4. If no path exists (stranded), worker is removed immediately

### Center Tile

The center of a segment is `tiles[Math.floor(tiles.length / 2)]` — the middle tile in the ordered list.

### Population Cost

Each road worker (active or returning) reduces available population by 1. The formula:

```
availablePopulation = population.current - roadSegmentManager.getWorkerCount() - returningWorkers.size
```

---

## Building Entrances

Every building ≥ 2×2 has an **entrance tile** — a road tile automatically placed inside the building footprint.

### Entrance Position

```
entranceX = pos.x + width - 1     (rightmost column)
entranceY = pos.y + ceil((height - 1) / 2)   (middle row, rounds toward front/bottom in iso)
```

Examples: 2×2 → (x+1, y+1), 3×3 → (x+2, y+1), 6×6 base_camp → (x+5, y+3).

### Entrance Tile State

- **Occupied** by the building entity (prevents other buildings from overlapping)
- **hasRoad = true** (workers can walk through, road renders visually)
- **NOT registered** in `RoadSegmentManager.roadTiles` — entrance tiles are excluded from segment computation so they don't spawn workers
- Pathfinder allows walking on occupied road tiles (`hasRoad && walkable`)

### Building Connectivity

A building with an entrance is **connected** only when a road tile cardinally adjacent to its entrance tile is in the base-camp-connected road set. The BFS flood-fill from the base camp uses cardinal-only directions and does not enter occupied tiles (including entrance tiles). This ensures buildings connect strictly through their entrance — a road running alongside a building wall does not connect it.

1×1 buildings have no entrance and connect via any cardinally adjacent connected road.

### "Front" Definition

In isometric view, a building's **front** is the **bottom-right side**. The entrance is placed at the center (or closest to center, biased toward the bottom/front) of this side. Building sprites are scaled down so the footprint tiles peek through underneath, making the entrance road visible behind/below the sprite:
- Buildings < 5 tiles: 85% scale
- Buildings ≥ 5 tiles (base camp): 72% scale

### Disconnected Indicator

When a building requires a road connection but isn't connected, a **road stub** is rendered behind the building sprite: it extends from the entrance tile (under the sprite) out to the adjacent tile where the player should connect. The out tile gets a subtle red highlight. This is drawn before entities so it appears behind building sprites. The indicator disappears once the entrance is connected to the road network.

---

## Road Placement Rules

Roads can be placed anywhere on walkable, unoccupied tiles. They don't need to be adjacent to existing roads. Drag-mode locking: the first tile in a drag determines whether the entire drag creates or deletes roads.

New games start with **zero roads**. The player builds the first road from the base camp.

---

## File Map

| File | Purpose |
|------|---------|
| `src/economics/RoadSegmentManager.ts` | Segment computation, worker reconciliation, segment CRUD |
| `src/core/Game.ts` | Integration: spawn/free/move workers, road placement validation |

### RoadSegmentManager API

| Method | Purpose |
|--------|---------|
| `addRoad(x, y)` | Track a newly placed road tile |
| `removeRoad(x, y)` | Track a removed road tile (building placed on it) |
| `recalculate(tileMap)` | Recompute all segments, reconcile workers |
| `rebuildRoadTileSet(tileMap)` | Scan entire map for roads (used on load) |
| `getSegments()` | Get current segment list |
| `getWorkerCount()` | Number of workers assigned to segments |
| `getCenterTile(segment)` | Middle tile of a segment |
| `getSegmentForWorker(workerId)` | Find which segment a worker belongs to |

### Game.ts Methods

| Method | Purpose |
|--------|---------|
| `spawnSegmentWorker(segment)` | Create worker entity, pathfind to center |
| `freeSegmentWorker(workerId)` | Drop carried items, pathfind worker back to base camp, remove on arrival |
| `rerouteReturningWorkers()` | Re-pathfind all returning workers (called on road deletion) |
| `moveSegmentWorker(workerId, segment)` | Pathfind existing worker to new center |
| `getAvailablePopulation()` | Population minus road workers and returning workers |
| `occupyBuildingTiles(...)` | Occupy footprint tiles, create entrance road |
| `hasBuildingConnectedRoad(...)` | Check entrance tile connectivity (or adjacent for 1×1) |
| `updateTransport()` | Per-frame: check idle workers for items, advance transport phases |
| `tryStartTransport(...)` | Check pickup endpoint for items, create TransportTask |
| `advanceTransport(...)` | Handle to_pickup → to_dropoff → to_center transitions |
| `getSegmentPath(...)` | Extract sub-path from segment tile list (no A*) |
| `recomputeTransportRoutes()` | Cancel tasks + recompute BFS after segment changes |

---

## Save/Load

Segment data is saved as `roadSegments` in the save file. Junction items are saved as `transport`. On load:
1. Road tile set is rebuilt from the map
2. Segment assignments are restored
3. Workers are spawned directly at segment centers (no walking animation on load)
4. Junction items are restored from `transport` data
5. Transport routes are recomputed via BFS

Old saves without `roadSegments` trigger a full recalculation from the road tile data.

---

## Transport Relay Chain

Road workers relay items through the segment graph. Each worker handles one segment. Items can flow in **either direction** depending on their destination — toward base camp OR toward a production building that needs them.

### Route Computation

`TransportManager` maintains direction maps via BFS:

- **Base camp routes**: `computeRoutes()` — BFS from base camp, determines "toward base camp" direction per segment
- **Building routes**: `computeRoutesToBuilding()` — BFS from each production building with inputs, determines "toward building" direction per segment
- `getDirectionIndex(segmentId, destEntityId)` — unified lookup for any destination

Routes are recomputed whenever roads change, buildings are placed/deleted, or a building finishes construction.

### Demand-Based Routing

When a worker picks up a resource, the system checks if any production building **demands** it (has it as an input and has storage space). If so, the item is routed toward that building instead of base camp. See [Building Dependencies](BUILDING_DEPENDENCIES.md) for full details.

### Worker State Machine

Each segment worker cycles through transport phases:

1. **Idle at center** → checks **both endpoints** for items to transport
2. **to_pickup** → walks along segment tiles to pickup endpoint
3. **Pickup** → takes 1 item from building's output (Storage or outputBuffer) or from junction items
4. **to_dropoff** → walks along segment tiles to dropoff endpoint (carrying the item visually)
5. **Dropoff**:
   - If at destination building → delivers to building's `Storage` (base camp or production building)
   - If at junction (not final destination) → drops as junction item with destination tag
6. **to_center** → walks back to segment center, then returns to idle

Workers walk along the segment's tile list (not A* pathfinding), which is a direct ordered path between endpoints.

### Junction Items

Items waiting at segment endpoints (junctions) for the next worker to pick up. Each item carries a destination tag. Managed by `TransportManager`:

- `addJunctionItem(x, y, resourceType, destinationEntityId)` — place item with destination
- `takeJunctionItemForDirection(x, y, segmentId, pickupIdx)` — take first item whose destination is reachable through this segment
- `peekJunctionItemForDirection(x, y, segmentId, pickupIdx)` — check without taking
- Junction items are serialized/deserialized for save/load (destination preserved)

### Visual Rendering

**Carrying**: When a worker carries an item, their arms are raised and a small colored box (or resource sprite if available at `/assets/resources/{type}.png`) is rendered above their head.

**Junction items**: Items on the ground at junctions are rendered as small 3D crates (or resource sprites), offset so up to 5 are visible per junction. Rendered after roads but before entities so workers walk over them.

### Edge Cases

- **Segment recalc mid-transport**: all active transport tasks are cancelled, carried items are dropped as junction items at the worker's current position
- **Worker freed**: carried items dropped as junction items before worker walks back to base camp
- **Item consumed before pickup**: worker returns to center idle
- **Single-tile segment**: worker skips walking phases (already at pickup/dropoff/center)

### File Map

| File | Purpose |
|------|---------|
| `src/economics/TransportManager.ts` | Junction items, route computation (BFS), pickup/dropoff endpoint helpers |
| `src/core/Game.ts` | Transport update loop, worker state machine, integration with Production/Storage |
| `src/components/Worker.ts` | `TransportTask` interface, `transportTask` field, `carryingResource` state |
| `src/systems/RenderSystem.ts` | Carrying visual (raised arms, item on head) |
