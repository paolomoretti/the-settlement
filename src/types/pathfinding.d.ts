declare module 'pathfinding' {
  export class Grid {
    constructor(width: number, height: number);
    setWalkableAt(x: number, y: number, walkable: boolean): void;
  }

  export class AStarFinder {
    constructor(options?: { allowDiagonal?: boolean });
    findPath(startX: number, startY: number, endX: number, endY: number, grid: Grid): number[][];
  }
}
