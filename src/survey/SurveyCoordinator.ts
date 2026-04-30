/**
 * Geological survey: HQ surveyor, flag tile, lazy minerals, dominant-ore labels, area lock.
 * See `.claude/SURVEY.md`.
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
import { ensureCellMinerals, dominantOreResourceType } from '@/map/CellMinerals';
import type { ResourceType } from '@/types/GameData';

/** Survey samples only within this Manhattan distance of the flag (closer cells first). */
export const SURVEY_MAX_MANHATTAN_STEPS = 4;
export const SURVEY_MAX_CELLS = 10;
export const SURVEY_LABEL_TTL_MS = 30 * 60 * 1000;
/** Dig + bash shovel at one survey cell before the label appears. */
export const SURVEY_DIG_PER_CELL_MS = 3400;

export type SurveyOverlayForRender = {
  flags: Array<{ x: number; y: number }>;
  labels: Array<{ x: number; y: number; resource: ResourceType }>;
  /** Progress while walking/digging the sampled cells (null if idle). */
  progress: {
    centerX: number;
    centerY: number;
    progress01: number;
    currentCell: { x: number; y: number } | null;
  } | null;
};

type SurveyLabel = {
  gx: number;
  gy: number;
  resource: ResourceType;
  expiresAt: number;
};

type SurveyPhase = 'travel' | 'sequential' | 'return_home' | 'cooldown';
type SeqSub = 'to_cell' | 'digging';

type ActiveSurvey = {
  centerX: number;
  centerY: number;
  workerEntityId: number | null;
  phase: SurveyPhase;
  /** HQ spawn tile (integer grid) for return journey. */
  spawnTile: { x: number; y: number };
  cellsQueue: { x: number; y: number }[];
  seqIndex: number;
  seqSub: SeqSub;
  digUntil: number;
  digStartedAt: number;
  /** After all labels expire; also max per-label expiry while labels exist. */
  postSurveyUnlockAt: number;
  labels: SurveyLabel[];
};

function manhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function cellsWithinManhattan(
  cx: number,
  cy: number,
  maxSteps: number
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = cy - maxSteps; y <= cy + maxSteps; y++) {
    for (let x = cx - maxSteps; x <= cx + maxSteps; x++) {
      if (manhattan(x, y, cx, cy) <= maxSteps) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

function concatPaths(a: Position[], b: Position[]): Position[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const last = a[a.length - 1]!;
  const first = b[0]!;
  if (last.x === first.x && last.y === first.y) {
    return [...a.slice(0, -1), ...b];
  }
  return [...a, ...b];
}

function findNearestHqRoadToPoint(
  tx: number,
  ty: number,
  connected: Set<string>,
  tileMap: TileMap,
  maxRing: number
): { x: number; y: number } | null {
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.abs(dx) + Math.abs(dy) !== ring) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (!connected.has(`${x},${y}`)) continue;
        const tile = tileMap.getTile(x, y);
        if (tile?.hasRoad && tile.walkable) {
          return { x, y };
        }
      }
    }
  }
  return null;
}

function buildSurveyCellQueue(
  tileMap: TileMap,
  centerX: number,
  centerY: number
): { x: number; y: number }[] {
  const pool = cellsWithinManhattan(centerX, centerY, SURVEY_MAX_MANHATTAN_STEPS).filter(c =>
    tileMap.isInBounds(c.x, c.y)
  );
  pool.sort((a, b) => {
    const da = manhattan(a.x, a.y, centerX, centerY);
    const db = manhattan(b.x, b.y, centerX, centerY);
    if (da !== db) return da - db;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });
  return pool.slice(0, SURVEY_MAX_CELLS);
}

