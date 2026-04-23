# Well underground aquifer

## Tile field

- `Tile.cellWellWaterRemaining?: number` — lazy; only set when a **completed** well exists on that cell (or restored from save).
- First completion on an untouched cell: random capacity **15–50** (`rollWellAquiferCapacity()` in `src/map/wellAquifer.ts`).
- If the value is already **`0`** (aquifer fully depleted on that cell), a new well never rerolls; that tile stays dry forever.

## When it is assigned

`Game.tryFinalizeWellAquifer(entity)` runs when a well becomes **complete**:

- After timer-based construction (`updateConstruction`),
- Immediately on place if `buildTime` is 0 and the building is already complete (`buildGeneric`),
- After **save/load** for each restored well in `complete` state (migration: old saves without map `wellWater` roll once on load).

`ensureWellAquiferInitialized(tile)` only fills `undefined`; it does not overwrite partial or depleted values.

## Production

Each normal production cycle that buffers **water** decrements the cell by the recipe’s water output (usually 1). Logic lives in `applyProductionCycleOutputs(..., { getTileMap })` in `ProductionSystem.ts`.

When the count drops from **> 0** to **≤ 0**:

- `building.outOfMapResources = true` (orange X on the roof, same path as gather exhaustion in `RenderSystem`),
- `eventBus.emit('well:aquifer_depleted', { entityId })`.

`Game` listens and **destroys the well entity after 2 seconds** (`destroyBuildingEntity`), so the tile is freed but `cellWellWaterRemaining` stays **0**.

## Clock pause

`ProductionSystem` does not advance the production timer while `cellWellWaterRemaining` is defined and `≤ 0` (dry site, including a rebuilt well on a depleted cell).

## Persistence

`TileMap.serialize` / `deserialize` include a `wellWater: { x, y, w }[]` array alongside `waterFish` and `cellMinerals`.
