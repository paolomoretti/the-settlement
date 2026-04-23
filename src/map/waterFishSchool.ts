/**
 * Lazy fish schools on water tiles (similar spirit to {@link ./CellMinerals}).
 * Each school has a deterministic max (5–15) per cell; remaining catches decrement with fishing.
 */

import type { Tile } from './Tile';

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

function rollSchoolMax(mapSeed: number, x: number, y: number): number {
  const rng = mulberry32(waterFishCellSeed(mapSeed, x, y));
  return WATER_FISH_SCHOOL_MIN + Math.floor(rng() * (WATER_FISH_SCHOOL_MAX - WATER_FISH_SCHOOL_MIN + 1));
}

/** Assign max + remaining once per water tile; idempotent if already assigned. */
export function ensureWaterFishSchool(tile: Tile, mapSeed: number, x: number, y: number): void {
  if (tile.terrain !== 'water') return;
  if (tile.waterFishSchoolMax !== undefined) return;
  const cap = rollSchoolMax(mapSeed, x, y);
  tile.waterFishSchoolMax = cap;
  if (tile.waterFishRemaining === undefined) {
    tile.waterFishRemaining = cap;
  } else {
    tile.waterFishRemaining = Math.min(cap, Math.max(0, tile.waterFishRemaining));
  }
}

export function getWaterFishSchoolMax(tile: Tile, mapSeed: number, x: number, y: number): number {
  ensureWaterFishSchool(tile, mapSeed, x, y);
  return tile.waterFishSchoolMax ?? WATER_FISH_SCHOOL_MAX;
}

export function getWaterFishRemaining(tile: Tile, mapSeed: number, x: number, y: number): number {
  ensureWaterFishSchool(tile, mapSeed, x, y);
  return tile.waterFishRemaining ?? 0;
}

/** Returns false if there was nothing left to take. */
export function takeOneFishFromSchool(tile: Tile, mapSeed: number, x: number, y: number): boolean {
  ensureWaterFishSchool(tile, mapSeed, x, y);
  let rem = tile.waterFishRemaining ?? 0;
  if (rem <= 0) return false;
  rem--;
  tile.waterFishRemaining = rem;
  return true;
}

/** Regen tick: +1 fish up to the school cap (only tiles that already have a school record). */
export function regenWaterFishOne(tile: Tile): void {
  if (tile.terrain !== 'water') return;
  if (tile.waterFishSchoolMax === undefined) return;
  const cap = tile.waterFishSchoolMax;
  const r = tile.waterFishRemaining ?? 0;
  tile.waterFishRemaining = Math.min(cap, r + 1);
}
