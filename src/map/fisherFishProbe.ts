/**
 * Fisher reachability: fish only from **shore** water (at least one walkable non-water neighbor
 * to stand on), path ends on the **stand** tile beside the water, not on the water cell.
 */

import { Position } from '@/components/Position';
import type { PathFinder } from '@/pathfinding/AStar';
import type { TileMap } from './TileMap';
import { ensureWaterFishSchool, getWaterFishRemaining } from './waterFishSchool';

export interface FisherWaterPick {
  waterX: number;
  waterY: number;
  standX: number;
  standY: number;
  path: Position[];
}

/** Cardinal neighbors only — diagonal stands read as “far from the water” in iso view. */
const STAND_OFFSETS: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
}

function isValidStandTile(tileMap: TileMap, sx: number, sy: number, gatherExclude: Set<string>): boolean {
  const key = `${sx},${sy}`;
  if (gatherExclude.has(key)) return false;
  const t = tileMap.getTile(sx, sy);
  if (!t || !t.walkable || t.isOccupied()) return false;
  if (t.terrain === 'water' || t.terrain === 'mountain') return false;
  return true;
}

/**
 * Water tile has fish and at least one adjacent stand tile with a path from the entrance
 * within `maxWalkCells` steps.
 */
function tryPickStandForWater(
  tileMap: TileMap,
  pathFinder: PathFinder,
  entranceX: number,
  entranceY: number,
  waterX: number,
  waterY: number,
  maxWalkCells: number,
  gatherExclude: Set<string>,
  mapSeed: number
): FisherWaterPick | null {
  const wtile = tileMap.getTile(waterX, waterY);
  if (!wtile || wtile.terrain !== 'water' || wtile.hasRoad || wtile.isOccupied()) return null;
  ensureWaterFishSchool(wtile, mapSeed, waterX, waterY);
  if (getWaterFishRemaining(wtile, mapSeed, waterX, waterY) <= 0) return null;

  const standCandidates: { sx: number; sy: number; path: Position[] }[] = [];
  for (const [dx, dy] of STAND_OFFSETS) {
    const sx = waterX + dx;
    const sy = waterY + dy;
    if (!isValidStandTile(tileMap, sx, sy, gatherExclude)) continue;
    const path = pathFinder.findOffRoadPath(
      new Position(entranceX, entranceY),
      new Position(sx, sy),
      tileMap
    );
    if (path.length === 0 || path.length > maxWalkCells) continue;
    standCandidates.push({ sx, sy, path });
  }
  if (standCandidates.length === 0) return null;

  shuffleInPlace(standCandidates);
  const pick = standCandidates[0]!;
  return {
    waterX,
    waterY,
    standX: pick.sx,
    standY: pick.sy,
    path: pick.path,
  };
}

/** All shore picks in random order (same entrance / radius / walk cap). */
export function listReachableWaterFishTargets(
  tileMap: TileMap,
  pathFinder: PathFinder,
  entranceX: number,
  entranceY: number,
  radius: number,
  maxWalkCells: number,
  gatherExclude: Set<string>
): FisherWaterPick[] {
  const mapSeed = tileMap.getSeed();
  const picks: FisherWaterPick[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const wx = entranceX + dx;
      const wy = entranceY + dy;
      const key = `${wx},${wy}`;
      if (gatherExclude.has(key)) continue;
      const pick = tryPickStandForWater(
        tileMap,
        pathFinder,
        entranceX,
        entranceY,
        wx,
        wy,
        maxWalkCells,
        gatherExclude,
        mapSeed
      );
      if (pick) picks.push(pick);
    }
  }
  shuffleInPlace(picks);
  return picks;
}

export function pickRandomReachableWaterFishTarget(
  tileMap: TileMap,
  pathFinder: PathFinder,
  entranceX: number,
  entranceY: number,
  radius: number,
  maxWalkCells: number,
  gatherExclude: Set<string>
): FisherWaterPick | null {
  const picks = listReachableWaterFishTargets(
    tileMap,
    pathFinder,
    entranceX,
    entranceY,
    radius,
    maxWalkCells,
    gatherExclude
  );
  return picks.length > 0 ? picks[0]! : null;
}

export function fisherHasReachableFish(
  tileMap: TileMap,
  pathFinder: PathFinder,
  entranceX: number,
  entranceY: number,
  radius: number,
  maxWalkCells: number,
  gatherExclude: Set<string>
): boolean {
  return (
    listReachableWaterFishTargets(
      tileMap,
      pathFinder,
      entranceX,
      entranceY,
      radius,
      maxWalkCells,
      gatherExclude
    ).length > 0
  );
}
