# The Settlement - Project Guide

A browser-based city-building game heavily inspired by Settlers of Catan / The Settlers II (1996). Built with TypeScript, HTML5 Canvas 2D, and Vite.

## Important Rules

- **Never start a dev server** (`npm run dev`, `npm run preview`, etc.) — the user will start servers manually when needed.

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Rendering:** HTML5 Canvas 2D, isometric projection (2:1 ratio, 64x32 tiles)
- **Build:** Vite 5.0 (dev server on port 3000)
- **Architecture:** Entity-Component-System (ECS) with EventBus
- **Dependencies:** `pathfinding` (A*), `howler.js` (audio), `hotkeys-js` (keyboard shortcuts)

## Project Structure

```
src/
  core/         - Game loop, Entity, System, EventBus, Component base classes
  components/   - ECS data: Position, Movable, Building, Worker, Renderable, Production, Storage
  systems/      - ECS logic: RenderSystem, InputSystem, MovementSystem, ProductionSystem
  economics/    - ResourceManager (global inventory), TransportRequest (pickup queue)
  entities/     - EntityFactory for creating game objects
  input/        - KeyboardShortcuts (centralized hotkey bindings via hotkeys-js)
  map/          - Tile and TileMap (1000x1000 procedural grid)
  pathfinding/  - A* pathfinding wrapper
  audio/        - AudioManager (Howler.js wrapper)
  utils/        - Isometric projection, NoiseGenerator
  main.ts       - Entry point
  debug/        - **`debug.html` asset catalogue** — `catalogPage.ts` (buildings + worker grid); not part of the game shell
  catalog/      - **`buildingSprites.ts`** — single source for building sprite URLs (game + debug page)
assets/         - **All game sprites & textures** (terrain/, buildings/, ui/, …). Served at `/assets/…` via `vite.config.ts`; **do not** mirror these under `public/`.
public/         - **Not** for PNG/WebP art. Only exceptions like `public/audio/` for `/audio/…` Howler loads.
debug.html      - **Standalone catalogue** page (Vite multi-page entry); open `/debug.html` beside the game for art review
```

## Key Commands

```bash
npm run dev      # Start dev server
npm run build    # Production build
npm run preview  # Preview production build
```

## Architecture Notes

- **ECS pattern:** Entities are ID containers, Components hold data, Systems process logic each frame
- **EventBus:** Decoupled pub/sub communication between systems
- **Map:** 1000x1000 tiles, procedurally generated from a seed using Perlin-like noise
- **Rendering:** Viewport culling, isometric depth sorting (back-to-front), minimap with offscreen canvas cache
- **Save/Load:** localStorage - stores RLE-encoded terrain, explored tiles, roads, buildings. Terrain is generated once on new game and persisted; loads restore exact saved terrain without regeneration
- **Input modes:** view, build_road, build_warehouse, build_lumberjack, select (drag); **right mouse drag always pans** (never places or selects on the main canvas)

## Current State

