/**
 * Worker component - settlers that perform jobs
 */

import { Component } from '@/core/Component';

export type WorkerState = 'idle' | 'walking' | 'working' | 'carrying';

export interface WorkerAppearance {
  skin: string;
  hair: string;
  tunic: string;
  pants: string;
  boots: string;
  variant: 'default' | 'hat' | 'tunic2' | 'dress';
}

export type WorkerRole = 'peasant';

export interface WorkerDef {
  role: WorkerRole;
  speed: number;
  variants: WorkerAppearance[];
}

export const WORKER_DEFS: Record<WorkerRole, WorkerDef> = {
  peasant: {
    role: 'peasant',
    speed: 1.8,
    variants: [
      {
        skin: '#d4a66a', hair: '#4a3020', tunic: '#8b7355',
        pants: '#6b5c45', boots: '#3a2a1a', variant: 'default',
      },
      {
        skin: '#d4a66a', hair: '#6b5033', tunic: '#7a6a4a',
        pants: '#5a5038', boots: '#3a2a1a', variant: 'hat',
      },
      {
        skin: '#c89858', hair: '#3a2518', tunic: '#6a7a55',
        pants: '#5c5540', boots: '#3a2a1a', variant: 'tunic2',
      },
      {
        skin: '#dbb07a', hair: '#6a3828', tunic: '#7a6068',
        pants: '#7a6068', boots: '#4a3528', variant: 'dress',
      },
    ],
  },
};

export class Worker extends Component {
  public state: WorkerState = 'idle';
  public carryingResource?: string;
  public currentJob?: any;
  public role: WorkerRole;
  public appearance: WorkerAppearance;

  constructor(public name: string = 'Peasant', role: WorkerRole = 'peasant') {
    super();
    this.role = role;
    const variants = WORKER_DEFS[role].variants;
    this.appearance = { ...variants[Math.floor(Math.random() * variants.length)] };
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
