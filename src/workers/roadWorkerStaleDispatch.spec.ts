import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setSimulationNowMs } from '@/core/simulationClock';
import { roadSegmentManager } from '@/economics/RoadSegmentManager';
import { GameWorkerRegistry } from '@/workers/GameWorkerRegistry';
import { createRoadReturnTestContext } from '@/test/roadReturnTestWorld';
import { Movable } from '@/components/Movable';
import { Worker } from '@/components/Worker';

describe('Road worker dispatch when roads are deleted mid-job', () => {
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

  it('does not apply a stale HQ→segment path after the road is deleted while still queued at HQ', () => {
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    const roadWorker = ctx.entities.find(
      e => e.id !== ctx.hqEntity.id && e.getComponent(Worker)?.role === 'peasant'
    );
    expect(roadWorker).toBeDefined();
    const w = roadWorker!.getComponent(Worker)!;
    expect(w.concealedInBuildingId).toBe(ctx.hqEntity.id);

    for (let x = 10; x <= 16; x++) {
      const t = ctx.tileMap.getTile(x, 7);
      if (t) t.hasRoad = false;
      ctx.hqConnectedRoads.delete(`${x},7`);
    }

    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    setSimulationNowMs(500_000);
    registry.updateConstructionDelivery();

    const stillThere = ctx.entities.find(
      e => e.id === roadWorker!.id && e.active && e.getComponent(Worker)?.role === 'peasant'
    );
    expect(stillThere).toBeUndefined();
  });

  it('reroutes home when the segment is removed while the worker is already walking to it', () => {
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    const roadWorker = ctx.entities.find(
      e => e.id !== ctx.hqEntity.id && e.getComponent(Worker)?.role === 'peasant'
    )!;
    const wid = roadWorker.id;

    setSimulationNowMs(500_000);
    registry.updateConstructionDelivery();

    const mov = roadWorker.getComponent(Movable)!;
    expect(mov.isMoving).toBe(true);
    expect(mov.path.length).toBeGreaterThan(0);

    for (let x = 10; x <= 16; x++) {
      const t = ctx.tileMap.getTile(x, 7);
      if (t) t.hasRoad = false;
      ctx.hqConnectedRoads.delete(`${x},7`);
    }
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    expect(registry.isRoadWorkerReturning(wid)).toBe(true);
    const pathAfter = roadWorker.getComponent(Movable)!.path;
    expect(pathAfter.length).toBeGreaterThan(0);
    const spawn = registry.getBaseCampSpawnTile()!;
    const last = pathAfter[pathAfter.length - 1]!;
    expect(last.x).toBe(spawn.x);
    expect(last.y).toBe(spawn.y);
  });

  it('cancels a queued road worker before release time if tiles were stripped without segment recalc (debounced recalc race)', () => {
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    const roadWorker = ctx.entities.find(
      e => e.id !== ctx.hqEntity.id && e.getComponent(Worker)?.role === 'peasant'
    )!;
    expect(roadWorker.getComponent(Worker)!.concealedInBuildingId).toBe(ctx.hqEntity.id);

    for (let x = 10; x <= 16; x++) {
      const t = ctx.tileMap.getTile(x, 7);
      if (t) t.hasRoad = false;
      ctx.hqConnectedRoads.delete(`${x},7`);
    }

    setSimulationNowMs(0);
    registry.updateConstructionDelivery();

    expect(ctx.entities.some(e => e.id === roadWorker.id && e.active)).toBe(false);
  });

  it('healRoadDispatchStaleAssignments sends a carrier home if tiles were stripped without a segment recalc', () => {
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    const roadWorker = ctx.entities.find(
      e => e.id !== ctx.hqEntity.id && e.getComponent(Worker)?.role === 'peasant'
    )!;
    const wid = roadWorker.id;

    setSimulationNowMs(500_000);
    registry.updateConstructionDelivery();

    for (let x = 10; x <= 16; x++) {
      const t = ctx.tileMap.getTile(x, 7);
      if (t) t.hasRoad = false;
      ctx.hqConnectedRoads.delete(`${x},7`);
    }

    setSimulationNowMs(500_000 + 900);
    registry.updateConstructionDelivery();

    expect(registry.isRoadWorkerReturning(wid)).toBe(true);
  });
});
