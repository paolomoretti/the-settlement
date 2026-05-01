/**
 * Building component - structures on the map
 */

import { Component } from '@/core/Component';
import { getSimulationNowMs } from '@/core/simulationClock';
import { BuildingType } from '@/types/GameData';

export type { BuildingType };

export type BuildingState = 'awaiting_materials' | 'under_construction' | 'complete';

/** One garrisoned soldier at a military post (assembled at HQ, rank promoted by gold at the fort). */
export type MilitaryGarrisonSlot = { rank: 1 | 2 | 3; workerEntityId: number };

export class Building extends Component {
  public state: BuildingState = 'complete';
  public constructionProgress: number = 0; // 0-1
  public constructionStartedAt: number | null = null; // Simulation timestamp
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
  /** Required-tool operator currently assigned to this building (tool id), if any. */
  public assignedToolSpecialist: string | null = null;
  public animationWorkerId: number | null = null;
  /** Lumberjack / quarry / fisher: no harvestable tile within search radius with a short enough off-road walk from the entrance. */
  public outOfMapResources: boolean = false;
  /** Throttle reachability scans for the fisher's water tiles (simulation ms). */
  public lastWaterFishProbeAt: number = 0;
  /** Throttle reachability scans for wild rabbits near the hunter (simulation ms). */
  public lastHuntRabbitProbeAt: number = 0;

  /** Length = `military.soldierCapacity` when set; entries `null` = empty slot. */
  public militaryGarrison: (MilitaryGarrisonSlot | null)[] | null = null;
  /** Once a soldier first enters a military post, its territory remains established even if soldiers march out. */
  public militaryTerritoryEstablished: boolean = false;
  /** True for a captured enemy headquarters that has been converted into a secondary player base. */
  public isAuxiliaryHQ: boolean = false;

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
      dy: Math.ceil((this.height - 1) / 2),
    };
  }

  isComplete(): boolean {
    return this.state === 'complete';
  }

  startConstruction(buildTimeSec: number, nowMs: number = getSimulationNowMs()): void {
    if (buildTimeSec <= 0) return;
    this.state = 'under_construction';
    this.buildTimeSec = buildTimeSec;
    this.constructionStartedAt = nowMs;
    this.constructionProgress = 0;
  }

  updateConstruction(nowMs: number = getSimulationNowMs()): void {
    if (this.state !== 'under_construction' || !this.constructionStartedAt) return;
    const elapsed = (nowMs - this.constructionStartedAt) / 1000;
    this.constructionProgress = Math.min(1, elapsed / this.buildTimeSec);
    if (this.constructionProgress >= 1) {
      this.state = 'complete';
      this.constructionStartedAt = null;
      this.completedAt = nowMs;
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
    return (
      this.state === 'awaiting_materials' && this.builderArrived && this.areMaterialsDelivered()
    );
  }

  beginConstruction(nowMs: number = getSimulationNowMs()): void {
    this.state = 'under_construction';
    this.constructionStartedAt = nowMs;
    this.constructionProgress = 0;
    this.constructionMaterials = null;
    this.materialsSent = {};
    this.materialsDelivered = {};
  }

  getProductionProgress(productionTimeSec: number, nowMs: number = getSimulationNowMs()): number {
    if (!this.completedAt || this.state !== 'complete' || productionTimeSec <= 0) return 0;
    const elapsed = (nowMs - this.completedAt) / 1000;
    return (elapsed % productionTimeSec) / productionTimeSec;
  }

  initMilitaryGarrison(capacity: number): void {
    if (capacity <= 0) {
      this.militaryGarrison = null;
      return;
    }
    if (!this.militaryGarrison || this.militaryGarrison.length !== capacity) {
      this.militaryGarrison = Array.from({ length: capacity }, () => null);
    }
  }

  getMilitaryGarrisonFilledCount(): number {
    if (!this.militaryGarrison) return 0;
    return this.militaryGarrison.filter(s => s != null).length;
  }

  /** At least one soldier garrisoned — used for settlement vision from soldier posts. */
  hasMilitaryTerritoryContributor(): boolean {
    return this.militaryTerritoryEstablished || this.getMilitaryGarrisonFilledCount() > 0;
  }

  findFreeMilitarySlotIndex(): number {
    if (!this.militaryGarrison) return -1;
    return this.militaryGarrison.findIndex(s => s == null);
  }

  assignMilitarySlot(slotIndex: number, workerEntityId: number): void {
    if (!this.militaryGarrison || slotIndex < 0 || slotIndex >= this.militaryGarrison.length)
      return;
    this.militaryGarrison[slotIndex] = { rank: 1, workerEntityId };
    this.militaryTerritoryEstablished = true;
  }

  /** Lowest rank &lt; 3 first, then lowest slot index. */
  pickSlotIndexForGoldPromotion(): number {
    if (!this.militaryGarrison) return -1;
    let best: { idx: number; rank: number } | null = null;
    for (let i = 0; i < this.militaryGarrison.length; i++) {
      const s = this.militaryGarrison[i];
      if (!s || s.rank >= 3) continue;
      if (!best || s.rank < best.rank || (s.rank === best.rank && i < best.idx)) {
        best = { idx: i, rank: s.rank };
      }
    }
    return best ? best.idx : -1;
  }

  promoteMilitaryAtSlot(slotIndex: number): void {
    if (!this.militaryGarrison) return;
    const s = this.militaryGarrison[slotIndex];
    if (!s || s.rank >= 3) return;
    const next = (s.rank + 1) as 1 | 2 | 3;
    this.militaryGarrison[slotIndex] = { rank: next, workerEntityId: s.workerEntityId };
  }

  militaryWantsMoreGold(): boolean {
    if (!this.militaryGarrison) return false;
    return this.militaryGarrison.some(s => s != null && s.rank < 3);
  }
}
