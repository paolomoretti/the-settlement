# Economics Runtime System

How production, storage, and transport actually work at runtime. This is the **implemented** system — for design goals and balance theory, see [ECONOMY_DESIGN.md](ECONOMY_DESIGN.md).

**Last Updated**: 2026-04-18

---

## Overview

The economics system follows the Settlers II model:

1. **Production buildings** produce resources on a timer into a local output buffer
2. When the buffer has items, a **transport request** is created for pickup
3. **Road workers** (not yet implemented) pick up items and carry them to the nearest warehouse or base camp
4. The **global inventory** is the sum of all Storage components across all storage buildings
5. Buildings that need **inputs** (e.g. sawmill needs wood_log) consume them from the global inventory

---

## Production System

### How It Works

Each production building has a `Production` component (`src/components/Production.ts`) attached by `EntityFactory` based on the building's definition in `buildings.json`.

**Per-frame cycle** (handled by `ProductionSystem` in `src/systems/ProductionSystem.ts`):

1. Skip if building is not complete (still under construction)
2. Skip if building has no road connection → status = `stopped_no_road`
3. Check if output buffer has space for the next production batch → if not, status = `stopped_full`
4. Check if required inputs are available in global inventory → if not, status = `stopped_no_inputs`
5. If all checks pass, advance the production timer by `deltaTime`
6. When timer reaches `productionTime`, one cycle completes:
   - Inputs are consumed from storage buildings (via `ResourceManager`)
   - Outputs are added to the building's local output buffer
   - A transport request is created for each output resource
   - Timer wraps (subtracts `productionTime`, keeping remainder for smooth cycling)

### Production Status

Every production building is in one of these states:

| Status | Meaning | What To Show (UX) |
|--------|---------|-------------------|
| `idle` | Not producing (one-time production finished) | Nothing |
| `producing` | Actively producing | Progress indicator |
| `stopped_full` | Output buffer is full, waiting for pickup | **Stop icon** — items need to be collected |
| `stopped_no_inputs` | Missing required input resources | Warning — missing ingredients |
| `stopped_no_road` | Not connected to road network | Road disconnected indicator |

### Output Buffer

Each production building has a local output buffer:

- **Max capacity**: 10 items (hardcoded in `EntityFactory`, same for all buildings)
- The buffer fills as the building produces
- Items stay in the buffer until a road worker picks them up
- When buffer is full, production stops (`stopped_full`)
- The buffer check accounts for the **next batch size** — if producing 2 planks but only 1 slot free, it stops

Example: A lumberjack produces 1 wood_log every 20 seconds. After 200 seconds with no pickup, buffer has 10 logs and production stops.

### Input Consumption

Buildings with inputs (sawmill, bakery, iron smelter, etc.) consume resources from the **global inventory** — the sum of all Storage components across warehouses and base camp. Inputs are consumed at the moment production completes, not when it starts.

If inputs become unavailable mid-cycle, the cycle pauses at completion time and the building enters `stopped_no_inputs`.

---

## Storage System

### Storage Component

Storage buildings (base_camp, warehouse, storehouse) have a `Storage` component (`src/components/Storage.ts`):

- **items**: `Record<string, number>` — resources stored in this building
- **capacity**: max total items (base_camp: 2000, warehouse: 500, storehouse: 200)
- **accepts**: optional filter for which resource types are allowed (currently unused — all accept everything)
- **isHeadquarters**: true for base_camp only

### Global Inventory

The game's `inventory` property (`game.inventory`) is **derived** — it's recalculated every frame by summing all Storage components:

```
game.inventory = sum of storage.items across all Storage entities
```

This means the inventory is always real-time. Opening a panel, checking affordability, or reading resource counts always reflects the current state.

### Starting Resources

Starting resources (defined in `game-config.json`) are loaded into the base camp's Storage component during `initializeWorld()`.

### Build Cost Deduction

When a player builds something, costs are deducted from Storage components via `ResourceManager.deductResources()`. It iterates through storage buildings and removes resources until the cost is fulfilled.

---

## Transport System

### The Vision (Settlers II Style)

This is how the full transport system is designed to work:

1. Every stretch of road has a **road worker** standing at its center
2. When a production building produces an item, a **transport request** is created
3. The road worker connected to that building walks to it, picks up the item, and carries it
4. The worker brings the item to the nearest connected warehouse or base camp
5. The item is deposited into the Storage component of the destination building
6. The worker returns to their road position

**Currently implemented**: The data layer (transport requests, queue management). **Not yet implemented**: The actual road workers and their movement/pickup behavior.

### Transport Queue

`TransportQueue` (`src/economics/TransportRequest.ts`) manages pickup requests:

Each `TransportRequest` has:
- **id**: unique identifier
- **sourceEntityId**: the building that produced the item
- **destinationEntityId**: target storage building (null until assigned)
- **resourceType**: what resource to carry
- **amount**: how many items
- **status**: `waiting` → `assigned` → `in_transit` → `delivered`
- **assignedWorkerId**: which road worker is handling this (null until assigned)

### Transport Lifecycle

```
Building produces item
  → TransportRequest created (status: waiting)
  → Event: transport:pickup_available

Road worker picks up request
  → transportQueue.assignWorker(requestId, workerId, destinationId)
  → status: assigned

Worker picks up item from building
  → production.removeFromBuffer(resource, amount)
  → transportQueue.markInTransit(requestId)
  → status: in_transit

Worker delivers to storage
  → resourceManager.completeDelivery(requestId, resource, amount)
  → storage.addItem(resource, amount)
  → status: delivered (removed from queue)
```

