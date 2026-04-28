# Game Configuration

`src/config/gameConfig.ts` is the central place for global gameplay tuning values.

Use it for balance knobs that designers or future agents should be able to scan and tweak quickly, such as:

- starting headquarters resources
- starting population
- starting headquarters territory radius
- enemy village count, size scaling, aggressiveness, raid cadence, road maintenance cadence, and forward barracks limits
- map-wide economy/population/world tuning values

Prefer this TypeScript object over JSON for global tuning because it supports comments beside each value. Comments should clarify units and semantics, especially when a value is a radius vs diameter, seconds vs milliseconds, cells vs pixels, or a multiplier vs absolute amount.

Do **not** try to migrate every existing constant at once. When touching a gameplay area, move relevant hard-coded tuning values into `GAME_CONFIG` as part of that change if doing so is low risk and keeps the config readable.

Keep content data in JSON:

- `src/data/resources.json` for resource definitions
- `src/data/buildings.json` for building definitions, build costs, production recipes, and per-building metadata

Runtime systems should usually read configuration through `dataManager.getGameConfig()` unless importing `GAME_CONFIG` directly makes a module simpler and does not create dependency cycles.

Current starting territory note: `starting.exploration.initialRadius` is a Chebyshev radius in map cells from the headquarters footprint center. It controls the initial settlement boundary disk, not a diameter.
