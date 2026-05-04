/**
 * WorkerBodyRenderer — Phase 1–6 implementation.
 *
 * Public entry points:
 *   paintWorkerV2()           — draw a worker given a pre-built pose
 *   computeWorkerV2State()    — derive pose + tools from a Worker component
 *   paintWorkerFromLegacy()   — convenience shim used by RenderSystem
 *
 * Coordinate system: (0,0) = worker ground centre.
 * Y is negative going UP (screen-space). All units in "pixel units" × s.
 */

import type { Worker } from '@/components/Worker';
import { inferHeldItemStyle } from '@/components/Worker';
import { applyHueShift, resolveColorSlot, migrateAppearance } from './WorkerAppearanceV2';
import type { WorkerAppearanceV2, HatType } from './WorkerAppearanceV2';
import { DEFAULT_BODY_DEF, DRAW_ORDER, buildBodyDefMap } from './WorkerBodyDef';
import type { BodyPartDef, BodyPartName } from './WorkerBodyDef';
import type { WorkerBodyPose } from './ActionPlayer';
import type { BodyPartTransform, WorkerActionDef } from './ActionDef';
import { interpolateTrack } from './ActionDef';
import { getToolDef } from './WorkerToolDef';
import type { WorkerToolDef } from './WorkerToolDef';
import { walkAction } from './actions/locomotion';
import {
  lookAroundAction,
  scratchHeadAction,
  handsOnHipsAction,
  stretchAction,
  readAction,
} from './actions/idle';
import {
  carryOverheadStandAction,
  carryOverheadWalkAction,
  carrySideStandAction,
  carrySideWalkAction,
} from './actions/carry';
import {
  workHammerAction,
  workChopAction,
  workDigAction,
  workFishAction,
  workWellAction,
  workCombatDuelAction,
  workBinocularsAction,
} from './actions/jobs';

// ─── Module-level caches ─────────────────────────────────────────────────────

const BODY_DEF_MAP = buildBodyDefMap(DEFAULT_BODY_DEF);

const CHILDREN_OF: Map<string, BodyPartName[]> = (() => {
  const map = new Map<string, BodyPartName[]>();
  for (const part of DEFAULT_BODY_DEF) {
    const list = map.get(part.parent) ?? [];
    list.push(part.name);
    map.set(part.parent, list);
  }
  const orderIndex = new Map(DRAW_ORDER.map((n, i) => [n, i]));
  for (const [, children] of map) {
    children.sort((a, b) => (orderIndex.get(a) ?? 99) - (orderIndex.get(b) ?? 99));
  }
  return map;
})();

// ─── Public types ────────────────────────────────────────────────────────────

export interface PaintWorkerV2Options {
  appearance: WorkerAppearanceV2;
  pose: WorkerBodyPose;
  scale: number;
  /** 0=SE  1=SW  2=NW  3=NE */
  facing: number;
  leftTool?: WorkerToolDef;
  rightTool?: WorkerToolDef;
  alpha?: number;
  /**
   * Hue shift in degrees applied to cloth colours before painting.
   * Positive → shifts toward red/orange (enemy faction tint).
   */
  hueShiftDeg?: number;
}

export interface WorkerV2State {
  pose: WorkerBodyPose;
  leftTool: WorkerToolDef | undefined;
  rightTool: WorkerToolDef | undefined;
  /** Global Y offset in pixel units applied to the whole worker before rendering. */
  globalOffsetY: number;
  /** Override alpha (0–1) — used for combat_fallen fade. */
  alpha: number;
  /** When true the worker should be rotated -90° before painting (floor nap / fallen). */
  layFlat: boolean;
}

// ─── Main entry points ───────────────────────────────────────────────────────

/**
 * Paint a worker using the V2 skeletal renderer.
 * Caller must translate the canvas to the worker's screen position first.
 */
