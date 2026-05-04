/**
 * Worker body skeleton — geometry definitions for the V2 renderer.
 *
 * Coordinate system:
 *   (0, 0) = ground centre of the worker.
 *   Y is negative going UP (screen-space convention).
 *   All values in "pixel units"; multiply by s (≈2.0) to get canvas pixels.
 *
 * Each BodyPartDef defines:
 *   origin  — where this part's pivot lands, in PARENT local space (parent's pivot = 0,0)
 *   pivot   — rotation/scale centre within this rect, as offset from rect top-left
 *   size    — rect dimensions in pixel units
 *   colorSlot — which WorkerAppearanceV2 field supplies the fill colour
 *   customPaint — optional override; when it returns true the default fillRect is skipped
 */
import type { WorkerAppearanceV2, AppearanceColorSlot } from './WorkerAppearanceV2';

export type BodyPartName =
  | 'shadow'
  | 'leftLeg'
  | 'rightLeg'
  | 'leftFoot'
  | 'rightFoot'
  | 'torso'
  | 'leftArm'
  | 'rightArm'
  | 'leftHand'
  | 'rightHand'
  | 'head'
  | 'leftEye'
  | 'rightEye'
  | 'hair';

export interface BodyPartDef {
  name: BodyPartName;
  parent: BodyPartName | 'root';
  /** Position of this part's pivot in parent-local coordinates (parent pivot = 0,0). */
  origin: { x: number; y: number };
  /** Rotation/scale centre expressed as offset from the rect's top-left corner. */
  pivot: { x: number; y: number };
  /** Rectangle size in pixel units. */
  size: { w: number; h: number };
  /** Which WorkerAppearanceV2 field supplies the fill colour. */
  colorSlot: AppearanceColorSlot;
  /**
   * Optional custom painter. Called with ctx already translated so that (0,0) is
   * at the part's pivot point. `showBack` is true when the worker is back-facing.
   * Return true to skip the default fillRect, false/void to draw it afterwards.
   */
  customPaint?: (
    ctx: CanvasRenderingContext2D,
    s: number,
    appearance: WorkerAppearanceV2,
    showBack: boolean
  ) => boolean | void;
}

/**
 * Flat draw order for the skeleton walker.
 * Every parent appears before its children; back/lower body parts appear before
 * front/upper parts for correct visual layering.
 */
export const DRAW_ORDER: readonly BodyPartName[] = [
  'shadow',
  'leftLeg',
  'leftFoot',
  'rightLeg',
  'rightFoot',
  'torso',
  'leftArm',
  'leftHand',
  'rightArm',
  'rightHand',
  'head',
  'hair',
  'leftEye',
  'rightEye',
] as const;

/**
 * Default body geometry.
 * The torso's customPaint draws the belt stripe; hair's customPaint is left to
 * WorkerBodyRenderer which replaces it per hatType.
 */
