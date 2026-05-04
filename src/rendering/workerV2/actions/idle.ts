/**
 * Idle micro-animations for V2 workers.
 * All are non-looping; caller restarts idle_stand when finished.
 */
import type { WorkerActionDef } from '../ActionDef';

export const lookAroundAction: WorkerActionDef = {
  id: 'idle_look_around',
  duration: 2400,
  loop: false,
  tracks: {
    head: [
      { t: 0.0, transform: {} },
      { t: 0.25, transform: { dx: -1.5 } },
      { t: 0.75, transform: { dx: 1.5 } },
      { t: 1.0, transform: {} },
    ],
  },
};

export const scratchHeadAction: WorkerActionDef = {
  id: 'idle_scratch_head',
  duration: 2000,
  loop: false,
  tracks: {
    rightArm: [
      { t: 0.0, transform: {} },
      { t: 0.15, transform: { dy: -5 } },
      { t: 0.85, transform: { dy: -5 } },
      { t: 1.0, transform: {} },
    ],
    rightHand: [
      { t: 0.0, transform: {} },
      { t: 0.15, transform: { dy: -5 } },
      { t: 0.85, transform: { dy: -5 } },
      { t: 1.0, transform: {} },
    ],
  },
};

export const handsOnHipsAction: WorkerActionDef = {
  id: 'idle_hands_on_hips',
  duration: 3500,
  loop: false,
  tracks: {
    leftArm: [
      { t: 0.0, transform: {} },
      { t: 0.1, transform: { dy: 1, dx: 1 } },
      { t: 0.9, transform: { dy: 1, dx: 1 } },
      { t: 1.0, transform: {} },
    ],
    rightArm: [
      { t: 0.0, transform: {} },
      { t: 0.1, transform: { dy: 1, dx: -1 } },
      { t: 0.9, transform: { dy: 1, dx: -1 } },
      { t: 1.0, transform: {} },
    ],
    leftHand: [
      { t: 0.0, transform: {} },
      { t: 0.1, transform: { dy: 1, dx: 1 } },
      { t: 0.9, transform: { dy: 1, dx: 1 } },
      { t: 1.0, transform: {} },
    ],
    rightHand: [
      { t: 0.0, transform: {} },
      { t: 0.1, transform: { dy: 1, dx: -1 } },
      { t: 0.9, transform: { dy: 1, dx: -1 } },
      { t: 1.0, transform: {} },
    ],
  },
};

export const stretchAction: WorkerActionDef = {
  id: 'idle_stretch',
  duration: 1500,
  loop: false,
  tracks: {
    leftArm: [
      { t: 0.0, transform: {} },
      { t: 0.5, transform: { dy: -5 } },
      { t: 1.0, transform: {} },
    ],
    rightArm: [
      { t: 0.0, transform: {} },
      { t: 0.5, transform: { dy: -5 } },
      { t: 1.0, transform: {} },
    ],
    leftHand: [
      { t: 0.0, transform: {} },
      { t: 0.5, transform: { dy: -5 } },
      { t: 1.0, transform: {} },
    ],
    rightHand: [
      { t: 0.0, transform: {} },
      { t: 0.5, transform: { dy: -5 } },
      { t: 1.0, transform: {} },
    ],
  },
};

export const readAction: WorkerActionDef = {
  id: 'idle_read',
  duration: 4000,
  loop: false,
  tracks: {
    leftArm: [
      { t: 0.0, transform: {} },
      { t: 0.1, transform: { dy: 1 } },
      { t: 0.9, transform: { dy: 1 } },
      { t: 1.0, transform: {} },
    ],
    rightArm: [
      { t: 0.0, transform: {} },
      { t: 0.1, transform: { dy: 1 } },
      { t: 0.9, transform: { dy: 1 } },
      { t: 1.0, transform: {} },
    ],
    leftHand: [
      { t: 0.0, transform: {} },
      { t: 0.1, transform: { dy: 1 } },
      { t: 0.9, transform: { dy: 1 } },
      { t: 1.0, transform: {} },
    ],
    rightHand: [
      { t: 0.0, transform: {} },
      { t: 0.1, transform: { dy: 1 } },
      { t: 0.9, transform: { dy: 1 } },
      { t: 1.0, transform: {} },
    ],
  },
};
