/**
 * Job-activity animations for V2 workers.
 * All are looping; the caller plays them when state=working and not moving.
 */
import type { WorkerActionDef } from '../ActionDef';

/**
 * Hammer construction: right arm swings up/down rapidly, body bobs.
 * ~820 ms for two full swings (matches original sin(now/130) cadence).
 */
export const workHammerAction: WorkerActionDef = {
  id: 'work_hammer',
  duration: 820,
  loop: true,
  tracks: {
    torso: [
      { t: 0, transform: {} },
      { t: 0.25, transform: { dy: 1 } },
      { t: 0.5, transform: {} },
      { t: 0.75, transform: { dy: 1 } },
      { t: 1, transform: {} },
    ],
    rightArm: [
      { t: 0, transform: { dy: 1 } }, // arm low (ready)
      { t: 0.15, transform: { dy: -7 } }, // arm raised (strike peak)
      { t: 0.5, transform: { dy: 1 } }, // arm low
      { t: 0.65, transform: { dy: -7 } }, // second strike
      { t: 1, transform: { dy: 1 } },
    ],
  },
};

/**
 * Chop/mine: right arm swings (pickaxe or axe), left arm counters slightly.
 * ~660 ms period (matches original sin(now/105) cadence).
 */
export const workChopAction: WorkerActionDef = {
  id: 'work_chop',
  duration: 660,
  loop: true,
  tracks: {
    rightArm: [
      { t: 0, transform: { dy: 0 } },
      { t: 0.25, transform: { dy: -3.5 } }, // up (backswing)
      { t: 0.5, transform: { dy: 0 } },
      { t: 0.75, transform: { dy: 3.5 } }, // down (strike)
      { t: 1, transform: { dy: 0 } },
    ],
    leftArm: [
      { t: 0, transform: { dy: 0 } },
      { t: 0.25, transform: { dy: -1 } },
      { t: 0.5, transform: { dy: 0 } },
      { t: 0.75, transform: { dy: 1 } },
      { t: 1, transform: { dy: 0 } },
    ],
  },
};

/**
 * Digging / surveying: whole body bobs and leans forward, shovel dips.
 * ~800 ms bob period.
 */
export const workDigAction: WorkerActionDef = {
  id: 'work_dig',
  duration: 800,
  loop: true,
  tracks: {
    torso: [
      { t: 0, transform: {} },
      { t: 0.3, transform: { dy: 2, dx: 0.5 } }, // lean forward + down
      { t: 0.6, transform: { dy: 2, dx: 0.5 } }, // hold low
      { t: 1, transform: {} },
    ],
    rightArm: [
      { t: 0, transform: { dy: 0 } },
      { t: 0.3, transform: { dy: 2 } },
      { t: 0.6, transform: { dy: 2 } },
      { t: 1, transform: { dy: 0 } },
    ],
  },
};

/**
 * Fishing: whole body shifted down toward the water bank, legs spread apart.
 * Arms hold rod at hip (side carry position — no separate arm motion).
 * Slow body sway (2.2 s period) matches original sin(now/1100).
 */
export const workFishAction: WorkerActionDef = {
  id: 'work_fish',
  duration: 2200,
  loop: true,
  tracks: {
    // Torso (and children: arms, head) shift down toward water
    torso: [
      { t: 0, transform: { dy: 2.65 } },
      { t: 0.5, transform: { dy: 2.87 } }, // + 0.22 unit squat
      { t: 1, transform: { dy: 2.65 } },
    ],
    // Legs also shift down + spread
    leftLeg: [
      { t: 0, transform: { dy: 2.65, dx: -1 } },
      { t: 1, transform: { dy: 2.65, dx: -1 } },
    ],
    rightLeg: [
      { t: 0, transform: { dy: 2.65, dx: 1 } },
      { t: 1, transform: { dy: 2.65, dx: 1 } },
    ],
    // Hands at hip grip position
    leftHand: [{ t: 0, transform: { dy: 1 } }],
    rightHand: [{ t: 0, transform: { dy: 1 } }],
  },
};

/**
 * Well / rope pull: both arms raised overhead, alternating up/down.
 * ~1257 ms period (matches original sin(now/200) cadence).
 */