export function paintWorkerV2(
  ctx: CanvasRenderingContext2D,
  loadSprite: (path: string) => HTMLImageElement | null,
  opts: PaintWorkerV2Options
): void {
  const { pose, scale: s, facing, alpha = 1, hueShiftDeg = 0 } = opts;

  let appearance = opts.appearance;
  if (hueShiftDeg !== 0) appearance = applyHueShift(appearance, hueShiftDeg);

  const mirror = facing === 1 || facing === 2;
  const showBack = facing === 2 || facing === 3;

  ctx.save();
  if (alpha !== 1) ctx.globalAlpha *= alpha;
  if (mirror) ctx.scale(-1, 1);

  const rootChildren = CHILDREN_OF.get('root') ?? [];
  for (const partName of rootChildren) {
    _renderPartTree(ctx, loadSprite, partName, pose, appearance, s, showBack, opts);
  }

  ctx.restore();
}

/**
 * Derive the full render state from a Worker component.
 * Stateless — called each frame.
 */
export function computeWorkerV2State(
  worker: Worker,
  isMoving: boolean,
  now: number
): WorkerV2State {
  const carrying = worker.carryingResource;
  const activity = worker.visualActivity;
  const isMilitary = worker.role === 'military';

  // ── Combat fallen ──────────────────────────────────────────────────────────
  if (activity === 'combat_fallen') {
    const fadeUntil = worker.buildIdleUntil || now;
    const alpha = Math.max(0, Math.min(1, (fadeUntil - now) / 2000));
    return {
      pose: new Map(),
      leftTool: undefined,
      rightTool: undefined,
      globalOffsetY: 0,
      alpha,
      layFlat: true,
    };
  }

  // ── Floor nap ──────────────────────────────────────────────────────────────
  if (
    !isMoving &&
    worker.state === 'idle' &&
    worker.floorSleepUntilMs != null &&
    now < worker.floorSleepUntilMs
  ) {
    return {
      pose: _buildNapPose(),
      leftTool: undefined,
      rightTool: undefined,
      globalOffsetY: 0,
      alpha: 1,
      layFlat: true,
    };
  }

  // ── Tool assignment ─────────────────────────────────────────────────────────
  // Military always carry sword (right) + shield (left).
  // Civilians: side-carry tools go to the right hand; overhead items go to the
  // left hand so that with gripOffset {x:2,y:7} the sprite lands at (-4,-22) in
  // root — exactly matching the original painter's item position.
  let leftTool: WorkerToolDef | undefined;
  let rightTool: WorkerToolDef | undefined;

  if (isMilitary) {
    leftTool = getToolDef('shield');
    rightTool = getToolDef('sword');
  } else if (carrying) {
    const toolDef = _toolForCarriedResource(carrying);
    if (toolDef) {
      if (inferHeldItemStyle(carrying) === 'side') {
        rightTool = toolDef; // axe, hammer, pickaxe, shovel, fishing_rod
      } else {
        leftTool = toolDef; // wood_log, water, flour, stone, board, etc.
      }
    }
  }

  // ── Select action ──────────────────────────────────────────────────────────
  let action: WorkerActionDef;
  let startTime = 0; // only used for non-looping idle anims

  if (isMilitary && activity === 'combat_duel') {
    action = workCombatDuelAction;
  } else if (!isMoving && worker.state === 'working' && activity === 'explore_scout') {
    action = workBinocularsAction;
  } else if (!isMoving && worker.state === 'working' && carrying) {
    action = _jobAction(worker, carrying, activity);
  } else if (isMoving) {
    if (carrying) {
      const style = inferHeldItemStyle(carrying);
      action = style === 'overhead' ? carryOverheadWalkAction : carrySideWalkAction;
    } else {
      action = walkAction;
    }
  } else {
    // Standing still
    const idle = _idleAction(worker);
    if (idle) {
      action = idle;
      startTime = worker.idleAnimStart;
    } else if (carrying) {
      const style = inferHeldItemStyle(carrying);
      action = style === 'overhead' ? carryOverheadStandAction : carrySideStandAction;
    } else {
      // Base pose — empty tracks
      return {
        pose: new Map(),
        leftTool,
        rightTool,
        globalOffsetY: 0,
        alpha: 1,
        layFlat: false,
      };
    }
  }

  const t = action.loop
    ? (now % action.duration) / action.duration
    : Math.min((now - startTime) / action.duration, 1);

  return {
    pose: _interpolateAllTracks(action.tracks, t),
    leftTool,
    rightTool,
    globalOffsetY: 0,
    alpha: 1,
    layFlat: false,
  };
}