### Cleanup

- When a building is deleted: `resourceManager.onBuildingDestroyed(entityId)` cancels all its transport requests
- When a worker is freed: `transportQueue.cancelByWorker(workerId)` resets their assigned requests back to `waiting`
- On game reset: `resourceManager.reset()` clears the entire queue

---

## ResourceManager

`ResourceManager` (`src/economics/ResourceManager.ts`) is a singleton that centralizes all resource operations:

### Key Methods

| Method | Purpose |
|--------|---------|
| `getGlobalInventory()` | Sum of all Storage components — the empire-wide inventory |
| `getGlobalAmount(type)` | Total amount of one resource across all storage |
| `canAfford(costs)` | Check if global inventory covers a cost map |
| `deductResources(costs)` | Remove resources from storage buildings |
| `consumeInputsForProduction(inputs)` | Check + deduct inputs for production |
| `requestPickup(entityId, resource, amount)` | Create a transport request |
| `completeDelivery(requestId, resource, amount)` | Deliver item to headquarters storage |
| `findNearestStorage(x, y, resourceType?)` | Find closest storage building by Manhattan distance |
| `getStorageBuildings()` | All completed buildings with Storage component |
| `getProductionBuildings()` | All buildings with Production component |

### Entity Access

ResourceManager gets entity access via a getter function set during Game initialization:

```typescript
resourceManager.setEntityGetter(() => this.entities);
```

This avoids circular dependencies — ResourceManager doesn't import Game.

---

## Events

The economics system emits these events via `EventBus`:

### Production Events

| Event | Payload | When |
|-------|---------|------|
| `production:complete` | `{ entityId, outputs }` | A production cycle finishes and items enter the buffer |
| `production:stopped` | `{ entityId, reason }` | Production stops (reason: `buffer_full`, `no_inputs`, `no_road`) |
| `production:resumed` | `{ entityId }` | Production restarts after being stopped |

### Transport Events

| Event | Payload | When |
|-------|---------|------|
| `transport:pickup_available` | `{ requestId, sourceEntityId, resourceType, amount }` | Item ready for pickup at a building |

### Resource Events

| Event | Payload | When |
|-------|---------|------|
| `resource:updated` | none | Global inventory changed (production consumed inputs, build cost deducted, delivery completed) |
| `resource:delivered` | `{ resourceType, amount }` | Item delivered to storage |

---

## Save/Load

All economics state is persisted:

### Per-Building Save Data

```json
{
  "type": "lumberjack",
  "x": 505, "y": 500,
  "production": {
    "status": "producing",
    "timer": 12.5,
    "outputBuffer": { "wood_log": 3 }
  },
  "storage": {
    "items": { "wood_log": 25, "stone": 10 }
  }
}
```

### Transport Queue

```json
{
  "transportQueue": {
    "transportQueue": [
      { "id": 1, "sourceEntityId": 5, "resourceType": "wood_log", "amount": 1, "status": "waiting", ... }
    ]
  }
}
```

### Backwards Compatibility

Old saves (before the economics system) have `inventory` at the top level instead of per-building Storage data. On load, the old inventory is migrated into the base camp's Storage component.

---

## File Map

| File | Purpose |
|------|---------|
| `src/components/Production.ts` | Production component — timer, buffer, status, outputs, inputs |
| `src/components/Storage.ts` | Storage component — items, capacity, accepts filter |
| `src/systems/ProductionSystem.ts` | ECS system — processes production each frame |
| `src/economics/ResourceManager.ts` | Singleton — global inventory, cost checks, transport queue |
| `src/economics/TransportRequest.ts` | Transport queue — pickup request lifecycle |
| `src/entities/EntityFactory.ts` | Attaches Production/Storage components based on building defs |
| `src/core/Game.ts` | Registers ProductionSystem, syncs inventory, save/load |

---

## ECS Integration

### System Order (every frame)

1. **ProductionSystem** — advance timers, produce items, create transport requests
2. **MovementSystem** — move workers along paths
3. **RenderSystem** — draw everything
4. After systems: **syncInventory()** — recalculate `game.inventory` from Storage components

### Component Attachment (EntityFactory)

When `createBuilding()` is called:
- If building def has `production` with non-empty `outputs` → attach `Production` component
- If building def has `storage` → attach `Storage` component (with `isHeadquarters` flag)

Buildings that get Production: lumberjack, sawmill, quarry, farm, mill, bakery, well, fisher, coal_mine, iron_mine, iron_smelter, tool_smithy

Buildings that get Storage: base_camp, warehouse, storehouse

---

## UX Indicators Needed (Not Yet Implemented)

These visual indicators should be added by the rendering/UI layer:

1. **Stop icon** on buildings with `production.status === 'stopped_full'` — buffer is full, items need pickup
2. **Pickup icon** on buildings where `production.getTotalBuffered() > 0` — at least one item ready for collection
3. **Missing inputs warning** on buildings with `production.status === 'stopped_no_inputs'`
4. **Production progress bar** showing `production.getProgress()` (0 to 1)
5. **Real-time inventory panel** — reads from `game.inventory` which updates every frame
