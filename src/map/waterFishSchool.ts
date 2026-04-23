/**
 * Deterministic per-water-cell fish caps (5–15) for lake-wide stock (see {@link ./TileMap} cluster logic).
 */

export const WATER_FISH_SCHOOL_MIN = 5;
export const WATER_FISH_SCHOOL_MAX = 15;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function waterFishCellSeed(mapSeed: number, x: number, y: number): number {
  return (mapSeed ^ (x * 374761393) ^ (y * 668265263)) | 0;
}

/** Deterministic per-cell cap roll (5–15); used when building a lake-wide cluster budget. */
export function rollWaterFishSchoolMax(mapSeed: number, x: number, y: number): number {
  const rng = mulberry32(waterFishCellSeed(mapSeed, x, y));
  return WATER_FISH_SCHOOL_MIN + Math.floor(rng() * (WATER_FISH_SCHOOL_MAX - WATER_FISH_SCHOOL_MIN + 1));
}
