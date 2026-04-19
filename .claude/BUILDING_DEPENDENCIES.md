# Building Dependencies & Demand Routing

How production buildings with inputs receive materials and produce outputs. This covers the local storage model and the demand-based transport routing system.

**Last Updated**: 2026-04-19

---

## Overview

Some buildings require **input materials** to produce outputs (e.g., sawmill needs wood_log to produce wood_plank). These buildings have:

1. **Local Storage** — a `Storage` component with `isProductionStorage = true`, holding both inputs and outputs in a shared capacity pool
2. **Local consumption** — inputs are consumed from the building's own Storage, not the global inventory
3. **Demand routing** — when a source building produces a resource that a consumer building needs, the transport system routes it directly to the consumer instead of to the base camp

---

## Local Storage Model

### How It Works

Production buildings with inputs get both `Production` and `Storage` components. The Storage acts as the building's local inventory, shared between input materials (waiting to be consumed) and output materials (waiting to be picked up).

Example: A sawmill has Storage capacity 10. It might contain 3 wood_log (inputs) + 4 wood_plank (outputs) = 7/10 items.

### Storage vs. Output Buffer

| Building Type | Has Inputs? | Uses | Example |
|---------------|-------------|------|---------|
| Lumberjack | No | `Production.outputBuffer` | Produces wood_log into buffer |
| Sawmill | Yes (wood_log) | `Storage` component | Inputs + outputs share Storage |
| Quarry | No | `Production.outputBuffer` | Produces stone into buffer |
| Bakery | Yes (flour) | `Storage` component | Inputs + outputs share Storage |

Buildings **without** inputs use the existing `outputBuffer` on the Production component. Buildings **with** inputs use a `Storage` component marked `isProductionStorage = true`.

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

Items in production storage are **not** counted in the global inventory (`resourceManager.getGlobalInventory()`). Only items in base camp, warehouse, and storehouse Storage components count. This prevents raw materials sitting in a sawmill from being "available" for other uses.

---

## Production System (Local Storage Mode)

When a building has `isProductionStorage`, the `ProductionSystem` switches to local storage mode:

1. **Check space**: `storage.getFreeSpace() >= outputTotal` (not `production.hasBufferSpace()`)
2. **Check inputs**: each input type must exist in local Storage in sufficient quantity
3. **Consume inputs**: `storage.removeItem(inputResource, amount)` (not global inventory)
4. **Produce outputs**: `storage.addItem(outputResource, amount)` (not outputBuffer)

### Status Mapping

| Condition | Status |
|-----------|--------|
| Storage full (inputs + outputs >= capacity) | `stopped_full` |
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

### Future Chains (defined in buildings.json but not yet active)

| Chain | Source | Consumer | Input → Output |
|-------|--------|----------|----------------|
| Flour milling | Farm | Mill | grain → flour |
| Baking | Mill | Bakery | flour → bread |
| Iron smelting | Iron Mine + Coal Mine | Iron Smelter | iron_ore + coal → iron_bar |
| Tool smithing | Iron Smelter + Sawmill | Tool Smithy | iron_bar + wood_plank → hammer |

Multi-input buildings (iron smelter, tool smithy) demand each input independently. Each input type is routed from its own source.

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
| `src/components/Production.ts` | Production component (outputBuffer for non-storage buildings) |
| `src/entities/EntityFactory.ts` | Sets `isProductionStorage` when building has inputs + storage |
| `src/systems/ProductionSystem.ts` | Local storage mode: consume inputs from Storage, produce into Storage |
| `src/economics/ResourceManager.ts` | Excludes production storage from global inventory |
| `src/economics/TransportManager.ts` | Per-building BFS routing, direction-aware junction items |
| `src/core/Game.ts` | Demand routing in `tryStartTransport`, delivery in `advanceTransport` |
| `src/ui/BuildingPopover.ts` | Shows production storage contents in building info panel |

---

## Save/Load

Production Storage items are saved per-building in the same format as warehouse/base camp Storage. Junction item destinations are saved. On load:

1. Buildings are recreated with `isProductionStorage` set by EntityFactory
2. Storage items are restored via `storage.deserialize()`
3. Junction items with destinations are restored
4. Building routes are computed via BFS for all production buildings with inputs
