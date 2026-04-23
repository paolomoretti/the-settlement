# Data System Documentation

This document explains the game's data layer: resources, buildings, economy, and configuration.

## Overview

The Settlement uses a **data-driven design** where all game content (resources, buildings, costs, production chains) is defined in JSON configuration files with full TypeScript type safety.

## Architecture

```
src/
├── types/
│   └── GameData.ts          # TypeScript type definitions
├── data/
│   ├── resources.json        # Resource definitions
│   ├── buildings.json        # Building definitions  
│   ├── game-config.json      # Game settings
│   └── DataManager.ts        # Data loader and utilities
```

---

## Resources

All resources are defined in `src/data/resources.json`.

### Resource Categories

1. **Raw Materials**: `wood_log`, `stone`, `coal`, `iron_ore`, `gold_ore`, `granite`
2. **Refined Materials**: `wood_plank`, `iron_bar`, `gold_coin`
3. **Food**: `grain`, `flour`, `bread`, `water`, `fish`, `meat`
4. **Tools**: `hammer`, `axe`, `saw`, `pickaxe`, `shovel`, `fishing_rod`, `scythe`, `bow`
5. **Weapons**: `sword`, `shield`

### Resource Schema

```typescript
{
  "id": "wood_log",           // Unique identifier
  "name": "Wood Log",          // Display name
  "category": "raw",           // Category: raw, refined, food, tool, weapon
  "description": "...",        // Tooltip text
  "stackSize": 50,             // Max items per inventory slot
  "icon": "/assets/..."        // Path to icon (16×16 sprite)
}
```

### Adding a New Resource

1. Add entry to `src/data/resources.json`
2. Add type to `ResourceType` in `src/types/GameData.ts`
3. Create 16×16 icon sprite at `/assets/ui/icons/`

---

## Buildings

All buildings are defined in `src/data/buildings.json`.

**Staffed buildings and map workers** (interior vs custom site animation, `operatorRole`, inferred defaults): see `.claude/BUILDING_WORKERS.md`.

### Building Categories

1. **Core**: `headquarters`, `warehouse`, `storehouse`
2. **Residential**: `hut`, `house`
3. **Production**: `lumberjack`, `sawmill`, `quarry`, `farm`, `mill`, `bakery`, etc.
4. **Military**: `barracks`, `guardhouse`, `watchtower`, `fortress`
5. **Infrastructure**: `well`

### Building Schema

```typescript
{
  "id": "lumberjack",
  "name": "Lumberjack's Hut",
  "description": "Harvests wood logs from trees.",
  
  // Physical size on map
  "size": {
    "width": 2,    // Tiles wide
    "height": 2    // Tiles deep
  },
  
  // Visual properties
  "visual": {
    "buildingHeight": 60,  // Pixels above ground
    "color": "#8b4513",    // Fallback color
    "sprite": "/assets/buildings/lumberjack.png",
    "spriteScale": 1.2    // Optional: multiplies footprint-fitted sprite size (default 1)
  },
  
  // Construction requirements
  "buildCost": {
    "wood_plank": 3,
    "stone": 1
  },
  "buildTime": 35,        // Seconds
  "requiresRoad": true,   // Must be connected to road network
  
  // Production (optional)
  "production": {
    "outputs": {
      "wood_log": 1       // Produces 1 log
    },
    "inputs": {},         // No inputs (gathers from environment)
    "productionTime": 20, // Seconds per cycle
    "continuous": true    // Keeps producing
  },
  
  // Storage (optional - for warehouses, or ingredient bin on processors)
  "storage": {
    "capacity": 200,
    "accepts": ["wood_log", "wood_plank"]  // Optional filter
  },
  // If the building has both production.inputs and storage, capacity counts ingredients only;
  // finished goods always stage in production.outputBuffer (see BUILDING_DEPENDENCIES.md).
  
  // Population
  "population": {
    "provides": 0,  // Housing capacity (residential buildings)
    "requires": 1   // Workers needed to operate
  },
  
  // Metadata
  "category": "production",
  "tier": 1,              // Tech tier: 1, 2, or 3
  "canUpgrade": "house",  // Optional upgrade path
  "isHeadquarters": false
}
```

### Production Chains

Buildings can have production rules:

**Simple Gathering** (no inputs):
```json
"production": {
  "outputs": { "wood_log": 1 },
  "productionTime": 20,
  "continuous": true
}
```

**Processing** (inputs → outputs):
```json
"production": {
  "outputs": { "wood_plank": 1 },
  "inputs": { "wood_log": 1 },
  "productionTime": 120,
  "continuous": true
}
```

**Multi-input**:
```json
"production": {
  "outputs": { "bread": 1 },
  "inputs": { 
    "flour": 1,
    "water": 1
  },
  "productionTime": 25,
  "continuous": true
}
```

### Example Production Chains

**Wood Chain**:
```
Forest → Lumberjack → Wood Logs → Sawmill → Wood Planks → Construction
```

**Food Chain**:
```
Farm → Grain → Mill → Flour + (Well → Water) → Bakery → Bread
```

**Iron Chain**:
```
Iron Mine → Iron Ore + (Coal Mine → Coal) → Iron Smelter → Iron Bars → Metalworks → Tools
```

### Adding a New Building

1. Add entry to `src/data/buildings.json`
2. Add type to `BuildingType` in `src/types/GameData.ts`
3. Create sprite at `/assets/buildings/` (see ASSET_GUIDE.md)
4. Update EntityFactory if special behavior needed