Working: terrain generation, isometric rendering, camera pan/zoom, building placement/selection/deletion/drag, road building with toggle (click to place or remove, drag mode locking), building entrance system (≥2×2 buildings get auto-placed entrance on front/bottom-right side), road segment computation with automatic worker assignment (one worker per segment, walks to center, **only on base-camp-connected segments**), freed workers walk back to base camp on road deletion, A* pathfinding on roads + off-road pathfinding, **territory fog** (vision from HQ + military `territoryVisionRadius` disks and a 5-cell preview band; camera does not scout; cordon rope/poles on the frontier; roads/buildings only inside the settlement interior, not on cordon tiles — see `.claude/TERRITORY_VISION.md`), minimap, save/load, touch support, resource production system (buildings produce into output buffers), storage system (inventory lives in Storage components on warehouses/base camp), **transport relay chain** (workers relay items from buildings to base camp through segment junctions, with carrying visual; **pickups use `endpoint.entityId`, not only `type === 'building'`**, so T-junctions next to producers still drain buffers — see `.claude/TRANSPORT.md`), **building dependencies** (production buildings with inputs use **local ingredient storage** plus a separate **output buffer** for pickup; demand-based routing sends materials to consumer buildings instead of base camp — e.g., wood_log → sawmill; **always falls back to HQ** if this segment cannot carry toward the consumer; **multi-input recipes** require every input type on hand before the production timer runs, and HQ dispatch to local storage will not strip one ingredient unless HQ can still cover shortfalls for the others — see `.claude/BUILDING_DEPENDENCIES.md`), **construction material delivery** (boards/stones deducted from base camp and physically delivered via road network; builder worker walks to site; construction starts when both materials and builder arrive), **production animation** (woodcutter worker leaves building during production, walks off-road to tree, chops it, terrain changes at 90% progress, returns carrying wood_log), **demolition fire** (deleted buildings leave 30s blocking fire, then 60s cosmetic scorch — see `.claude/DEMOLITION_FIRE.md`), disconnected building indicator (road stub at entrance), disconnected roads allowed, **Alt/Option insight mode** (tile grid at any zoom while held; in view mode, instant hover tooltips + highlights on buildings, quarry rock, and water — see `.claude/HOVER_TOOLTIP.md`), **water fish (lake clusters)** (shared stock per orthogonal water body; 5–15 cap rolled per cell and summed for the lake; fisher + jumps + save; regen +1 per water cell per 2 in-game hours on that cluster — see `.claude/WATER_FISH.md`), **wild rabbits** (spawn on explored grass near forest/water; new worlds start with 2–3; legacy saves gain rabbits every ~2 min real time; Hunter’s Hut `wild_hunt` gather returns `ham` — see `.claude/WILDLIFE_RABBITS.md`), **geological survey** (bare grass: highlight + center icon, then icon opens menu → HQ surveyor with shovel; road then off-road to flag; sequential dig per cell + progress bar; lazy `Tile.cellMinerals`; sign labels with resource art; walk back to HQ; 4-step Manhattan disk re-lock until labels clear — see `.claude/SURVEY.md`), **well aquifer** (lazy `Tile.cellWellWaterRemaining` 15–50 when a well completes on a cell; each water cycle consumes from that cell; at 0, orange X then auto-demolish after 2s; depleted cells stay at 0 forever — see `.claude/WELL_AQUIFER.md`).

Not yet implemented: tool requirements for workers, mine food system (bread/fish/ham OR-input), metalworks tool priority system, production UX indicators (stop/pickup icons, progress bars), worker job assignment to buildings, resource consumption (food), trading, audio, building upgrades, weather/seasons.

**Military (partial):** HQ assembly + march to fort, garrison slots, alternating armory sword/shield, gold payroll promotions, territory gated on garrison for soldier posts — see [.claude/MILITARY.md](.claude/MILITARY.md).

## Documentation

