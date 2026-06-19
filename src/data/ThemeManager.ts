/**
 * ThemeManager - Singleton that manages active theme and provides patching for definitions/sprites
 */

import { ResourceDefinition, BuildingDefinition, ResourceType, BuildingType } from '@/types/GameData';
import { THEMES, ThemeOverrides } from './themes';

const THEME_STORAGE_KEY = 'settler_active_theme';

export class ThemeManager {
  private static instance: ThemeManager;
  private activeThemeName: string | null = null;
  private activeTheme: ThemeOverrides | null = null;

  // Caches for patched definitions to avoid recreation every frame
  private patchedResources = new Map<ResourceType, ResourceDefinition>();
  private patchedBuildings = new Map<BuildingType, BuildingDefinition>();

  private constructor() {
    this.loadActiveTheme();
  }

  static getInstance(): ThemeManager {
    if (!ThemeManager.instance) {
      ThemeManager.instance = new ThemeManager();
    }
    return ThemeManager.instance;
  }

  /** Load active theme from localStorage */
  private loadActiveTheme(): void {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored && THEMES[stored]) {
        this.activeThemeName = stored;
        this.activeTheme = THEMES[stored];
        console.log(`🎨 Theme loaded: ${stored}`);
      }
    } catch (e) {
      console.warn('Failed to load theme from localStorage:', e);
    }
  }

  /** Check if any theme is currently active */
  isActive(): boolean {
    return this.activeTheme !== null;
  }

  /** Get current active theme name */
  getActiveThemeName(): string | null {
    return this.activeThemeName;
  }

  /**
   * Set active theme and save to localStorage
   * @returns true if theme changed
   */
  setActiveTheme(themeName: string | null): boolean {
    const previousTheme = this.activeThemeName;

    if (themeName === null) {
      this.activeThemeName = null;
      this.activeTheme = null;
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else if (THEMES[themeName]) {
      this.activeThemeName = themeName;
      this.activeTheme = THEMES[themeName];
      localStorage.setItem(THEME_STORAGE_KEY, themeName);
    } else {
      console.warn(`Unknown theme: ${themeName}`);
      return false;
    }

    // Clear caches when theme changes
    this.clearCaches();

    const changed = previousTheme !== this.activeThemeName;
    if (changed) {
      console.log(`🎨 Theme ${themeName ? 'activated' : 'deactivated'}: ${themeName || 'none'}`);
    }

    return changed;
  }

  /** Clear cached patched definitions (call when theme changes) */
  clearCaches(): void {
    this.patchedResources.clear();
    this.patchedBuildings.clear();
  }

  /**
   * Patch a resource definition with theme overrides
   * Returns a shallow copy with overridden properties
   */
  patchResourceDefinition(base: ResourceDefinition): ResourceDefinition {
    if (!this.activeTheme) return base;

    const override = this.activeTheme.resources[base.id as ResourceType];
    if (!override) return base;

    // Return shallow copy with overridden properties
    return {
      ...base,
      ...(override.name && { name: override.name }),
      ...(override.description && { description: override.description }),
      ...(override.icon && { icon: `/assets/resources/${override.icon}` }),
    };
  }

  /**
   * Patch a building definition with theme overrides
   * Returns a shallow copy with overridden properties
   */
  patchBuildingDefinition(base: BuildingDefinition): BuildingDefinition {
    if (!this.activeTheme) return base;

    const override = this.activeTheme.buildings[base.id as BuildingType];
    if (!override) return base;

    // Build patched definition
    const patched: BuildingDefinition = {
      ...base,
      ...(override.name && { name: override.name }),
      ...(override.description && { description: override.description }),
    };

    // Apply requiredTool override (null removes the tool requirement)
    if ('requiredTool' in override) {
      if (override.requiredTool === null) {
        delete patched.requiredTool;
      } else if (override.requiredTool) {
        patched.requiredTool = override.requiredTool;
      }
    }

    // Apply plotType override if present
    if (override.plotType) {
      patched.plotType = override.plotType;
    }

    // Apply production overrides if present
    if (override.production && base.production) {
      patched.production = {
        ...base.production,
        ...(override.production.inputs && { inputs: override.production.inputs }),
        ...(override.production.outputs && { outputs: override.production.outputs }),
      };
    }

    // Apply animation overrides if present
    if (override.animation && base.animation && base.animation.type === 'gather') {
      patched.animation = {
        ...base.animation,
        ...(override.animation.gatherMode && { gatherMode: override.animation.gatherMode as any }),
        ...(override.animation.targetTerrain && { targetTerrain: override.animation.targetTerrain }),
        ...(override.animation.searchRadius !== undefined && { searchRadius: override.animation.searchRadius }),
        ...(override.animation.carriedResource && { carriedResource: override.animation.carriedResource }),
      };
    }

    return patched;
  }

  /**
   * Transform a sprite path based on active theme
   * Replaces building IDs in paths: fisher.png → algae_hut.png
   */
  transformSpritePath(originalPath: string): string {
    if (!this.activeTheme) return originalPath;

    // Match building sprite patterns:
    // /assets/buildings/{buildingId}.png
    // /assets/buildings/{buildingId}_build_N.png
    // /assets/buildings/{buildingId}_prod_N.png
    // Building IDs can contain underscores (e.g., pig_farm), so match everything before _build or _prod
    const buildingMatch = originalPath.match(/\/assets\/buildings\/(.+?)((?:_build_\d+|_prod_\d+)?)\.png$/);
    if (buildingMatch) {
      const buildingId = buildingMatch[1] as BuildingType;
      const suffix = buildingMatch[2]; // e.g., "_build_0" or ""
      const override = this.activeTheme.buildings[buildingId];

      if (override?.spriteBaseName) {
        return `/assets/buildings/${override.spriteBaseName}${suffix}.png`;
      }
    }

    // Match resource icon patterns: /assets/resources/{resourceId}.png
    const resourceMatch = originalPath.match(/\/assets\/resources\/([^/]+)\.png$/);
    if (resourceMatch) {
      const resourceId = resourceMatch[1] as ResourceType;
      const override = this.activeTheme.resources[resourceId];

      if (override?.icon) {
        return `/assets/resources/${override.icon}`;
      }
    }

    // Also handle icon paths from ui/icons directory
    const uiIconMatch = originalPath.match(/\/assets\/ui\/icons\/([^/]+)\.png$/);
    if (uiIconMatch) {
      const resourceId = uiIconMatch[1] as ResourceType;
      const override = this.activeTheme.resources[resourceId];

      if (override?.icon) {
        return `/assets/resources/${override.icon}`;
      }
    }

    return originalPath;
  }
}

// Export singleton instance
export const themeManager = ThemeManager.getInstance();
