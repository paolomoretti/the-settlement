/**
 * A* Pathfinding implementation using the pathfinding library
 * Workers prefer to walk on roads (lower cost) but can go off-road when needed
 */

import PF from 'pathfinding';
import { TileMap } from '@/map/TileMap';
import { Position } from '@/components/Position';

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
}
