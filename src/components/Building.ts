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
  public constructionProgress: number = 0; // 0-1
  public constructionStartedAt: number | null = null; // Unix timestamp
  public buildTimeSec: number = 0; // Total build time in seconds
  public width: number; // Width in tiles
  public height: number; // Depth in tiles (for isometric footprint)
  public buildingHeight: number; // Visual 3D height in pixels
  public passable: boolean; // Can workers walk through?
  public requiresRoad: boolean;
  public isActive: boolean = true;

  constructor(
    public buildingType: BuildingType,
    width: number = 1,
    height: number = 1,
    buildingHeight: number = 40,
    passable: boolean = false,
    requiresRoad: boolean = false
  ) {
    super();
    this.width = width;
    this.height = height;
    this.buildingHeight = buildingHeight;
    this.passable = passable;
    this.requiresRoad = requiresRoad;
    this.isActive = !requiresRoad;
  }

  isComplete(): boolean {
    return this.state === 'complete';
  }

  startConstruction(buildTimeSec: number): void {
    if (buildTimeSec <= 0) return;
    this.state = 'under_construction';
    this.buildTimeSec = buildTimeSec;
    this.constructionStartedAt = Date.now();
    this.constructionProgress = 0;
  }

  updateConstruction(): void {
    if (this.state !== 'under_construction' || !this.constructionStartedAt) return;
    const elapsed = (Date.now() - this.constructionStartedAt) / 1000;
    this.constructionProgress = Math.min(1, elapsed / this.buildTimeSec);
    if (this.constructionProgress >= 1) {
      this.state = 'complete';
      this.constructionStartedAt = null;
    }
  }
}
