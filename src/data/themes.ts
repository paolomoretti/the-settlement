/**
 * Theme override definitions for cosmetic game variations (vegan mode, etc.)
 * Themes patch building/resource names, descriptions, and sprite paths without affecting gameplay.
 */

import { ResourceType, BuildingType } from '@/types/GameData';

/** Override configuration for a single resource */
export interface ResourceThemeOverride {
  name?: string;
  description?: string;
  /** Icon filename (e.g., 'algae.png' instead of 'fish.png') */
  icon?: string;
}

/** Override configuration for a single building */
export interface BuildingThemeOverride {
  name?: string;
  description?: string;
  /** Base name for sprite files (e.g., 'algae_hut' transforms fisher.png → algae_hut.png) */
  spriteBaseName?: string;
  /** Override production inputs/outputs */
  production?: {
    inputs?: Partial<Record<ResourceType, number>>;
    outputs?: Partial<Record<ResourceType, number>>;
  };
  /** Override animation configuration (for gather behavior) */
  animation?: {
    gatherMode?: string;
    targetTerrain?: string[];
    searchRadius?: number;
  };
  /** Override required tool (set to undefined to remove tool requirement) */
  requiredTool?: ResourceType | null;
  /** Override plot type preference (where building likes to be placed) */
  plotType?: 'small' | 'medium' | 'large' | 'mine';
}

/** Complete theme override configuration */
export interface ThemeOverrides {
  resources: Partial<Record<ResourceType, ResourceThemeOverride>>;
  buildings: Partial<Record<BuildingType, BuildingThemeOverride>>;
}

/** Vegan mode theme: replaces meat/animal content with plant-based alternatives */
export const VeganTheme: ThemeOverrides = {
  resources: {
    fish: {
      name: 'Algae',
      icon: 'algae.png',
    },
    ham: {
      name: 'Mushrooms',
      icon: 'mushrooms.png',
    },
    meat: {
      name: 'Tofu',
      icon: 'tofu.png',
    },
  },
  buildings: {
    fisher: {
      name: 'Algae Hut',
      description: 'Harvests algae from ponds and lakes.',
      spriteBaseName: 'algae_hut',
      production: {
        outputs: { fish: 1 }, // Still uses 'fish' internally, displays as 'algae'
      },
    },
    hunter: {
      name: 'Gatherer',
      description: 'Forages mushrooms from the forest. Works best near trees.',
      spriteBaseName: 'gatherer',
      requiredTool: null, // No tool needed - just picks mushrooms by hand
      production: {
        outputs: { ham: 1 }, // Still uses 'ham' internally, displays as 'mushrooms'
      },
      animation: {
        gatherMode: 'forest_forage', // Never runs out, as long as trees exist
        targetTerrain: ['grass', 'forest'], // Search for forest areas
        searchRadius: 16, // Keep same search radius
      },
    },
    pig_farm: {
      name: 'Soy Farm',
      description: 'Cultivates soybeans for processing.',
      spriteBaseName: 'soy_farm',
      production: {
        inputs: { water: 1 }, // Remove grain requirement
        outputs: { soy: 1 }, // Output soy instead of meat
      },
    },
    slaughterhouse: {
      name: 'Soy Factory',
      description: 'Processes soybeans into tofu.',
      spriteBaseName: 'soy_factory',
      production: {
        inputs: { soy: 1 }, // Input soy instead of meat
        outputs: { tofu: 1 }, // Output tofu (new resource)
      },
    },
  },
};

/** Registry of all available themes */
export const THEMES: Record<string, ThemeOverrides> = {
  vegan: VeganTheme,
};
