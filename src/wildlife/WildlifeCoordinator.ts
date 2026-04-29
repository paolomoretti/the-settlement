/**
 * Wild rabbits: spawn on explored land, wander near their origin, persist until hunted.
 * @see `.claude/WILDLIFE_RABBITS.md`
 */

import type { TileMap } from '@/map/TileMap';
import type { PathFinder } from '@/pathfinding/AStar';
import { getSimulationNowMs } from '@/core/simulationClock';
import { Position } from '@/components/Position';
import type { Tile } from '@/map/Tile';

export type RabbitVariant = 'white' | 'beige' | 'brown';

export interface RabbitJumpState {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startMs: number;
}

/** Shared with render for arc length (ms). */
export const RABBIT_JUMP_DURATION_MS = 420;

export interface WildRabbit {
  id: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  variant: RabbitVariant;
  /** Stable phase offset for idle / motion. */
  animSeed: number;
  /** Epoch ms when this rabbit may try to wander again. */
  nextWanderAtMs: number;
  /** While set, logical `(x,y)` stays at origin cell until landing; render interpolates. */
  jumping?: RabbitJumpState;
}

const SPAWN_INTERVAL_MS = 120_000;
/** Explored rabbit-habitat tiles per batch / per 3 rabbits of cap (see countExploredRabbitHabitatCells). */
const HABITAT_TILES_PER_CHUNK = 2000;
const RABBITS_PER_HABITAT_CHUNK = 3;
const WANDER_INTERVAL_MS = 40_000;
const INITIAL_MIN = 2;
const INITIAL_MAX = 3;
const WANDER_RADIUS_MANHATTAN = 2;
const SPAWN_ATTEMPTS_PER_RABBIT = 96;

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function rollVariant(): RabbitVariant {
  const r = Math.random();
  if (r < 0.33) return 'white';
  if (r < 0.66) return 'beige';
  return 'brown';
}

function isForestLike(t: Tile | null | undefined): boolean {
  return !!t && (t.terrain === 'tree' || t.terrain === 'forest');
}

function isWater(t: Tile | null | undefined): boolean {
  return !!t && t.terrain === 'water';
}

/** Explored, walkable rabbit terrain without roads (for population caps; ignores building occupancy). */
function isExploredRabbitHabitatMetricTile(tile: Tile | null | undefined): tile is Tile {
  if (!tile) return false;
  if (!tile.isExplored()) return false;
  if (!tile.walkable) return false;
  if (tile.hasRoad) return false;
  if (tile.terrain !== 'grass' && tile.terrain !== 'desert' && tile.terrain !== 'hill') return false;
  return true;
}

function isValidRabbitStandTile(tile: Tile | null | undefined): tile is Tile {
  if (!isExploredRabbitHabitatMetricTile(tile)) return false;
  if (tile.isOccupied()) return false;
  return true;
}

/** Full-map scan; call only on spawn ticks (e.g. every 2 min), not each frame. */
export function countExploredRabbitHabitatCells(tileMap: TileMap): number {
  let n = 0;
  const w = tileMap.width;
  const h = tileMap.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = tileMap.getTile(x, y);
      if (isExploredRabbitHabitatMetricTile(t)) n++;
    }
  }
  return n;
}

export interface SerializedWildlife {
  rabbits: Array<{
    id: number;
    originX: number;
    originY: number;
    x: number;
    y: number;
    variant: RabbitVariant;
    animSeed: number;
    nextWanderAtMs: number;
  }>;
  nextRabbitId: number;
  nextSpawnAttemptAtMs: number;
}

export class WildlifeCoordinator {
  private rabbits: WildRabbit[] = [];
  private cellOccupied = new Set<string>();
  /** Destination cells reserved while a rabbit is mid-jump (prevents double booking). */
  private jumpDestReserved = new Set<string>();
  private reservedForHunt = new Set<number>();
  private nextRabbitId = 1;
  private nextSpawnAttemptAtMs = 0;

  reset(): void {
    this.rabbits = [];
    this.cellOccupied.clear();
    this.jumpDestReserved.clear();
    this.reservedForHunt.clear();
    this.nextRabbitId = 1;
    this.nextSpawnAttemptAtMs = 0;
  }

  getRabbits(): readonly WildRabbit[] {
    return this.rabbits;
  }

  serialize(): SerializedWildlife {
    return {
      rabbits: this.rabbits.map(r => ({
        id: r.id,
        originX: r.originX,
        originY: r.originY,
        x: r.x,
        y: r.y,
        variant: r.variant,
        animSeed: r.animSeed,
        nextWanderAtMs: r.nextWanderAtMs,
      })),
      nextRabbitId: this.nextRabbitId,
      nextSpawnAttemptAtMs: this.nextSpawnAttemptAtMs,
    };
  }

