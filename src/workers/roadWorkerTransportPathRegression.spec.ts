import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setSimulationNowMs } from '@/core/simulationClock';
import { roadSegmentManager } from '@/economics/RoadSegmentManager';
import { createRoadReturnTestContext } from '@/test/roadReturnTestWorld';
import { Movable } from '@/components/Movable';
import { Position } from '@/components/Position';
import { Worker } from '@/components/Worker';

/**
 * Regression: road-segment peasants also run `transportTask`. Duty-rest validation must not
 * call `moveSegmentWorker` while transporting — path end is pickup/dropoff, not segment center.
 */
describe('Road worker + transport path (no duty reroute)', () => {
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

  it('does not replace a to_pickup polyline with a walk to segment rest on updateConstructionDelivery', () => {
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    setSimulationNowMs(500_000);
    ctx.registry.updateConstructionDelivery();

    const seg = roadSegmentManager.getSegments()[0]!;
    const rest = roadSegmentManager.getCenterRestPosition(seg);
    expect(seg.assignedWorkerId).not.toBeNull();

    const wEntity = ctx.entities.find(
      e => e.id === seg.assignedWorkerId && e.active
    );
    expect(wEntity).toBeDefined();

    const w = wEntity!.getComponent(Worker)!;
    const m = wEntity!.getComponent(Movable)!;
    expect(m.isMoving).toBe(true);

    const pickup = { x: 10, y: 7 };
    const dropoff = { x: 16, y: 7 };
    expect(Math.hypot(rest.x - pickup.x, rest.y - pickup.y)).toBeGreaterThan(0.5);

    w.transportTask = {
      phase: 'to_pickup',
      pickupPos: { ...pickup },
      dropoffPos: { ...dropoff },
      resourceType: 'wood_log',
      amount: 1,
      sourceEntityId: 42,
      destEntityId: ctx.hqEntity.id,
    };

    m.setPath([
      new Position(13, 7),
      new Position(12, 7),
      new Position(11, 7),
      new Position(pickup.x, pickup.y),
    ]);
    m.isMoving = true;
    m.currentPathIndex = 0;
    m.progress = 0;
    w.setState('walking');

    const endBefore = m.path[m.path.length - 1]!;

    ctx.registry.updateConstructionDelivery();

    expect(m.path.length).toBeGreaterThan(0);
    const endAfter = m.path[m.path.length - 1]!;
    expect(endAfter.x).toBe(endBefore.x);
    expect(endAfter.y).toBe(endBefore.y);
    expect(w.transportTask?.phase).toBe('to_pickup');
  });
});
