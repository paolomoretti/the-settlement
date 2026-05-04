/**
 * Generic code-level debug switch. Keep false in normal play.
 *
 * Enables broad debugging affordances such as full-world navigator reveal.
 */
export const DEBUG = false;

export type RoadRenderingMode = 'vector' | 'classic';

/**
 * Road rendering mode:
 * - 'vector': curved roads with straightened isometric stair runs and matching worker visual paths.
 * - 'classic': original 16-mask tile atlas roads; workers render at their normal tile-interpolated position.
 */
export let ROAD_RENDERING_MODE: RoadRenderingMode = 'vector';

export function setRoadRenderingMode(mode: RoadRenderingMode): void {
  ROAD_RENDERING_MODE = mode;
}

/**
 * Toggle the V2 skeletal worker renderer.
 * When true, all human workers use the new skeleton+actions+tools system.
 * Donkey carriers always use the old renderer regardless of this flag.
 * Default: false (old renderer until Phase 8 cleanup).
 */
export let USE_WORKER_V2 = true;

export function setWorkerV2Mode(enabled: boolean): void {
  USE_WORKER_V2 = enabled;
}
