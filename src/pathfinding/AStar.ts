/**
 * A* Pathfinding implementation using the pathfinding library
 * Workers prefer to walk on roads (lower cost) but can go off-road when needed
 */

import PF from 'pathfinding';
import { TileMap } from '@/map/TileMap';
import { Position } from '@/components/Position';

type RoadBuildPathOptions = {
  canUseCell: (x: number, y: number) => boolean;
  isExistingRoad?: (x: number, y: number) => boolean;
};

type RoadSearchNode = {
  x: number;
  y: number;
  dir: number;
  g: number;
  f: number;
};

class MinHeap {
  private items: RoadSearchNode[] = [];

  get length(): number {
    return this.items.length;
  }

  push(item: RoadSearchNode): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): RoadSearchNode | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (!first || !last) return first;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  private bubbleUp(index: number): void {
    let i = index;
    const item = this.items[i]!;
    while (i > 0) {
      const parentIndex = Math.floor((i - 1) / 2);
      const parent = this.items[parentIndex]!;
      if (item.f >= parent.f) break;
      this.items[i] = parent;
      i = parentIndex;
    }
    this.items[i] = item;
  }

  private bubbleDown(index: number): void {
    let i = index;
    const length = this.items.length;
    const item = this.items[i]!;
    while (true) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < length && this.items[left]!.f < this.items[best]!.f) best = left;
      if (right < length && this.items[right]!.f < this.items[best]!.f) best = right;
      if (best === i) break;
      this.items[i] = this.items[best]!;
      i = best;
    }
    this.items[i] = item;
  }
}

export class PathFinder {
  private finder: PF.AStarFinder;

  constructor() {
    this.finder = new PF.AStarFinder({
      allowDiagonal: false
    });
  }

  findPath(
    start: Position,
    end: Position,
    tileMap: TileMap,
    _preferRoads: boolean = true
  ): Position[] {
    // Create grid with dimensions
    const grid = new PF.Grid(tileMap.width, tileMap.height);

    // Set walkability for each tile - ONLY ROADS are walkable for now
    for (let y = 0; y < tileMap.height; y++) {
      for (let x = 0; x < tileMap.width; x++) {
        const tile = tileMap.getTile(x, y);
        const walkable = tile ? (tile.hasRoad && tile.walkable) : false;
        grid.setWalkableAt(x, y, walkable);
      }
    }

    // Find path
    const path = this.finder.findPath(
      Math.floor(start.x),
      Math.floor(start.y),
      Math.floor(end.x),
      Math.floor(end.y),
      grid
    );

    // Convert to Position array (skip first point as it's the current position)
    return path.slice(1).map(([x, y]) => new Position(x, y));
  }

  /**
   * Find a path that allows going off-road (e.g., for hunters, lumberjacks)
   * Workers will still prefer roads but won't avoid off-road heavily
   */
  findOffRoadPath(
    start: Position,
    end: Position,
    tileMap: TileMap
  ): Position[] {
    const sx = Math.floor(start.x);
    const sy = Math.floor(start.y);
    const ex = Math.floor(end.x);
    const ey = Math.floor(end.y);

    const margin = 5;
    const minX = Math.max(0, Math.min(sx, ex) - margin);
    const minY = Math.max(0, Math.min(sy, ey) - margin);
    const maxX = Math.min(tileMap.width - 1, Math.max(sx, ex) + margin);
    const maxY = Math.min(tileMap.height - 1, Math.max(sy, ey) + margin);
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;

    const grid = new PF.Grid(w, h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tile = tileMap.getTile(minX + x, minY + y);
        const walkable = tile ? (tile.walkable && !tile.isOccupied()) : false;
        grid.setWalkableAt(x, y, walkable);
      }
    }

    grid.setWalkableAt(sx - minX, sy - minY, true);
    grid.setWalkableAt(ex - minX, ey - minY, true);

    const path = this.finder.findPath(
      sx - minX, sy - minY,
      ex - minX, ey - minY,
      grid
    );

    return path.slice(1).map(([x, y]) => new Position(minX + x, minY + y));
  }

  findBuildableRoadPath(
    start: { x: number; y: number },
    end: { x: number; y: number },
    tileMap: TileMap,
    options: RoadBuildPathOptions
  ): { x: number; y: number }[] {
    const sx = Math.floor(start.x);
    const sy = Math.floor(start.y);
    const ex = Math.floor(end.x);
    const ey = Math.floor(end.y);
    if (!tileMap.isInBounds(sx, sy) || !tileMap.isInBounds(ex, ey)) return [];
    if (!options.canUseCell(sx, sy) || !options.canUseCell(ex, ey)) return [];
    if (sx === ex && sy === ey) return [{ x: sx, y: sy }];

    const manhattan = Math.abs(ex - sx) + Math.abs(ey - sy);
    const margin = Math.min(120, Math.max(12, Math.ceil(manhattan * 0.35)));
    const minX = Math.max(0, Math.min(sx, ex) - margin);
    const minY = Math.max(0, Math.min(sy, ey) - margin);
    const maxX = Math.min(tileMap.width - 1, Math.max(sx, ex) + margin);
    const maxY = Math.min(tileMap.height - 1, Math.max(sy, ey) + margin);

    const open = new MinHeap();
    const bestCost = new Map<string, number>();
    const cameFrom = new Map<string, string>();
    const startKey = `${sx},${sy}`;
    bestCost.set(startKey, 0);
    open.push({ x: sx, y: sy, dir: -1, g: 0, f: manhattan });

    const dirs: readonly (readonly [number, number])[] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];

    while (open.length > 0) {
      const current = open.pop()!;
      const currentKey = `${current.x},${current.y}`;
      if (current.g > (bestCost.get(currentKey) ?? Infinity)) continue;
      if (current.x === ex && current.y === ey) {
        return this.reconstructRoadBuildPath(cameFrom, currentKey);
      }

      for (let dir = 0; dir < dirs.length; dir++) {
        const [dx, dy] = dirs[dir]!;
        const nx = current.x + dx;
        const ny = current.y + dy;
        if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
        if (!options.canUseCell(nx, ny)) continue;

        const existingRoadDiscount = options.isExistingRoad?.(nx, ny) ? 0.35 : 1;
        const turnPenalty = current.dir >= 0 && current.dir !== dir ? 0.18 : 0;
        const nextCost = current.g + existingRoadDiscount + turnPenalty;
        const nextKey = `${nx},${ny}`;
        if (nextCost >= (bestCost.get(nextKey) ?? Infinity)) continue;

        bestCost.set(nextKey, nextCost);
        cameFrom.set(nextKey, currentKey);
        const h = Math.abs(ex - nx) + Math.abs(ey - ny);
        open.push({ x: nx, y: ny, dir, g: nextCost, f: nextCost + h });
      }
    }

    return [];
  }

  private reconstructRoadBuildPath(cameFrom: Map<string, string>, endKey: string): { x: number; y: number }[] {
    const keys = [endKey];
    let current = endKey;
    while (cameFrom.has(current)) {
      current = cameFrom.get(current)!;
      keys.push(current);
    }
    keys.reverse();
    return keys.map(key => {
      const [x, y] = key.split(',').map(Number);
      return { x: x!, y: y! };
    });
  }
}
