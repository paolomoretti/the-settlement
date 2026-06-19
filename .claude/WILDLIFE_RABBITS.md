# Wild rabbits & Hunter’s Hut

Wild rabbits are lightweight world objects (not ECS entities): they persist in `WildlifeCoordinator`, render in the isometric depth pass, save/load with the game, and are consumed when a hunter’s animation worker completes a kill.

## Runtime

- **Module:** `src/wildlife/WildlifeCoordinator.ts`
- **Owner:** `Game.wildlife` (`src/core/Game.ts`)
- **Tick:** `Game` calls `wildlife.tick(tileMap)` once per frame (real-time wander + spawn scheduling).
- **Render:** `RenderSystem.setWildRabbitSupplier(() => game.wildlife.getRabbits())` — rabbits are **vector shapes** (no PNG). They are drawn inside **`renderDepthSorted`**, merged with entities at each depth slice using the same **walker-style sort depth** as workers (`getWildRabbitDrawDepthForSort` mirrors `southCellSum` clamping) so **trees in front occlude rabbits** correctly. Survey workers on top still draw after the world pass.

## Behaviour

### Spawning

- **New world:** After HQ placement and initial `exploreArea` (~25 tiles), `seedInitialRabbits` places **2–3** rabbits on explored **grass**, **desert**, or **hill** tiles (no roads, not occupied). Placement prefers tiles **next to forest** (`tree` / `forest`) or **water**; if too few candidates, a looser random search expands outward.
- **Existing saves (no `wildlife` blob):** `onLoadedLegacySave()` arms the periodic spawner only (no starter burst).
- **Ongoing:** Every **96 seconds** of real time, one spawn attempt runs: up to **48** random map coordinates are tried for a valid explored grass/desert tile with **at most one rabbit per cell** (`cellOccupied`). Open-field spawns are rarer than forest/water-adjacent spawns (probabilistic filter when the tile has no neighbours boosting score).

### Wander / jump

- Each rabbit has an **`originX` / `originY`**. Every **~40s** (± jitter), if not reserved for a hunt and not already mid-jump, it picks another valid tile within **Manhattan distance ≤ 2** of that origin.
- Movement is a **jump arc** (`RABBIT_JUMP_DURATION_MS` ≈ **420ms**): logical grid `(x,y)` stays on the **from** cell until landing; destination is reserved in `jumpDestReserved` so two rabbits cannot target the same hop landing. `advanceRabbitJumps` commits occupancy on landing.

### Hunter integration

- **Config:** `buildings.json` → `hunter` uses `animation.type: "gather"` with **`gatherMode: "wild_hunt"`**, `productionTime` **180s**, outputs **`ham`**, `maxGatherRadius` **16**, `maxGatherWalkCells` **36**, `animation.searchRadius` **16** (same pattern as quarry/fisher; walk cap scales with radius so off-road paths can reach prey).
- **Targeting:** `GameWorkerRegistry.spawnGatherAnimationWorker` calls `pickAndReserveReachableRabbit` so two huts cannot reserve the same prey in one tick.
- **Path:** Off-road A\* from the hut **entrance** to the rabbit’s cell (inclusive), same walk limits as other gather buildings.
- **Kill & carry:** On site, a short dig timer runs; then `removeRabbitAfterSuccessfulHunt`, worker picks up **`ham`** (per `carriedResource`), walks back; on arrival `applyProductionCycleOutputs` runs and the production timer resets (mirrors rock/fish depletion gather).
- **Production clock:** `ProductionSystem` treats `wild_hunt` like depletion gathers: timer **pauses** while `animationWorkerId` is set, and **does not** fire the timer-based output branch for hunter.
- **Out of prey:** If no reachable rabbit, `outOfMapResources` is set; `Building.lastHuntRabbitProbeAt` throttles reachability rescans (~500ms) so new spawns clear the orange-X state like the fisher.

### Cleanup / destroy building

- `detachWorkersForDestroyedBuilding` and `cleanupAnimationWorker` call `releaseHuntReservation` if a hunt was aborted before the kill, so rabbits become available again.

## Persistence

- `getSaveData` includes `wildlife: wildlife.serialize()` (rabbit list, `nextRabbitId`, `nextSpawnAttemptAtMs`).
- `loadSaveData` calls `deserialize`; missing key uses `reset()` + `onLoadedLegacySave()`.

## Vegan mode

When `themeManager.getActiveThemeName() === 'vegan'`, the Hunter's Hut is themed into the **Gatherer** (mushrooms instead of rabbits — see [MUSHROOMS_VEGAN.md](./MUSHROOMS_VEGAN.md)) and the rabbit pipeline is suppressed:

- **`seedInitialRabbits`** early-returns with no placements on a new vegan game — the world starts with **zero rabbits**.
- **`trySpawnBatch`** early-returns on every periodic tick, so no rabbits are ever added in vegan mode (the soft per-habitat cap is moot because the gatherer never culls them).
- **Existing rabbits** (from a save that predates vegan toggle, or from a player toggling vegan on mid-game) are **kept**. They continue to wander forever; nothing reduces their population in vegan mode. The user explicitly accepted this trade-off — no lifespan field is needed because no new rabbits ever spawn.

Disabling vegan re-arms both the initial seed (next new game only) and the periodic batches.

## Art note

Rabbits use **`RenderSystem.renderWildRabbit`**: no stroke — scaled ~**0.7**; **elliptical body**; **hind feet** as small rotated rects (kick only while **jumping**); **head + ears + eyes + nose** in a local frame rotated **±45°** with **nose below the eyes** and offset sideways (`noseSide` vs `tailOnRight`); ears tight; **tail** as overlapping circles; **head** mirrors on a timer; **jump** arc unchanged. Replace with sprites later if needed.
