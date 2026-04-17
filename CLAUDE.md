# The Settlement - Project Guide

A browser-based city-building game heavily inspired by Settlers of Catan / The Settlers II (1996). Built with TypeScript, HTML5 Canvas 2D, and Vite.

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Rendering:** HTML5 Canvas 2D, isometric projection (2:1 ratio, 64x32 tiles)
- **Build:** Vite 5.0 (dev server on port 3000)
- **Architecture:** Entity-Component-System (ECS) with EventBus
- **Dependencies:** `pathfinding` (A*), `howler.js` (audio)

## Project Structure

```
src/
  core/         - Game loop, Entity, System, EventBus, Component base classes
  components/   - ECS data: Position, Movable, Building, Worker, Renderable
  systems/      - ECS logic: RenderSystem, InputSystem, MovementSystem
  entities/     - EntityFactory for creating game objects
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
- **Save/Load:** localStorage - stores seed (regenerates terrain), explored tiles, roads, buildings
- **Input modes:** view, build_road, build_warehouse, build_lumberjack, select (drag)

## Current State

Working: terrain generation, isometric rendering, camera pan/zoom, building placement/selection/deletion/drag, road building, worker spawning, A* pathfinding on roads, fog of war, minimap, save/load, touch support.

Not yet implemented: sprite assets (all visuals are colored shapes), resource system, production chains, worker job assignment, trading, military, audio, building upgrades, weather/seasons.

## Documentation

- [Asset Guide](.claude/ASSET_GUIDE.md) - Comprehensive guide for creating game sprites
- [AI Prompt Template](.claude/AI_PROMPT_TEMPLATE.txt) - Quick-reference template for AI image generation
- [Performance Guidelines](.claude/PERFORMANCE.md) - Mandatory rules for rendering, textures, and canvas performance

## Style & Conventions

- Isometric perspective, 2:1 ratio, 45-degree view angle
- Hand-painted medieval fantasy aesthetic (Settlers II style)
- Warm earthy color palette, lighting from top-left
- Asset naming: `[category]_[name]_[variant].png`, lowercase with underscores
- Tile dimensions: 64x32px base diamond