export const DEFAULT_BODY_DEF: readonly BodyPartDef[] = [
  // ── Shadow ───────────────────────────────────────────────────────────────
  {
    name: 'shadow',
    parent: 'root',
    origin: { x: 0, y: 0 },
    pivot: { x: 0, y: 0 },
    size: { w: 0, h: 0 },
    colorSlot: 'skin', // unused — customPaint handles everything
    customPaint: (ctx, s) => {
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(0, 0, 4 * s, 1.5 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      return true;
    },
  },

  // ── Left leg ─────────────────────────────────────────────────────────────
  {
    name: 'leftLeg',
    parent: 'root',
    origin: { x: -1, y: -4 },
    pivot: { x: 1, y: 0 },
    size: { w: 2, h: 2 },
    colorSlot: 'trouser',
  },
  {
    name: 'leftFoot',
    parent: 'leftLeg',
    origin: { x: 0, y: 2 },
    pivot: { x: 1, y: 0 },
    size: { w: 2, h: 2 },
    colorSlot: 'foot',
  },

  // ── Right leg ────────────────────────────────────────────────────────────
  {
    name: 'rightLeg',
    parent: 'root',
    origin: { x: 2, y: -4 },
    pivot: { x: 1, y: 0 },
    size: { w: 2, h: 2 },
    colorSlot: 'trouser',
  },
  {
    name: 'rightFoot',
    parent: 'rightLeg',
    origin: { x: 0, y: 2 },
    pivot: { x: 1, y: 0 },
    size: { w: 2, h: 2 },
    colorSlot: 'foot',
  },

  // ── Torso ─────────────────────────────────────────────────────────────────
  // (0,0) in customPaint = hip = y=-4 in root.
  // Torso rect spans y=-9 to y=-4 in root (-5 to 0 in customPaint).
  // Belt at y=-5 to y=-4 in root = -1 to 0 in customPaint.
  // Dress variant overrides width and adds skirt/apron.
  {
    name: 'torso',
    parent: 'root',
    origin: { x: 0, y: -4 },
    pivot: { x: 2.5, y: 5 },
    size: { w: 5, h: 5 },
    colorSlot: 'shirt',
    customPaint: (ctx, s, a, showBack) => {
      if (a.bodyVariant === 'dress') {
        // Wide dress body covering y=-9 to y=-1 in root (-5 to 3 in customPaint)
        ctx.fillStyle = a.shirtColor;
        ctx.fillRect(-3 * s, -5 * s, 7 * s, 8 * s);
        // Hem stripe
        ctx.fillStyle = _darken(a.shirtColor, 0.8);
        ctx.fillRect(-3 * s, 2 * s, 7 * s, s);
        // Front apron panel (only in front view)
        if (!showBack) {
          ctx.fillStyle = '#d8cbb8';
          ctx.fillRect(-s, -3 * s, 4 * s, 5 * s);
        }
      } else {
        ctx.fillStyle = a.shirtColor;
        ctx.fillRect(-2.5 * s, -5 * s, 5 * s, 5 * s);
        // Belt stripe at y=-5 to y=-4 in root = -1 to 0 in customPaint
        ctx.fillStyle = '#2a1f14';
        ctx.fillRect(-2.5 * s, -s, 5 * s, s);
      }
      return true;
    },
  },

  // ── Left arm ─────────────────────────────────────────────────────────────
  {
    name: 'leftArm',
    parent: 'torso',
    origin: { x: -3, y: -4 },
    pivot: { x: 1, y: 0 },
    size: { w: 2, h: 3 },
    colorSlot: 'shirt',
  },
  {
    name: 'leftHand',
    parent: 'leftArm',
    origin: { x: 0, y: 3 },
    pivot: { x: 1, y: 0 },
    size: { w: 2, h: 1 },
    colorSlot: 'skin',
  },

  // ── Right arm ────────────────────────────────────────────────────────────
  {
    name: 'rightArm',
    parent: 'torso',
    origin: { x: 4, y: -4 },
    pivot: { x: 1, y: 0 },
    size: { w: 2, h: 3 },
    colorSlot: 'shirt',
  },
  {
    name: 'rightHand',
    parent: 'rightArm',
    origin: { x: 0, y: 3 },
    pivot: { x: 1, y: 0 },
    size: { w: 2, h: 1 },
    colorSlot: 'skin',
  },

  // ── Head ─────────────────────────────────────────────────────────────────
  // pivot at bottom-centre (chin/neck).
  {
    name: 'head',
    parent: 'torso',
    origin: { x: 0, y: -5 },
    pivot: { x: 2.5, y: 4 },
    size: { w: 5, h: 4 },
    colorSlot: 'skin',
  },

  // ── Eyes (only drawn in front-facing view) ───────────────────────────────
  {
    name: 'leftEye',
    parent: 'head',
    origin: { x: -1, y: -3 },
    pivot: { x: 0.5, y: 0.5 },
    size: { w: 1, h: 1 },
    colorSlot: 'eye',
    customPaint: (ctx, s) => {
      ctx.fillStyle = '#1a1008';
      ctx.fillRect(-0.5 * s, -0.5 * s, s, s);
      return true;
    },
  },
  {
    name: 'rightEye',
    parent: 'head',
    origin: { x: 1, y: -3 },
    pivot: { x: 0.5, y: 0.5 },
    size: { w: 1, h: 1 },
    colorSlot: 'eye',
    customPaint: (ctx, s) => {
      ctx.fillStyle = '#1a1008';
      ctx.fillRect(-0.5 * s, -0.5 * s, s, s);
      return true;
    },
  },

  // ── Hair / Hat ─────────────────────────────────────────────────────────────────
  // (0,0) in customPaint = head top = y=-13 in root.
  // Hair rect default spans y=-15 to y=-12 in root (-2 to 1 in customPaint).
  // customPaint dispatches on a.hatType to paint hair or the correct hat.
  {
    name: 'hair',
    parent: 'head',
    origin: { x: 0, y: -4 },
    pivot: { x: 2.5, y: 2 },
    size: { w: 5, h: 3 },
    colorSlot: 'hair',
    customPaint: (ctx, s, a, showBack) => {
      switch (a.hatType) {
        case 'none':
        case 'cap': // TODO: distinct cap shape; use bare hair for now
        case 'hood': // TODO: distinct hood shape; use bare hair for now
          _paintBareHair(ctx, s, a.hairColor, showBack);
          break;
        case 'wide_brim':
          _paintWideBrimHat(ctx, s, a, showBack);
          break;
        case 'helmet_leather':
          _paintHelmetLeather(ctx, s, a.hairColor, showBack);
          break;
        case 'helmet_steel':
          _paintHelmetSteel(ctx, s, showBack);
          break;
        case 'crown':
          _paintHelmetSteel(ctx, s, showBack);
          _paintCrown(ctx, s);
          break;
      }
      return true;
    },
  },
] as const;

// ─── Private hair/hat paint helpers ─────────────────────────────────────────
// All helpers: (0,0) = head top = y=-13 in root.
// Coordinate legend:
//   customPaint y=0  = root y=-13 (top of head)
//   customPaint y=-1 = root y=-14
//   customPaint y=-2 = root y=-15
//   customPaint y=-3 = root y=-16

function _darken(color: string, factor: number): string {
  const rgb = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgb) {
    return `rgb(${Math.floor(+rgb[1]! * factor)},${Math.floor(+rgb[2]! * factor)},${Math.floor(+rgb[3]! * factor)})`;
  }
  const h = color.replace('#', '');
  const r = Math.floor(parseInt(h.slice(0, 2), 16) * factor);
  const g = Math.floor(parseInt(h.slice(2, 4), 16) * factor);
  const b = Math.floor(parseInt(h.slice(4, 6), 16) * factor);
  return `rgb(${r},${g},${b})`;
}

