import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setSimulationNowMs } from '@/core/simulationClock';
import { roadSegmentManager } from '@/economics/RoadSegmentManager';
import { createRoadReturnTestContext } from '@/test/roadReturnTestWorld';
import { Movable } from '@/components/Movable';
import { Worker } from '@/components/Worker';

/**
 * Regression: deleting the only HQ road strip and restoring it must not leave two
 * road-segment peasants while the first is still walking home (population cap stayed "available").
 */
describe('Road worker spawn — no duplicate pile on delete / restore', () => {
  let ctx: ReturnType<typeof createRoadReturnTestContext>;

  beforeEach(() => {
    setSimulationNowMs(0);
    roadSegmentManager.reset();
    ctx = createRoadReturnTestContext();
    roadSegmentManager.setCallbacks(ctx.registry.getRoadSegmentCallbacks());
  });

  afterEach(() => {
    roadSegmentManager.reset();
    roadSegmentManager.setCallbacks({
      spawnWorker: () => null,
      freeWorker: () => {},
      moveWorker: () => {},
    });
  });

  it('does not spawn a second road peasant on the single HQ strip while the first is still returning', () => {
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    const peasantsBefore = ctx.entities.filter(
      e => e.id !== ctx.hqEntity.id && e.getComponent(Worker)?.role === 'peasant'
    );
    expect(peasantsBefore).toHaveLength(1);
    const firstId = peasantsBefore[0]!.id;

    // Same as roadWorkerReturn: release from HQ concealment so delete hits a live carrier
    // (otherwise `freeSegmentWorker` removes the never-dispatched entity instead of homing).
    setSimulationNowMs(500_000);
    ctx.registry.updateConstructionDelivery();
    expect(ctx.registry.isRoadWorkerReturning(firstId)).toBe(false);
    expect(peasantsBefore[0]!.getComponent(Movable)!.isMoving).toBe(true);

    for (let x = 10; x <= 16; x++) {
      const t = ctx.tileMap.getTile(x, 7);
      if (t) t.hasRoad = false;
      ctx.hqConnectedRoads.delete(`${x},7`);
    }
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    expect(ctx.registry.isRoadWorkerReturning(firstId)).toBe(true);

    for (let x = 10; x <= 16; x++) {
      const t = ctx.tileMap.getTile(x, 7);
      if (t) t.hasRoad = true;
      ctx.hqConnectedRoads.add(`${x},7`);
    }
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    const peasantsAfter = ctx.entities.filter(
      e => e.id !== ctx.hqEntity.id && e.getComponent(Worker)?.role === 'peasant'
    );
    expect(peasantsAfter.length).toBeLessThanOrEqual(1);
  });
});
