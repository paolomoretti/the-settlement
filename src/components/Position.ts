/**
 * Position component - world position in grid coordinates
 */

import { Component } from '@/core/Component';

export class Position extends Component {
  constructor(
    public x: number,
    public y: number
  ) {
    super();
  }

  set(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  clone(): Position {
    return new Position(this.x, this.y);
  }

  equals(other: Position): boolean {
    return this.x === other.x && this.y === other.y;
  }

  distanceTo(other: Position): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}
