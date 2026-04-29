import { Component } from '@/core/Component';
import type { BuildingType, ResourceType } from '@/types/GameData';

export type ProductionStatus =
  | 'idle'
  | 'producing'
  | 'stopped_full'
  | 'stopped_no_inputs'
  | 'stopped_no_road';

/** Consume `amount` total per cycle from any of `resourceTypes` (e.g. miner food). */
export type ProductionInputAnyGroup = { resourceTypes: ResourceType[]; amount: number };
export type ProductionOutputMode = 'all' | 'weighted_random';
export type ProductionPriorityState = Record<string, Record<string, number>>;

export class Production extends Component {
  public status: ProductionStatus = 'idle';
  public timer: number = 0;
  public productionTime: number;
  public outputs: Record<string, number>;
  public inputs: Record<string, number>;
  /** OR-groups: each needs `amount` units summed across its `resourceTypes` in local storage. */
  public inputsAny: ProductionInputAnyGroup[];
  public outputBuffer: Record<string, number> = {};
  public maxOutputBuffer: number;
  public continuous: boolean;
  public outputMode: ProductionOutputMode;
  public currentCycleOutputs: Record<string, number> | null = null;
  /** Armory alternates sword / shield each completed cycle (starts with sword). */
  public armoryNextOutput: 'sword' | 'shield' = 'sword';

  constructor(
    productionTime: number,
    outputs: Record<string, number>,
    inputs: Record<string, number> = {},
    maxOutputBuffer: number = 10,
    continuous: boolean = true,
    inputsAny: ProductionInputAnyGroup[] = [],
    outputMode: ProductionOutputMode = 'all'
  ) {
    super();
    this.productionTime = productionTime;
    this.outputs = { ...outputs };
    this.inputs = { ...inputs };
    this.inputsAny = inputsAny.map(g => ({
      resourceTypes: [...g.resourceTypes],
      amount: g.amount,
    }));
    this.maxOutputBuffer = maxOutputBuffer;
    this.continuous = continuous;
    this.outputMode = outputMode;
  }

  getTotalBuffered(): number {
    let total = 0;
    for (const amount of Object.values(this.outputBuffer)) {
      total += amount;
    }
    return total;
  }

  private getWeightedRandomOutput(
    buildingType: BuildingType,
    priorities?: ProductionPriorityState
  ): Record<string, number> {
    const candidates = Object.entries(this.outputs).filter(([, amount]) => amount > 0);
    if (candidates.length === 0) return {};

    const weights = priorities?.[buildingType] ?? {};
    const weighted = candidates.map(([resource, amount]) => ({
      resource,
      amount,
      weight: Math.min(10, Math.max(1, Math.floor(weights[resource] ?? 5))),
    }));
    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const item of weighted) {
      roll -= item.weight;
      if (roll < 0) {
        return { [item.resource]: item.amount };
      }
    }

    const fallback = weighted[weighted.length - 1]!;
    return { [fallback.resource]: fallback.amount };
  }

  private getOutputAmountForCapacity(buildingType: BuildingType): number {
    if (buildingType === 'armory') return 1;
    const amounts = Object.values(this.outputs).filter(amount => amount > 0);
    if (this.outputMode === 'weighted_random') {
      return amounts.length > 0 ? Math.max(...amounts) : 0;
    }
    return amounts.reduce((sum, n) => sum + n, 0);
  }

  /** Per-cycle outputs; weighted producers pick one output, armory alternates. */
  getEffectiveOutputs(
    buildingType: BuildingType,
    priorities?: ProductionPriorityState
  ): Record<string, number> {
    if (this.currentCycleOutputs) {
      return this.currentCycleOutputs;
    }
    if (buildingType === 'armory') {
      return { [this.armoryNextOutput]: 1 };
    }
    if (this.outputMode === 'weighted_random') {
      return this.getWeightedRandomOutput(buildingType, priorities);
    }
    return this.outputs;
  }

  prepareCycleOutputs(
    buildingType: BuildingType,
    priorities?: ProductionPriorityState
  ): Record<string, number> {
    if (!this.currentCycleOutputs) {
      this.currentCycleOutputs = this.getEffectiveOutputs(buildingType, priorities);
    }
    return this.currentCycleOutputs;
  }

  clearCycleOutputs(): void {
    this.currentCycleOutputs = null;
  }

  hasBufferSpaceForBuilding(buildingType: BuildingType): boolean {
    const totalAfterProduction =
      this.getTotalBuffered() + this.getOutputAmountForCapacity(buildingType);
    return totalAfterProduction <= this.maxOutputBuffer;
  }

  hasBufferSpace(): boolean {
    const totalAfterProduction =
      this.getTotalBuffered() + Object.values(this.outputs).reduce((sum, n) => sum + n, 0);
    return totalAfterProduction <= this.maxOutputBuffer;
  }

  hasInputs(): boolean {
    return Object.keys(this.inputs).length > 0 || this.inputsAny.length > 0;
  }

  /** Resource types this building may pull as recipe / OR-group inputs (for HQ dispatch & transport). */
  getAllInputResourceTypes(): ResourceType[] {
    const s = new Set<ResourceType>();
    for (const [k, n] of Object.entries(this.inputs)) {
      if ((n ?? 0) > 0) s.add(k as ResourceType);
    }
    for (const g of this.inputsAny) {
      for (const t of g.resourceTypes) s.add(t);
    }
    return [...s];
  }

  /** Sum stored + in-flight for one OR-group (in-flight counts per type). */
  pipelineSumForInputsAnyGroup(
    group: ProductionInputAnyGroup,
    storage: { getAmount: (r: string) => number },
    inFlightFor: (r: string) => number
  ): number {
    let sum = 0;
    for (const t of group.resourceTypes) {
      sum += storage.getAmount(t) + inFlightFor(t);
    }
    return sum;
  }

  addToBuffer(resource: string, amount: number): void {
    this.outputBuffer[resource] = (this.outputBuffer[resource] || 0) + amount;
  }

  removeFromBuffer(resource: string, amount: number): number {
    const available = this.outputBuffer[resource] || 0;
    const taken = Math.min(available, amount);
    this.outputBuffer[resource] = available - taken;
    if (this.outputBuffer[resource] <= 0) {
      delete this.outputBuffer[resource];
    }
    return taken;
  }

  getProgress(): number {
    if (this.productionTime <= 0) return 0;
    return this.timer / this.productionTime;
  }

  serialize(): object {
    return {
      status: this.status,
      timer: this.timer,
      outputBuffer: { ...this.outputBuffer },
      armoryNextOutput: this.armoryNextOutput,
      currentCycleOutputs: this.currentCycleOutputs ? { ...this.currentCycleOutputs } : null,
    };
  }

  deserialize(data: any): void {
    if (data.status) this.status = data.status;
    if (data.timer !== undefined) this.timer = data.timer;
    if (data.outputBuffer) this.outputBuffer = { ...data.outputBuffer };
    if (data.armoryNextOutput === 'sword' || data.armoryNextOutput === 'shield') {
      this.armoryNextOutput = data.armoryNextOutput;
    }
    if (data.currentCycleOutputs && typeof data.currentCycleOutputs === 'object') {
      this.currentCycleOutputs = { ...data.currentCycleOutputs };
    }
  }
}
