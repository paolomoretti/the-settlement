/**
 * Worker component - settlers that perform jobs
 */

import { Component } from '@/core/Component';

export type WorkerState = 'idle' | 'walking' | 'working' | 'carrying';

export class Worker extends Component {
  public state: WorkerState = 'idle';
  public carryingResource?: string;
  public currentJob?: any; // Will be properly typed when job system is implemented

  constructor(public name: string = 'Worker') {
    super();
  }

  setState(state: WorkerState): void {
    this.state = state;
  }

  pickUpResource(resource: string): void {
    this.carryingResource = resource;
    this.state = 'carrying';
  }

  dropResource(): void {
    this.carryingResource = undefined;
    this.state = 'idle';
  }
}
