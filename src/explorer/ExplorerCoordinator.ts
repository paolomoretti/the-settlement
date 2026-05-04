/**
 * Explorer: a specialised scout worker dispatched from HQ to a target cell.
 * Once arrived, patrols randomly within PATROL_RADIUS of the dispatch origin,
 * periodically stopping to raise binoculars and reveal a large fog-of-war radius.
 * Returns to HQ after EXPLORE_DURATION_MS (3 min). Visually distinguished by
 * binoculars strapped to the chest (Worker.isExplorer flag).
 * See `.claude/EXPLORER.md`.
 */

import { Entity } from '@/core/Entity';
import { eventBus } from '@/core/EventBus';
import { getSimulationNowMs } from '@/core/simulationClock';
import { Position } from '@/components/Position';
import { Movable } from '@/components/Movable';
import { Worker } from '@/components/Worker';
import { createWorker } from '@/entities/EntityFactory';
import { PathFinder } from '@/pathfinding/AStar';
import { TileMap } from '@/map/TileMap';

export const EXPLORE_DURATION_MS = 3 * 60 * 1000; // 3 minutes
const EXPLORE_REVEAL_RADIUS = 5; // Chebyshev reveal while walking
const BINOCULARS_REVEAL_RADIUS = 14; // large reveal on binoculars stop
const BINOCULARS_INTERVAL_MS = 22_000; // stop every 22 s
const BINOCULARS_DURATION_MS = 4_500; // hold binoculars 4.5 s
const PATROL_RADIUS = 20; // hard cap: never wander more than this from the dispatch origin
const MAX_ACTIVE_EXPLORERS = 2;
const WAYPOINT_DEBOUNCE_MS = 500; // don't repick waypoints faster than this

type ExplorerPhase = 'travel' | 'exploring' | 'return_home';

type ActiveExplorer = {
  workerEntityId: number | null;
  phase: ExplorerPhase;
  spawnTile: { x: number; y: number };
  /** The cell the player clicked to dispatch this explorer — roaming is capped around it. */
  originX: number;
  originY: number;
  startedAt: number;
  nextBinocularsAt: number;
  binocularsUntilMs: number;
  isBinocularing: boolean;
  lastWaypointPickMs: number;
};

export interface ExplorerCoordinatorDeps {
  getTileMap: () => TileMap;
  getPathFinder: () => PathFinder;
  getEntities: () => Entity[];
  addEntity: (e: Entity) => void;
  removeEntity: (e: Entity) => void;
  getAvailablePopulation: () => number;
  getBaseCampSpawnTile: () => { x: number; y: number } | null;
  queueHqStreetEntry: (entity: Entity, path: Position[], options?: { speed?: number }) => void;
  attachExplorerWorker: (id: number) => void;
  detachExplorerWorker: (id: number) => void;
  /** Mark these tiles as explored and update the minimap. */
  revealTiles: (cells: { x: number; y: number }[]) => void;
}

export class ExplorerCoordinator {
  private readonly active: ActiveExplorer[] = [];

  constructor(private readonly deps: ExplorerCoordinatorDeps) {}

  reset(): void {
    for (const e of this.active) {
      if (e.workerEntityId == null) continue;
      const ent = this.deps.getEntities().find(e2 => e2.id === e.workerEntityId && e2.active);
      if (ent) this.deps.removeEntity(ent);
      this.deps.detachExplorerWorker(e.workerEntityId);
    }
    this.active.length = 0;
  }

  canSendExplorerTo(_gx: number, _gy: number): boolean {
    if (this.active.length >= MAX_ACTIVE_EXPLORERS) return false;
    if (this.deps.getAvailablePopulation() <= 0) return false;
    if (!this.deps.getBaseCampSpawnTile()) return false;
    return true;
  }