  deserialize(data: unknown): void {
    this.reset();
    if (!data || typeof data !== 'object') {
      this.scheduleNextSpawnFromNow();
      return;
    }
    const d = data as Partial<SerializedWildlife>;
    if (typeof d.nextRabbitId === 'number' && d.nextRabbitId > 0) {
      this.nextRabbitId = d.nextRabbitId;
    }
    if (typeof d.nextSpawnAttemptAtMs === 'number') {
      this.nextSpawnAttemptAtMs = d.nextSpawnAttemptAtMs;
    } else {
      this.scheduleNextSpawnFromNow();
    }
    if (Array.isArray(d.rabbits)) {
      for (const raw of d.rabbits) {
        if (
          !raw ||
          typeof raw.id !== 'number' ||
          typeof raw.originX !== 'number' ||
          typeof raw.originY !== 'number' ||
          typeof raw.x !== 'number' ||
          typeof raw.y !== 'number'
        ) {
          continue;
        }
        const variant: RabbitVariant =
          raw.variant === 'white' || raw.variant === 'beige' || raw.variant === 'brown'
            ? raw.variant
            : 'brown';
        const animSeed = typeof raw.animSeed === 'number' ? raw.animSeed : Math.random() * 1000;
        const nextWander =
          typeof raw.nextWanderAtMs === 'number' ? raw.nextWanderAtMs : getSimulationNowMs() + WANDER_INTERVAL_MS;
        this.insertRabbit({
          id: raw.id,
          originX: raw.originX,
          originY: raw.originY,
          x: raw.x,
          y: raw.y,
          variant,
          animSeed,
          nextWanderAtMs: nextWander,
        });
      }
    }
  }

  /** After a brand-new map (HQ + initial explore), place starter rabbits and arm periodic spawns. */
  seedInitialRabbits(tileMap: TileMap, centerX: number, centerY: number): void {
    const habitatCells = countExploredRabbitHabitatCells(tileMap);
    const maxRabbits =
      Math.floor(habitatCells / HABITAT_TILES_PER_CHUNK) * RABBITS_PER_HABITAT_CHUNK;
    const want = INITIAL_MIN + Math.floor(Math.random() * (INITIAL_MAX - INITIAL_MIN + 1));
    const target = Math.min(want, maxRabbits);
    if (target > 0) {
      const placed = this.tryPlaceStarterRabbits(tileMap, centerX, centerY, target);
      if (placed < target) {
        this.tryPlaceStarterRabbitsLoose(tileMap, centerX, centerY, target - placed);
      }
    }
    this.scheduleNextSpawnFromNow(getSimulationNowMs());
  }

  /** Saves from before wildlife: periodic spawns only (no starter burst). */
  onLoadedLegacySave(): void {
    this.scheduleNextSpawnFromNow(getSimulationNowMs());
  }

  tick(tileMap: TileMap, now: number = getSimulationNowMs()): void {
    this.advanceRabbitJumps(now);

    for (const r of this.rabbits) {
      if (r.jumping) continue;
      if (this.reservedForHunt.has(r.id)) continue;
      if (now < r.nextWanderAtMs) continue;
      this.tryWanderOne(r, tileMap, now);
    }

    if (now >= this.nextSpawnAttemptAtMs) {
      const jitter = Math.floor(Math.random() * 8000);
      this.nextSpawnAttemptAtMs = now + SPAWN_INTERVAL_MS + jitter;
      this.trySpawnBatch(tileMap);
    }
  }

  private advanceRabbitJumps(now: number): void {
    for (const r of this.rabbits) {
      const j = r.jumping;
      if (!j) continue;
      if (now - j.startMs < RABBIT_JUMP_DURATION_MS) continue;
      const fk = cellKey(j.fromX, j.fromY);
      const tk = cellKey(j.toX, j.toY);
      this.cellOccupied.delete(fk);
      r.x = j.toX;
      r.y = j.toY;
      this.cellOccupied.add(tk);
      this.jumpDestReserved.delete(tk);
      r.jumping = undefined;
    }
  }

  hasReachableRabbit(
    tileMap: TileMap,
    pathFinder: PathFinder,
    entranceX: number,
    entranceY: number,
    gatherRadius: number,
    maxWalkCells: number,
    footprintCells: Set<string>
  ): boolean {
    return (
      this.pickReachableRabbit(tileMap, pathFinder, entranceX, entranceY, gatherRadius, maxWalkCells, footprintCells) !==
      null
    );
  }