export interface SurveyCoordinatorDeps {
  getTileMap: () => TileMap;
  getPathFinder: () => PathFinder;
  getEntities: () => Entity[];
  addEntity: (e: Entity) => void;
  removeEntity: (e: Entity) => void;
  getHqRoadNetwork: () => Set<string>;
  getBuildingAt: (gx: number, gy: number) => Entity | null;
  getMapSeed: () => number;
  getAvailablePopulation: () => number;
  getBaseCampSpawnTile: () => { x: number; y: number } | null;
  queueHqStreetEntry: (entity: Entity, path: Position[], options?: { speed?: number }) => void;
  attachSurveyorWorker: (workerEntityId: number) => void;
  detachSurveyorWorker: (workerEntityId: number) => void;
}

export class SurveyCoordinator {
  private readonly active: ActiveSurvey[] = [];

  constructor(private readonly deps: SurveyCoordinatorDeps) {}

  reset(): void {
    for (const s of this.active) {
      if (s.workerEntityId == null) continue;
      const ent = this.deps.getEntities().find(e => e.id === s.workerEntityId && e.active);
      if (ent) this.deps.removeEntity(ent);
      this.deps.detachSurveyorWorker(s.workerEntityId);
    }
    this.active.length = 0;
  }

  /** True if this grid cell is bare grass (survey menu target). */
  isTileEligibleForSurveyTarget(gx: number, gy: number): boolean {
    const tileMap = this.deps.getTileMap();
    const tile = tileMap.getTile(gx, gy);
    if (!tile) return false;
    if (tile.terrain !== 'grass') return false;
    if (tile.hasRoad) return false;
    if (tile.isOccupied()) return false;
    if (this.deps.getBuildingAt(gx, gy)) return false;
    return true;
  }

  private isAreaBlockedForNewCenter(cx: number, cy: number, now: number): boolean {
    for (const s of this.active) {
      if (manhattan(cx, cy, s.centerX, s.centerY) > SURVEY_MAX_MANHATTAN_STEPS) continue;
      if (s.phase !== 'cooldown') return true;
      if (s.labels.length > 0) return true;
      if (now < s.postSurveyUnlockAt) return true;
    }
    return false;
  }

  canSendSurveyorTo(centerX: number, centerY: number, now: number = getSimulationNowMs()): boolean {
    if (!this.isTileEligibleForSurveyTarget(centerX, centerY)) return false;
    if (this.isAreaBlockedForNewCenter(centerX, centerY, now)) return false;
    if (this.deps.getAvailablePopulation() <= 0) return false;
    if (!this.deps.getBaseCampSpawnTile()) return false;
    return true;
  }

  tryDispatchSurveyor(centerX: number, centerY: number): boolean {
    const now = getSimulationNowMs();
    if (!this.canSendSurveyorTo(centerX, centerY, now)) return false;

    const tileMap = this.deps.getTileMap();
    const pathFinder = this.deps.getPathFinder();
    const connected = this.deps.getHqRoadNetwork();

    const spawnTile = this.deps.getBaseCampSpawnTile();
    if (!spawnTile) {
      eventBus.emit('build:failed', { reason: 'No HQ road exit for surveyor' });
      return false;
    }

    const start = new Position(spawnTile.x + 0.5, spawnTile.y + 0.5);
    const goal = new Position(centerX + 0.5, centerY + 0.5);

    let fullPath: Position[] = [];

    const anchor = findNearestHqRoadToPoint(centerX, centerY, connected, tileMap, 96);
    if (anchor) {
      const roadPath = pathFinder.findPath(
        new Position(spawnTile.x, spawnTile.y),
        new Position(anchor.x, anchor.y),
        tileMap
      );
      const offPath = pathFinder.findOffRoadPath(new Position(anchor.x, anchor.y), goal, tileMap);
      fullPath = concatPaths(roadPath, offPath);
    }

    if (fullPath.length === 0) {
      fullPath = pathFinder.findOffRoadPath(start, goal, tileMap);
    }

    if (fullPath.length === 0) {
      eventBus.emit('build:failed', { reason: 'Cannot reach survey site' });
      return false;
    }

    const worker = createWorker(spawnTile.x + 0.5, spawnTile.y + 0.5);
    const w = worker.getComponent(Worker);
    const m = worker.getComponent(Movable);
    if (w) {
      w.pickUpResource('shovel');
      w.visualActivity = 'general';
    }
    if (m) m.clearPath();

    this.deps.addEntity(worker);
    this.deps.queueHqStreetEntry(worker, fullPath, { speed: 1.65 });
    this.deps.attachSurveyorWorker(worker.id);

    this.active.push({
      centerX,
      centerY,
      workerEntityId: worker.id,
      phase: 'travel',
      spawnTile: { x: spawnTile.x, y: spawnTile.y },
      cellsQueue: [],
      seqIndex: 0,
      seqSub: 'to_cell',
      digUntil: 0,
      digStartedAt: 0,
      postSurveyUnlockAt: 0,
      labels: [],
    });

    eventBus.emit('survey:session_updated');
    return true;
  }

