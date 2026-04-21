/**
 * Core data types for game configuration
 * Based on The Settlers II mechanics
 */

// ============================================================================
// RESOURCES
// ============================================================================

export type ResourceType =
  // Raw Materials
  | 'wood_log'
  | 'wood_plank'
  | 'stone'
  | 'coal'
  | 'iron_ore'
  | 'gold_ore'
  | 'granite'

  // Refined Materials
  | 'iron_bar'
  | 'gold_coin'

  // Food
  | 'grain'
  | 'flour'
  | 'bread'
  | 'water'
  | 'fish'
  | 'meat'
  | 'ham'
  | 'beer'

  // Tools
  | 'hammer'
  | 'axe'
  | 'saw'
  | 'pickaxe'
  | 'shovel'
  | 'fishing_rod'
  | 'scythe'
  | 'rolling_pin'
  | 'crucible'
  | 'tongs'
  | 'cleaver'
  | 'bow'

  // Weapons
  | 'sword'
  | 'shield';

export interface ResourceDefinition {
  id: ResourceType;
  name: string;
  category: 'raw' | 'refined' | 'food' | 'tool' | 'weapon';
  description: string;
  stackSize: number; // Max items per inventory slot
  icon?: string; // Path to icon asset
}

// ============================================================================
// BUILDINGS
// ============================================================================

export type BuildingType =
  // Core Buildings
  | 'base_camp'
  | 'storehouse'

  // Residential
  | 'hut'
  | 'house'

  // Construction Resources
  | 'lumberjack'
  | 'sawmill'
  | 'forester'
  | 'quarry'
  | 'granite_mine'

  // Mining & Smelting
  | 'coal_mine'
  | 'iron_mine'
  | 'gold_mine'
  | 'iron_smelter'
  | 'mint'

  // Industry
  | 'metalworks'
  | 'armory'

  // Food Production
  | 'farm'
  | 'mill'
  | 'bakery'
  | 'brewery'
  | 'well'
  | 'fisher'
  | 'hunter'
  | 'pig_farm'
  | 'slaughterhouse'

  // Military
  | 'barracks'
  | 'guardhouse'
  | 'watchtower'
  | 'fortress'
  | 'catapult'
  | 'lookout_tower'

  // Transport
  | 'donkey_breeder'
  | 'shipyard'
  | 'harbor'

  // Infrastructure
  | 'road';

export interface BuildingCost {
  [resourceType: string]: number;
}

export interface ProductionRule {
  // What the building produces
  outputs: {
    [resourceType: string]: number;
  };
  // What it consumes to produce (optional)
  inputs?: {
    [resourceType: string]: number;
  };
  // Production time in seconds
  productionTime: number;
  // Can it produce continuously or one-time?
  continuous: boolean;
  // Max items the building can buffer before pickup (default 10)
  maxOutputBuffer?: number;
}

export type AnimationConfig =
  | {
      type: 'gather';
      targetTerrain: string[];
      searchRadius: number;
      terrainTransition: Record<string, string>;
      workerSpeed: number;
    }
  | {
      /** Persistent operator: idles left of the well, works at an adjacent tile in the last part of each cycle. */
      type: 'well_operator';
      workerSpeed: number;
      drawingPhaseSec: number;
      walkLeadSec?: number;
    };

export interface BuildingDefinition {
  id: BuildingType;
  name: string;
  description: string;

  // Physical properties
  size: {
    width: number;   // Tiles wide
    height: number;  // Tiles deep
  };

  // Visual properties
  visual: {
    buildingHeight: number; // Pixels above ground (for rendering)
    color: string;          // Base color (until sprites loaded)
    sprite?: string;        // Path to sprite asset
    /** Optional multiplier for the footprint-fitted sprite (default 1). Anchored at footprint bottom center. */
    spriteScale?: number;
  };

  // Construction
  buildCost: BuildingCost;
  buildTime: number; // Seconds to construct
  requiresRoad: boolean; // Must be connected to road network

  // Production (if applicable)
  production?: ProductionRule;

  // Storage (if applicable)
  storage?: {
    capacity: number; // Total item slots
    accepts?: ResourceType[]; // Which resources (undefined = all)
  };

  // Population
  population?: {
    provides?: number;  // Housing: adds to max population
    requires?: number;  // Workers: needs this many workers to operate
  };

  // Worker requirements
  requiredTool?: ResourceType; // Tool the worker needs to operate this building

  // Production animation (worker leaves building during production cycle)
  animation?: AnimationConfig;

  // Special flags
  isHeadquarters?: boolean; // Starting building
  canUpgrade?: BuildingType; // Can upgrade to this type

  // Metadata
  category: 'core' | 'residential' | 'production' | 'military' | 'infrastructure';
  tier: 1 | 2 | 3; // Tech tier
  plotType?: 'small' | 'medium' | 'large' | 'mine'; // Terrain placement type (future)

  // Military (for military buildings)
  military?: {
    soldierCapacity: number; // Max soldiers garrisoned
  };
}

// ============================================================================
// GAME CONFIGURATION
// ============================================================================

export interface GameConfig {
  // Starting conditions
  starting: {
    baseCamp: {
      position: { x: number; y: number } | 'center';
      startingResources: BuildingCost;
      startingPopulation: number;
    };
    exploration: {
      initialRadius: number; // Tiles to explore at start
    };
  };

  // Population
  population: {
    maxPerHut: number;
    maxPerHouse: number;
    workerWalkSpeed: number; // Tiles per second
  };

  // Economy
  economy: {
    baseProductionRate: number; // Multiplier for all production
    storageWarningThreshold: number; // % full before warning
  };

  // World
  world: {
    mapSize: { width: number; height: number };
    seed?: number;
  };
}

// ============================================================================
// GAME STATE (Runtime)
// ============================================================================

export interface Inventory {
  [resourceType: string]: number;
}

export interface BuildingInstance {
  entityId: number; // Link to ECS entity
  type: BuildingType;
  position: { x: number; y: number };

  // State
  constructionProgress: number; // 0-1, 1 = complete
  isOperational: boolean;

  // Production state
  productionProgress?: number; // 0-1 for current production cycle
  assignedWorkers?: number;

  // Inventory (for storage buildings)
  inventory?: Inventory;
}

export interface GameState {
  // Resources
  inventory: Inventory; // Global inventory (in headquarters/warehouses)

  // Population
  population: {
    current: number;
    max: number;
    workers: {
      idle: number;
      assigned: number;
    };
  };

  // Buildings
  buildings: BuildingInstance[];

  // Statistics
  stats: {
    buildingsConstructed: number;
    resourcesGathered: Inventory;
    timeElapsed: number; // Seconds
  };
}