  tryDispatchExplorer(targetX: number, targetY: number): boolean {
    const now = getSimulationNowMs();
    if (!this.canSendExplorerTo(targetX, targetY)) return false;

    const tileMap = this.deps.getTileMap();
    const pathFinder = this.deps.getPathFinder();
    const spawnTile = this.deps.getBaseCampSpawnTile();
    if (!spawnTile) return false;

    const start = new Position(spawnTile.x + 0.5, spawnTile.y + 0.5);
    const goal = new Position(targetX + 0.5, targetY + 0.5);

    let fullPath = pathFinder.findOffRoadPath(start, goal, tileMap);
    if (fullPath.length === 0) {
      eventBus.emit('build:failed', { reason: 'Explorer cannot reach that cell' });
      return false;
    }

    const worker = createWorker(spawnTile.x + 0.5, spawnTile.y + 0.5);
    const w = worker.getComponent(Worker);
    const m = worker.getComponent(Movable);
    if (w) {
      w.visualActivity = 'general';
      w.isExplorer = true;
      // Mimetic uniform: forest green shirt, dark olive trousers, near-black boots.
      // Wide-brim hat (variant:'hat') gives the classic explorer silhouette;
      // hat colour is derived from hair in migrateAppearance, overridden to camo
      // green in WorkerBodyRenderer._buildAppearance when isExplorer is true.
      const skins = ['#d4a66a', '#c89858', '#c09050'];
      w.appearance = {
        skin: skins[Math.floor(Math.random() * skins.length)]!,
        hair: '#2a1a10',
        tunic: '#506838', // medium forest green
        pants: '#3a4a28', // dark olive
        boots: '#222818', // near-black green
        variant: 'hat', // wide-brim explorer hat
      };
    }
    if (m) {
      m.clearPath();
    }

    this.deps.addEntity(worker);
    this.deps.queueHqStreetEntry(worker, fullPath, { speed: 1.85 });
    this.deps.attachExplorerWorker(worker.id);

    this.active.push({
      workerEntityId: worker.id,
      phase: 'travel',
      spawnTile: { x: spawnTile.x, y: spawnTile.y },
      originX: targetX,
      originY: targetY,
      startedAt: now,
      nextBinocularsAt: now + BINOCULARS_INTERVAL_MS,
      binocularsUntilMs: 0,
      isBinocularing: false,
      lastWaypointPickMs: 0,
    });

    return true;
  }

  tick(nowMs: number): void {
    const tileMap = this.deps.getTileMap();
    const pathFinder = this.deps.getPathFinder();
    const entities = this.deps.getEntities();

    for (let i = this.active.length - 1; i >= 0; i--) {
      const s = this.active[i]!;
      if (s.workerEntityId == null) continue;

      const ent = entities.find(e => e.id === s.workerEntityId && e.active);
      if (!ent) {
        this.active.splice(i, 1);
        continue;
      }

      const movable = ent.getComponent(Movable);
      const pos = ent.getComponent(Position);
      const wc = ent.getComponent(Worker);
      if (!movable || !pos || !wc) continue;

      // ── Travel phase ──────────────────────────────────────────────────────
      if (s.phase === 'travel') {
        this._revealAroundPos(pos, EXPLORE_REVEAL_RADIUS, tileMap);
        if (!movable.isMoving) {
          // Arrived at target tile; start exploring
          s.phase = 'exploring';
          s.startedAt = nowMs;
          s.nextBinocularsAt = nowMs + BINOCULARS_INTERVAL_MS;
        }
      }

      // ── Exploring phase ───────────────────────────────────────────────────
      else if (s.phase === 'exploring') {
        // Time's up → head home
        if (nowMs >= s.startedAt + EXPLORE_DURATION_MS) {
          this._beginReturnHome(ent, s, tileMap, pathFinder);
          continue;
        }

        // Always reveal nearby
        this._revealAroundPos(pos, EXPLORE_REVEAL_RADIUS, tileMap);

        if (s.isBinocularing) {
          // Waiting for binoculars animation to finish
          if (nowMs >= s.binocularsUntilMs) {
            s.isBinocularing = false;
            s.nextBinocularsAt = nowMs + BINOCULARS_INTERVAL_MS;
            wc.setState('walking');
            wc.visualActivity = 'general';
          }
        } else if (!movable.isMoving && nowMs >= s.nextBinocularsAt) {
          // Time to stop and use binoculars
          s.isBinocularing = true;
          s.binocularsUntilMs = nowMs + BINOCULARS_DURATION_MS;
          wc.setState('working');
          wc.visualActivity = 'explore_scout';
          this._revealAroundPos(pos, BINOCULARS_REVEAL_RADIUS, tileMap);
        } else if (!movable.isMoving) {
          // Pick next patrol waypoint around the dispatch origin
          if (nowMs - s.lastWaypointPickMs >= WAYPOINT_DEBOUNCE_MS) {
            s.lastWaypointPickMs = nowMs;
            const path = this._pickNextWaypoint(pos, s.originX, s.originY, pathFinder, tileMap);
            if (path) {
              movable.setPath(path);
              wc.setState('walking');
              wc.visualActivity = 'general';
            }
            // If no walkable path found (e.g. explorer is in water-surrounded area),
            // just wait for the next debounce tick rather than heading home early.
          }
        }
      }

      // ── Return home phase ─────────────────────────────────────────────────
      else if (s.phase === 'return_home') {
        this._revealAroundPos(pos, EXPLORE_REVEAL_RADIUS, tileMap);
        if (!movable.isMoving) {
          this.deps.detachExplorerWorker(s.workerEntityId!);
          this.deps.removeEntity(ent);
          this.active.splice(i, 1);
        }
      }
    }
  }

