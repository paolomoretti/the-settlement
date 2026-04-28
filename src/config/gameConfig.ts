import type { GameConfig } from '@/types/GameData';

/**
 * Central gameplay tuning values.
 *
 * Keep values here when they are global balance knobs rather than content data.
 * Content definitions such as individual buildings/resources still live in JSON.
 */
export const GAME_CONFIG = {
  starting: {
    baseCamp: {
      position: 'center',
      startingResources: {
        wood_plank: 48,
        stone: 48,
        wood_log: 20,
        coal: 16,
        iron_ore: 8,
        iron_bar: 8,
        gold_ore: 4,
        grain: 16,
        water: 8,
        fish: 12,
        bread: 16,
        ham: 8,
        beer: 8,
        axe: 6,
        saw: 4,
        pickaxe: 8,
        shovel: 4,
        fishing_rod: 4,
        scythe: 4,
        hammer: 4,
        rolling_pin: 2,
        crucible: 2,
        tongs: 2,
        cleaver: 2,
        bow: 2,
        sword: 5,
        shield: 5,
      },
      startingPopulation: 100,
    },
    exploration: {
      // Chebyshev radius, in map cells, from the center of each headquarters.
      // This defines the starting settlement boundary; 12 is about half the old 25-cell reach.
      initialRadius: 12,
    },
  },

  population: {
    maxPerHut: 3,
    maxPerHouse: 6,
    workerWalkSpeed: 2,
  },

  economy: {
    baseProductionRate: 1.0,
    storageWarningThreshold: 0.8,
  },

  world: {
    mapSize: {
      width: 1000,
      height: 1000,
    },
  },
} satisfies GameConfig;
