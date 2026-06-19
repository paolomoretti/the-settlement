import { describe, expect, it } from 'vitest';

import { createGrassTileMap } from '@/test/roadNetworkFixtures';
import {
  MUSHROOM_REGROW_MS,
  markMushroomsPickedAt,
  mushroomDotsForTile,
  tileHasMushrooms,
  tileIsMushroomCandidate,
} from './mushroomTiles';

function exploreAll(tileMap: ReturnType<typeof createGrassTileMap>) {
  for (let y = 0; y < tileMap.height; y++) {
    for (let x = 0; x < tileMap.width; x++) {
      tileMap.getTile(x, y)!.explore();
    }
  }
}

/** Find a tile that satisfies the deterministic candidate predicate, so we can assert other branches without fighting the hash. */
function findCandidate(tileMap: ReturnType<typeof createGrassTileMap>) {
  for (let y = 1; y < tileMap.height - 1; y++) {
    for (let x = 1; x < tileMap.width - 1; x++) {
      const t = tileMap.getTile(x, y)!;
      if (tileIsMushroomCandidate(t, tileMap)) return t;
    }
  }
  return null;
}

describe('mushroomTiles', () => {
  it('returns false for tiles with no tree neighbor', () => {
    const tm = createGrassTileMap(8, 8);
    exploreAll(tm);
    const t = tm.getTile(4, 4)!;
    expect(tileIsMushroomCandidate(t, tm)).toBe(false);
    expect(tileHasMushrooms(t, tm, 0)).toBe(false);
  });

  it('returns false on unexplored tiles even with a tree neighbor and lucky hash', () => {
    const tm = createGrassTileMap(8, 8);
    tm.setTerrain(3, 4, 'tree');
    const t = tm.getTile(4, 4)!;
    // not explored yet
    expect(tileIsMushroomCandidate(t, tm)).toBe(false);
  });

  it('returns false on water / road / occupied tiles', () => {
    const tm = createGrassTileMap(8, 8);
    exploreAll(tm);
    tm.setTerrain(3, 4, 'tree');

    const water = tm.getTile(4, 4)!;
    tm.setTerrain(4, 4, 'water');
    expect(tileIsMushroomCandidate(water, tm)).toBe(false);

    const road = tm.getTile(5, 4)!;
    road.hasRoad = true;
    tm.setTerrain(5, 4, 'grass');
    // road tile in an originally-grass map: tree neighbor at (3,4) is two away, so this also fails the neighbor test.
    // Place a tree directly next to (5,4) too so the only reason for false is `hasRoad`.
    tm.setTerrain(4, 4, 'tree');
    tm.setTerrain(5, 5, 'tree');
    expect(tileIsMushroomCandidate(road, tm)).toBe(false);

    const occupied = tm.getTile(6, 4)!;
    occupied.occupy(999);
    tm.setTerrain(6, 5, 'tree');
    expect(tileIsMushroomCandidate(occupied, tm)).toBe(false);
  });

  it('finds at least one candidate when forest borders a large explored area', () => {
    // 30% density × 4 neighbor tiles around a single tree on a 30×30 map yields several.
    const tm = createGrassTileMap(30, 30);
    exploreAll(tm);
    for (let y = 2; y < 28; y += 4) {
      for (let x = 2; x < 28; x += 4) {
        tm.setTerrain(x, y, 'tree');
      }
    }
    expect(findCandidate(tm)).not.toBeNull();
  });

  it('markMushroomsPickedAt hides pickability until regrow', () => {
    const tm = createGrassTileMap(30, 30);
    exploreAll(tm);
    for (let y = 2; y < 28; y += 4) {
      for (let x = 2; x < 28; x += 4) {
        tm.setTerrain(x, y, 'tree');
      }
    }
    const candidate = findCandidate(tm);
    expect(candidate).not.toBeNull();

    const t0 = 10_000;
    expect(tileHasMushrooms(candidate, tm, t0)).toBe(true);

    markMushroomsPickedAt(candidate!, t0);
    expect(tileHasMushrooms(candidate, tm, t0)).toBe(false);
    expect(tileHasMushrooms(candidate, tm, t0 + MUSHROOM_REGROW_MS - 1)).toBe(false);
    expect(tileHasMushrooms(candidate, tm, t0 + MUSHROOM_REGROW_MS)).toBe(true);
  });

  it('mushroomDotsForTile is deterministic and produces 2..4 dots', () => {
    for (let i = 0; i < 20; i++) {
      const a = mushroomDotsForTile(123 + i, 456 + i);
      const b = mushroomDotsForTile(123 + i, 456 + i);
      expect(a.length).toBeGreaterThanOrEqual(2);
      expect(a.length).toBeLessThanOrEqual(4);
      expect(a).toEqual(b);
      for (const dot of a) {
        expect(dot.dx).toBeGreaterThanOrEqual(-0.35);
        expect(dot.dx).toBeLessThanOrEqual(0.35);
        expect(dot.dy).toBeGreaterThanOrEqual(-0.35);
        expect(dot.dy).toBeLessThanOrEqual(0.35);
        expect(['red', 'brown', 'black']).toContain(dot.cap);
      }
    }
  });
});
