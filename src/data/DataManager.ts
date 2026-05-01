/**
 * DataManager - Central registry for all game data
 * Loads and manages resources, buildings, and game configuration
 */

import {
  ResourceType,
  ResourceDefinition,
  BuildingType,
  BuildingDefinition,
  GameConfig,
} from '@/types/GameData';

import resourcesData from './resources.json';
import buildingsData from './buildings.json';
import { GAME_CONFIG } from '@/config/gameConfig';
import { themeManager } from './ThemeManager';

export class DataManager {
  private static instance: DataManager;

  private resources: Map<ResourceType, ResourceDefinition> = new Map();
  private buildings: Map<BuildingType, BuildingDefinition> = new Map();
  private gameConfig!: GameConfig;

  // Theme-patched definition caches
  private themedResources: Map<ResourceType, ResourceDefinition> = new Map();
  private themedBuildings: Map<BuildingType, BuildingDefinition> = new Map();

  private constructor() {
    this.loadData();
  }

  static getInstance(): DataManager {
    if (!DataManager.instance) {
      DataManager.instance = new DataManager();
    }
    return DataManager.instance;
  }

  private loadData(): void {
    // Load resources
    Object.values(resourcesData).forEach((resource: any) => {
      this.resources.set(resource.id as ResourceType, resource as ResourceDefinition);
    });

    // Load buildings
    Object.values(buildingsData).forEach((building: any) => {
      this.buildings.set(building.id as BuildingType, building as BuildingDefinition);
    });

    // Load central gameplay tuning config
    this.gameConfig = GAME_CONFIG;

    console.log(
      `📊 Data loaded: ${this.resources.size} resources, ${this.buildings.size} buildings`
    );
  }

  // ========================================================================
  // RESOURCES
  // ========================================================================

  getResource(id: ResourceType): ResourceDefinition | undefined {
    // If theme is active, check themed cache first
    if (themeManager.isActive()) {
      const cached = this.themedResources.get(id);
      if (cached) return cached;

      // Patch base definition and cache result
      const base = this.resources.get(id);
      if (base) {
        const patched = themeManager.patchResourceDefinition(base);
        this.themedResources.set(id, patched);
        return patched;
      }
      return undefined;
    }

    // No theme active, return base definition
    return this.resources.get(id);
  }

  getAllResources(): ResourceDefinition[] {
    const ids = Array.from(this.resources.keys());
    return ids.map(id => this.getResource(id)).filter((r): r is ResourceDefinition => r !== undefined);
  }

  getResourcesByCategory(
    category: 'raw' | 'refined' | 'food' | 'tool' | 'weapon'
  ): ResourceDefinition[] {
    return this.getAllResources().filter(r => r.category === category);
  }

  // ========================================================================
  // BUILDINGS
  // ========================================================================

  getBuilding(id: BuildingType): BuildingDefinition | undefined {
    // If theme is active, check themed cache first
    if (themeManager.isActive()) {
      const cached = this.themedBuildings.get(id);
      if (cached) return cached;

      // Patch base definition and cache result
      const base = this.buildings.get(id);
      if (base) {
        const patched = themeManager.patchBuildingDefinition(base);
        this.themedBuildings.set(id, patched);
        return patched;
      }
      return undefined;
    }

    // No theme active, return base definition
    return this.buildings.get(id);
  }

  getAllBuildings(): BuildingDefinition[] {
    const ids = Array.from(this.buildings.keys());
    return ids.map(id => this.getBuilding(id)).filter((b): b is BuildingDefinition => b !== undefined);
  }

  getBuildingsByCategory(
    category: 'core' | 'residential' | 'production' | 'military' | 'infrastructure'
  ): BuildingDefinition[] {
    return this.getAllBuildings().filter(b => b.category === category);
  }

  getBuildingsByTier(tier: 1 | 2 | 3): BuildingDefinition[] {
    return this.getAllBuildings().filter(b => b.tier === tier);
  }

  // Check if player can afford to build
  canAfford(buildingType: BuildingType, inventory: { [key: string]: number }): boolean {
    const building = this.getBuilding(buildingType);
    if (!building) return false;

    for (const [resource, amount] of Object.entries(building.buildCost)) {
      if ((inventory[resource] || 0) < amount) {
        return false;
      }
    }

    return true;
  }

  // Get missing resources for a building
  getMissingResources(
    buildingType: BuildingType,
    inventory: { [key: string]: number }
  ): { [key: string]: number } {
    const building = this.getBuilding(buildingType);
    if (!building) return {};

    const missing: { [key: string]: number } = {};

    for (const [resource, required] of Object.entries(building.buildCost)) {
      const available = inventory[resource] || 0;
      if (available < required) {
        missing[resource] = required - available;
      }
    }

    return missing;
  }

  // ========================================================================
  // GAME CONFIG
  // ========================================================================

  getGameConfig(): GameConfig {
    return this.gameConfig;
  }

  getStartingResources(): { [key: string]: number } {
    return this.gameConfig.starting.baseCamp.startingResources;
  }

  getStartingPopulation(): number {
    return this.gameConfig.starting.baseCamp.startingPopulation;
  }

  // ========================================================================
  // UTILITY
  // ========================================================================

  // Validate that all building costs reference valid resources
  validateData(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check building costs
    this.getAllBuildings().forEach(building => {
      Object.keys(building.buildCost).forEach(resourceId => {
        if (!this.resources.has(resourceId as ResourceType)) {
          errors.push(`Building ${building.id} references unknown resource: ${resourceId}`);
        }
      });

      // Check production inputs/outputs
      if (building.production) {
        if (building.production.inputs) {
          Object.keys(building.production.inputs).forEach(resourceId => {
            if (!this.resources.has(resourceId as ResourceType)) {
              errors.push(
                `Building ${building.id} production inputs reference unknown resource: ${resourceId}`
              );
            }
          });
        }
        if (building.production.inputsAny) {
          for (const g of building.production.inputsAny) {
            for (const resourceId of g.resourceTypes) {
              if (!this.resources.has(resourceId)) {
                errors.push(
                  `Building ${building.id} production inputsAny references unknown resource: ${resourceId}`
                );
              }
            }
          }
        }

        Object.keys(building.production.outputs).forEach(resourceId => {
          if (!this.resources.has(resourceId as ResourceType)) {
            errors.push(
              `Building ${building.id} production outputs reference unknown resource: ${resourceId}`
            );
          }
        });
      }
    });

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // Get a formatted display string for resource costs
  formatCost(cost: { [key: string]: number }): string {
    return Object.entries(cost)
      .map(([resourceId, amount]) => {
        const resource = this.getResource(resourceId as ResourceType);
        return `${resource?.name || resourceId}: ${amount}`;
      })
      .join(', ');
  }

  // Calculate total storage capacity across all storage buildings
  calculateTotalStorage(buildings: BuildingDefinition[]): number {
    return buildings.reduce((total, building) => {
      return total + (building.storage?.capacity || 0);
    }, 0);
  }

  // Calculate total population capacity
  calculatePopulationCapacity(buildings: BuildingDefinition[]): number {
    return buildings.reduce((total, building) => {
      return total + (building.population?.provides || 0);
    }, 0);
  }

  // ========================================================================
  // THEME SUPPORT
  // ========================================================================

  /** Clear cached themed definitions (call when theme changes) */
  invalidateThemedCaches(): void {
    this.themedResources.clear();
    this.themedBuildings.clear();
  }
}

// Export singleton instance
export const dataManager = DataManager.getInstance();
