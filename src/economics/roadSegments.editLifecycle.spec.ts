import { describe, it, expect, beforeEach } from 'vitest';
import { RoadSegmentManager } from '@/economics/RoadSegmentManager';
import { createGrassTileMap } from '@/test/roadNetworkFixtures';

function setRoads(map: ReturnType<typeof createGrassTileMap>, coords: { x: number; y: number }[]) {
  for (const { x, y } of coords) {
    const t = map.getTile(x, y);
    if (t) t.hasRoad = true;
  }
}

function clearRoads(map: ReturnType<typeof createGrassTileMap>, coords: { x: number; y: number }[]) {
  for (const { x, y } of coords) {
    const t = map.getTile(x, y);
    if (t) t.hasRoad = false;
  }
}

describe('RoadSegmentManager — worker continuity when geometry changes', () => {
  let mgr: RoadSegmentManager;

  beforeEach(() => {
    mgr = new RoadSegmentManager();
  });

  it('keeps the same worker when a straight corridor lengthens (fuzzy match), without extra spawns', () => {
    const map = createGrassTileMap(40, 40, { roads: [] });
    const island = [
      { x: 5, y: 5 },
      { x: 6, y: 5 },
      { x: 7, y: 5 },
    ];
    const trunk = [
      { x: 9, y: 5 },
      { x: 10, y: 5 },
      { x: 11, y: 5 },
    ];
    setRoads(map, island);

    let spawnCalls = 0;
    let nextId = 1000;
    const spawn = () => {
      spawnCalls++;
      return nextId++;
    };

    mgr.reset();
    mgr.rebuildRoadTileSet(map);
    mgr.setCallbacks({
      spawnWorker: spawn,
      freeWorker: () => {},
      moveWorker: () => {},
    });
    mgr.recalculate(map);

    expect(mgr.getSegments()).toHaveLength(1);
    const firstWorker = mgr.getSegments()[0]!.assignedWorkerId;
    expect(firstWorker).not.toBeNull();
    expect(spawnCalls).toBe(1);

    // Merge into one long line by adding the bridge plus the trunk.
    setRoads(map, [{ x: 8, y: 5 }, ...trunk]);
    mgr.rebuildRoadTileSet(map);
    mgr.recalculate(map);

    expect(mgr.getSegments()).toHaveLength(1);
    expect(mgr.getSegments()[0]!.assignedWorkerId).toBe(firstWorker);
    expect(spawnCalls).toBe(1);
  });

  it('calls onFreeWorker when a staffed corridor is fully removed', () => {
    const map = createGrassTileMap(40, 40, { roads: [] });
    const cells = [
      { x: 3, y: 3 },
      { x: 4, y: 3 },
      { x: 5, y: 3 },
    ];
    setRoads(map, cells);

    const freed: number[] = [];
    mgr.reset();
    mgr.rebuildRoadTileSet(map);
    mgr.setCallbacks({
      spawnWorker: () => 3001,
      freeWorker: id => freed.push(id),
      moveWorker: () => {},
    });
    mgr.recalculate(map);
    expect(mgr.getSegments()).toHaveLength(1);

    clearRoads(map, cells);
    mgr.rebuildRoadTileSet(map);
    mgr.recalculate(map);

    expect(mgr.getSegments()).toHaveLength(0);
    expect(freed).toEqual([3001]);
  });

  it('keeps the worker on a disconnected island when the island still exists (no free)', () => {
    const map = createGrassTileMap(40, 40, { roads: [] });
    const island = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ];
    setRoads(map, island);

    const freed: number[] = [];
    mgr.reset();
    mgr.rebuildRoadTileSet(map);
    mgr.setCallbacks({
      spawnWorker: () => 4001,
      freeWorker: id => freed.push(id),
      moveWorker: () => {},
    });
    mgr.recalculate(map);
    expect(mgr.getSegments()[0]!.assignedWorkerId).toBe(4001);

    // Second recalculation of the same disconnected map — assignment must persist.
    mgr.rebuildRoadTileSet(map);
    mgr.recalculate(map);

    expect(freed).toHaveLength(0);
    expect(mgr.getSegments()).toHaveLength(1);
    expect(mgr.getSegments()[0]!.assignedWorkerId).toBe(4001);
  });
});

describe('RoadSegmentManager — topology-driven staffing', () => {
  let mgr: RoadSegmentManager;

  beforeEach(() => {
    mgr = new RoadSegmentManager();
  });

  it('forms three staffed legs when a straight spine becomes a T junction', () => {
    const map = createGrassTileMap(40, 40, { roads: [] });
    const spine = [
      { x: 11, y: 8 },
      { x: 11, y: 9 },
      { x: 11, y: 10 },
      { x: 11, y: 11 },
    ];
    setRoads(map, spine);

    let spawnCalls = 0;
    mgr.reset();
    mgr.rebuildRoadTileSet(map);
    mgr.setCallbacks({
      spawnWorker: () => ++spawnCalls,
      freeWorker: () => {},
      moveWorker: () => {},
    });
    mgr.recalculate(map);
    expect(mgr.getSegments()).toHaveLength(1);
    expect(spawnCalls).toBe(1);

    // Add a single side arm at the junction cell (11,10) → T shape (three legs).
    setRoads(map, [{ x: 10, y: 10 }]);
    mgr.rebuildRoadTileSet(map);
    mgr.recalculate(map);

    expect(mgr.getSegments()).toHaveLength(3);
    expect(spawnCalls).toBe(3);
  });
});
