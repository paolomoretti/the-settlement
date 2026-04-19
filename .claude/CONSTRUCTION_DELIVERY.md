# Construction Material Delivery

How the construction system will work when building placement requires physical delivery of boards and stones via the road network.

**Status**: PLANNED (not yet implemented)
**Last Updated**: 2026-04-19

---

## Overview

Currently, placing a building instantly deducts resources from global inventory and starts a build timer. The new system replaces this with physical material delivery: players place a construction site, then workers deliver the required boards (`wood_plank`) and stones (`stone`) via roads. Construction completes once all materials arrive.

This matches The Settlers II construction model where buildings are built by delivering materials to the site.

---

## New Construction Flow

### Current Flow (to be replaced)
```
Player places building → Resources deducted from inventory → Build timer starts → Building complete
```

### New Flow
```
1. Player places building → Construction site appears (no resources deducted)
2. Transport system creates delivery requests for each board/stone needed
3. Road workers deliver materials one at a time via the relay chain
4. Each delivery increments construction progress
5. When all materials delivered → Build timer starts (construction animation)
6. Timer completes → Building operational
```

### Example: Sawmill (cost: 2 boards + 2 stones)
1. Player places sawmill → construction site sprite appears
2. System creates 4 delivery requests: 2 × wood_plank, 2 × stone
3. Workers deliver from nearest storage (base camp/storehouse) via road network
4. After each delivery, construction progress updates (25% per item)
5. After 4th delivery → build timer runs (30 seconds)
6. Building complete and operational

---

## Design Decisions

### Pre-placement Check
When the player tries to place a building, the system should:
- **Check** that enough boards/stones exist in global inventory (across all storage buildings)
- **Reserve** the materials so they can't be double-spent on another building
- If materials are insufficient, show a toast: "Need X more boards / Y more stones"

### Material Reservation
Once a building is placed:
- Materials are **reserved** but not deducted from storage
- Reserved materials don't count as "available" for other build requests
- If the building is cancelled/deleted before completion, reserved materials are released

### Delivery Priority
- Construction deliveries share the road network with production transport
- No special priority — materials wait their turn in the relay chain
- Multiple construction sites compete for the same board/stone supply

### Road Requirement
- The construction site must be connected to the road network (via its entrance)
- If not connected, the site stays as a placeholder until roads reach it
- This creates a natural gameplay loop: roads first, then buildings

### Construction Site Visual
- Show the building's footprint/foundation at reduced opacity
- Display a progress indicator showing materials received vs. needed
- Example: "Sawmill [2/2 boards, 1/2 stones]"

### Cancellation
- Player can delete a construction site at any time
- Materials already delivered are dropped at the site and need to be transported back to storage
- Materials in transit continue to their destination (the construction site), then get rerouted

---

## Implementation Plan

### Phase 1: Building Component Changes
- Add `constructionMaterials` field to `Building` component:
  ```typescript
  constructionMaterials: {
    required: Record<string, number>;   // { wood_plank: 2, stone: 2 }
    delivered: Record<string, number>;   // { wood_plank: 1, stone: 0 }
  } | null;
  ```
- Building state flow: `awaiting_materials` → `under_construction` → `complete`
- Construction timer only starts when all materials are delivered

### Phase 2: Placement Logic Changes (Game.ts)
- `buildGeneric()`:
  - Remove `resourceManager.deductResources()` call
  - Instead, set `building.constructionMaterials` from `buildCost`
  - Building starts in `awaiting_materials` state
  - Only board/stone costs trigger deliveries; tools are separate

### Phase 3: Transport Integration
- Create delivery requests for each unit of material needed
- Use the existing demand-based routing: construction sites "demand" boards and stones
- Workers deliver from nearest storage building with available materials
- On delivery arrival, increment `constructionMaterials.delivered`
- When `delivered >= required` for all materials → transition to `under_construction`

### Phase 4: UI Updates
- `BuildingPopover`: show material delivery progress for buildings in `awaiting_materials` state
- Construction site rendering: show foundation/outline with progress overlay
- Build menu: show "X boards, Y stones" cost, grey out if insufficient

### Phase 5: Save/Load
- Serialize `constructionMaterials` state
- On load, resume delivery requests for incomplete construction sites

---

## Interaction with Existing Systems

### Transport Manager
- Construction sites register as "demanding" buildings for wood_plank and stone
- The existing `computeRoutesToBuilding()` handles pathfinding to construction sites
- Materials route via the standard relay chain

### Resource Manager  
- `canAfford()` needs to account for reserved materials
- Add `getReservedAmount(resourceType)` to track materials committed to construction
- `getAvailableAmount()` = stored - reserved - in_transit

### Production System
- Buildings in `awaiting_materials` state are skipped by ProductionSystem
- No change needed — the existing `building.isComplete()` check handles this

### Road Segment Workers
- No changes — workers already handle demand-based routing
- Construction site deliveries are just another destination type

---

## Edge Cases

- **No road connection**: Construction site placed but not connected → materials can't be delivered → site waits
- **Storage empty**: Not enough boards/stones in any storage → deliveries stall, construction waits
- **Building deleted mid-delivery**: Cancel pending deliveries, reroute in-transit materials to nearest storage
- **Multiple construction sites**: Materials distributed based on which site workers reach first (no priority system initially)
- **Road destroyed mid-delivery**: Existing stranded item recovery handles this

---

## Future Enhancements

- **Construction priority**: Let player set priority order for multiple construction sites
- **Builder workers**: Dedicated builder workers with hammers who do the actual construction (visual)
- **Construction stages**: Show visual building stages as materials arrive (foundation → walls → roof)

---

## File Map (planned changes)

| File | Change |
|------|--------|
| `src/components/Building.ts` | Add `constructionMaterials` field, `awaiting_materials` state |
| `src/core/Game.ts` | Update `buildGeneric()`, add construction delivery logic |
| `src/economics/ResourceManager.ts` | Add material reservation tracking |
| `src/ui/BuildingPopover.ts` | Show material delivery progress |
| `src/systems/RenderSystem.ts` | Render construction site differently |
| `src/data/buildings.json` | Already done — costs are in boards + stones |
