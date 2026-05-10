import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setSimulationNowMs } from '@/core/simulationClock';
import { roadSegmentManager } from '@/economics/RoadSegmentManager';
import { GameWorkerRegistry } from '@/workers/GameWorkerRegistry';
import { createRoadReturnTestContext } from '@/test/roadReturnTestWorld';

/**
 * Straight HQ strip (10,7)–(16,7) with a T at (11,7): one arm (11,6) only (two arms ⇒ + junction ⇒ 4 segments).
 * Removing the arm must leave exactly one segment and one road-segment worker.
 */
describe('One road worker per HQ-connected corridor', () => {
  let registry: GameWorkerRegistry;
  let ctx: ReturnType<typeof createRoadReturnTestContext>;

  beforeEach(() => {
    setSimulationNowMs(0);
    roadSegmentManager.reset();
    ctx = createRoadReturnTestContext();
    registry = ctx.registry;
    roadSegmentManager.setCallbacks(registry.getRoadSegmentCallbacks());
  });

  afterEach(() => {
    roadSegmentManager.reset();
    roadSegmentManager.setCallbacks({
      spawnWorker: () => null,
      freeWorker: () => {},
      moveWorker: () => {},
    });
  });

  it('drops orphan carriers when a T-junction reverts to a single corridor (merge duplicate workers)', () => {
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    expect(roadSegmentManager.getSegments()).toHaveLength(1);
    expect(registry.getPlayerRoadSegmentWorkerCount()).toBe(1);

    const arm = { x: 11, y: 6 };
    {
      const t = ctx.tileMap.getTile(arm.x, arm.y);
      if (t) t.hasRoad = true;
      ctx.hqConnectedRoads.add(`${arm.x},${arm.y}`);
    }

    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    expect(roadSegmentManager.getSegments()).toHaveLength(3);
    expect(registry.getPlayerRoadSegmentWorkerCount()).toBe(3);

    {
      const t = ctx.tileMap.getTile(arm.x, arm.y);
      if (t) t.hasRoad = false;
      ctx.hqConnectedRoads.delete(`${arm.x},${arm.y}`);
    }

    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    expect(roadSegmentManager.getSegments()).toHaveLength(1);
    expect(roadSegmentManager.getSegments()[0]!.assignedWorkerId).not.toBeNull();

    registry.updateConstructionDelivery();

    expect(registry.getPlayerRoadSegmentWorkerCount()).toBe(1);
    const assigned = new Set(
      roadSegmentManager
        .getSegments()
        .map(s => s.assignedWorkerId)
        .filter((id): id is number => id != null)
    );
    expect(assigned.size).toBe(1);
  });
});
