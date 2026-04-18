import { Component } from '@/core/Component';

export type ProductionStatus = 'idle' | 'producing' | 'stopped_full' | 'stopped_no_inputs' | 'stopped_no_road';

export class Production extends Component {
  public status: ProductionStatus = 'idle';
  public timer: number = 0;
  public productionTime: number;
  public outputs: Record<string, number>;
  public inputs: Record<string, number>;
  public outputBuffer: Record<string, number> = {};
  public maxOutputBuffer: number;
  public continuous: boolean;

  constructor(
    productionTime: number,
    outputs: Record<string, number>,
    inputs: Record<string, number> = {},
    maxOutputBuffer: number = 10,
    continuous: boolean = true
  ) {
    super();
    this.productionTime = productionTime;
    this.outputs = { ...outputs };
    this.inputs = { ...inputs };
    this.maxOutputBuffer = maxOutputBuffer;
    this.continuous = continuous;
  }

  getTotalBuffered(): number {
    let total = 0;
    for (const amount of Object.values(this.outputBuffer)) {
      total += amount;
    }
    return total;
  }

  hasBufferSpace(): boolean {
    const totalAfterProduction = this.getTotalBuffered() +
      Object.values(this.outputs).reduce((sum, n) => sum + n, 0);
    return totalAfterProduction <= this.maxOutputBuffer;
  }

  hasInputs(): boolean {
    return Object.keys(this.inputs).length > 0;
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
    };
  }

  deserialize(data: any): void {
    if (data.status) this.status = data.status;
    if (data.timer !== undefined) this.timer = data.timer;
    if (data.outputBuffer) this.outputBuffer = { ...data.outputBuffer };
  }
}
