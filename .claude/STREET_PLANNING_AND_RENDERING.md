# Street Planning & Vector Roads

Roads are still stored as plain `Tile.hasRoad` cells. The build tool and renderer derive richer behavior from that tile topology without adding save data.

## Shift A-to-B Planning

- In road build mode, a normal road click becomes the anchor point.
- Holding Shift previews a planned route from that anchor to the current hover cell.
- Shift-click builds the planned route in one batch.
- Planning uses `PathFinder.findBuildableRoadPath`, a bounded A* search over buildable/existing road cells.
- Existing roads are valid and discounted, so planned routes naturally reuse streets.
- Candidate cells must pass the same practical placement gates as road building: explored, inside player territory, not blocked by demolition fire, not water/mountain, and not occupied unless they are already unoccupied road cells.

Batch building calls `roadSegmentManager.addRoad` for new cells, then performs one segment recalculation and one building connection update. This avoids per-tile recalculation cost on long routes.

## Vector Road Rendering

`src/debug/debugFlags.ts` exposes `ROAD_RENDERING_MODE`:

- `'vector'` uses the curved/linearized renderer and matching worker visual projection.
- `'classic'` uses the original 16-mask tile atlas road visuals and normal tile-interpolated worker rendering.

The in-game Options dialog persists the same mode under `settler_options.roadRenderingMode` and updates the renderer immediately.

Road visuals remain derived from the 4-bit road mask:

- bit 0: road at `x - 1, y` (NW edge)
- bit 1: road at `x, y - 1` (NE edge)
- bit 2: road at `x + 1, y` (SE edge)
- bit 3: road at `x, y + 1` (SW edge)

`TerrainTextures.drawRoad` now draws curved canvas strokes clipped to the tile diamond instead of only blitting a fixed 16-cell atlas. Endpoints stay fixed at shared tile edges so neighboring cells connect cleanly, while each tile gets deterministic hub wobble and pebbles from tile-coordinate hashes. Dead ends, straights, corners, T intersections, and X intersections are all still represented by the same mask.

## Worker Visual Alignment

Worker ECS movement still uses normal grid paths. During rendering, `RenderSystem.getRoadWalkScreenPosition` detects movement between adjacent road cells and draws the worker along the same deterministic hub/edge curve used by the road renderer. This is visual-only; pathfinding, transport, sorting, and saves remain tile-based.
