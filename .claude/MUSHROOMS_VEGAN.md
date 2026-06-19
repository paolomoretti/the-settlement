# Mushrooms (vegan mode)

In vegan mode the Hunter's Hut is themed into a **Gatherer** that picks mushrooms from forest-edge tiles instead of hunting rabbits (see [WILDLIFE_RABBITS.md § Vegan mode](./WILDLIFE_RABBITS.md#vegan-mode)). Mushrooms are deliberately **not** a real resource — internally the gatherer outputs `ham`, and the theme system renames/reskins it to "Mushrooms" via `src/data/themes.ts`. This doc covers the world-side decor + harvest logic that makes the gatherer's walk meaningful.

## Presence (deterministic)

Module: **`src/world/mushroomTiles.ts`** — pure helpers; no coordinator, no entities, no per-mushroom save data.

A tile is a *mushroom candidate* (`tileIsMushroomCandidate`) when **all** are true:

- `terrain` is `'grass'` or `'desert'`
- `isExplored()` and not `isOccupied()` and not `hasRoad`
- At least one **orthogonal** neighbour is `'tree'` or `'forest'`
- `hashCoord(x, y) % 100 < 30` (~30% of forest-edge tiles)

`hashCoord` is a stable 31-bit integer hash of `(x, y)`, so the same world tile always has — or never has — mushrooms. No persistence is needed for the presence roll itself.

`tileHasMushrooms(tile, tileMap, simNowMs)` adds a regrow gate (see below). Render and gameplay both call this so they stay in lock-step.

## Picking & regrow

- When the gatherer's animation worker finishes its 2.5s dig at the target tile, `markMushroomsPickedAt(tile, simNow)` sets the new lazy field **`Tile.mushroomPickedUntilMs = simNow + MUSHROOM_REGROW_MS`** (60 s, sim-time).
- While that timestamp is in the future, `tileHasMushrooms` returns `false` — the dots vanish from the renderer and the gatherer's probe skips the tile.
- After regrow, the tile is mushroom-pickable again.

Persistence: `mushroomPickedUntilMs` is packed into the RLE-style sparse list `mushroomPicked: [{x, y, u}]` by `TileMap.serialize/deserialize` (same pattern as `cellWellWaterRemaining` / `cellMinerals`). Only tiles with a cooldown timer are written.

## Rendering

`RenderSystem.renderTile` calls `renderMushroomDecor(tile)` at the end of the per-tile pass. The hook is gated on `themeManager.getActiveThemeName() === 'vegan'` and on `tileHasMushrooms`. `mushroomDotsForTile(x, y)` returns 2–4 deterministic `{ dx, dy, capRadius, cap }` records, each drawn as:

- Off-white stalk: 2 × 3 px rect.
- Dome cap: filled half-circle (`Math.PI..2π`), color from `mushroomCapColor(cap)`: `red` `#a8261c`, `brown` `#6b3a1e`, `black` `#1a1a1a`, with a 0.6 px dark rim.

Drawn in the per-tile pass (under entities/trees) — correct depth for ground decor.

## Gatherer behaviour

Module: **`src/workers/GameWorkerRegistry.ts`** — the `forest_forage` gatherMode now has its own branch parallel to `wild_hunt`:

- **Target selection** (`spawnGatherAnimationWorker`): enumerate tiles in `gatherRadius`, filter by `tileHasMushrooms`, sort by Manhattan distance, A\* off-road to the first reachable one. No tree-tile reservation is taken — the regrow cooldown prevents two gatherers from racing the same tile.
- **Chopping phase**: 2.5 s dig (uses `anim.digAtSiteSec`), then `markMushroomsPickedAt(tile, simNow)`, worker picks up `anim.carriedResource ?? 'ham'` overhead (themed icon = mushrooms), and walks home off-road.
- **Tool**: the vegan theme sets `requiredTool: null`, so the gatherer carries nothing on the way out (no bow, no axe).
- **Out of mushrooms**: `ProductionSystem`'s `forest_forage` probe calls `tileHasMushrooms` (throttled to 500 ms via `Building.lastHuntRabbitProbeAt`); if nothing in range, `outOfMapResources = true` shows the standard orange-X.

## Files

| Concern | File |
|---|---|
| Predicate + dot generator + cooldown helper | `src/world/mushroomTiles.ts` |
| Lazy tile field | `src/map/Tile.ts` |
| Serialize/deserialize | `src/map/TileMap.ts` (`mushroomPicked` array) |
| Theme override (name, sprite, carried resource, gatherMode) | `src/data/themes.ts` |
| Render hook | `src/systems/RenderSystem.ts` `renderMushroomDecor` |
| Production probe | `src/systems/ProductionSystem.ts` (forest_forage block) |
| Gatherer target + dig + pick | `src/workers/GameWorkerRegistry.ts` (`forestForage` branches) |
| Vitest specs | `src/world/mushroomTiles.spec.ts` |
