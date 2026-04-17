/**
 * Building component - structures on the map
 */

import { Component } from '@/core/Component';

export type BuildingType =
  | 'warehouse'
  | 'lumberjack'
  | 'sawmill'
  | 'quarry'
  | 'farm'
  | 'road';

export type BuildingState = 'planning' | 'under_construction' | 'complete';

export class Building extends Component {
  public state: BuildingState = 'complete';
  public constructionProgress: number = 0; // 0-100
  public width: number; // Width in tiles
  public height: number; // Depth in tiles (for isometric footprint)
  public buildingHeight: number; // Visual 3D height in pixels
  public passable: boolean; // Can workers walk through?

  constructor(
    public buildingType: BuildingType,
    width: number = 1,
    height: number = 1,
    buildingHeight: number = 40,
    passable: boolean = false
  ) {
    super();
    this.width = width;
    this.height = height;
    this.buildingHeight = buildingHeight;
    this.passable = passable;
  }

  isComplete(): boolean {
    return this.state === 'complete';
  }

  startConstruction(): void {
    this.state = 'under_construction';
    this.constructionProgress = 0;
  }

  addConstructionProgress(amount: number): void {
    this.constructionProgress = Math.min(100, this.constructionProgress + amount);
    if (this.constructionProgress >= 100) {
      this.state = 'complete';
    }
  }
}
