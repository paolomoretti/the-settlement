/**
 * Carry pose actions for V2 workers.
 *
 * Coordinate reference (pixel units, ground = y=0, up = more negative):
 *   Arms at rest: pivot at y=-8 in root.
 *
 *   Overhead carry — ROTATION approach:
 *     rotation: Math.PI flips the arm so it extends UPWARD from the shoulder.
 *     dy: -4 moves the shoulder pivot to y=-12 in root.
 *     → Arm rect visible: y=-15 to y=-12 (arm sleeve above head).
 *     → Hand (child at arm-local y=3, rotated) lands at y=-15. ✓
 *     → Item drawn at hand with gripOffset {x:2,y:7} → item at (-4,-22). ✓
 *     dx: ±1 brings arms slightly inward (matching original leftArmX=-3 / rightArmX=2).
 *
 *   Side carry: hand dy=+1 → hand drops 1 unit to hip-grip position at y=-4.
 */
import type { WorkerActionDef } from '../ActionDef';

const WALK_LEGS = {
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
};

/**
 * Standing with item held overhead.
 * Arms rotate 180° (π) to point upward; arm sleeve visible y=-15→-12, hand at y=-15.
 */
export const carryOverheadStandAction: WorkerActionDef = {
  id: 'carry_overhead_stand',
  duration: 1000,
  loop: true,
  tracks: {
    leftArm: [{ t: 0, transform: { dx: 1, dy: -4, rotation: Math.PI } }],
    rightArm: [{ t: 0, transform: { dx: -1, dy: -4, rotation: Math.PI } }],
  },
};

/** Walking with item held overhead. Legs walk, arms stay rotated upward. */
export const carryOverheadWalkAction: WorkerActionDef = {
  id: 'carry_overhead_walk',
  duration: 800,
  loop: true,
  tracks: {
    ...WALK_LEGS,
    leftArm: [
      { t: 0, transform: { dx: 1, dy: -4, rotation: Math.PI } },
      { t: 1, transform: { dx: 1, dy: -4, rotation: Math.PI } },
    ],
    rightArm: [
      { t: 0, transform: { dx: -1, dy: -4, rotation: Math.PI } },
      { t: 1, transform: { dx: -1, dy: -4, rotation: Math.PI } },
    ],
  },
};

/** Standing with side tool (at hip). Hand drops 1 unit to grip position. */
export const carrySideStandAction: WorkerActionDef = {
  id: 'carry_side_stand',
  duration: 1000,
  loop: true,
  tracks: {
    leftHand: [{ t: 0, transform: { dy: 1 } }],
    rightHand: [{ t: 0, transform: { dy: 1 } }],
  },
};

/**
 * Walking with side tool. Legs walk, arms wobble at half-swing,
 * hands stay at grip position (dy=+1 from wrist).
 * The hand dy is additive on top of arm dy (child inherits parent transform).
 */
export const carrySideWalkAction: WorkerActionDef = {
  id: 'carry_side_walk',
  duration: 800,
  loop: true,
  tracks: {
    ...WALK_LEGS,
    leftArm: [
      { t: 0, transform: { dy: 0 } },
      { t: 0.25, transform: { dy: 0.5 } },
      { t: 0.5, transform: { dy: 0 } },
      { t: 0.75, transform: { dy: -0.5 } },
      { t: 1, transform: { dy: 0 } },
    ],
    rightArm: [
      { t: 0, transform: { dy: 0 } },
      { t: 0.25, transform: { dy: -0.5 } },
      { t: 0.5, transform: { dy: 0 } },
      { t: 0.75, transform: { dy: 0.5 } },
      { t: 1, transform: { dy: 0 } },
    ],
    leftHand: [
      { t: 0, transform: { dy: 1 } },
      { t: 1, transform: { dy: 1 } },
    ],
    rightHand: [
      { t: 0, transform: { dy: 1 } },
      { t: 1, transform: { dy: 1 } },
    ],
  },
};
