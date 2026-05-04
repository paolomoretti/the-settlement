/**
 * Locomotion actions for V2 workers: walk and idle_stand.
 */
import type { WorkerActionDef } from '../ActionDef';

/**
 * 4-frame walk cycle (800 ms total, 200 ms per frame).
 * Arms and legs swing in opposition.
 */
export const walkAction: WorkerActionDef = {
  id: 'walk',
  duration: 800,
  loop: true,
  tracks: {
    leftLeg: [
      { t: 0, transform: {} },
      { t: 0.25, transform: { dx: -1, dy: 1 } },
      { t: 0.5, transform: {} },
      { t: 0.75, transform: { dx: 1, dy: -1 } },
      { t: 1, transform: {} },
    ],
    rightLeg: [
      { t: 0, transform: {} },
      { t: 0.25, transform: { dx: 1, dy: -1 } },
      { t: 0.5, transform: {} },
      { t: 0.75, transform: { dx: -1, dy: 1 } },
      { t: 1, transform: {} },
    ],
    leftArm: [
      { t: 0, transform: {} },
      { t: 0.25, transform: { dy: 1 } },
      { t: 0.5, transform: {} },
      { t: 0.75, transform: { dy: -1 } },
      { t: 1, transform: {} },
    ],
    rightArm: [
      { t: 0, transform: {} },
      { t: 0.25, transform: { dy: -1 } },
      { t: 0.5, transform: {} },
      { t: 0.75, transform: { dy: 1 } },
      { t: 1, transform: {} },
    ],
  },
};

/** Neutral standing pose — no movement on any part. */
export const idleStandAction: WorkerActionDef = {
  id: 'idle_stand',
  duration: 1000,
  loop: true,
  tracks: {},
};
