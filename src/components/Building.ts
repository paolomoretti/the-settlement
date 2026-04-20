/**
 * Building component - structures on the map
 */

import { Component } from '@/core/Component';
import { BuildingType } from '@/types/GameData';

export type { BuildingType };

export type BuildingState = 'awaiting_materials' | 'under_construction' | 'complete';

export class Building extends Component {
  public state: BuildingState = 'complete';
  public constructionProgress: number = 0; // 0-1
  public constructionStartedAt: number | null = null; // Unix timestamp
  public buildTimeSec: number = 0; // Total build time in seconds
  public completedAt: number | null = null;
  public width: number; // Width in tiles
  public height: number; // Depth in tiles (for isometric footprint)
  public buildingHeight: number; // Visual 3D height in pixels
  public passable: boolean; // Can workers walk through?
  public requiresRoad: boolean;
  public isActive: boolean = true;

  // Construction material delivery tracking
  public constructionMaterials: Record<string, number> | null = null;
  public materialsSent: Record<string, number> = {};
  public materialsDelivered: Record<string, number> = {};
  public builderEntityId: number | null = null;
  public builderArrived: boolean = false;
  public hasOperator: boolean = true;
  public animationWorkerId: number | null = null;

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

  getEntranceOffset(): { dx: number; dy: number } | null {
    if (this.passable) return null;
    if (this.width <= 1 && this.height <= 1) return null;
    return {
      dx: this.width - 1,
      dy: Math.ceil((this.height - 1) / 2)
    };
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
      this.completedAt = Date.now();
    }
  }

  startAwaitingMaterials(buildTimeSec: number, materials: Record<string, number>): void {
    this.state = 'awaiting_materials';
    this.buildTimeSec = buildTimeSec;
    this.constructionMaterials = { ...materials };
    this.materialsSent = {};
    this.materialsDelivered = {};
    this.constructionProgress = 0;
  }

  deliverMaterial(resourceType: string): boolean {
    if (!this.constructionMaterials) return false;
    const required = this.constructionMaterials[resourceType] || 0;
    const delivered = this.materialsDelivered[resourceType] || 0;
    if (delivered >= required) return false;
    this.materialsDelivered[resourceType] = delivered + 1;
    return true;
  }

  areMaterialsDelivered(): boolean {
    if (!this.constructionMaterials) return true;
    for (const [res, required] of Object.entries(this.constructionMaterials)) {
      if ((this.materialsDelivered[res] || 0) < required) return false;
    }
    return true;
  }

  canStartConstruction(): boolean {
    return this.state === 'awaiting_materials' &&
           this.builderArrived &&
           this.areMaterialsDelivered();
  }

  beginConstruction(): void {
    this.state = 'under_construction';
    this.constructionStartedAt = Date.now();
    this.constructionProgress = 0;
    this.constructionMaterials = null;
    this.materialsSent = {};
    this.materialsDelivered = {};
  }

  getProductionProgress(productionTimeSec: number): number {
    if (!this.completedAt || this.state !== 'complete' || productionTimeSec <= 0) return 0;
    const elapsed = (Date.now() - this.completedAt) / 1000;
    return (elapsed % productionTimeSec) / productionTimeSec;
  }
}
