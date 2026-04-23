/**
 * Underground ore deposits per cell (lazy-assigned). Total units per cell = 10.
 */

import type { ResourceType } from '@/types/GameData';

export type OreVeinKey = 'coal' | 'iron_ore' | 'gold_ore' | 'granite';

export interface CellMinerals {
  coal: number;
  iron_ore: number;
  gold_ore: number;
  granite: number;
}

const ORE_KEYS: OreVeinKey[] = ['coal', 'iron_ore', 'gold_ore', 'granite'];

/** Tie-break order for dominant icon (first wins on equal count). */
const DOMINANT_PRIORITY: OreVeinKey[] = ['gold_ore', 'iron_ore', 'coal', 'granite'];

export function emptyCellMinerals(): CellMinerals {
  return { coal: 0, iron_ore: 0, gold_ore: 0, granite: 0 };
}

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

/** Roll exactly 10 units split across the four ore types (deterministic from seed). */
export function rollCellMinerals(seed: number): CellMinerals {
  const rng = mulberry32(seed);
  const m = emptyCellMinerals();
  for (let i = 0; i < 10; i++) {
    const pick = ORE_KEYS[Math.floor(rng() * ORE_KEYS.length)]!;
    m[pick]++;
  }
  return m;
}

export function cellMineralTotal(m: CellMinerals): number {
  return m.coal + m.iron_ore + m.gold_ore + m.granite;
}

export function dominantOreKey(m: CellMinerals): OreVeinKey {
  let best: OreVeinKey = 'coal';
  let bestV = -1;
  for (const k of DOMINANT_PRIORITY) {
    const v = m[k];
    if (v > bestV) {
      bestV = v;
      best = k;
    }
  }
  return best;
}

export function dominantOreResourceType(m: CellMinerals): ResourceType {
  return dominantOreKey(m) as ResourceType;
}

export interface TileMineralHost {
  cellMinerals?: CellMinerals;
}

/** Assign minerals once; idempotent if already present. */
export function ensureCellMinerals(tile: TileMineralHost, seed: number): CellMinerals {
  if (!tile.cellMinerals) {
    tile.cellMinerals = rollCellMinerals(seed);
  }
  return tile.cellMinerals;
}
