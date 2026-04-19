# The Settlement - Project Guide

A browser-based city-building game heavily inspired by Settlers of Catan / The Settlers II (1996). Built with TypeScript, HTML5 Canvas 2D, and Vite.

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
assets/         - Sprite folders (terrain/, buildings/, units/, roads/, ui/) - currently empty placeholders
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

Working: terrain generation, isometric rendering, camera pan/zoom, building placement/selection/deletion/drag, road building with toggle (click to place or remove, drag mode locking), building entrance system (≥2×2 buildings get auto-placed entrance on front/bottom-right side), road segment computation with automatic worker assignment (one worker per segment, walks to center), freed workers walk back to base camp on road deletion, A* pathfinding on roads, fog of war, minimap, save/load, touch support, resource production system (buildings produce into output buffers), storage system (inventory lives in Storage components on warehouses/base camp), **transport relay chain** (workers relay items from buildings to base camp through segment junctions, with carrying visual), **building dependencies** (production buildings with inputs have local storage, demand-based routing sends materials to consumer buildings instead of base camp — e.g., wood_log → sawmill), disconnected building indicator (road stub at entrance), disconnected roads allowed.

Not yet implemented: production UX indicators (stop/pickup icons, progress bars), worker job assignment to buildings, resource consumption (food), trading, military, audio, building upgrades, weather/seasons.

## Documentation

- [Economics Runtime](.claude/ECONOMICS_RUNTIME.md) - **How production, storage, and transport work** — the core game economics system
- [Transport & Road Workers](.claude/TRANSPORT.md) - **Road segments, worker assignment, item carrying** — how roads are split into segments and workers assigned
- [Economy Design](.claude/ECONOMY_DESIGN.md) - Game design goals, balance theory, production chains, tech progression
- [Data System](.claude/DATA_SYSTEM.md) - JSON config layer: resources.json, buildings.json, game-config.json, DataManager
- [Asset Guide](.claude/ASSET_GUIDE.md) - Comprehensive guide for creating game sprites
- [AI Prompt Template](.claude/AI_PROMPT_TEMPLATE.txt) - Quick-reference template for AI image generation
- [Performance Guidelines](.claude/PERFORMANCE.md) - Mandatory rules for rendering, textures, and canvas performance
- [Keyboard Shortcuts](.claude/KEYBOARD_SHORTCUTS.md) - Centralized shortcut system using hotkeys-js, all bindings and how to add more
- [Building Dependencies](.claude/BUILDING_DEPENDENCIES.md) - **Local storage, demand routing, production chains** — how buildings receive inputs and produce outputs
- [Toast Notifications](.claude/TOAST.md) - Reusable short-lived messages via `showToast()` or EventBus `'toast'` event
- [World Generation](.claude/WORLD_GENERATION.md) - Terrain generation pipeline, RLE persistence, deterministic seeding

**Convention**: Every time new logic is added to the game, document it in `.claude/` and reference it here. Future agents and chats rely on these docs to understand how systems work without re-explanation.

## Style & Conventions

- Isometric perspective, 2:1 ratio, 45-degree view angle
- Hand-painted medieval fantasy aesthetic (Settlers II style)
- Warm earthy color palette, lighting from top-left
- Asset naming: `[category]_[name]_[variant].png`, lowercase with underscores
- Tile dimensions: 64x32px base diamond