  private assignPathToCell(ent: Entity, tx: number, ty: number): boolean {
    const pos = ent.getComponent(Position);
    const movable = ent.getComponent(Movable);
    const wc = ent.getComponent(Worker);
    if (!pos || !movable || !wc) return false;

    const tileMap = this.deps.getTileMap();
    const pathFinder = this.deps.getPathFinder();
    const sx = Math.floor(pos.x + 1e-6);
    const sy = Math.floor(pos.y + 1e-6);
    if (sx === tx && sy === ty) {
      return true;
    }

    const path = pathFinder.findOffRoadPath(
      new Position(sx, sy),
      new Position(tx + 0.5, ty + 0.5),
      tileMap
    );
    if (path.length === 0) return false;
    movable.speed = 1.65;
    movable.setPath(path);
    wc.setState('walking');
    wc.visualActivity = 'general';
    return true;
  }

  private assignReturnToHq(ent: Entity, spawn: { x: number; y: number }): boolean {
    const pos = ent.getComponent(Position);
    const movable = ent.getComponent(Movable);
    const wc = ent.getComponent(Worker);
    if (!pos || !movable || !wc) return false;

    const tileMap = this.deps.getTileMap();
    const pathFinder = this.deps.getPathFinder();
    const sx = Math.floor(pos.x + 1e-6);
    const sy = Math.floor(pos.y + 1e-6);
    const gx = spawn.x;
    const gy = spawn.y;

    let path = pathFinder.findOffRoadPath(
      new Position(sx, sy),
      new Position(gx + 0.5, gy + 0.5),
      tileMap
    );

    if (path.length === 0 && sx === gx && sy === gy) {
      return true;
    }

    if (path.length === 0) {
      const connected = this.deps.getHqRoadNetwork();
      const anchor = findNearestHqRoadToPoint(sx, sy, connected, tileMap, 64);
      const anchorGoal = findNearestHqRoadToPoint(gx, gy, connected, tileMap, 64);
      if (anchor && anchorGoal) {
        const a = pathFinder.findOffRoadPath(
          new Position(sx, sy),
          new Position(anchor.x, anchor.y),
          tileMap
        );
        const r = pathFinder.findPath(
          new Position(anchor.x, anchor.y),
          new Position(anchorGoal.x, anchorGoal.y),
          tileMap
        );
        const b = pathFinder.findOffRoadPath(
          new Position(anchorGoal.x, anchorGoal.y),
          new Position(gx + 0.5, gy + 0.5),
          tileMap
        );
        path = concatPaths(concatPaths(a, r), b);
      }
    }

    if (path.length === 0) return false;
    movable.speed = 1.65;
    movable.setPath(path);
    wc.setState('walking');
    wc.visualActivity = 'general';
    return true;
  }

  private atGridCell(pos: Position, tx: number, ty: number): boolean {
    return Math.floor(pos.x + 1e-6) === tx && Math.floor(pos.y + 1e-6) === ty;
  }

