# Building Dependencies & Demand Routing

How production buildings with inputs receive materials and produce outputs. This covers the local storage model and the demand-based transport routing system.

**Last Updated**: 2026-04-22

---

## Overview

Some buildings require **input materials** to produce outputs (e.g., sawmill needs wood_log to produce wood_plank). These buildings have:

1. **Local Storage** — a `Storage` component with `isProductionStorage = true`, holding **recipe inputs only** (ingredients waiting to be consumed), up to `storage.capacity`
2. **Output staging** — finished goods always go to `Production.outputBuffer` (same as gatherer buildings), i.e. **outside / awaiting road pickup**, capped by `production.maxOutputBuffer` (default 10). Inputs filling the ingredient store **must never** block the first unit of output: output space is separate from ingredient capacity
3. **Local consumption** — inputs are consumed from the building's own Storage, not the global inventory
4. **Demand routing** — when a source building produces a resource that a consumer building needs, the transport system routes it directly to the consumer instead of to the base camp

---

## Local Storage Model

### How It Works

Production buildings with inputs get both `Production` and `Storage` components. **Storage** is only the on-site ingredient bin. **Outputs** are staged in `Production.outputBuffer` until a segment worker collects them (same transport rules as lumberjack / quarry).

Example: A sawmill has ingredient Storage capacity 10 (only logs count toward that cap) and a default output buffer of 10 planks **outside** the ingredient tally. Ten logs filling the bin does not prevent producing the first plank.

### Convention for new buildings

Whenever you add a building with `production.inputs` + `storage` in `buildings.json`:

- Treat `storage.capacity` as **inputs only** (multi-input headroom rules in this doc still apply).
- Set `production.maxOutputBuffer` if the default (10) is wrong for the chain.
- Do **not** expect outputs to live in `Storage`; code paths assume outputs are only in `outputBuffer`.

### Storage vs. Output Buffer

| Building Type | Has Inputs? | Ingredients | Finished goods (awaiting pickup) |
|---------------|-------------|-------------|-----------------------------------|
| Lumberjack | No | — | `Production.outputBuffer` |
| Sawmill | Yes (wood_log) | `Storage` (`isProductionStorage`) | `Production.outputBuffer` |
| Quarry | No | — | `Production.outputBuffer` |
| Bakery | Yes | `Storage` (`isProductionStorage`) | `Production.outputBuffer` |

Buildings **without** inputs use only `Production.outputBuffer`. Buildings **with** inputs use **`Storage` for inputs** and **`Production.outputBuffer` for outputs** — both are always created when the building has production; `isProductionStorage` is set when the definition has both `production.inputs` and `storage`.

### Configuration

In `buildings.json`, a building with inputs needs both `production` and `storage` blocks:

```json
"sawmill": {
  "production": {
    "outputs": { "wood_plank": 1 },
    "inputs": { "wood_log": 1 },
    "productionTime": 120,
    "continuous": true
  },
  "storage": {
    "capacity": 10
  }
}
```

`EntityFactory` automatically sets `isProductionStorage = true` when a building has both `production.inputs` and `storage`.

### Global Inventory Exclusion

Items in production **ingredient** storage are **not** counted in the global inventory (`resourceManager.getGlobalInventory()`). Only items in base camp, warehouse, and storehouse Storage components count. This prevents raw materials sitting in a sawmill from being "available" for other uses. Items in `outputBuffer` are also excluded until picked up and delivered to HQ storage.

---

## Production System (Local Storage Mode)

When a building has `isProductionStorage`, the `ProductionSystem` switches to local storage mode for **inputs only**:

1. **Check output staging space**: `production.hasBufferSpace()` (next batch must fit in `outputBuffer`, same as gatherer buildings)
2. **Check inputs**: each input type must exist in local Storage in sufficient quantity
3. **Consume inputs**: `storage.removeItem(inputResource, amount)` (not global inventory)
4. **Produce outputs**: `production.addToBuffer` + `resourceManager.requestPickup` (not `Storage`)

### Multi-input recipes (all types before production)

If `production.inputs` lists **more than one** resource type (e.g. pig farm: grain + water), the building **does not advance the production timer** until **every** type is present in local `Storage` in at least the configured amount for one cycle (same check as step 2 — no “half batch” while waiting for the second input).

