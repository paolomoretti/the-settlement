import { describe, it, expect, beforeEach } from 'vitest';
import { RoadSegmentManager } from '@/economics/RoadSegmentManager';
import {
  collectOpenRoadKeys,
  createGrassTileMap,
  floodFillHqRoadNetwork,
  hqConnectedOpenRoadKeys,
} from '@/test/roadNetworkFixtures';

function recalcWithSpawn(
  mgr: RoadSegmentManager,
  tileMap: ReturnType<typeof createGrassTileMap>,
  spawn: (seg: ReturnType<RoadSegmentManager['getSegments']>[number]) => number | null
): void {
  mgr.reset();
  mgr.rebuildRoadTileSet(tileMap);
  let fallback = 1;
  mgr.setCallbacks({
    spawnWorker: seg => {
      const id = spawn(seg);
      return id !== null ? id : fallback++;
    },
    freeWorker: () => {},
    moveWorker: () => {},
  });
  mgr.recalculate(tileMap);
}

/** When spawn returns null, Pass 5 leaves segments unassigned; use explicit ids from `spawn`. */
function recalcWithSpawnExact(
  mgr: RoadSegmentManager,
  tileMap: ReturnType<typeof createGrassTileMap>,
  spawn: (seg: ReturnType<RoadSegmentManager['getSegments']>[number]) => number | null
): void {
  mgr.reset();
  mgr.rebuildRoadTileSet(tileMap);
  mgr.setCallbacks({
    spawnWorker: spawn,
    freeWorker: () => {},
    moveWorker: () => {},
  });
  mgr.recalculate(tileMap);
}

function unionStaffedSegmentTiles(
  segments: ReturnType<RoadSegmentManager['getSegments']>
): Set<string> {
  const keys = new Set<string>();
  for (const seg of segments) {
    if (seg.assignedWorkerId === null) continue;
    for (const t of seg.tiles) {
      keys.add(`${t.x},${t.y}`);
    }
  }
  return keys;
}

function segmentTouchesKeySet(
  seg: ReturnType<RoadSegmentManager['getSegments']>[number],
  keys: Set<string>
): boolean {
  return seg.tiles.some(t => keys.has(`${t.x},${t.y}`));
}

describe('RoadSegmentManager — decomposition', () => {
  let mgr: RoadSegmentManager;

  beforeEach(() => {
    mgr = new RoadSegmentManager();
  });

  it('represents a straight corridor as one segment between two dead ends', () => {
    const roads = [
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 12, y: 10 },
      { x: 13, y: 10 },
      { x: 14, y: 10 },
    ];
    const map = createGrassTileMap(32, 32, { roads });
    recalcWithSpawn(mgr, map, () => 1);
    const segs = mgr.getSegments();
    expect(segs).toHaveLength(1);
    expect(segs[0]!.tiles).toHaveLength(5);
    expect(segs[0]!.endpoints[0]!.type).toBe('dead_end');
    expect(segs[0]!.endpoints[1]!.type).toBe('dead_end');
  });

  it('splits a T junction into three legs', () => {
    const roads = [
      { x: 11, y: 9 },
      { x: 11, y: 10 },
      { x: 11, y: 11 },
      { x: 10, y: 10 },
    ];
    const map = createGrassTileMap(32, 32, { roads });
    recalcWithSpawn(mgr, map, () => 1);
    expect(mgr.getSegments()).toHaveLength(3);
  });

  it('splits a four-way crossing into four legs', () => {
    const roads = [
      { x: 11, y: 9 },
      { x: 11, y: 10 },
      { x: 11, y: 11 },
      { x: 10, y: 10 },
      { x: 12, y: 10 },
    ];
    const map = createGrassTileMap(32, 32, { roads });
    recalcWithSpawn(mgr, map, () => 1);
    expect(mgr.getSegments()).toHaveLength(4);
  });
});

describe('RoadSegmentManager — worker coverage (spawn rules)', () => {
  let mgr: RoadSegmentManager;

  beforeEach(() => {
    mgr = new RoadSegmentManager();
  });

  it('when spawn always succeeds, every open-road cell lies on a segment with an assigned worker', () => {
    const roads = [
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 12, y: 10 },
      { x: 11, y: 9 },
      { x: 11, y: 11 },
    ];
    const map = createGrassTileMap(32, 32, { roads });
    let id = 100;
    recalcWithSpawn(mgr, map, () => id++);
    const open = collectOpenRoadKeys(map);
    const staffedTiles = unionStaffedSegmentTiles(mgr.getSegments());
    expect(staffedTiles.size).toBe(open.size);
    for (const k of open) {
      expect(staffedTiles.has(k)).toBe(true);
    }
  });

  it('HQ-connected open roads must each be staffed when spawn succeeds for those segments', () => {
    const HQ_ID = 501;
    // 5×5 HQ at (10,10): entrance offset (dx=4, dy=2) → tile (14,12)
    const entranceX = 14;
    const entranceY = 12;
    const roads = [
      { x: entranceX, y: entranceY },
      { x: 15, y: 12 },
      { x: 16, y: 12 },
      { x: 17, y: 12 },
    ];
    const map = createGrassTileMap(40, 40, { roads });
    const ent = map.getTile(entranceX, entranceY);
    expect(ent).not.toBeNull();
    ent!.hasRoad = true;
    ent!.occupiedBy = HQ_ID;

    const hqConnected = floodFillHqRoadNetwork(map, HQ_ID, entranceX, entranceY);
    const mustCover = hqConnectedOpenRoadKeys(map, hqConnected);

    let next = 200;
    recalcWithSpawnExact(mgr, map, seg =>
      segmentTouchesKeySet(seg, hqConnected) ? next++ : null
    );

    for (const seg of mgr.getSegments()) {
      if (segmentTouchesKeySet(seg, hqConnected)) {
        expect(seg.assignedWorkerId).not.toBeNull();
      }
    }

    const staffed = unionStaffedSegmentTiles(mgr.getSegments());
    for (const k of mustCover) {
      expect(staffed.has(k)).toBe(true);
    }
  });

  it('when spawn is denied for disconnected pavement, those segments stay unassigned', () => {
    const left = [
      { x: 5, y: 5 },
      { x: 6, y: 5 },
    ];
    const right = [
      { x: 20, y: 20 },
      { x: 21, y: 20 },
    ];
    const map = createGrassTileMap(32, 32, { roads: [...left, ...right] });
    const leftKeys = new Set(left.map(c => `${c.x},${c.y}`));

    recalcWithSpawnExact(mgr, map, seg =>
      segmentTouchesKeySet(seg, leftKeys) ? 777 : null
    );

    const segs = mgr.getSegments();
    expect(segs).toHaveLength(2);
    for (const seg of segs) {
      if (segmentTouchesKeySet(seg, leftKeys)) {
        expect(seg.assignedWorkerId).toBe(777);
      } else {
        expect(seg.assignedWorkerId).toBeNull();
      }
    }
  });
});
