# Building workers (map staffing)

This document defines how **staffed buildings** get a **map worker**: a peasant entity spawned from the base camp, walking on roads, with behaviour driven by the building definition. It complements `.claude/WORKER_SPAWN.md` (camp-first spawn rules) and `src/workers/GameWorkerRegistry.ts` (implementation).

## Who gets a map worker?

| Condition | Map worker |
|-----------|------------|
| `population.provides` only (hut, house, headquarters, warehouse, …) | **No** dedicated map worker for “housing capacity”. |
| `population.requires` + `requiredTool` | **No extra map worker** — the delivered tool specialist is the building worker. They enter the building, are tracked on the building, and return to HQ if the building is demolished. |
| `population.requires` + timed `production` + **no** `animation` in JSON + **no** `requiredTool` | **Yes** — runtime synthesizes **`interior_operator`**, except buildings deferred until custom outdoor animation exists (today: `hunter`, `farm`, `pig_farm`; see `resolveStaffingAnimation()`). |
| `population.requires` + explicit `animation` | **Yes** — behaviour is whatever that block specifies, except `requiredTool` + `interior_operator` still uses only the tool specialist. |
| `population.requires` but **no** `production` timer (e.g. donkey breeder, shipyard, lookout as of today) | **No** automatic interior worker; add `animation` later or extend systems when those buildings get timed work. |

Residential and pure storage/military buildings without `population.requires` do not use this staffing pipeline.

## Two families of behaviour

### 1. `interior_operator` — default workshop operator

**Intent:** The worker is **delivered from HQ**, walks to the **door**, then is **hidden inside** the footprint for the lifetime of the building. They do not idle outside or step out for production-cycle timing. If the building is demolished, the worker is revealed at the road/door and walks back to HQ, freeing the worker slot when they arrive.

- **Strictly tied to the building type** via **`operatorRole`** (usually the same string as the building `id`, e.g. `mill`, `bakery`). Code uses `operatorRole` for outfits and future upgrades (“mill worker” vs “baker”).
- **JSON:** either omit `animation` entirely (game infers `interior_operator` + `operatorRole: <building id>`), or declare an `interior_operator` block to override speed / legacy phase fields (see `mill` in `buildings.json`).
- **Implementation:** `GameWorkerRegistry.resolveStaffingAnimation()`, `spawnSiteOperator()`, phases `interior_inside`, `Worker.concealedInBuildingId`, `RenderSystem` skip-draw when concealed.
- **Load behavior:** completed buildings with an interior operator restore that worker already concealed inside, so refreshing a save does not send a new visible worker from HQ.

**Optional later:** occasional “step outside” breaks (same operator, same building) without changing the data model.

### 2. Custom site animation — building-specific choreography

Used when the worker should **leave the workshop** and do something on the map:

| `animation.type` | Example buildings | Role |
|------------------|-------------------|------|
| `gather` | Lumberjack, quarry, fisher, mines (`gatherMode: mine_site`) | Terrain interaction (or adjacent dig tile for mines), carry resources, depletion rules, etc. |
| `well_operator` | Well | Adjacent tiles, timed “draw” pose with water, etc. |
| `plant_tree` | Forester | Reserved tile, dig, tree placement |

Each of these is a **different state machine** in `GameWorkerRegistry` (`updateAnimationWorkers`). Adding a new style means new `AnimationConfig` variant + implementation, not reusing `interior_operator`.

## `operatorRole` (worker specification)

For `interior_operator`, **`operatorRole`** is the stable key for “which worker spec this is”:

- Defaults to the building **`id`** when animation is **inferred** (no JSON block).
- Can be set explicitly in JSON (e.g. `"operatorRole": "mill"`) so tuning and art notes stay obvious.

`GameWorkerRegistry.applyInteriorOperatorAppearance()` maps roles to outfits today (e.g. white apron + hat for `mill` and `bakery`); other roles keep the random peasant palette until you add more roles.

## Adding or changing behaviour

1. **Workshop, worker mostly inside**  
   - Prefer **no** `animation` key → inferred `interior_operator`.  
   - Or add `animation: { "type": "interior_operator", "operatorRole": "…", "workerSpeed", "drawingPhaseSec", "walkLeadSec" }` to tune timings.

2. **Worker must walk the map / interact with terrain**  
   - Add or keep a **custom** `animation` block (`gather`, `well_operator`, `plant_tree`, or a new type once implemented).

3. **Staffed building but no production timer yet**  
   - No automatic interior worker; document in this file when you add `production` or a bespoke `animation`.

## Type references

- `AnimationConfig` and `BuildingDefinition.animation` — `src/types/GameData.ts`
- Runtime resolution — `GameWorkerRegistry.resolveStaffingAnimation()`
- Concealed render — `Worker.concealedInBuildingId`, `RenderSystem` entity draw branch for workers
