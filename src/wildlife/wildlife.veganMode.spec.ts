import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { themeManager } from '@/data/ThemeManager';
import { createGrassTileMap } from '@/test/roadNetworkFixtures';
import { WildlifeCoordinator } from './WildlifeCoordinator';

function exploreAll(tileMap: ReturnType<typeof createGrassTileMap>) {
  for (let y = 0; y < tileMap.height; y++) {
    for (let x = 0; x < tileMap.width; x++) {
      tileMap.getTile(x, y)!.explore();
    }
  }
}

describe('WildlifeCoordinator vegan-mode rabbit spawning', () => {
  let previousTheme: string | null;

  beforeEach(() => {
    previousTheme = themeManager.getActiveThemeName();
  });

  afterEach(() => {
    themeManager.setActiveTheme(previousTheme);
  });

  it('seeds 2-3 initial rabbits when no theme is active', () => {
    themeManager.setActiveTheme(null);
    const tm = createGrassTileMap(40, 40);
    exploreAll(tm);
    const wc = new WildlifeCoordinator();
    wc.seedInitialRabbits(tm, 20, 20);
    const n = wc.getRabbits().length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(3);
  });

  it('places zero initial rabbits in vegan mode', () => {
    themeManager.setActiveTheme('vegan');
    const tm = createGrassTileMap(40, 40);
    exploreAll(tm);
    const wc = new WildlifeCoordinator();
    wc.seedInitialRabbits(tm, 20, 20);
    expect(wc.getRabbits().length).toBe(0);
  });

  it('skips periodic spawn batches in vegan mode even on tick', () => {
    themeManager.setActiveTheme('vegan');
    const tm = createGrassTileMap(40, 40);
    exploreAll(tm);
    const wc = new WildlifeCoordinator();
    wc.seedInitialRabbits(tm, 20, 20);
    // Fast-forward past the scheduled spawn attempt and tick repeatedly.
    for (let i = 0; i < 10; i++) {
      wc.tick(tm, 1_000_000 + i * 10_000);
    }
    expect(wc.getRabbits().length).toBe(0);
  });

  it('pre-existing rabbits survive vegan-mode ticks', () => {
    themeManager.setActiveTheme(null);
    const tm = createGrassTileMap(40, 40);
    exploreAll(tm);
    const wc = new WildlifeCoordinator();
    wc.seedInitialRabbits(tm, 20, 20);
    const beforeCount = wc.getRabbits().length;

    themeManager.setActiveTheme('vegan');
    for (let i = 0; i < 5; i++) {
      wc.tick(tm, 1_000_000 + i * 10_000);
    }
    // Vegan suppresses spawning, never removes existing rabbits.
    expect(wc.getRabbits().length).toBe(beforeCount);
  });
});