/** Bare hair: matches original px(-2,-15,5,3) + dark fringe at hairline. */
function _paintBareHair(
  ctx: CanvasRenderingContext2D,
  s: number,
  hairColor: string,
  showBack: boolean
): void {
  if (showBack) {
    // Back view: solid silhouette covers the whole head back.
    // px(-2,-14,5,5) in root = (-2,-1,5,5) in customPaint = y=-14 to y=-9 in root
    ctx.fillStyle = hairColor;
    ctx.fillRect(-2 * s, -s, 5 * s, 5 * s);
    // Small top tuft: px(0,-15,1,1) in root = (0,-2) customPaint
    ctx.fillRect(0, -2 * s, s, s);
  } else {
    // Front view: main block px(-2,-15,5,3) + dark hairline fringe
    ctx.fillStyle = hairColor;
    ctx.fillRect(-2 * s, -2 * s, 5 * s, 3 * s);
    // Dark forehead fringe at root y=-13 = customPaint y=0
    ctx.fillStyle = '#3a2a1a';
    ctx.fillRect(-2 * s, 0, 5 * s, s);
  }
}

/** Wide-brim peasant hat. Matches original hat px series. */
function _paintWideBrimHat(
  ctx: CanvasRenderingContext2D,
  s: number,
  a: WorkerAppearanceV2,
  showBack: boolean
): void {
  // Hat always visible from both sides
  // Outer brim: px(-4,-14,9,1) in root = (-4,-1) customPaint
  ctx.fillStyle = a.hatColor;
  ctx.fillRect(-4 * s, -s, 9 * s, s);
  // Inner brim: px(-3,-15,7,1) = (-3,-2) customPaint
  ctx.fillRect(-3 * s, -2 * s, 7 * s, s);
  // Hat crown: px(-1,-16,3,1) = (-1,-3) customPaint
  ctx.fillStyle = a.hatAccentColor ?? '#b89858';
  ctx.fillRect(-s, -3 * s, 3 * s, s);
  // Band: px(-3,-14,7,1,'#7a5a30') = (-3,-1) customPaint, drawn over brim
  ctx.fillStyle = '#7a5a30';
  ctx.fillRect(-3 * s, -s, 7 * s, s);
  // Small hair tuft visible below brim (front only)
  if (!showBack) {
    ctx.fillStyle = a.hairColor;
    ctx.fillRect(-2 * s, 0, 5 * s, s); // hair peeks below brim
  }
}

/** Rank-1 military: leather look = hat that matches hair colour. */
function _paintHelmetLeather(
  ctx: CanvasRenderingContext2D,
  s: number,
  hairColor: string,
  showBack: boolean
): void {
  // Same silhouette as bare hair but in leather tone
  _paintBareHair(ctx, s, hairColor, showBack);
}

/** Rank-2 military: grey steel helmet. */
function _paintHelmetSteel(ctx: CanvasRenderingContext2D, s: number, _showBack: boolean): void {
  // Helmet base: px(-3,-14,7,4) in root = (-3,-1,7,4) customPaint = y=-14 to y=-10
  ctx.fillStyle = '#5a5a5a';
  ctx.fillRect(-3 * s, -s, 7 * s, 4 * s);
  // Notches: px(-2,-15,1,1) and px(2,-15,1,1) = (-2,-2) and (2,-2) customPaint
  ctx.fillStyle = '#4a4a4a';
  ctx.fillRect(-2 * s, -2 * s, s, s);
  ctx.fillRect(2 * s, -2 * s, s, s);
}

/** Rank-3 crown (drawn on top of steel helmet). */
function _paintCrown(ctx: CanvasRenderingContext2D, s: number): void {
  // px(-2,-16,5,2,'#d4af37') = (-2,-3) customPaint
  ctx.fillStyle = '#d4af37';
  ctx.fillRect(-2 * s, -3 * s, 5 * s, 2 * s);
  // px(-1,-17,3,1,'#f0d060') = (-1,-4) customPaint
  ctx.fillStyle = '#f0d060';
  ctx.fillRect(-s, -4 * s, 3 * s, s);
  // px(0,-18,1,1,'#f8e090') = (0,-5) customPaint
  ctx.fillStyle = '#f8e090';
  ctx.fillRect(0, -5 * s, s, s);
}

/** Build a lookup map from part name to definition (for O(1) access). */
export function buildBodyDefMap(defs: readonly BodyPartDef[]): Map<BodyPartName, BodyPartDef> {
  const map = new Map<BodyPartName, BodyPartDef>();
  for (const d of defs) map.set(d.name, d);
  return map;
}
