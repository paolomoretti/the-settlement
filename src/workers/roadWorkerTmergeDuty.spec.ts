import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setSimulationNowMs } from '@/core/simulationClock';
import { roadSegmentManager } from '@/economics/RoadSegmentManager';
import { createRoadReturnTestContext } from '@/test/roadReturnTestWorld';
import { Movable } from '@/components/Movable';
import { Position } from '@/components/Position';
import { Worker } from '@/components/Worker';

/**
 * T-junction from the middle of the HQ strip, then remove the perpendicular spine.
 * The overlap winner must adopt the merged line's duty rest; freed workers go home.
 * No carrier should keep walking toward a deleted arm rest.
 */
describe('T-junction merge — duty rest and paths', () => {
  let ctx: ReturnType<typeof createRoadReturnTestContext>;

  const armCells = [
    { x: 11, y: 6 },
    { x: 11, y: 5 },
    { x: 11, y: 4 },
  ];

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

  it('reroutes the kept worker to merged rest and stops phantom walks to the removed arm', () => {
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);
    expect(roadSegmentManager.getSegments()).toHaveLength(1);

    for (const c of armCells) {
      const t = ctx.tileMap.getTile(c.x, c.y);
      if (t) t.hasRoad = true;
      ctx.hqConnectedRoads.add(`${c.x},${c.y}`);
    }
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);
    expect(roadSegmentManager.getSegments().length).toBeGreaterThanOrEqual(3);
    expect(ctx.registry.getPlayerRoadSegmentWorkerCount()).toBe(3);

    setSimulationNowMs(500_000);
    for (let i = 0; i < 12; i++) {
      ctx.registry.updateConstructionDelivery();
    }

    for (const c of armCells) {
      const t = ctx.tileMap.getTile(c.x, c.y);
      if (t) t.hasRoad = false;
      ctx.hqConnectedRoads.delete(`${c.x},${c.y}`);
    }
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    expect(roadSegmentManager.getSegments()).toHaveLength(1);
    for (let i = 0; i < 15; i++) {
      ctx.registry.updateConstructionDelivery();
    }

    expect(ctx.registry.getPlayerRoadSegmentWorkerCount()).toBe(1);
    const seg = roadSegmentManager.getSegments()[0]!;
    expect(seg.assignedWorkerId).not.toBeNull();
    const rest = roadSegmentManager.getCenterRestPosition(seg);
    const keeper = ctx.entities.find(e => e.id === seg.assignedWorkerId);
    expect(keeper).toBeDefined();
    const mov = keeper!.getComponent(Movable)!;
    if (mov.path.length > 0) {
      const end = mov.path[mov.path.length - 1]!;
      expect(Math.hypot(end.x - rest.x, end.y - rest.y)).toBeLessThan(0.2);
    } else {
      const pos = keeper!.getComponent(Position);
      expect(pos && Math.hypot(pos.x - rest.x, pos.y - rest.y)).toBeLessThan(0.15);
    }

    for (const c of armCells) {
      expect(ctx.tileMap.getTile(c.x, c.y)?.hasRoad).toBeFalsy();
    }

    for (const e of ctx.entities) {
      if (e.id === ctx.hqEntity.id) continue;
      const w = e.getComponent(Worker);
      if (!w || w.role !== 'peasant') continue;
      if (e.id === seg.assignedWorkerId) continue;
      if (ctx.registry.isRoadWorkerReturning(e.id)) continue;
      const m = e.getComponent(Movable);
      if (!m?.isMoving || m.path.length === 0) continue;
      const end = m.path[m.path.length - 1]!;
      const tx = Math.floor(end.x + 1e-9);
      const ty = Math.floor(end.y + 1e-9);
      const t = ctx.tileMap.getTile(tx, ty);
      const targetsRemovedSpine = tx === 11 && ty <= 6 && ty >= 4 && (!t || !t.hasRoad);
      expect(targetsRemovedSpine).toBe(false);
    }
  });

  it('aborts mid-walk toward deleted spine tiles so workers reroute home instead of finishing a stale road polyline', () => {
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    for (const c of armCells) {
      const t = ctx.tileMap.getTile(c.x, c.y);
      if (t) t.hasRoad = true;
      ctx.hqConnectedRoads.add(`${c.x},${c.y}`);
    }
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    setSimulationNowMs(50_000);
    for (let i = 0; i < 3; i++) {
      ctx.registry.updateConstructionDelivery();
    }

    for (const c of armCells) {
      const t = ctx.tileMap.getTile(c.x, c.y);
      if (t) t.hasRoad = false;
      ctx.hqConnectedRoads.delete(`${c.x},${c.y}`);
    }
    roadSegmentManager.rebuildRoadTileSet(ctx.tileMap);
    roadSegmentManager.recalculate(ctx.tileMap);

    for (let step = 0; step < 30; step++) {
      ctx.registry.updateConstructionDelivery();
      for (const e of ctx.entities) {
        if (e.id === ctx.hqEntity.id) continue;
        const w = e.getComponent(Worker);
        if (!w || w.role !== 'peasant') continue;
        if (ctx.registry.isRoadWorkerReturning(e.id)) continue;
        const m = e.getComponent(Movable);
        if (!m?.isMoving || m.path.length === 0) continue;
        for (let j = m.currentPathIndex; j < m.path.length; j++) {
          const p = m.path[j]!;
          const tx = Math.floor(p.x + 1e-9);
          const ty = Math.floor(p.y + 1e-9);
          const t = ctx.tileMap.getTile(tx, ty);
          expect(Boolean(t?.hasRoad && t.walkable)).toBe(true);
        }
      }
    }
  });
});