**HQ → building dispatch (`Game.tryDispatchHqProductionInputsForBuilding`)** fills the local ingredient store toward per-resource targets instead of only sending one cycle’s worth. Single-input buildings can fill the full ingredient capacity. Multi-input fixed recipes split the capacity by recipe ratio (e.g. a 10-slot `wood_plank + iron_bar` store targets 5 boards and 5 iron bars). If HQ only has one ingredient, that ingredient can still be delivered up to its target; production still waits until every required input is present for a cycle.

Related helpers: `Game.countInTransitToBuildingForResource`, `ResourceManager.hasAvailableInputsForProduction` (global / output-buffer buildings).

### Input headroom (multi-input local storage)

A full shared store must still leave **physical slots** for every other ingredient that has not yet reached its recipe amount. `Game.canAddProductionInputToLocalStorage` enforces: remaining free space (capacity − stored − all in-flight to this building) minus the **new** occupancy from this shipment must be **≥** the largest shortfall among **other** inputs (`need[O] − pipeline(O)`). For **HQ→junction** spawns, the shipment is not yet in `countInTransitToBuilding`, so the “new occupancy” term subtracts `amount`. For **worker drop-off**, the carried unit is **already** counted in transit, so pass `incomingAlreadyInTransit: true` — otherwise free space is double-counted and valid water (etc.) bounces back to HQ.

- **HQ dispatch** and **worker drop-off** to the building both call this check; otherwise the item is not sent / is bounced to the base camp as a junction item toward HQ.
- **`rescueStuckMultiInputProductionStorage`** (runs on the same throttled pass as HQ input recheck) fixes legacy saves: if the recipe is still incomplete, the store is full, and there is not enough free space for the largest remaining shortfall, it removes one unit at a time from the most over-stocked **input** (above its recipe line), then if needed from **output-only** stacks, and spawns each unit at the camp entrance for HQ.

### Status Mapping

| Condition | Status |
|-----------|--------|
| Output buffer full (`outputBuffer` total ≥ `maxOutputBuffer` for the next batch) | `stopped_full` |
| Ingredient store full (inputs only) — does **not** stop production by itself | *(n/a — outputs use buffer)* |
| Required input not in local Storage | `stopped_no_inputs` |
| No road connection | `stopped_no_road` |
| Actively producing | `producing` |

---

## Demand-Based Transport Routing

### The Problem

Without demand routing, all resources flow toward the base camp. A sawmill would never receive wood_log because lumberjack output always goes to base camp.

### The Solution

When a road worker picks up a resource, the transport system checks if any production building **demands** that resource. If so, the item is routed toward that building instead of the base camp.

### Demand Definition

A building "demands" a resource when:
- It has a `Production` component with that resource as an input
- It has a `Storage` component with `isProductionStorage = true`
- It is complete and road-connected (`building.isActive`)
- Its Storage is not full

### Route Computation

`TransportManager` maintains direction maps for both the base camp and all production buildings with inputs:

- **Base camp direction**: `baseCampDirection` — BFS from base camp through the segment graph (existing)
- **Building directions**: `buildingDirections` — BFS from each production building with inputs

Both are computed/recomputed when:
- Roads are placed or deleted
- Buildings are placed or deleted
- A building finishes construction

For each segment, the direction map stores which endpoint is "toward" the target (base camp or building).

### Routing Decision Flow

When a worker picks up a resource from a building's output:

```
1. Check: does any building demand this resource?
   ├── YES: Can this segment route toward the demanding building?
   │   ├── YES → destination = demanding building
   │   └── NO → Can another segment at this position route to it?
   │       ├── YES → skip (let the other segment handle it)
   │       └── NO → destination = base camp (building unreachable)
   └── NO → destination = base camp
```

### Junction Items with Destinations

Junction items now carry a `destinationEntityId`:

```typescript
interface JunctionItem {
  resourceType: string;
  destinationEntityId: number | null; // null = base camp
}
```

When a worker drops an item at a junction, the destination is preserved. The next worker picks up items whose destination is reachable through their segment.

Workers check **both endpoints** of their segment for items, not just the "away from base camp" endpoint. An item headed toward a sawmill might need to travel in the opposite direction from base camp on some segments.

### Direction-Aware Pickup

`TransportManager.takeJunctionItemForDirection(x, y, segmentId, pickupEndpointIdx)` finds and takes the first junction item at a position whose destination is reachable through the given segment (i.e., destination direction ≠ pickup endpoint).

### Delivery to Production Buildings

When a worker arrives at a dropoff endpoint:

