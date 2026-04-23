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

/** How a carried resource or tool is attached to the body in `RenderSystem`. */
export type WorkerHeldItemStyle = 'overhead' | 'side';

/**
 * Visual behavior for worker rendering. Game logic sets this from job type;
 * `WorkerRole` can diverge later (e.g. militia) while activity stays data-driven.
 */
export type WorkerVisualActivity =
  | 'general'
  | 'construct'
  | 'deliver_tool'
  | 'production_gather'
  | 'production_well'
  | 'production_mill'
  | 'production_plant'
  | 'survey_dig';

/** Tools held at the hip / one hand; bulk goods use overhead carry. */
const RESOURCE_HELD_SIDE = new Set<string>(['hammer', 'axe', 'pickaxe', 'fishing_rod', 'shovel']);

export function inferHeldItemStyle(resource: string): WorkerHeldItemStyle {
  return RESOURCE_HELD_SIDE.has(resource) ? 'side' : 'overhead';
}

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

export interface TransportTask {
  phase: 'to_pickup' | 'to_dropoff' | 'to_center';
  pickupPos: { x: number; y: number };
  dropoffPos: { x: number; y: number };
  resourceType: string;
  sourceEntityId: number | null;
  destEntityId: number | null;
}

export type IdleAnim = 'none' | 'look_around' | 'scratch_head' | 'read' | 'stretch' | 'hands_on_hips';

export class Worker extends Component {
  public state: WorkerState = 'idle';
  public carryingResource?: string;
  public transportTask: TransportTask | null = null;
  public role: WorkerRole;
  public appearance: WorkerAppearance;

  /** Render pose for anything currently carried (tools vs logs, etc.). */
  public heldItemStyle: WorkerHeldItemStyle = 'overhead';
  /** Job-driven animation bucket for render + brief gameplay (patrol pauses). */
  public visualActivity: WorkerVisualActivity = 'general';
  /** When set, the worker is inside this building entity and must not be drawn (e.g. mill operator). */
  public concealedInBuildingId: number | null = null;
  /** Builder may hammer on site only after `beginConstruction()` runs. */
  public hammerConstructionEnabled = false;
  /** Builder stands and plays hammer idle until this time (ms since epoch). */
  public buildIdleUntil = 0;

  public idleAnim: IdleAnim = 'none';
  public idleAnimStart = 0;
  public idleAnimDuration = 0;
  public nextIdleCheck = 0;
  public idleFacing = 0;

  /** Monotonic idle on tile (no walk / no job state); cleared when moving or non-idle. Used for rare floor naps. */
  public idleContinuousSinceMs: number | null = null;
  /** When set and `Date.now() <` this, worker is drawn napping on the ground. */
  public floorSleepUntilMs: number | null = null;
  public floorSleepStartedAtMs: number | null = null;
  /** Next wall-clock time to roll for starting a floor nap (throttles probability). */
  public nextFloorSleepProbeMs: number | null = null;

  constructor(public name: string = 'Peasant', role: WorkerRole = 'peasant') {
    super();
    this.role = role;
    const variants = WORKER_DEFS[role].variants;
    this.appearance = { ...variants[Math.floor(Math.random() * variants.length)] };
    this.nextIdleCheck = Date.now() + 2000 + Math.random() * 5000;
    this.idleFacing = Math.floor(Math.random() * 4);
  }

  setState(state: WorkerState): void {
    this.state = state;
  }

  pickUpResource(resource: string, heldOverride?: WorkerHeldItemStyle): void {
    this.carryingResource = resource;
    this.state = 'carrying';
    this.heldItemStyle = heldOverride ?? inferHeldItemStyle(resource);
  }

  dropResource(): void {
    this.carryingResource = undefined;
    this.state = 'idle';
    this.heldItemStyle = 'overhead';
  }
}