  tick(now: number = getSimulationNowMs()): void {
    const tileMap = this.deps.getTileMap();
    const entities = this.deps.getEntities();
    const mapSeed = this.deps.getMapSeed();

    for (let i = this.active.length - 1; i >= 0; i--) {
      const s = this.active[i]!;

      s.labels = s.labels.filter(l => now < l.expiresAt);

      if (s.phase === 'cooldown') {
        if (s.labels.length === 0 && now >= s.postSurveyUnlockAt) {
          this.active.splice(i, 1);
          eventBus.emit('survey:session_updated');
        }
        continue;
      }

      const wid = s.workerEntityId;
      if (wid == null) {
        this.active.splice(i, 1);
        eventBus.emit('survey:session_updated');
        continue;
      }

      const ent = entities.find(e => e.id === wid && e.active);
      const movable = ent?.getComponent(Movable);
      const pos = ent?.getComponent(Position);
      const wc = ent?.getComponent(Worker);

      if (s.phase === 'travel') {
        if (!ent || !movable || !pos || !wc) {
          this.abortSurveyAt(i, 'Surveyor lost');
          continue;
        }
        const at = !movable.isMoving && this.atGridCell(pos, s.centerX, s.centerY);
        if (at) {
          s.cellsQueue = buildSurveyCellQueue(tileMap, s.centerX, s.centerY);
          s.phase = 'sequential';
          s.seqIndex = 0;
          s.seqSub = 'to_cell';
          const first = s.cellsQueue[0];
          if (!first) {
            this.abortSurveyAt(i, 'No survey cells');
            continue;
          }
          if (this.atGridCell(pos, first.x, first.y)) {
            s.seqSub = 'digging';
            s.digStartedAt = now;
            s.digUntil = now + SURVEY_DIG_PER_CELL_MS;
            wc.setState('working');
            wc.visualActivity = 'survey_dig';
          } else if (!this.assignPathToCell(ent, first.x, first.y)) {
            this.abortSurveyAt(i, 'Cannot reach survey cell');
          }
        }
        continue;
      }

      if (s.phase === 'sequential') {
        if (!ent || !movable || !pos || !wc) {
          this.abortSurveyAt(i, 'Surveyor lost');
          continue;
        }

        const cell = s.cellsQueue[s.seqIndex];
        if (!cell) {
          this.beginReturnHome(i, ent, s, wc, movable);
          continue;
        }

        if (s.seqSub === 'to_cell') {
          if (!movable.isMoving && this.atGridCell(pos, cell.x, cell.y)) {
            s.seqSub = 'digging';
            s.digStartedAt = now;
            s.digUntil = now + SURVEY_DIG_PER_CELL_MS;
            wc.setState('working');
            wc.visualActivity = 'survey_dig';
          }
          continue;
        }

        // digging
        if (now < s.digUntil) continue;

        const tile = tileMap.getTile(cell.x, cell.y);
        if (tile) {
          const seed = (mapSeed ^ (cell.x * 2246822519) ^ (cell.y * 3266489917) ^ 0xcee11) >>> 0;
          ensureCellMinerals(tile, seed);
          const dom = dominantOreResourceType(tile.cellMinerals!);
          const exp = now + SURVEY_LABEL_TTL_MS;
          s.labels.push({ gx: cell.x, gy: cell.y, resource: dom, expiresAt: exp });
          s.postSurveyUnlockAt = Math.max(s.postSurveyUnlockAt, exp);
        }

        s.seqIndex++;
        if (s.seqIndex >= s.cellsQueue.length) {
          this.beginReturnHome(i, ent, s, wc, movable);
          continue;
        }

        const next = s.cellsQueue[s.seqIndex]!;
        s.seqSub = 'to_cell';
        wc.visualActivity = 'general';
        if (this.atGridCell(pos, next.x, next.y)) {
          s.seqSub = 'digging';
          s.digStartedAt = now;
          s.digUntil = now + SURVEY_DIG_PER_CELL_MS;
          wc.setState('working');
          wc.visualActivity = 'survey_dig';
        } else if (!this.assignPathToCell(ent, next.x, next.y)) {
          this.abortSurveyAt(i, 'Cannot reach next survey cell');
        }
        eventBus.emit('survey:session_updated');
        continue;
      }

      if (s.phase === 'return_home') {
        if (!ent || !movable || !pos || !wc) {
          this.abortSurveyAt(i, 'Surveyor lost');
          continue;
        }
        const atSpawn = !movable.isMoving && this.atGridCell(pos, s.spawnTile.x, s.spawnTile.y);
        if (atSpawn) {
          this.deps.removeEntity(ent);
          this.deps.detachSurveyorWorker(wid);
          s.workerEntityId = null;
          s.phase = 'cooldown';
          if (s.postSurveyUnlockAt === 0) {
            s.postSurveyUnlockAt = now;
          }
          eventBus.emit('survey:session_updated');
        }
      }
    }
  }