/**
 * Convenience shim used by RenderSystem during migration.
 * Migrates the legacy Worker.appearance, computes state, and paints.
 */
export function paintWorkerFromLegacy(
  ctx: CanvasRenderingContext2D,
  loadSprite: (path: string) => HTMLImageElement | null,
  worker: Worker,
  isMoving: boolean,
  facing: number,
  now: number,
  scale: number,
  enemyTint: boolean
): void {
  const state = computeWorkerV2State(worker, isMoving, now);

  const appearance = _buildAppearance(worker);

  if (state.layFlat) {
    ctx.save();
    ctx.globalAlpha *= state.alpha;
    // Rotate worker -90° to lay flat, offset matches original painter
    ctx.translate(0, 2.5 * scale - 10);
    ctx.rotate(-Math.PI / 2);
    ctx.translate(-2 * scale, 8.5 * scale);
    paintWorkerV2(ctx, loadSprite, {
      appearance,
      pose: state.pose,
      scale,
      facing,
      hueShiftDeg: enemyTint ? 150 : 0,
    });
    ctx.restore();
    return;
  }

  paintWorkerV2(ctx, loadSprite, {
    appearance,
    pose: state.pose,
    scale,
    facing,
    leftTool: state.leftTool,
    rightTool: state.rightTool,
    alpha: state.alpha,
    hueShiftDeg: enemyTint ? 150 : 0,
  });
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function _buildAppearance(worker: Worker): WorkerAppearanceV2 {
  const base = migrateAppearance(worker.appearance);
  if (worker.role === 'military') {
    // Military rank determines hat type; override what migrateAppearance guessed
    const hatMap: Record<number, HatType> = {
      1: 'helmet_leather',
      2: 'helmet_steel',
      3: 'crown',
    };
    return { ...base, hatType: hatMap[worker.militaryRank] ?? 'helmet_leather' };
  }
  if (worker.isExplorer) {
    // Override hat colours to camo green regardless of hair colour
    return { ...base, isExplorer: true, hatColor: '#3a4a25', hatAccentColor: '#2a3518' };
  }
  return base;
}

function _toolForCarriedResource(resource: string | undefined): WorkerToolDef | undefined {
  if (!resource) return undefined;
  return getToolDef(resource);
}

function _jobAction(worker: Worker, carrying: string, activity: string): WorkerActionDef {
  // Hammer construction
  if (carrying === 'hammer' && activity === 'construct' && worker.hammerConstructionEnabled) {
    return workHammerAction;
  }
  // Digging (planting / survey)
  if (carrying === 'shovel' && (activity === 'production_plant' || activity === 'survey_dig')) {
    return workDigAction;
  }
  // Stone / ore gathering (pickaxe)
  if (carrying === 'pickaxe' && activity === 'production_gather') {
    return workChopAction;
  }
  // Woodcutting (axe)
  if (carrying === 'axe' && activity === 'production_gather') {
    return workChopAction;
  }
  // Fishing (rod in hand while at the bank)
  if (carrying === 'fishing_rod' && activity === 'production_gather') {
    return workFishAction;
  }
  // Well drawing
  if (activity === 'production_well' && carrying === 'water') {
    return workWellAction;
  }
  // Mill / bakery operating
  if (activity === 'production_mill') {
    return workWellAction;
  }
  // Fallback: stand with item (side or overhead based on style)
  const style = inferHeldItemStyle(carrying);
  return style === 'overhead' ? carryOverheadStandAction : carrySideStandAction;
}

function _idleAction(worker: Worker): WorkerActionDef | null {
  switch (worker.idleAnim) {
    case 'look_around':
      return lookAroundAction;
    case 'scratch_head':
      return scratchHeadAction;
    case 'hands_on_hips':
      return handsOnHipsAction;
    case 'stretch':
      return stretchAction;
    case 'read':
      return readAction;
    default:
      return null;
  }
}

/** Floor-nap pose: arms arranged as a pillow under the head. */
function _buildNapPose(): WorkerBodyPose {
  const pose: WorkerBodyPose = new Map();
  pose.set('leftArm', { dx: -1, dy: -1 });
  pose.set('leftHand', { dy: 2 });
  pose.set('rightArm', { dx: -1, dy: -3 });
  pose.set('rightHand', { dy: -2 });
  return pose;
}

function _interpolateAllTracks(tracks: WorkerActionDef['tracks'], t: number): WorkerBodyPose {
  const pose: WorkerBodyPose = new Map();
  for (const partName of Object.keys(tracks) as BodyPartName[]) {
    const track = tracks[partName];
    if (!track) continue;
    const transform = interpolateTrack(track, t);
    if (transform) pose.set(partName, transform);
  }
  return pose;
}

// ─── Skeleton renderer ────────────────────────────────────────────────────────

function _renderPartTree(
  ctx: CanvasRenderingContext2D,
  loadSprite: (path: string) => HTMLImageElement | null,
  partName: BodyPartName,
  pose: WorkerBodyPose,
  appearance: WorkerAppearanceV2,
  s: number,
  showBack: boolean,
  opts: PaintWorkerV2Options
): void {
  const part: BodyPartDef | undefined = BODY_DEF_MAP.get(partName);
  if (!part) return;

  if (showBack && (partName === 'leftEye' || partName === 'rightEye')) return;

  const delta: BodyPartTransform | undefined = pose.get(partName);
  const dx = (delta?.dx ?? 0) * s;
  const dy = (delta?.dy ?? 0) * s;
  const rotation = delta?.rotation ?? 0;
  const scaleX = delta?.scaleX ?? 1;
  const scaleY = delta?.scaleY ?? 1;

  ctx.save();
  ctx.translate(part.origin.x * s + dx, part.origin.y * s + dy);
  if (rotation !== 0) ctx.rotate(rotation);
  if (scaleX !== 1 || scaleY !== 1) ctx.scale(scaleX, scaleY);

  const skipDefault = part.customPaint?.(ctx, s, appearance, showBack) ?? false;
  if (!skipDefault && (part.size.w > 0 || part.size.h > 0)) {
    ctx.fillStyle = resolveColorSlot(part.colorSlot, appearance);
    ctx.fillRect(-part.pivot.x * s, -part.pivot.y * s, part.size.w * s, part.size.h * s);
  }

  if (partName === 'leftHand' && opts.leftTool) _drawTool(ctx, loadSprite, opts.leftTool, s);
  if (partName === 'rightHand' && opts.rightTool) _drawTool(ctx, loadSprite, opts.rightTool, s);

  const children = CHILDREN_OF.get(partName);
  if (children) {
    for (const childName of children) {
      _renderPartTree(ctx, loadSprite, childName, pose, appearance, s, showBack, opts);
    }
  }

  ctx.restore();
}

function _drawTool(
  ctx: CanvasRenderingContext2D,
  loadSprite: (path: string) => HTMLImageElement | null,
  tool: WorkerToolDef,
  s: number
): void {
  const sprite = loadSprite(tool.spritePath);
  if (!sprite) return;
  ctx.save();
  if (tool.initialRotation !== 0) ctx.rotate(tool.initialRotation);
  ctx.drawImage(
    sprite,
    -tool.gripOffset.x * s,
    -tool.gripOffset.y * s,
    tool.renderSize.w * s,
    tool.renderSize.h * s
  );
  ctx.restore();
}
