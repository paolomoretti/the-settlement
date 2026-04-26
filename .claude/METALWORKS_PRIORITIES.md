# Production Priorities

The Base Camp Production tab contains two priority groups.

## Tools

Metalworks is the first weighted-random multi-output producer.

- Its JSON recipe lists every tool it can craft and sets `production.outputMode` to `weighted_random`.
- Each completed production cycle consumes the normal recipe inputs, then picks exactly one listed output.
- The pick is weighted by settlement-wide priorities on `Game.productionPriorities`; each resource weight is clamped to 1-10 and defaults to 5.
- Priorities are saved in `productionPriorities` and normalized against current JSON on load, so new tools appear with defaults and removed outputs are ignored.

The percentage shown in the UI is the current relative chance for that building: `item priority / sum of priorities`.

## Buildings

Every non-HQ, non-road building type has a `buildingPriorities` value from 1-100, defaulting to 50.

- Construction material rechecks scan waiting sites from highest to lowest building priority.
- HQ production-input dispatch scans consumer buildings from highest to lowest building priority.
- Direct demand routing (`findDemandingBuilding`) also chooses the highest-priority matching consumer first.

Priorities are per building type, not per placed instance. Ties fall back to entity creation order.
