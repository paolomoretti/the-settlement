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
  /** Forester / terrain: not stockpiled; applied to the map instead. */
  | 'planted_tree'

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
  | 'soy'
  | 'tofu'
  | 'beer'
  | 'donkey'

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
  /** If true, production never buffers this or requests transport; game handles the effect. */
  virtualOutput?: boolean;
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
  | 'lookout_tower'

  // Transport
  | 'donkey_breeder'

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
  /**
   * Each entry: need `amount` units in total per cycle from **any** of the listed resources
   * (e.g. miners fed by bread **or** ham **or** fish). Independent of `inputs` (AND across groups).
   */
  inputsAny?: Array<{ resourceTypes: ResourceType[]; amount: number }>;
  // Production time in seconds
  productionTime: number;
  // Can it produce continuously or one-time?
  continuous: boolean;
  /**
   * `all` buffers every listed output each cycle.
   * `weighted_random` picks one listed output per cycle using settlement priorities.
   */
  outputMode?: 'all' | 'weighted_random';
  // Max items the building can buffer before pickup (default 10)
  maxOutputBuffer?: number;
  /** Max Manhattan distance from building entrance to search for gather sources (trees, rock, water). */
  maxGatherRadius?: number;
  /** Max off-road path steps from entrance to a source tile; candidates with longer paths are skipped. Defaults to `maxGatherRadius` or animation `searchRadius`. */
  maxGatherWalkCells?: number;
  /** Harvests left per rock tile before terrain clears (quarry `rock_depletion` gather). */
  stonesPerRockTile?: number;
  /**
   * Legacy JSON field; fish schools now use lazy per-tile caps (5–15) from the map seed.
   * Ignored by runtime if omitted.
   */
  fishPerWaterTile?: number;
}

export type AnimationConfig =
  | {
      type: 'gather';
      targetTerrain: string[];
      searchRadius: number;
      terrainTransition: Record<string, string>;
      workerSpeed: number;
      /** Lumberjack-style single chop vs quarry-style timed dig + partial tile depletion. */
      /** `mine_site`: walk to a dig tile in front of the mine, pickaxe at ground, return with ore (no terrain change). */
      gatherMode?:
        | 'tree'
        | 'rock_depletion'
        | 'water_depletion'
        | 'mine_site'
        | 'wild_hunt'
        | 'forest_forage';
      /** With `walkLeadSec` + `digAtSiteSec`: worker departs late in the cycle (like forester). */
      walkLeadSec?: number;
      digAtSiteSec?: number;
      /** Resource sprite while carrying back (defaults to `wood_log` for tree gather). */
      carriedResource?: ResourceType;
    }
  | {
      /** Persistent operator: idles left of the well, works at an adjacent tile in the last part of each cycle. */
      type: 'well_operator';
      workerSpeed: number;
      drawingPhaseSec: number;
      walkLeadSec?: number;
    }
  | {
      /**
       * Indoor workshop operator: HQ delivery, door approach, then concealed inside the footprint
       * until demolition. Use for staffed buildings that have no required tool and no custom site
       * animation (`gather`, `well_operator`, `plant_tree`).
       */
      type: 'interior_operator';
      /** Worker spec id (usually same as building id): drives outfit and future upgrades; tied 1:1 to this building type. */
      operatorRole: string;
      workerSpeed: number;
      drawingPhaseSec: number;
      walkLeadSec?: number;
    }
  | {
      /** Forester: walk to a reserved grass tile, dig, return; tree appears after digging. */
      type: 'plant_tree';
      searchRadius: number;
      workerSpeed: number;
      /** Seconds before cycle end to start walking to the plant site (must fit walk + dig before pause lifts). */
      walkLeadSec: number;
      /** Seconds at the site with shovel before the tree is placed and the worker returns. */
      digAtSiteSec: number;
    };

/** Ambient sound emitted periodically while a worker from this building is active and on-screen. */
export interface WorkerAmbientSoundConfig {
  /** Path to the audio file (e.g. '/audio/surveyor.mp3'). */
  src: string;
  /** Minimum seconds between plays of this sound. */
  intervalSec: number;
}

/** Optional chimney smoke (offsets in building-local sprite space; see RenderSystem building anchor). */
export interface ChimneySmokeConfig {
  /** Optional schedule that overrides production-based gating. */
  schedule?: {
    /** Full cycle length in seconds (e.g. 30 = repeats every 30s). */
    everySec: number;
    /** Emit time per cycle in seconds (e.g. 5 = smoke for 5s, then pause). */
    onSec: number;
    /** Optional phase shift in seconds for staggering identical buildings. */
    phaseOffsetSec?: number;
  };
  /** Horizontal offset from the building render origin (pixels). */
  offsetX: number;
  /** Vertical offset from the building render origin (pixels, down = positive). */
  offsetY: number;
  /** Emission strength 0–3 (default 1). */
  density?: number;
  /**
   * Smoke colour shade, 1–5 (default 3).
   *   1 = white / steam
   *   2 = light grey
   *   3 = medium grey  (default)
   *   4 = dark grey
   *   5 = near-black / sooty coal
   */
  shade?: number;
  /**
   * Emitter lifetime in seconds (default: unlimited).
   * In-game, emission is still gated by production (`producing`); omit for smoke only while the furnace runs.
   */
  duration?: number;
}

