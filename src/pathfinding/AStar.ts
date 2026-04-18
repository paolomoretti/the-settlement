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
        // Workers can ONLY walk on roads that are not occupied by buildings
        const walkable = tile ? (tile.hasRoad && !tile.isOccupied()) : false;
        grid.setWalkableAt(x, y, walkable);
      }
    }

    console.log(`Grid created: ${tileMap.width}x${tileMap.height}`);
    console.log(`Start: (${Math.floor(start.x)}, ${Math.floor(start.y)})`);
    console.log(`End: (${Math.floor(end.x)}, ${Math.floor(end.y)})`);

    // Find path
    const path = this.finder.findPath(
      Math.floor(start.x),
      Math.floor(start.y),
      Math.floor(end.x),
      Math.floor(end.y),
      grid
    );

    console.log(`Raw path result: ${path.length} points`);

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
    return this.findPath(start, end, tileMap, false);
  }
}
