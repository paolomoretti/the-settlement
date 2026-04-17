# Economy & Game Design Documentation

This document outlines the economic system design, balance considerations, and future expansion plans for The Settlement.

**Last Updated**: 2026-04-17  
**Game Version**: 0.2.0 (Economy System)

---

## Table of Contents
1. [Core Economic Principles](#core-economic-principles)
2. [Resource System](#resource-system)
3. [Production Chains](#production-chains)
4. [Population & Housing](#population--housing)
5. [Building Costs & Balance](#building-costs--balance)
6. [Tech Progression](#tech-progression)
7. [Future Improvements](#future-improvements)
8. [Balance Tuning Guide](#balance-tuning-guide)

---

## Core Economic Principles

### Design Goals
1. **Resource Scarcity**: Players must make meaningful choices about what to build
2. **Production Chains**: Buildings interconnect to create complex economies
3. **Expansion Cycle**: Gather → Build → Produce → Expand
4. **Population Limits**: Housing caps total population, creating expansion pressure
5. **Worker Assignment**: Production requires workers, creating strategic workforce management

### Economy Flow
```
Starting Resources (Base Camp)
         ↓
    Build Housing (+population)
         ↓
    Build Production Buildings
         ↓
    Assign Workers to Buildings
         ↓
    Resources Produced Over Time
         ↓
    Expand Economy Further
```

### Key Metrics
- **Starting Resources**: Enough to build 3-5 basic buildings
- **Production Rates**: Buildings produce every 15-45 seconds
- **Population Growth**: +3 per Hut, +6 per House
- **Starting Population**: 10 workers (from Base Camp: +15 capacity)

---

## Resource System

### Resource Categories

#### 1. Raw Materials
| Resource | Source | Stack Size | Usage |
|----------|--------|------------|-------|
| Wood Log | Lumberjack, Trees | 50 | Construction, Sawmill input |
| Stone | Quarry | 50 | Construction |
| Coal | Coal Mine | 50 | Smelting fuel |
| Iron Ore | Iron Mine | 50 | Iron production |
| Gold Ore | Gold Mine | 50 | Gold production |
| Granite | Granite Mine | 50 | Advanced construction |

#### 2. Refined Materials
| Resource | Source | Stack Size | Usage |
|----------|--------|------------|-------|
| Wood Plank | Sawmill (from logs) | 50 | Advanced construction |
| Iron Bar | Iron Smelter (ore + coal) | 50 | Tools, weapons |
| Gold Bar | Mint (ore + coal) | 50 | Economy, trade |

#### 3. Food
| Resource | Source | Stack Size | Usage |
|----------|--------|------------|-------|
| Grain | Farm | 100 | Mill input |
| Flour | Mill (from grain) | 100 | Bakery input |
| Bread | Bakery (flour + water) | 100 | Worker consumption |
| Water | Well | 100 | Bakery input, consumption |
| Fish | Fisher | 100 | Worker consumption |
| Meat | Hunter | 100 | Worker consumption |

#### 4. Tools
| Resource | Source | Stack Size | Usage |
|----------|--------|------------|-------|
| Hammer | Tool Smithy | 20 | Builder equipment |
| Axe | Tool Smithy | 20 | Lumberjack equipment |
| Saw | Tool Smithy | 20 | Sawmill equipment |
| Pickaxe | Tool Smithy | 20 | Miner equipment |
| Shovel | Tool Smithy | 20 | Various workers |
| Fishing Rod | Tool Smithy | 20 | Fisher equipment |
| Scythe | Tool Smithy | 20 | Farmer equipment |

#### 5. Weapons
| Resource | Source | Stack Size | Usage |
|----------|--------|------------|-------|
| Sword | Weapon Smithy | 20 | Soldier equipment |
| Shield | Weapon Smithy | 20 | Soldier equipment |
| Bow | Weapon Smithy | 20 | Archer equipment |

### Starting Inventory
```json
{
  "wood_log": 30,        // Build 10 basic buildings
  "wood_plank": 20,      // Build 5 advanced buildings
  "stone": 30,           // Build 15 buildings
  "coal": 10,            // Smelt 10 bars
  "iron_ore": 5,         // Smelt 5 iron bars
  "grain": 10,           // Mill 10 flour
  "water": 5,            // Bake 5 bread
  "fish": 5,             // Feed workers
  "bread": 10,           // Feed workers
  "hammer": 3,           // Equip 3 builders
  "axe": 2,              // Equip 2 lumberjacks
  "saw": 1,              // Equip 1 sawmill
  "pickaxe": 1,          // Equip 1 miner
  "scythe": 1            // Equip 1 farmer
}
```

**Design Rationale**: Players start with enough resources to:
- Build 2-3 production buildings immediately
- Experiment with building placement
- Not feel overwhelmed by scarcity
- Still need to establish production chains quickly

---

## Production Chains

### Primary Chains

#### Wood Chain (Tier 1)
```
Forest/Trees → Lumberjack (20s) → Wood Logs
                                      ↓
                           Sawmill (15s, 1 log) → 2 Wood Planks
```
- **Worker Requirements**: 1 lumberjack, 1 sawmill worker
- **Purpose**: Basic construction material
- **Bottleneck**: Tree proximity to lumberjack

#### Stone Chain (Tier 1)
```
Mountains/Rocks → Quarry (25s) → Stone
```
- **Worker Requirements**: 1 quarry worker
- **Purpose**: Building foundations
- **Bottleneck**: Mountain proximity

#### Food Chain (Tier 1-2)
```
Farm (45s) → Grain → Mill (20s, 1 grain) → 2 Flour
                                              ↓
                              Well (15s) → Water
                                              ↓
                         Bakery (25s, 1 flour + 1 water) → 3 Bread
```
- **Worker Requirements**: 1 farmer, 1 miller, 1 baker, 1 well worker = 4 total
- **Purpose**: Worker sustenance (future feature)
- **Alternative**: Fisher (30s) → Fish (direct consumption)

#### Iron Chain (Tier 2)
```
Iron Mine (35s) → Iron Ore
                     ↓
Coal Mine (30s) → Coal
                     ↓
Iron Smelter (25s, 1 ore + 1 coal) → 1 Iron Bar
                                         ↓
                      Tool Smithy (30s, 1 bar) → 1 Tool
```
- **Worker Requirements**: 2 miners (iron + coal), 1 smelter, 1 smithy = 4 total
- **Purpose**: Tools for specialized workers
- **Bottleneck**: Finding iron and coal deposits

#### Gold Chain (Tier 3)
```
Gold Mine (40s) → Gold Ore
                     ↓
Coal Mine (30s) → Coal
                     ↓
Mint (30s, 1 ore + 1 coal) → 1 Gold Bar
```
- **Worker Requirements**: 2 miners, 1 minter = 3 total
- **Purpose**: Economy, trade (future), military upgrades

### Chain Complexity
- **Tier 1**: Single building (lumberjack, quarry, fisher)
- **Tier 2**: 2-3 buildings (wood → planks, grain → flour → bread)
- **Tier 3**: 3-4 buildings (ore → coal → bars → tools/weapons)

---

## Population & Housing

### Capacity System
| Building | Population Provided | Build Cost |
|----------|-------------------|------------|
| Base Camp | +15 | Free (starting) |
| Hut | +3 | 2 logs, 1 stone |
| House | +6 | 4 planks, 3 stone |

### Population Formula
```
Max Population = Σ(all housing buildings' capacity)
Current Population = Starting workers (10)
Available Workers = Current - Assigned to buildings
```

### Worker Assignment (Future)
When a production building is constructed:
1. Check if workers are available (`Available Workers > 0`)
2. Assign 1 worker to building (if required)
3. Worker walks to building
4. Production begins when worker arrives
5. Building is idle if no worker assigned

### Population Pressure
- **Early Game**: Start with 10/15 population (5 workers available)
- **Mid Game**: Build huts to reach 25-30 population
- **Late Game**: Upgrade to houses for 40+ population
- **Expansion**: Each new production building needs 1 worker → need more housing

---

## Building Costs & Balance

### Residential Buildings
| Building | Cost | Capacity | Cost/Capacity | Upgrade Path |
|----------|------|----------|---------------|--------------|
| Base Camp | Free | +15 | Free | - |
| Hut | 2 logs, 1 stone | +3 | 0.67 logs/pop | → House |
| House | 4 planks, 3 stone | +6 | 0.67 planks/pop | - |

**Balance Notes**:
- Huts use raw logs (cheap, early game)
- Houses use planks (requires sawmill, mid-game)
- Same cost/population ratio maintains balance

### Production Buildings (Tier 1)
| Building | Cost | Output | Production Time | Workers |
|----------|------|--------|----------------|---------|
| Lumberjack | 3 logs, 1 stone | 1 log | 20s | 1 |
| Sawmill | 4 logs, 2 stone | 2 planks (1 log) | 15s | 1 |
| Quarry | 2 logs, 2 stone | 1 stone | 25s | 1 |
| Farm | 3 planks, 2 stone | 2 grain | 45s | 1 |
| Well | 3 stone | 2 water | 15s | 1 |
| Fisher | 2 logs, 1 stone | 1 fish | 30s | 1 |

**Balance Rationale**:
- Basic production (lumberjack, quarry) has low costs
- Processing buildings (sawmill) cost more but multiply output
- Farm has high production time but yields 2 units
- Water is fastest (15s) because it's needed for bakery

### Production Buildings (Tier 2)
| Building | Cost | Output | Production Time | Workers |
|----------|------|--------|----------------|---------|
| Mill | 4 planks, 3 stone | 2 flour (1 grain) | 20s | 1 |
| Bakery | 3 planks, 3 stone | 3 bread (1 flour + 1 water) | 25s | 1 |
| Coal Mine | 4 planks, 4 stone | 1 coal | 30s | 2 |
| Iron Mine | 4 planks, 5 stone | 1 iron ore | 35s | 2 |
| Iron Smelter | 4 planks, 6 stone | 1 iron bar (1 ore + 1 coal) | 25s | 1 |
| Tool Smithy | 4 planks, 4 stone | 1 tool (1 iron bar) | 30s | 1 |

**Balance Rationale**:
- Mines cost more stone (excavation infrastructure)
- Mines require 2 workers (dangerous work)
- Smelter has faster production than mines (bottleneck is ore supply)
- Tool smithy makes 1:1 conversion (tools are valuable)

### Storage Buildings
| Building | Cost | Capacity | Cost/100 Storage |
|----------|------|----------|-----------------|
| Base Camp | Free | 2000 | Free |
| Warehouse | 6 planks, 8 stone | 500 | 1.2 planks, 1.6 stone |
| Storehouse | 4 planks, 4 stone | 200 | 2 planks, 2 stone |

**Balance Notes**:
- Warehouse is more efficient than storehouse (economy of scale)
- Base Camp has massive capacity to start

---

## Tech Progression

### Tier System
Buildings are organized into 3 tiers representing technological advancement:

#### Tier 1: Foundation (Starting Resources Sufficient)
- **Residential**: Hut
- **Production**: Lumberjack, Quarry, Fisher, Farm, Well
- **Infrastructure**: Storehouse
- **Purpose**: Establish basic economy

#### Tier 2: Industry (Requires Tier 1 Production)
- **Residential**: House
- **Production**: Sawmill, Mill, Bakery, Coal Mine, Iron Mine, Iron Smelter, Tool Smithy
- **Infrastructure**: Warehouse
- **Purpose**: Refine resources, create tools

#### Tier 3: Advanced (Future Expansion)
- **Military**: Barracks, Towers, Fortress
- **Production**: Weapon Smithy, Gold Mine, Mint
- **Infrastructure**: Market, Trading Post
- **Purpose**: Military, economy, trade

### Progression Gates
1. **Early Game (0-10 min)**: Build with starting resources, establish wood/stone production
2. **Mid Game (10-30 min)**: Refine resources (planks), build housing, establish food chains
3. **Late Game (30+ min)**: Mining, smelting, tools, weapons, military

### Unlock Requirements (Future Feature)
Consider gating advanced buildings behind prerequisites:
```
Sawmill: Requires 1 Lumberjack built
Mine: Requires 1 Quarry built
Smelter: Requires 1 Mine built
Tool Smithy: Requires 1 Iron Smelter built
```

---

## Future Improvements

### Phase 1: Production System (NEXT)
**Priority: HIGH**
- [ ] Implement actual resource production over time
- [ ] Add worker assignment to buildings
- [ ] Workers walk to assigned buildings
- [ ] Idle workers return to base camp
- [ ] Production halts if no worker assigned
- [ ] Resource delivery system (carriers transport goods to storage)

**Data Changes Needed**:
```typescript
// Add to BuildingInstance in GameData.ts
interface BuildingInstance {
  // ... existing fields
  productionTimer?: number;        // Current production progress (0-1)
  nextProduction?: ResourceType[]; // What will be produced next
  workerAssigned?: number;         // Entity ID of assigned worker
}
```

### Phase 2: Resource Consumption
**Priority: HIGH**
- [ ] Workers consume food (bread, fish, or meat)
- [ ] Buildings require tool maintenance
- [ ] Consumption rate: 1 food per worker per 60s
- [ ] Production stops if workers are hungry
- [ ] Warning UI when food is low

**New System**: Consumption Tracker
```typescript
interface ConsumptionTracker {
  lastFoodConsumption: number;  // Timestamp
  foodConsumptionRate: number;  // Items per second
  hungerLevel: number;          // 0-1 (1 = starving)
}
```

### Phase 3: Pathfinding & Logistics
**Priority: MEDIUM**
- [ ] Carrier units transport resources between buildings
- [ ] Production buildings request inputs from storage
- [ ] Optimize pathfinding for multiple units
- [ ] Road prioritization bonus (faster travel)
- [ ] Building proximity matters (reduce transport time)

### Phase 4: Tech Tree UI
**Priority: MEDIUM**
- [ ] Visual tech tree showing building dependencies
- [ ] Lock advanced buildings until prerequisites met
- [ ] Unlock notifications
- [ ] Research/upgrade system for buildings

### Phase 5: Military System
**Priority: LOW**
- [ ] Soldier units (consume weapons + food)
- [ ] Guard towers (provide defense radius)
- [ ] Enemy units (wildlife, bandits)
- [ ] Territory control mechanics

### Phase 6: Economy & Trade
**Priority: LOW**
- [ ] Market building (trade resources)
- [ ] Dynamic pricing based on supply/demand
- [ ] Trading with AI settlements
- [ ] Economic victory condition

### Phase 7: Advanced Features
- [ ] Building upgrades (Hut → House, etc.)
- [ ] Seasonal effects (winter slows production)
- [ ] Random events (bountiful harvest, plague)
- [ ] Statistics dashboard (production graphs, resource trends)
- [ ] Achievements system

---

## Balance Tuning Guide

### How to Adjust Balance

#### Production Rates
Located in: `src/data/buildings.json`

```json
{
  "production": {
    "outputs": { "wood_log": 1 },
    "productionTime": 20  // ← Adjust this (in seconds)
  }
}
```

**Guidelines**:
- Basic resources (logs, stone): 20-30s
- Processed resources (planks, flour): 15-20s
- Complex resources (iron bars, tools): 25-35s
- Gathering (fish, grain): 30-45s

#### Building Costs
Located in: `src/data/buildings.json`

```json
{
  "buildCost": {
    "wood_log": 3,    // ← Adjust quantities
    "stone": 1
  }
}
```

**Guidelines**:
- Tier 1: 2-4 total resources
- Tier 2: 6-10 total resources
- Tier 3: 10-15 total resources
- Use raw materials (logs) for early buildings
- Use refined (planks) for advanced buildings

#### Starting Resources
Located in: `src/data/game-config.json`

```json
{
  "starting": {
    "baseCamp": {
      "startingResources": {
        "wood_log": 30,  // ← Adjust starting quantities
        "stone": 30
      }
    }
  }
}
```

**Test Formula**:
```
Starting Resources ≥ (3-5 buildings × average cost per building)
```

#### Population Capacity
Located in: `src/data/buildings.json`

```json
{
  "population": {
    "provides": 3  // ← Adjust housing capacity
  }
}
```

**Guidelines**:
- Starting (Base Camp): 15-20
- Basic Housing (Hut): 2-4
- Advanced Housing (House): 5-8
- Keep progression linear: House ≈ 2× Hut

### Playtesting Checklist

When adjusting balance, test:
- [ ] Can player build 3+ buildings with starting resources?
- [ ] Do production chains complete in reasonable time (<5 min)?
- [ ] Does population limit force strategic choices?
- [ ] Are refined resources worth the extra steps?
- [ ] Is there meaningful progression (easy → hard buildings)?

### Common Balance Issues

**Problem**: Player runs out of resources too quickly  
**Solution**: Increase starting resources or decrease building costs

**Problem**: Production is too slow  
**Solution**: Decrease `productionTime` or increase `outputs` quantity

**Problem**: No incentive to build advanced buildings  
**Solution**: Make refined resources more valuable (higher output multipliers)

**Problem**: Population grows too fast  
**Solution**: Increase housing costs or decrease capacity provided

---

## Design Philosophy

### Core Tenets
1. **Player Choice Matters**: Limited resources force strategic building placement
2. **Interconnected Economy**: Buildings depend on each other (chains)
3. **Expansion Pressure**: Population limits push player to expand territory
4. **Visual Feedback**: Players can see workers, resources, production happening
5. **Gradual Complexity**: Start simple (logs, stone), add complexity over time

### Inspiration
- **The Settlers II**: Production chains, worker assignment, visual logistics
- **Anno Series**: Complex economy, balanced resource consumption/production
- **Banished**: Population limits, food consumption, seasonal challenges

### Success Metrics
A well-balanced economy should:
- Require 10-15 minutes to establish basic production
- Force difficult choices (build housing vs. production)
- Reward planning (efficient building placement)
- Create visible activity (workers moving, resources flowing)
- Scale complexity gradually (simple → intermediate → complex)

---

**Next Steps**:
1. Implement production system (buildings generate resources over time)
2. Add worker assignment UI
3. Create resource delivery system (carriers)
4. Add food consumption
5. Build tech tree UI

**Contributors**: Update this document when making balance changes!  
**Changelog**: Document balance changes in git commits for tracking

---

**End of Document**