export interface BuildingDefinition {
  id: BuildingType;
  name: string;
  description: string;

  // Physical properties
  size: {
    width: number; // Tiles wide
    height: number; // Tiles deep
  };

  // Visual properties
  visual: {
    buildingHeight: number; // Pixels above ground (for rendering)
    color: string; // Base color (until sprites loaded)
    sprite?: string; // Path to sprite asset
    /** Optional multiplier for the footprint-fitted sprite (default 1). Anchored at footprint bottom center. */
    spriteScale?: number;
    /** Optional screen-space nudge for the sprite (pixels); may be negative. */
    offsetX?: number;
    offsetY?: number;
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
    provides?: number; // Housing: adds to max population
    requires?: number; // Workers: needs this many workers to operate
  };

  // Worker requirements
  requiredTool?: ResourceType; // Tool the worker needs to operate this building

  /**
   * Map worker behaviour for staffed production buildings.
   * Omit only when the building has no `population.requires` worker, or when no timed production exists yet.
   * If `population.requires` and `production` exist but `animation` is omitted, the game synthesizes
   * `interior_operator` at runtime (see `.claude/BUILDING_WORKERS.md`).
   */
  animation?: AnimationConfig;

  // Special flags
  isHeadquarters?: boolean; // Starting building
  canUpgrade?: BuildingType; // Can upgrade to this type

  // Metadata
  category: 'core' | 'residential' | 'production' | 'military' | 'infrastructure';
  tier: 1 | 2 | 3; // Tech tier
  plotType?: 'small' | 'medium' | 'large' | 'mine'; // Terrain placement type (future)

  /**
   * Fog-of-war reveal radius (Chebyshev cells from building center) applied continuously while
   * a staffed operator is inside. Does NOT expand territory ownership — only lifts the fog
   * beyond the current settlement boundary. Intended for the Lookout Tower.
   */
  fogRevealRadius?: number;

  // Military (for military buildings)
  military?: {
    soldierCapacity?: number; // Max soldiers garrisoned
    /** Chebyshev radius from footprint center; expands settlement disks when the building is complete. */
    territoryVisionRadius?: number;
  };

  /** Retro chimney smoke while `Production.status === 'producing'` (when building has Production). */
  chimneySmoke?: ChimneySmokeConfig;

  /**
   * Ambient sound played periodically while a building-assigned animation worker is active and visible.
   * Leave undefined for buildings with no bespoke worker sound.
   */
  ambientSound?: WorkerAmbientSoundConfig;
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
      initialRadius: number; // Chebyshev radius in map cells from each headquarters center
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

  enemyRealms: {
    /** Number of enemy villages planned when creating a new world. */
    villageCount: number;
    /** Square village patch side length in map cells for the nearest enemy. */
    minVillageSize: number;
    /** Maximum square village patch side length in map cells for distant enemies. */
    maxVillageSize: number;
    /** Empty map-cell padding enforced between planned enemy village patches. */
    minSpacingBetweenVillages: number;
    /** Aggressiveness per planned village index; index 0 is the nearby starter enemy. */
    aggressivenessByVillageIndex: number[];
    /** Temporary debug override for all realms, including existing saves. Use null for normal behavior. */
    debugAggressivenessOverride: number | null;
    attacks: {
      enabled: boolean;
      /** Maximum Chebyshev distance, in map cells, from source fort to target fort. */
      maxRangeCells: number;
      /** How often the enemy border-pressure scheduler wakes up. */
      checkIntervalMs: number;
      /** First possible attack delay after border contact, indexed by aggressiveness level. */
      firstAttackDelayMsByAggressiveness: Record<number, number>;
      /** Cooldown after an attack attempt, indexed by aggressiveness level. */
      cooldownMsByAggressiveness: Record<number, number>;
      /** Maximum soldiers committed to one attack, indexed by aggressiveness level. */
      maxAttackersByAggressiveness: Record<number, number>;
      /** How often an enemy realm can add replacement soldiers to its military buildings. */
      garrisonReinforceIntervalMs: number;
      /** Replacement soldiers added per reinforcement tick while borders touch. */
      garrisonReinforceCount: number;
    };
    roadMaintenance: {
      enabled: boolean;
      /** How often active, visible enemy realms try to reconnect stranded buildings. */
      intervalMs: number;
      /** Maximum disconnected buildings repaired across all enemy realms per tick. */
      maxRepairsPerTick: number;
      /** Maximum forward barracks created across all enemy realms per tick. */
      maxForwardBarracksPerTick: number;
      /** Safety cap for generated repair road length in cells. */
      maxPathCells: number;
      /** Candidate search radius around an isolated military post when placing a forward barracks. */
      forwardBarracksSearchRadius: number;
    };
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