1. If the endpoint's building matches the item's destination → deliver to building's `Storage`
2. If the building is full or gone → redirect to base camp (drop as junction item tagged for base camp)
3. If at a junction (not the final destination) → drop as junction item preserving the destination tag

### Commitment Rule

Once a routing decision is made (at first pickup), the item's destination is **locked**:
- If routed to a sawmill, it stays routed to that sawmill even if the sawmill fills up mid-transit
- If routed to base camp, it stays routed to base camp even if a sawmill frees up space
- If the sawmill is full on arrival, the item is redirected to base camp at that point

---

## Production Chains

The system is general — any building with `production.inputs` and `storage` automatically participates in demand routing.

### Current Chains

| Chain | Source | Consumer | Input → Output |
|-------|--------|----------|----------------|
| Wood processing | Lumberjack | Sawmill | wood_log → wood_plank |

**Audit (2026-04-22):** Every building in `buildings.json` that defines both `production.inputs` and `storage` uses `storage.capacity: 10` for ingredients and relies on the default `production.maxOutputBuffer` (10) for the outside pickup queue — same pattern: `sawmill`, `pig_farm`, `mill`, `bakery`, `brewery`, `slaughterhouse`, `coal_mine`, `iron_mine`, `gold_mine`, `granite_mine`, `iron_smelter`, `mint`, `metalworks`, `armory`. None share a single pool for inputs and outputs anymore, so a full ingredient bin cannot block the first output unit.

### Future Chains (defined in buildings.json but not yet active)

| Chain | Source | Consumer | Input → Output |
|-------|--------|----------|----------------|
| Flour milling | Farm | Mill | grain → flour |
| Baking | Mill | Bakery | flour → bread |
| Iron smelting | Iron Mine + Coal Mine | Iron Smelter | iron_ore + coal → iron_bar |
| Tool smithing | Iron Smelter + Sawmill | Metalworks | iron_bar + wood_plank → hammer |
| Brewing | Brewery | brewery | grain + water → beer |
| Meat processing | Pig Farm | Slaughterhouse | meat → ham |
| Pig breeding | Farm + Well | Pig Farm | grain + water → meat |
| Coal mining | Bakery | Coal Mine | bread → coal |
| Iron mining | Bakery | Iron Mine | bread → iron_ore |
| Gold mining | Bakery | Gold Mine | bread → gold_ore |
| Gold minting | Iron Smelter pattern | Mint | coal + gold_ore → gold_coin |
| Weapon forging | Iron Smelter pattern | Armory | coal + iron_bar → sword |

Multi-input buildings (iron smelter, metalworks) demand each input independently. Each input type is routed from its own source.

---

## Edge Cases

- **Multiple consumers**: `findDemandingBuilding()` returns the first building with space. No round-robin or nearest-first optimization yet.
- **Segment priority**: When a building is at a junction between multiple segments, the system ensures only the segment that can route toward the demanding building picks up the item. Other segments leave it for the correct one.
- **Mid-transport recalc**: If roads change while an item is in transit, carried items are dropped as junction items preserving their destination.
- **Building destroyed mid-transit**: Items destined for a destroyed building are redirected to base camp on arrival.
- **Single-tile segments**: Workers skip walking phases and advance transport immediately.

---

## File Map

| File | Purpose |
|------|---------|
| `src/data/buildings.json` | Building definitions with `production.inputs` and `storage` |
| `src/components/Storage.ts` | Storage component with `isProductionStorage` flag |
| `src/components/Production.ts` | Production component (`outputBuffer` for all finished goods awaiting pickup) |
| `src/entities/EntityFactory.ts` | Sets `isProductionStorage` when building has inputs + storage |
| `src/systems/ProductionSystem.ts` | Local ingredient mode: consume inputs from Storage, add outputs to `outputBuffer` |
| `src/economics/ResourceManager.ts` | Excludes production storage from global inventory |
| `src/economics/TransportManager.ts` | Per-building BFS routing, direction-aware junction items |
| `src/core/Game.ts` | Demand routing in `tryStartTransport`, pickup in `advanceTransport`, legacy output migration on load |
| `src/ui/BuildingPopover.ts` | Ingredients vs outside pickup for `isProductionStorage` buildings |

---

## Save/Load

Production Storage items are saved per-building in the same format as warehouse/base camp Storage. Junction item destinations are saved. On load:

1. Buildings are recreated with `isProductionStorage` set by EntityFactory
2. Storage items are restored via `storage.deserialize()`
3. Junction items with destinations are restored
4. Building routes are computed via BFS for all production buildings with inputs
