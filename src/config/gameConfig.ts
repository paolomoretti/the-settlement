import type { GameConfig, WorkerAmbientSoundConfig } from '@/types/GameData';

/**
 * Central gameplay tuning values.
 *
 * Keep values here when they are global balance knobs rather than content data.
 * Content definitions such as individual buildings/resources still live in JSON.
 */
/**
 * Per-worker-role ambient sounds played periodically while the worker is active and visible on screen.
 * Keys match the role identifiers used in `updateWorkerAmbientSounds` (e.g. 'surveyor').
 */
export const WORKER_AMBIENT_SOUNDS: Record<string, WorkerAmbientSoundConfig> = {
  surveyor: { src: '/audio/surveyor.mp3', intervalSec: 15 },
};

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
    // Base terrain: forest blobs + scattered trees (`TileMap.generateTerrain`).
    // Previous sparse defaults (~0.6 / 0.2 / 0.65) were tuned down in one pass; these
    // values bring roughly 2×+ more forest + lone trees while staying clustered.
    terrain: {
      forestDensityMin: 0.38,
      forestTreePlacementMin: 0.17,
      scatteredTreePlacementMin: 0.42,
      // Fair start: reachable wood near HQ (new worlds only; see TileMap.ensureStarterTreesNearHq).
      hqMinTreeCellsNearHq: 10,
      hqStarterForestSearchRadius: 48,
    },
  },

  enemyRealms: {
    // Number of rival villages placed during new-world generation.
    villageCount: 10,
    // Square village patch side length in map cells. Distant villages interpolate toward max.
    minVillageSize: 28,
    maxVillageSize: 56,
    // Minimum empty padding, in map cells, between enemy village patches.
    minSpacingBetweenVillages: 12,
    // Per planned village index. The first nearby red village is a passive neighbor.
    aggressivenessByVillageIndex: [0, 1, 1, 2, 2, 3, 4, 4, 5, 5],
    // TEMP DEBUG: set to 5 to force every enemy realm, including existing saves, to maximum aggression.
    // Keep null for normal play so the nearby red realm stays passive.
    debugAggressivenessOverride: null,
    attacks: {
      enabled: true,
      // Chebyshev distance in map cells from an enemy military building to a player target.
      maxRangeCells: 50,
      // Scheduler cadence; attacks still use the longer per-level cooldowns below.
      checkIntervalMs: 5_000,
      // First possible attack after borders touch. Level 0 never attacks.
      firstAttackDelayMsByAggressiveness: {
        0: 10_000,
        1: 240_000,
        2: 210_000,
        3: 180_000,
        4: 150_000,
        5: 120_000,
      },
      // Delay after each attack attempt, successful or not. Higher levels pressure more often.
      cooldownMsByAggressiveness: {
        0: Number.POSITIVE_INFINITY,
        1: 360_000,
        2: 300_000,
        3: 240_000,
        4: 180_000,
        5: 150_000,
      },
      // Maximum soldiers sent in one raid.
      maxAttackersByAggressiveness: {
        0: 0,
        1: 1,
        2: 2,
        3: 3,
        4: 4,
        5: 5,
      },
      // Enemy realms do not run a full economy yet, so bordering realms slowly refill forts.
      garrisonReinforceIntervalMs: 45_000,
      garrisonReinforceCount: 1,
    },
    roadMaintenance: {
      enabled: true,
      // Active, visible enemy realms repair disconnected buildings at this cadence.
      intervalMs: 30_000,
      // Keep each tick bounded so road healing cannot spike on large villages.
      maxRepairsPerTick: 3,
      // At most one new military support building per maintenance tick.
      maxForwardBarracksPerTick: 1,
      // Ignore very long repairs; those usually mean territory moved too far or a road would cross a border.
      maxPathCells: 80,
      // Search radius, in cells, around an isolated conquered military post for a support barracks.
      forwardBarracksSearchRadius: 18,
    },
  },
} satisfies GameConfig;
