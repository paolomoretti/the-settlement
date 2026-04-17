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
      y: Math.floor(gridY)
    };
  }

  // Get the four corner points of a tile in screen space
  getTileCorners(gridX: number, gridY: number): Point[] {
    const center = this.gridToScreen(gridX, gridY);
    const hw = this.tileWidth / 2;
    const hh = this.tileHeight / 2;

    return [
      { x: center.x, y: center.y - hh },      // Top
      { x: center.x + hw, y: center.y },      // Right
      { x: center.x, y: center.y + hh },      // Bottom
      { x: center.x - hw, y: center.y }       // Left
    ];
  }
}
