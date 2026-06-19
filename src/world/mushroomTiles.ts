/**
 * Vegan-mode mushroom decor: deterministic per-tile presence, no global coordinator.
 *
 * Mushrooms appear on explored grass/desert tiles that border a tree/forest tile, gated
 * by a stable coordinate hash so the same tile always has (or never has) mushrooms.
 * Picking sets a regrow timer on `Tile.mushroomPickedUntilMs` (lazy field).
 *
 * @see .claude/MUSHROOMS_VEGAN.md
 */

import type { Tile } from '@/map/Tile';
import type { TileMap } from '@/map/TileMap';

/** Default regrow delay after a gatherer harvests a tile (sim-time ms). */
export const MUSHROOM_REGROW_MS = 60_000;

/** Fraction (0-100) of forest-edge tiles that grow mushrooms. */
const MUSHROOM_DENSITY_PERCENT = 30;

export type MushroomCap = 'red' | 'brown' | 'black';

export interface MushroomDot {
  /** Offset from tile center, in tile units (-0.5..0.5). */
  dx: number;
  dy: number;
  /** Visual size in pixels for the cap radius. */
  capRadius: number;
  cap: MushroomCap;
}

/** Stable integer hash from a coord pair; positive 31-bit result. */
function hashCoord(x: number, y: number, salt = 0): number {
  let h = (x | 0) * 73856093;
  h ^= (y | 0) * 19349663;
  h ^= (salt | 0) * 83492791;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) >>> 0;
}

function isTreeNeighbor(t: Tile | null | undefined): boolean {
  if (!t) return false;
  return t.terrain === 'tree' || t.terrain === 'forest';
}

function hasTreeOrthNeighbor(tileMap: TileMap, x: number, y: number): boolean {
  return (
    isTreeNeighbor(tileMap.getTile(x - 1, y)) ||
    isTreeNeighbor(tileMap.getTile(x + 1, y)) ||
    isTreeNeighbor(tileMap.getTile(x, y - 1)) ||
    isTreeNeighbor(tileMap.getTile(x, y + 1))
  );
}

/**
 * Deterministic baseline: does this tile *ever* grow mushrooms, ignoring the cooldown timer?
 *
 * Splitting baseline from cooldown lets the renderer and gameplay share one canonical test
 * for "this is a mushroom tile", and lets specs assert determinism without juggling sim time.
 */
export function tileIsMushroomCandidate(tile: Tile | null | undefined, tileMap: TileMap): boolean {
  if (!tile) return false;
  if (!tile.isExplored()) return false;
  if (tile.terrain !== 'grass' && tile.terrain !== 'desert') return false;
  if (tile.hasRoad) return false;
  if (tile.isOccupied()) return false;
  if (!hasTreeOrthNeighbor(tileMap, tile.x, tile.y)) return false;
  return hashCoord(tile.x, tile.y) % 100 < MUSHROOM_DENSITY_PERCENT;
}

/** Mushroom is currently pickable (candidate AND not on regrow cooldown). */
export function tileHasMushrooms(
  tile: Tile | null | undefined,
  tileMap: TileMap,
  simNowMs: number
): boolean {
  if (!tileIsMushroomCandidate(tile, tileMap)) return false;
  const until = tile!.mushroomPickedUntilMs;
  if (until !== undefined && simNowMs < until) return false;
  return true;
}

/** Mark a tile as just picked; mushrooms hide and become unpickable until `simNowMs + regrowMs`. */
export function markMushroomsPickedAt(
  tile: Tile,
  simNowMs: number,
  regrowMs: number = MUSHROOM_REGROW_MS
): void {
  tile.mushroomPickedUntilMs = simNowMs + regrowMs;
}

const CAP_BY_INDEX: readonly MushroomCap[] = ['red', 'brown', 'black'];

/**
 * Deterministic 2–4 mushrooms for a tile, with offsets stable across frames and runs.
 * Returned even for non-candidate tiles — callers should check `tileHasMushrooms` first.
 */
export function mushroomDotsForTile(x: number, y: number): MushroomDot[] {
  const h0 = hashCoord(x, y, 11);
  const count = 2 + (h0 % 3); // 2..4
  const dots: MushroomDot[] = [];
  for (let i = 0; i < count; i++) {
    const h = hashCoord(x, y, 1000 + i);
    // Spread across most of the tile diamond: dx,dy in [-0.35, 0.35]
    const dx = ((h & 0xffff) / 0xffff) * 0.7 - 0.35;
    const dy = (((h >>> 16) & 0xffff) / 0xffff) * 0.7 - 0.35;
    const capIdx = hashCoord(x, y, 2000 + i) % CAP_BY_INDEX.length;
    const radiusJitter = hashCoord(x, y, 3000 + i) % 100;
    // 3..4 px caps (small but visible at default zoom)
    const capRadius = 3 + (radiusJitter < 40 ? 1 : 0);
    dots.push({ dx, dy, capRadius, cap: CAP_BY_INDEX[capIdx]! });
  }
  return dots;
}

/** Hex color for a cap variant (used by the renderer). */
export function mushroomCapColor(cap: MushroomCap): string {
  switch (cap) {
    case 'red':
      return '#a8261c';
    case 'brown':
      return '#6b3a1e';
    case 'black':
      return '#1a1a1a';
  }
}
