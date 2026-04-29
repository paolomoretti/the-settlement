/**
 * Isometric coordinate conversion utilities
 */

export interface Point {
  x: number;
  y: number;
}

export class Isometric {
  constructor(
    public tileWidth: number = 64,
    public tileHeight: number = 32
  ) {}

  // Convert grid coordinates to screen coordinates
  gridToScreen(gridX: number, gridY: number): Point {
    const screenX = (gridX - gridY) * (this.tileWidth / 2);
    const screenY = (gridX + gridY) * (this.tileHeight / 2);
    return { x: screenX, y: screenY };
  }

  // Convert screen coordinates to grid coordinates
  screenToGrid(screenX: number, screenY: number): Point {
    const gridX = (screenX / (this.tileWidth / 2) + screenY / (this.tileHeight / 2)) / 2;
    const gridY = (screenY / (this.tileHeight / 2) - screenX / (this.tileWidth / 2)) / 2;
    return {
      x: Math.floor(gridX),
      y: Math.floor(gridY),
    };
  }

  /**
   * Nearest tile center in world/iso plane (same space as `gridToScreen`).
   * Fixes off-by-one hover at diamond edges vs plain `floor` of the inverse map.
   */
  screenToGridNearest(screenX: number, screenY: number): Point {
    const tw = this.tileWidth / 2;
    const th = this.tileHeight / 2;
    const fx = (screenX / tw + screenY / th) / 2;
    const fy = (screenY / th - screenX / tw) / 2;
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    let bestX = i0;
    let bestY = j0;
    let bestD = Infinity;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const ix = i0 + di;
        const iy = j0 + dj;
        const c = this.gridToScreen(ix, iy);
        const d = (c.x - screenX) ** 2 + (c.y - screenY) ** 2;
        if (d < bestD) {
          bestD = d;
          bestX = ix;
          bestY = iy;
        }
      }
    }
    return { x: bestX, y: bestY };
  }

  // Get the four corner points of a tile in screen space
  getTileCorners(gridX: number, gridY: number): Point[] {
    const center = this.gridToScreen(gridX, gridY);
    const hw = this.tileWidth / 2;
    const hh = this.tileHeight / 2;

    return [
      { x: center.x, y: center.y - hh }, // Top
      { x: center.x + hw, y: center.y }, // Right
      { x: center.x, y: center.y + hh }, // Bottom
      { x: center.x - hw, y: center.y }, // Left
    ];
  }
}