- [Economics Runtime](.claude/ECONOMICS_RUNTIME.md) - **How production, storage, and transport work** — the core game economics system
- [Transport & Road Workers](.claude/TRANSPORT.md) - **Road segments, worker assignment, item carrying, production buffer pickup** — segment graph, `tryStartTransport` / `Game.ts` pitfalls (junction vs `building` endpoints, `pendingBuildingPickups`, route healing)
- [Economy Design](.claude/ECONOMY_DESIGN.md) - Game design goals, balance theory, production chains, tech progression
- [Data System](.claude/DATA_SYSTEM.md) - JSON config layer: resources.json, buildings.json, game-config.json, DataManager
- [Asset Guide](.claude/ASSET_GUIDE.md) - Comprehensive guide for creating game sprites
- [AI Prompt Template](.claude/AI_PROMPT_TEMPLATE.txt) - Quick-reference template for AI image generation
- [Performance Guidelines](.claude/PERFORMANCE.md) - Mandatory rules for rendering, textures, and canvas performance
- [Game inputs & controls](.claude/GAME_INPUTS.md) - **Player-facing input reference** — mouse (incl. right-pan), wheel, modes, toolbar, minimap, touch, Alt insight; source for in-game help
- [Keyboard Shortcuts](.claude/KEYBOARD_SHORTCUTS.md) - Centralized shortcut system using hotkeys-js, all bindings and how to add more
- [Save Slots](.claude/SAVE_SLOTS.md) - Save/load slot storage, resume pointer, autosave binding, and clear-slot behavior
- [Building Dependencies](.claude/BUILDING_DEPENDENCIES.md) - **Local storage, demand routing, production chains** — how buildings receive inputs and produce outputs
- [Construction Delivery](.claude/CONSTRUCTION_DELIVERY.md) - **Material delivery to construction sites** — builder workers, material dispatch, construction flow
- [Toast Notifications](.claude/TOAST.md) - Reusable short-lived messages via `showToast()` or EventBus `'toast'` event
- [Hover tooltip (canvas)](.claude/HOVER_TOOLTIP.md) - **Alt/Option + hover** insight (grid, highlights, tooltips); `InsightAltKey`, `registerFrameHook`, `buildHoverLines.ts`
- [World Generation](.claude/WORLD_GENERATION.md) - Terrain generation pipeline, RLE persistence, deterministic seeding
- [Survey & cell minerals](.claude/SURVEY.md) - **Surveyor**, lazy `cellMinerals`, labels, area lock
- [Well aquifer](.claude/WELL_AQUIFER.md) - **Lazy `cellWellWaterRemaining`**, depletion, save, auto-demolish
- [Water fish](.claude/WATER_FISH.md) - **Lake-wide fish clusters**, fisher shore reachability, regen, saves, decorative jumps
- [Wild rabbits & Hunter](.claude/WILDLIFE_RABBITS.md) - **WildlifeCoordinator**, spawn/wander/save, `gatherMode: wild_hunt`, ham output on return
- [Territory & cordon vision](.claude/TERRITORY_VISION.md) - **TerritoryCoordinator**, HQ + military disks, preview band, cordon render, build/road rules, save fog
- [Military & garrison](.claude/MILITARY.md) - **HQ soldier assembly**, march to fort, `gold_coin` promotions, armory weapon alternation, territory vs garrison
- [Military attacks](.claude/MILITARY_ATTACKS.md) - **Enemy target selection, rank-limited attack UI, sequential duels, conquest aftermath**
- [Production priorities](.claude/METALWORKS_PRIORITIES.md) - **Tools + building routing priorities** — weighted-random Metalworks tools, building priority weights for construction/input dispatch, save/load normalization
- [Enemy realms](.claude/ENEMY_REALMS.md) - **Prototype computer-controlled village** — owner factions, per-faction territory, red cordon, initial 40x40 enemy village, attackable HQ
- [Production Animation](.claude/PRODUCTION_ANIMATION.md) - **Worker animation during production** — woodcutter leaves building, chops tree, terrain changes, returns
- [Demolition Fire](.claude/DEMOLITION_FIRE.md) - **Building deletion aftermath** — 30s blocking fire, 60s cosmetic scorch, save/load behavior
- [Worker spawn rules](.claude/WORKER_SPAWN.md) - **HQ-assigned workers** — spawn at base camp road, walk in; never appear at the job site without travel
- [Debug asset catalogue](.claude/DEBUG_CATALOGUE.md) - **`/debug.html`** — building sprite maps + worker preview grid; **must stay in sync** when adding/changing building PNGs, construction/production frames, or new worker visual cases

**Convention**: Every time new logic is added to the game, document it in `.claude/` and reference it here. Future agents and chats rely on these docs to understand how systems work without re-explanation.

**Art & worker visuals:** Whenever you add or change **building sprites** (final, `*_build_*`, `*_prod_*`) or **worker drawing / new poses / roles** you expect to review visually, also update the debug catalogue per [.claude/DEBUG_CATALOGUE.md](.claude/DEBUG_CATALOGUE.md) so `debug.html` stays truthful.

## Style & Conventions

- Isometric perspective, 2:1 ratio, 45-degree view angle
- Hand-painted medieval fantasy aesthetic (Settlers II style)
- Warm earthy color palette, lighting from top-left
- Asset naming: `[category]_[name]_[variant].png`, lowercase with underscores
- Tile dimensions: 64x32px base diamond