  /**
   * Returns a rabbit and path from the building entrance to the rabbit's tile (inclusive),
   * excluding rabbits already reserved for another hunter.
   */
  pickReachableRabbit(
    tileMap: TileMap,
    pathFinder: PathFinder,
    entranceX: number,
    entranceY: number,
    gatherRadius: number,
    maxWalkCells: number,
    footprintCells: Set<string>
  ): { rabbit: WildRabbit; path: Position[] } | null {
    const sorted = [...this.rabbits].filter(r => !this.reservedForHunt.has(r.id));
    sorted.sort((a, b) => {
      const da = Math.abs(a.x - entranceX) + Math.abs(a.y - entranceY);
      const db = Math.abs(b.x - entranceX) + Math.abs(b.y - entranceY);
      return da - db;
    });

    for (const rabbit of sorted) {
      if (footprintCells.has(cellKey(rabbit.x, rabbit.y))) continue;
      const man = Math.abs(rabbit.x - entranceX) + Math.abs(rabbit.y - entranceY);
      if (man > gatherRadius) continue;
      const path = pathFinder.findOffRoadPath(
        new Position(entranceX, entranceY),
        new Position(rabbit.x, rabbit.y),
        tileMap
      );
      if (path.length > 0 && path.length <= maxWalkCells) {
        return { rabbit, path };
      }
    }
    return null;
  }

  /**
   * Atomically picks a path, then reserves the rabbit so two hunters cannot claim the same prey.
   */
  pickAndReserveReachableRabbit(
    tileMap: TileMap,
    pathFinder: PathFinder,
    entranceX: number,
    entranceY: number,
    gatherRadius: number,
    maxWalkCells: number,
    footprintCells: Set<string>
  ): { rabbit: WildRabbit; path: Position[] } | null {
    const pick = this.pickReachableRabbit(
      tileMap,
      pathFinder,
      entranceX,
      entranceY,
      gatherRadius,
      maxWalkCells,
      footprintCells
    );
    if (!pick) return null;
    if (!this.tryReserveRabbitForHunt(pick.rabbit.id)) return null;
    return pick;
  }

  tryReserveRabbitForHunt(id: number): boolean {
    if (this.reservedForHunt.has(id)) return false;
    if (!this.rabbits.some(r => r.id === id)) return false;
    this.reservedForHunt.add(id);
    return true;
  }

  releaseHuntReservation(id: number): void {
    this.reservedForHunt.delete(id);
  }

  /** Removes the rabbit after a successful kill; clears hunt reservation. */
  removeRabbitAfterSuccessfulHunt(id: number): void {
    const idx = this.rabbits.findIndex(r => r.id === id);
    if (idx === -1) return;
    const r = this.rabbits[idx]!;
    if (r.jumping) {
      this.jumpDestReserved.delete(cellKey(r.jumping.toX, r.jumping.toY));
    }
    this.cellOccupied.delete(cellKey(r.x, r.y));
    this.rabbits.splice(idx, 1);
    this.reservedForHunt.delete(id);
  }

  private scheduleNextSpawnFromNow(now: number = getSimulationNowMs()): void {
    const jitter = Math.floor(Math.random() * 8000);
    this.nextSpawnAttemptAtMs = now + SPAWN_INTERVAL_MS + jitter;
  }

  private insertRabbit(r: WildRabbit): void {
    const k = cellKey(r.x, r.y);
    if (this.cellOccupied.has(k)) return;
    if (this.jumpDestReserved.has(k)) return;
    this.cellOccupied.add(k);
    this.rabbits.push(r);
    this.nextRabbitId = Math.max(this.nextRabbitId, r.id + 1);
  }

  private tryPlaceStarterRabbits(tileMap: TileMap, cx: number, cy: number, count: number): number {
    const candidates: { x: number; y: number; score: number }[] = [];
    const radii = [28, 48, 80, 120];
    for (const rad of radii) {
      for (let y = cy - rad; y <= cy + rad; y++) {
        for (let x = cx - rad; x <= cx + rad; x++) {
          const tile = tileMap.getTile(x, y);
          if (!isValidRabbitStandTile(tile)) continue;
          if (this.cellOccupied.has(cellKey(x, y))) continue;

          let score = 2;
          const n = tileMap.getNeighbors(x, y);
          if (n.some(isForestLike)) score += 24;
          if (n.some(isWater)) score += 12;

          candidates.push({ x, y, score });
        }
      }
      if (candidates.length >= count * 6) break;
    }

    candidates.sort((a, b) => b.score - a.score);
    let placed = 0;
    for (const c of candidates) {
      if (placed >= count) break;
      if (this.cellOccupied.has(cellKey(c.x, c.y))) continue;
      const now = getSimulationNowMs();
      this.insertRabbit({
        id: this.nextRabbitId++,
        originX: c.x,
        originY: c.y,
        x: c.x,
        y: c.y,
        variant: rollVariant(),
        animSeed: Math.random() * 1000,
        nextWanderAtMs: now + WANDER_INTERVAL_MS + Math.floor(Math.random() * 4000),
      });
      placed++;
    }
    return placed;
  }

