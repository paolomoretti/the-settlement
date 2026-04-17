# The Settlement

A web-based tribute to The Settlers II, built with modern web technologies.

![Game Status](https://img.shields.io/badge/status-in%20development-yellow)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![Vite](https://img.shields.io/badge/Vite-5.0-purple)

## 🎮 About

The Settlement is a browser-based city-building game inspired by the classic The Settlers II (1996). Built from scratch using TypeScript and HTML5 Canvas, it recreates the beloved isometric gameplay with modern web technologies.

## ✨ Features

- **Isometric 3D Rendering** - Classic 2:1 isometric perspective with proper depth sorting
- **Procedural World** - 1000×1000 tile map with mountains, forests, rivers, and hills
- **Fog of War** - Exploration system revealing the map as you play
- **Interactive Minimap** - Click to navigate, see explored regions
- **Building System** - Multi-tile buildings (warehouse 3×3, lumberjack 2×2)
- **Road Network** - Workers pathfind along roads using A* algorithm
- **Save/Load** - Compressed save system using seed-based terrain regeneration
- **Touch Support** - Fully playable on mobile devices

## 🚀 Getting Started

### Prerequisites
- Node.js 18+ and npm

### Installation

```bash
# Clone the repository
git clone git@github.com:paolomoretti/the-settlement.git
cd the-settlement

# Install dependencies
npm install

# Start development server
npm run dev
```

Visit `http://localhost:5173` to play!

### Build for Production

```bash
npm run build
npm run preview
```

## 🎨 Asset Creation

We're using AI-generated sprites in the style of The Settlers II. For detailed instructions on creating and integrating assets, see:

**📖 [Asset Guide](./.claude/ASSET_GUIDE.md)**

Quick summary:
- **Terrain tiles**: 64×32px isometric diamonds
- **Buildings**: Multi-tile sprites with transparency
- **Style**: Hand-painted medieval fantasy, warm colors
- **Format**: PNG with alpha channel

## 🎯 Controls

- **Mouse Drag** - Pan camera
- **Mouse Wheel** - Zoom in/out
- **Spacebar + Drag** - Pan camera (any mode)
- **Escape** - Return to view mode
- **Click** - Select buildings, place structures
- **Minimap Click** - Jump to location

## 🏗️ Project Structure

```
settler/
├── src/
│   ├── audio/          # Sound management (placeholder)
│   ├── components/     # ECS components (Position, Movable, Building, etc.)
│   ├── core/           # Core systems (Game, Entity, EventBus)
│   ├── entities/       # Entity factories
│   ├── map/            # Tile and TileMap classes
│   ├── pathfinding/    # A* pathfinding implementation
│   ├── systems/        # ECS systems (Render, Movement, Input)
│   ├── utils/          # Utilities (Isometric, NoiseGenerator)
│   └── main.ts         # Entry point
├── assets/             # Game assets (sprites, sounds)
│   ├── terrain/
│   ├── buildings/
│   ├── units/
│   └── ui/
├── .claude/            # Project docs (asset guide, prompts)
└── index.html          # Main HTML file
```

## 🧩 Architecture

The game uses an **Entity-Component-System (ECS)** architecture:

- **Entities**: Game objects (workers, buildings)
- **Components**: Data (Position, Renderable, Movable)
- **Systems**: Logic (RenderSystem, MovementSystem, InputSystem)
- **EventBus**: Decoupled communication between systems

## 🗺️ World Generation

The map uses **procedural generation** with Perlin-like noise:

1. **Elevation** - Determines mountains, hills, and valleys
2. **Moisture** - Controls forest density
3. **Tree Distribution** - Scattered individual trees
4. **Rivers** - Meandering waterways from north to south

All terrain is regenerated from a single **seed** for efficient save/load.

## 💾 Save System

Saves include:
- Terrain seed (regenerates identical world)
- Explored tiles (compressed coordinate list)
- Roads (compressed coordinate list)
- Buildings (position + type)

Result: ~200KB save file instead of 100MB!

## 🛠️ Tech Stack

- **TypeScript** - Type-safe development
- **Vite** - Fast build tool and dev server
- **Canvas 2D** - Rendering engine
- **pathfinding** - A* pathfinding library
- **howler.js** - Audio management (future)

## 📋 Roadmap

- [x] Basic isometric rendering
- [x] Procedural terrain generation
- [x] Building placement system
- [x] Worker pathfinding
- [x] Save/load functionality
- [x] Fog of war
- [ ] **Asset integration** (current focus)
- [ ] Resource system (wood, stone, food)
- [ ] Production chains
- [ ] Multiple building types
- [ ] Population management
- [ ] Economy simulation
- [ ] Sound effects and music
- [ ] Multiplayer (future)

## 🤝 Contributing

This is a personal learning project, but suggestions and feedback are welcome!

## 📝 License

This project is for educational purposes. The Settlers is a trademark of Ubisoft.

## 🙏 Credits

- Inspired by **The Settlers II** by Blue Byte (1996)
- Built with love and nostalgia

---

**Status**: Active Development  
**Last Updated**: 2026-04-17