---

## Game Configuration

Game-wide settings in `src/data/game-config.json`.

```json
{
  "starting": {
    "headquarters": {
      "position": "center",  // or {x, y}
      "startingResources": {
        "wood_log": 30,
        "wood_plank": 20,
        // ... starting inventory
      },
      "startingPopulation": 10
    },
    "exploration": {
      "initialRadius": 25  // Tiles explored at start
    }
  },
  
  "population": {
    "maxPerHut": 3,
    "maxPerHouse": 6,
    "workerWalkSpeed": 2.5
  },
  
  "economy": {
    "baseProductionRate": 1.0,
    "storageWarningThreshold": 0.8
  },
  
  "world": {
    "mapSize": { "width": 1000, "height": 1000 }
  }
}
```

---

## Using the Data System

### Loading Data

```typescript
import { dataManager } from '@/data/DataManager';

// Data is loaded automatically when first accessed
```

### Getting Resources

```typescript
// Get single resource
const wood = dataManager.getResource('wood_log');
console.log(wood?.name); // "Wood Log"

// Get all resources
const allResources = dataManager.getAllResources();

// Get by category
const tools = dataManager.getResourcesByCategory('tool');
```

### Getting Buildings

```typescript
// Get single building
const lumberjack = dataManager.getBuilding('lumberjack');

// Get by category
const productionBuildings = dataManager.getBuildingsByCategory('production');

// Get by tier
const tier1Buildings = dataManager.getBuildingsByTier(1);
```

### Checking Build Costs

```typescript
const inventory = {
  wood_log: 10,
  stone: 5
};

// Can player afford this?
const canBuild = dataManager.canAfford('lumberjack', inventory);

// What's missing?
const missing = dataManager.getMissingResources('lumberjack', inventory);
// Returns: { wood_log: 0, stone: 0 } (if can afford)
// Or: { stone: 1 } (if missing 1 stone)
```

### Formatting Costs

```typescript
const cost = { wood_log: 3, stone: 1 };
const formatted = dataManager.formatCost(cost);
// Returns: "Wood Log: 3, Stone: 1"
```

### Game Config

```typescript
const config = dataManager.getGameConfig();
const startingResources = dataManager.getStartingResources();
const startingPop = dataManager.getStartingPopulation();
```

---

## Population System

### Housing

Residential buildings provide population capacity:

- **Hut**: +3 max population (costs: 2 wood planks, 1 stone)
- **House**: +6 max population (costs: 4 wood planks, 3 stone)
- **Headquarters**: +10 max population (starting building)

### Workers

Production buildings require workers to operate:

```typescript
{
  "population": {
    "requires": 1  // Needs 1 worker assigned
  }
}
```

**Worker Assignment Flow**:
1. Build production building
2. Assign idle worker from population pool
3. Worker walks to building
4. Production begins

**Population Balance**:
- Total Population = Sum of all housing capacities
- Idle Workers = Total Population - Assigned Workers
- Must have idle workers to operate new buildings

---

## Economy System

### Inventory

Global inventory stored in headquarters/warehouses.

```typescript
interface Inventory {
  [resourceType: string]: number;
}

// Example:
{
  "wood_log": 25,
  "stone": 10,
  "bread": 15
}
```

### Storage Capacity

Storage buildings provide capacity:

- **Headquarters**: 1000 slots
- **Warehouse**: 500 slots
- **Storehouse**: 200 slots

**Total Capacity** = Sum of all storage buildings

### Production

Buildings produce resources over time:

```typescript
productionTime = baseTime / baseProductionRate
```

Example: Lumberjack produces 1 log every 20 seconds.

---

## Validation

Validate all data references:

```typescript
const validation = dataManager.validateData();

if (!validation.valid) {
  console.error('Data validation errors:', validation.errors);
}
```

Checks:
- Building costs reference valid resources
- Production inputs/outputs reference valid resources
- No circular dependencies (future)

---

## TypeScript Types

All data is fully typed in `src/types/GameData.ts`:

```typescript
// Type-safe resource access
const resource: ResourceDefinition = dataManager.getResource('wood_log')!;

// Type-safe building access  
const building: BuildingDefinition = dataManager.getBuilding('lumberjack')!;

// Autocompletion works!
building.production?.outputs  // ✓ Type-safe
building.invalidProperty      // ✗ Compile error
```

---

## Extending the System

### Adding New Resource Categories

1. Update `ResourceDefinition` category union in `GameData.ts`
2. Add resources to `resources.json`
3. Update `getResourcesByCategory()` usage

### Adding New Building Types

1. Add to `BuildingType` in `GameData.ts`
2. Add definition to `buildings.json`
3. Create sprite asset
4. Update UI if needed

### Custom Building Logic

For buildings with special behavior, extend in code:

```typescript
// In EntityFactory.ts or new system
if (buildingType === 'forester') {
  // Custom logic: plant trees on map
  this.plantTreesNearby(position);
}
```

---

## Future Enhancements

- [ ] Recipe system (crafting combinations)
- [ ] Tech tree (unlock buildings by tier)
- [ ] Building upgrades (hut → house)
- [ ] Resource consumption (workers eat food)
- [ ] Trade system (buy/sell resources)
- [ ] Dynamic pricing
- [ ] Building maintenance costs
- [ ] Seasonal production modifiers
- [ ] Random events (bountiful harvest, etc.)

---

**Last Updated**: 2026-04-17
