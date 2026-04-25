# Demolition Fire

When a building is deleted, `Game.destroyBuildingEntity()` records a demolition site for the building footprint before freeing its occupied tiles. The site has two phases:

- Fire: 30 seconds from `startedAt`. The footprint cannot accept buildings or roads while this is active.
- Scorch: 60 seconds after the fire. This is only a ground overlay; buildings and roads may be placed over it.

`Game` owns the authoritative `demolitionSites` list because placement and save/load rules live there. It passes a copy to `RenderSystem.setDemolitionSites()` for drawing.

Rendering is split by phase:

- `src/rendering/loFiFire.ts` contains the reusable particle effect adapted from the self-contained Canvas example.
- `RenderSystem.updateDemolitionFires()` keeps one particle emitter per active site.
- `RenderSystem.renderDemolitionScorches()` paints black/brown scorch ellipses on the ground.
- Active fires are drawn during the depth-sorted pass so they sit naturally among trees, workers, and nearby structures.

Save/load persists active demolition sites and drops expired ones on load. The timestamps use real time (`Date.now()`), matching construction and other temporary world timers.