  /** Fallback: any explored grass away from HQ if scored candidates were too few. */
  private tryPlaceStarterRabbitsLoose(tileMap: TileMap, cx: number, cy: number, count: number): void {
    let placed = 0;
    const rad = 140;
    for (let attempt = 0; attempt < 8000 && placed < count; attempt++) {
      const x = cx + Math.floor((Math.random() * 2 - 1) * rad);
      const y = cy + Math.floor((Math.random() * 2 - 1) * rad);
      const tile = tileMap.getTile(x, y);
      if (!isValidRabbitStandTile(tile)) continue;
      if (this.cellOccupied.has(cellKey(x, y))) continue;
      const now = getSimulationNowMs();
      this.insertRabbit({
        id: this.nextRabbitId++,
        originX: x,
        originY: y,
        x,
        y,
        variant: rollVariant(),
        animSeed: Math.random() * 1000,
        nextWanderAtMs: now + WANDER_INTERVAL_MS + Math.floor(Math.random() * 4000),
      });
      placed++;
    }
  }

  private tryWanderOne(r: WildRabbit, tileMap: TileMap, now: number): void {
    if (r.jumping) return;

    const picks: { x: number; y: number }[] = [];
    for (let y = r.originY - WANDER_RADIUS_MANHATTAN; y <= r.originY + WANDER_RADIUS_MANHATTAN; y++) {
      for (let x = r.originX - WANDER_RADIUS_MANHATTAN; x <= r.originX + WANDER_RADIUS_MANHATTAN; x++) {
        const man = Math.abs(x - r.originX) + Math.abs(y - r.originY);
        if (man > WANDER_RADIUS_MANHATTAN) continue;
        if (x === r.x && y === r.y) continue;
        const tile = tileMap.getTile(x, y);
        if (!isValidRabbitStandTile(tile)) continue;
        const k = cellKey(x, y);
        if (this.cellOccupied.has(k)) continue;
        if (this.jumpDestReserved.has(k)) continue;
        picks.push({ x, y });
      }
    }
    if (picks.length === 0) {
      r.nextWanderAtMs = now + WANDER_INTERVAL_MS + Math.floor(Math.random() * 2500);
      return;
    }
    const dest = picks[Math.floor(Math.random() * picks.length)]!;
    const dk = cellKey(dest.x, dest.y);
    this.jumpDestReserved.add(dk);
    r.jumping = { fromX: r.x, fromY: r.y, toX: dest.x, toY: dest.y, startMs: now };
    r.nextWanderAtMs =
      now + RABBIT_JUMP_DURATION_MS + WANDER_INTERVAL_MS + Math.floor(Math.random() * 2500);
  }

  /**
   * Every spawn interval: up to (habitatCells/500) rabbits, total population capped at 3× that chunk count.
   * Stops early if random search finds no free stand tile.
   */
  private trySpawnBatch(tileMap: TileMap): void {
    const habitatCells = countExploredRabbitHabitatCells(tileMap);
    const batchCount = Math.floor(habitatCells / HABITAT_TILES_PER_CHUNK);
    const maxRabbits = batchCount * RABBITS_PER_HABITAT_CHUNK;
    if (batchCount <= 0 || maxRabbits <= 0) return;

    const headroom = maxRabbits - this.rabbits.length;
    const toPlace = Math.min(batchCount, headroom);
    if (toPlace <= 0) return;

    const w = tileMap.width;
    const h = tileMap.height;
    const now = getSimulationNowMs();

    for (let b = 0; b < toPlace; b++) {
      let placedOne = false;
      for (let a = 0; a < SPAWN_ATTEMPTS_PER_RABBIT; a++) {
        const x = Math.floor(Math.random() * w);
        const y = Math.floor(Math.random() * h);
        const tile = tileMap.getTile(x, y);
        if (!isValidRabbitStandTile(tile)) continue;
        if (this.cellOccupied.has(cellKey(x, y))) continue;

        this.insertRabbit({
          id: this.nextRabbitId++,
          originX: x,
          originY: y,
          x,
          y,
          variant: rollVariant(),
          animSeed: Math.random() * 1000,
          nextWanderAtMs: now + WANDER_INTERVAL_MS + Math.floor(Math.random() * 4000),
        });
        placedOne = true;
        break;
      }
      if (!placedOne) return;
    }
  }
}
