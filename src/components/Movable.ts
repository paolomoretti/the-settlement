/**
 * Movable component - entities that can move along paths
 */

import { Component } from '@/core/Component';
import { Position } from './Position';

export class Movable extends Component {
  public path: Position[] = [];
  public currentPathIndex: number = 0;
  public speed: number; // Tiles per second
  public isMoving: boolean = false;
  public progress: number = 0; // 0-1 progress between current and next tile
  public segmentStartX: number = 0; // Start X of current path segment
  public segmentStartY: number = 0; // Start Y of current path segment

  constructor(speed: number = 2) {
    super();
    this.speed = speed;
  }

  setPath(path: Position[]): void {
    this.path = path;
    this.currentPathIndex = 0;
    this.progress = 0;
    this.isMoving = path.length > 0;
  }

  clearPath(): void {
    this.path = [];
    this.currentPathIndex = 0;
    this.progress = 0;
    this.isMoving = false;
  }

  getCurrentTarget(): Position | null {
    if (this.currentPathIndex < this.path.length) {
      return this.path[this.currentPathIndex];
    }
    return null;
  }
}