  getActiveExplorerWorkerIds(): number[] {
    return this.active.map(s => s.workerEntityId).filter((id): id is number => id != null);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _revealAroundPos(pos: Position, radius: number, tileMap: TileMap): void {
    const cx = Math.floor(pos.x);
    const cy = Math.floor(pos.y);
    const cells: { x: number; y: number }[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) > radius) continue;
        const x = cx + dx;
        const y = cy + dy;
        const tile = tileMap.getTile(x, y);
        if (!tile || tile.isExplored()) continue;
        cells.push({ x, y });
      }
    }
    if (cells.length > 0) this.deps.revealTiles(cells);
  }

  /**
   * Pick a patrol waypoint within PATROL_RADIUS of the dispatch origin.
   * Unexplored walkable tiles are preferred so the explorer naturally heads toward
   * unseen land first; once the whole radius is revealed it falls back to any
   * walkable tile so patrolling continues for the full duration.
   */
  private _pickNextWaypoint(
    pos: Position,
    originX: number,
    originY: number,
    pathFinder: PathFinder,
    tileMap: TileMap
  ): Position[] | null {
    const cx = Math.floor(pos.x);
    const cy = Math.floor(pos.y);

    const unexplored: { x: number; y: number }[] = [];
    const explored: { x: number; y: number }[] = [];

    for (let dy = -PATROL_RADIUS; dy <= PATROL_RADIUS; dy++) {
      for (let dx = -PATROL_RADIUS; dx <= PATROL_RADIUS; dx++) {
        const x = originX + dx;
        const y = originY + dy;
        const tile = tileMap.getTile(x, y);
        if (!tile || !tile.walkable) continue;
        // Skip tiles too close to the current position (avoid micro-steps)
        if (Math.abs(x - cx) + Math.abs(y - cy) < 4) continue;
        if (tile.isExplored()) {
          explored.push({ x, y });
        } else {
          unexplored.push({ x, y });
        }
      }
    }

    // Prefer unexplored; fall back to explored so patrolling continues
    // even when the whole radius has already been revealed.
    const pool = unexplored.length > 0 ? unexplored : explored;
    if (pool.length === 0) return null;

    // Shuffle for natural patrol variety, then try up to 10 candidates
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = tmp;
    }
    for (const c of pool.slice(0, 10)) {
      const path = pathFinder.findOffRoadPath(
        new Position(cx, cy),
        new Position(c.x + 0.5, c.y + 0.5),
        tileMap
      );
      if (path.length > 0) return path;
    }
    return null;
  }

  private _beginReturnHome(
    ent: Entity,
    s: ActiveExplorer,
    tileMap: TileMap,
    pathFinder: PathFinder
  ): void {
    const pos = ent.getComponent(Position);
    const movable = ent.getComponent(Movable);
    const wc = ent.getComponent(Worker);
    if (!pos || !movable || !wc) return;

    s.phase = 'return_home';
    s.isBinocularing = false;
    wc.setState('walking');
    wc.visualActivity = 'general';

    const path = pathFinder.findOffRoadPath(
      new Position(Math.floor(pos.x), Math.floor(pos.y)),
      new Position(s.spawnTile.x + 0.5, s.spawnTile.y + 0.5),
      tileMap
    );

    if (path.length > 0) {
      movable.setPath(path);
    } else {
      // Cannot path home — just despawn
      this.deps.detachExplorerWorker(s.workerEntityId!);
      this.deps.removeEntity(ent);
      const idx = this.active.indexOf(s);
      if (idx >= 0) this.active.splice(idx, 1);
    }
  }
}