  private beginReturnHome(
    _index: number,
    ent: Entity,
    s: ActiveSurvey,
    wc: Worker,
    _movable: Movable
  ): void {
    s.phase = 'return_home';
    wc.visualActivity = 'general';
    if (!this.assignReturnToHq(ent, s.spawnTile)) {
      this.deps.removeEntity(ent);
      this.deps.detachSurveyorWorker(s.workerEntityId!);
      s.workerEntityId = null;
      s.phase = 'cooldown';
      if (s.postSurveyUnlockAt === 0) {
        s.postSurveyUnlockAt = getSimulationNowMs();
      }
    }
    eventBus.emit('survey:session_updated');
  }

  private abortSurveyAt(index: number, reason: string): void {
    const s = this.active[index]!;
    if (s.workerEntityId != null) {
      const ent = this.deps.getEntities().find(e => e.id === s.workerEntityId && e.active);
      if (ent) this.deps.removeEntity(ent);
      this.deps.detachSurveyorWorker(s.workerEntityId);
    }
    this.active.splice(index, 1);
    eventBus.emit('build:failed', { reason });
    eventBus.emit('survey:session_updated');
  }

  /**
   * Surveyor worker IDs that are actively digging (phase === 'sequential').
   * Use this for ambient sound — excludes travel and return legs.
   */
  getWorkingSurveyorWorkerIds(): number[] {
    const out: number[] = [];
    for (const s of this.active) {
      if (s.workerEntityId == null) continue;
      if (s.phase === 'sequential') out.push(s.workerEntityId);
    }
    return out;
  }

  /** Surveyor worker entities that should paint above survey UI (labels, bar, highlights). */
  getActiveSurveyorWorkerIds(): number[] {
    const out: number[] = [];
    for (const s of this.active) {
      if (s.workerEntityId == null) continue;
      if (s.phase === 'travel' || s.phase === 'sequential' || s.phase === 'return_home') {
        out.push(s.workerEntityId);
      }
    }
    return out;
  }

  getOverlayForRender(now: number = getSimulationNowMs()): SurveyOverlayForRender {
    const flags: Array<{ x: number; y: number }> = [];
    const labels: Array<{ x: number; y: number; resource: ResourceType }> = [];
    let progress: SurveyOverlayForRender['progress'] = null;

    for (const s of this.active) {
      if (s.phase === 'travel' || s.phase === 'sequential') {
        flags.push({ x: s.centerX, y: s.centerY });
      }

      for (const lab of s.labels) {
        if (now < lab.expiresAt) {
          labels.push({ x: lab.gx, y: lab.gy, resource: lab.resource });
        }
      }
    }

    for (const s of this.active) {
      if (s.phase !== 'sequential' || s.cellsQueue.length === 0) continue;
      const n = s.cellsQueue.length;
      let p01 = s.seqIndex / n;
      if (s.seqSub === 'digging' && s.digUntil > s.digStartedAt) {
        p01 += Math.min(1, (now - s.digStartedAt) / (s.digUntil - s.digStartedAt)) / n;
      }
      p01 = Math.min(1, p01);
      const cur =
        s.seqSub === 'to_cell' || s.seqSub === 'digging'
          ? (s.cellsQueue[s.seqIndex] ?? null)
          : null;
      progress = {
        centerX: s.centerX,
        centerY: s.centerY,
        progress01: p01,
        currentCell: cur,
      };
      break;
    }

    return { flags, labels, progress };
  }
}
