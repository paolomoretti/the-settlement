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
assets/         - **All game sprites & textures** (terrain/, buildings/, ui/, …). Served at `/assets/…` via `vite.config.ts`; **do not** mirror these under `public/`.
public/         - **Not** for PNG/WebP art. Only exceptions like `public/audio/` for `/audio/…` Howler loads.
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
- **Input modes:** view, build_road, build_warehouse, build_lumberjack, select (drag)

## Current State

Working: terrain generation, isometric rendering, camera pan/zoom, building placement/selection/deletion/drag, road building with toggle (click to place or remove, drag mode locking), building entrance system (≥2×2 buildings get auto-placed entrance on front/bottom-right side), road segment computation with automatic worker assignment (one worker per segment, walks to center, **only on base-camp-connected segments**), freed workers walk back to base camp on road deletion, A* pathfinding on roads + off-road pathfinding, fog of war, minimap, save/load, touch support, resource production system (buildings produce into output buffers), storage system (inventory lives in Storage components on warehouses/base camp), **transport relay chain** (workers relay items from buildings to base camp through segment junctions, with carrying visual; **pickups use `endpoint.entityId`, not only `type === 'building'`**, so T-junctions next to producers still drain buffers — see `.claude/TRANSPORT.md`), **building dependencies** (production buildings with inputs use **local ingredient storage** plus a separate **output buffer** for pickup; demand-based routing sends materials to consumer buildings instead of base camp — e.g., wood_log → sawmill; **always falls back to HQ** if this segment cannot carry toward the consumer; **multi-input recipes** require every input type on hand before the production timer runs, and HQ dispatch to local storage will not strip one ingredient unless HQ can still cover shortfalls for the others — see `.claude/BUILDING_DEPENDENCIES.md`), **construction material delivery** (boards/stones deducted from base camp and physically delivered via road network; builder worker walks to site; construction starts when both materials and builder arrive), **production animation** (woodcutter worker leaves building during production, walks off-road to tree, chops it, terrain changes at 90% progress, returns carrying wood_log), disconnected building indicator (road stub at entrance), disconnected roads allowed, **Alt/Option insight mode** (tile grid at any zoom while held; in view mode, instant hover tooltips + highlights on buildings, quarry rock, and water — see `.claude/HOVER_TOOLTIP.md`), **fish school depletion** (fisher `water_depletion`: up to 15 fish per water tile, `Tile.waterFishRemaining`, saved like rock harvests), **geological survey** (bare grass: highlight + center icon, then icon opens menu → HQ surveyor with shovel; road then off-road to flag; sequential dig per cell + progress bar; lazy `Tile.cellMinerals`; sign labels with resource art; walk back to HQ; 4-step Manhattan disk re-lock until labels clear — see `.claude/SURVEY.md`).

Not yet implemented: tool requirements for workers, mine food system (bread/fish/ham OR-input), metalworks tool priority system, production UX indicators (stop/pickup icons, progress bars), worker job assignment to buildings, resource consumption (food), trading, military, audio, building upgrades, weather/seasons.

## Documentation

- [Economics Runtime](.claude/ECONOMICS_RUNTIME.md) - **How production, storage, and transport work** — the core game economics system
- [Transport & Road Workers](.claude/TRANSPORT.md) - **Road segments, worker assignment, item carrying, production buffer pickup** — segment graph, `tryStartTransport` / `Game.ts` pitfalls (junction vs `building` endpoints, `pendingBuildingPickups`, route healing)
- [Economy Design](.claude/ECONOMY_DESIGN.md) - Game design goals, balance theory, production chains, tech progression
- [Data System](.claude/DATA_SYSTEM.md) - JSON config layer: resources.json, buildings.json, game-config.json, DataManager
- [Asset Guide](.claude/ASSET_GUIDE.md) - Comprehensive guide for creating game sprites
- [AI Prompt Template](.claude/AI_PROMPT_TEMPLATE.txt) - Quick-reference template for AI image generation
- [Performance Guidelines](.claude/PERFORMANCE.md) - Mandatory rules for rendering, textures, and canvas performance
- [Keyboard Shortcuts](.claude/KEYBOARD_SHORTCUTS.md) - Centralized shortcut system using hotkeys-js, all bindings and how to add more
- [Building Dependencies](.claude/BUILDING_DEPENDENCIES.md) - **Local storage, demand routing, production chains** — how buildings receive inputs and produce outputs
- [Construction Delivery](.claude/CONSTRUCTION_DELIVERY.md) - **Material delivery to construction sites** — builder workers, material dispatch, construction flow
- [Toast Notifications](.claude/TOAST.md) - Reusable short-lived messages via `showToast()` or EventBus `'toast'` event
- [Hover tooltip (canvas)](.claude/HOVER_TOOLTIP.md) - **Alt/Option + hover** insight (grid, highlights, tooltips); `InsightAltKey`, `registerFrameHook`, `buildHoverLines.ts`
- [World Generation](.claude/WORLD_GENERATION.md) - Terrain generation pipeline, RLE persistence, deterministic seeding
- [Survey & cell minerals](.claude/SURVEY.md) - **Surveyor**, lazy `cellMinerals`, labels, area lock
- [Production Animation](.claude/PRODUCTION_ANIMATION.md) - **Worker animation during production** — woodcutter leaves building, chops tree, terrain changes, returns
- [Worker spawn rules](.claude/WORKER_SPAWN.md) - **HQ-assigned workers** — spawn at base camp road, walk in; never appear at the job site without travel

**Convention**: Every time new logic is added to the game, document it in `.claude/` and reference it here. Future agents and chats rely on these docs to understand how systems work without re-explanation.

## Style & Conventions

- Isometric perspective, 2:1 ratio, 45-degree view angle
- Hand-painted medieval fantasy aesthetic (Settlers II style)
- Warm earthy color palette, lighting from top-left
- Asset naming: `[category]_[name]_[variant].png`, lowercase with underscores
- Tile dimensions: 64x32px base diamond
