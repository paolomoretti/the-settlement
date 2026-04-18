# Transport & Road Workers System

How road segments are computed and workers are assigned to them. Settlers II style: every segment of road gets exactly one worker standing at its center.

**Last Updated**: 2026-04-18

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
4. Old segments with no matching new segment → free the worker

### Spawning

When a new segment needs a worker:
1. Check available population (`population.current - roadWorkerCount`)
2. If no population available, segment gets no worker
3. Find a road tile on the base camp perimeter
4. Create worker entity there
5. Pathfind to the segment's center tile
6. Worker walks there and stays

### Center Tile

The center of a segment is `tiles[Math.floor(tiles.length / 2)]` — the middle tile in the ordered list.

### Population Cost

Each road worker reduces available population by 1. The formula:

```
availablePopulation = population.current - roadSegmentManager.getWorkerCount()
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

A building with an entrance is **connected** only when its entrance tile appears in the base-camp-connected road set (BFS flood-fill from base camp). Previously any adjacent road counted; now only the entrance matters.

1×1 buildings (well) have no entrance and fall back to the old any-adjacent-road check.

### "Front" Definition

In isometric view, a building's **front** is the **bottom-right side**. The entrance is placed at the center (or closest to center, biased toward the bottom/front) of this side. Building sprites are scaled down so the footprint tiles peek through underneath, making the entrance road visible behind/below the sprite:
- Buildings < 5 tiles: 85% scale
- Buildings ≥ 5 tiles (base camp): 72% scale

### Disconnected Indicator

When a building requires a road connection but isn't connected, its entrance tile is highlighted with a **red diamond overlay** drawn on top of the building sprite. This clearly shows the player where to connect a road. The indicator disappears once the entrance is connected to the road network.

---

## Road Placement Rules

Roads must be placed **adjacent (4-directional) to an existing road tile** (including building entrance tiles, which have `hasRoad = true`). This enforces that all roads grow outward from the base camp — no disconnected roads. The base camp follows the same entrance system as all other buildings; roads can only connect to it at its entrance tile, not anywhere around its perimeter.

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
| `freeSegmentWorker(workerId)` | Remove worker entity |
| `moveSegmentWorker(workerId, segment)` | Pathfind existing worker to new center |
| `isRoadPlacementValid(x, y)` | Check adjacency to existing road or base camp |
| `getAvailablePopulation()` | Population minus road workers |
| `occupyBuildingTiles(...)` | Occupy footprint tiles, create entrance road |
| `hasBuildingConnectedRoad(...)` | Check entrance tile connectivity (or adjacent for 1×1) |

---

## Save/Load

Segment data is saved as `roadSegments` in the save file. On load:
1. Road tile set is rebuilt from the map
2. Segment assignments are restored
3. Workers are spawned directly at segment centers (no walking animation on load)

Old saves without `roadSegments` trigger a full recalculation from the road tile data.

---

## Future: Item Transport

Road workers will eventually carry items between production buildings and storage:

1. Production building fills its output buffer → creates a `TransportRequest` (already implemented in economics system)
2. The road worker on the segment connected to that building picks up the request
3. Worker walks to the building, picks up the item
4. Worker carries item to the nearest warehouse/base camp
5. Item is deposited into the Storage component
6. Worker returns to their segment center

The transport request queue (`src/economics/TransportRequest.ts`) and ResourceManager delivery methods are already implemented — they just need to be wired to the road worker behavior.