export const workWellAction: WorkerActionDef = {
  id: 'work_well',
  duration: 1257,
  loop: true,
  tracks: {
    // Arms rotate upward (π) so sleeve is visible, with alternating pull motion.
    // dy oscillates ±2.5 around the raised position dy=-4.
    leftArm: [
      { t: 0, transform: { dx: 1, dy: -4, rotation: Math.PI } },
      { t: 0.25, transform: { dx: 1, dy: -4 + 2.5, rotation: Math.PI } }, // pulls down
      { t: 0.5, transform: { dx: 1, dy: -4, rotation: Math.PI } },
      { t: 0.75, transform: { dx: 1, dy: -4 - 2.5, rotation: Math.PI } }, // pushes up
      { t: 1, transform: { dx: 1, dy: -4, rotation: Math.PI } },
    ],
    rightArm: [
      { t: 0, transform: { dx: -1, dy: -4, rotation: Math.PI } },
      { t: 0.25, transform: { dx: -1, dy: -4 - 2.5, rotation: Math.PI } }, // opposite phase
      { t: 0.5, transform: { dx: -1, dy: -4, rotation: Math.PI } },
      { t: 0.75, transform: { dx: -1, dy: -4 + 2.5, rotation: Math.PI } },
      { t: 1, transform: { dx: -1, dy: -4, rotation: Math.PI } },
    ],
  },
};

/**
 * Binoculars scan: both arms raised to eye level, head sweeps left then right.
 * Used when an explorer stops to survey the horizon.
 * 3000 ms loop.
 */
export const workBinocularsAction: WorkerActionDef = {
  id: 'work_binoculars',
  duration: 3000,
  loop: true,
  tracks: {
    torso: [
      { t: 0.0, transform: {} },
      { t: 0.12, transform: { dy: -0.5 } },
      { t: 0.85, transform: { dy: -0.5 } },
      { t: 1.0, transform: {} },
    ],
    rightArm: [
      { t: 0.0, transform: {} },
      { t: 0.12, transform: { dy: -6, dx: -1 } },
      { t: 0.85, transform: { dy: -6, dx: -1 } },
      { t: 1.0, transform: {} },
    ],
    leftArm: [
      { t: 0.0, transform: {} },
      { t: 0.12, transform: { dy: -6, dx: 1 } },
      { t: 0.85, transform: { dy: -6, dx: 1 } },
      { t: 1.0, transform: {} },
    ],
    rightHand: [
      { t: 0.0, transform: {} },
      { t: 0.12, transform: { dy: -6, dx: -1 } },
      { t: 0.85, transform: { dy: -6, dx: -1 } },
      { t: 1.0, transform: {} },
    ],
    leftHand: [
      { t: 0.0, transform: {} },
      { t: 0.12, transform: { dy: -6, dx: 1 } },
      { t: 0.85, transform: { dy: -6, dx: 1 } },
      { t: 1.0, transform: {} },
    ],
    head: [
      { t: 0.0, transform: {} },
      { t: 0.12, transform: {} },
      { t: 0.35, transform: { dx: -1.5 } },
      { t: 0.55, transform: { dx: 1.5 } },
      { t: 0.78, transform: {} },
      { t: 0.85, transform: {} },
      { t: 1.0, transform: {} },
    ],
  },
};

/**
 * Combat duel: sword arm swings forward/back, body bobs and leans.
 * 580 ms period (matches original now/145 cadence).
 */
export const workCombatDuelAction: WorkerActionDef = {
  id: 'combat_duel',
  duration: 580,
  loop: true,
  tracks: {
    torso: [
      { t: 0, transform: {} },
      { t: 0.5, transform: { dy: -1, dx: 0.5 } }, // forward lean
      { t: 1, transform: {} },
    ],
    rightArm: [
      { t: 0, transform: { dy: 2.2 } }, // sword low
      { t: 0.25, transform: { dy: -2.2 } }, // sword raised
      { t: 0.75, transform: { dy: 2.2 } },
      { t: 1, transform: { dy: 2.2 } },
    ],
    leftArm: [
      { t: 0, transform: { dx: -2, dy: -1 } }, // shield brace
      { t: 0.5, transform: { dx: -3, dy: -1 } }, // brace extends
      { t: 1, transform: { dx: -2, dy: -1 } },
    ],
  },
};
