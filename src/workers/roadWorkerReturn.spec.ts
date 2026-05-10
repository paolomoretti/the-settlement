import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setSimulationNowMs } from '@/core/simulationClock';
import { roadSegmentManager } from '@/economics/RoadSegmentManager';
import { GameWorkerRegistry } from '@/workers/GameWorkerRegistry';
import { createRoadReturnTestContext } from '@/test/roadReturnTestWorld';
import { Movable } from '@/components/Movable';
import { Worker } from '@/components/Worker';

describe('Road worker return / population (GameWorkerRegistry + roadSegmentManager)', () => {
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

  it('after the segment is removed while walking home, peasant slot stays reserved until HQ conceal completes', () => {
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    expect(registry.getPlayerRoadSegmentWorkerCount()).toBe(1);
    const availWithRoad = ctx.effectiveAvailablePeasantSlots();
    expect(availWithRoad).toBe(ctx.populationCap - 1);

    setSimulationNowMs(500_000);
    registry.updateConstructionDelivery();

    const wEntity = ctx.entities.find(e => {
      const w = e.getComponent(Worker);
      return w && w.role === 'peasant' && e.id !== ctx.hqEntity.id;
    });
    expect(wEntity).toBeDefined();
    expect(wEntity!.getComponent(Movable)!.isMoving).toBe(true);

    for (let x = 10; x <= 16; x++) {
      const t = ctx.tileMap.getTile(x, 7);
      if (t) t.hasRoad = false;
      ctx.hqConnectedRoads.delete(`${x},7`);
    }

    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    expect(roadSegmentManager.getSegments()).toHaveLength(0);
    expect(registry.getPlayerRoadSegmentWorkerCount()).toBe(0);
    const availWalkingHome = ctx.effectiveAvailablePeasantSlots();
    expect(availWalkingHome).toBe(availWithRoad);

    const movable = wEntity!.getComponent(Movable)!;
    expect(movable.path.length).toBeGreaterThan(0);

    movable.path = [];
    movable.isMoving = false;
    movable.currentPathIndex = 0;
    wEntity!.getComponent(Worker)?.setState('idle');

    setSimulationNowMs(0);
    registry.tickReturnLegs();
    expect(ctx.entities.some(e => e.id === wEntity!.id)).toBe(true);
    const availConcealed = ctx.effectiveAvailablePeasantSlots();
    expect(availConcealed).toBe(availWithRoad);

    setSimulationNowMs(2000);
    registry.tickReturnLegs();
    expect(ctx.entities.some(e => e.id === wEntity!.id)).toBe(false);
    expect(ctx.effectiveAvailablePeasantSlots()).toBe(ctx.populationCap);
  });
});
