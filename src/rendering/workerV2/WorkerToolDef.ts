/**
 * Tool definitions for the V2 worker renderer.
 *
 * Each tool is a PNG sprite attached to a specific hand.
 * gripOffset is the pixel on the sprite that aligns with the hand's pivot.
 * initialRotation is the at-rest angle (radians). Positive = clockwise.
 * Actions that drive rotation on the hand cause the tool to rotate
 * around its grip point automatically (since it's in hand-local space).
 */

export interface WorkerToolDef {
  /** Matches a resource id, e.g. 'axe', 'hammer', 'fishing_rod'. */
  resourceId: string;
  /** Absolute path for loadSprite(), e.g. '/assets/resources/axe.png'. */
  spritePath: string;
  /**
   * Pixel offset from the sprite's top-left corner to the grip/hold point.
   * This point will coincide with the hand's pivot when drawn.
   */
  gripOffset: { x: number; y: number };
  /**
   * Resting rotation in radians (applied before any action-driven rotation).
   * Positive = clockwise.
   */
  initialRotation: number;
  /** Sprite render size in pixel units (before × s). */
  renderSize: { w: number; h: number };
  /** Which hand to attach to. Can be overridden when equipping a worker. */
  defaultHand: 'left' | 'right';
}

/**
 * Default tool definitions.
 * gripOffset and initialRotation are approximate — tune after first visual pass.
 */
export const TOOL_DEFS: readonly WorkerToolDef[] = [
  {
    resourceId: 'axe',
    spritePath: '/assets/resources/axe.png',
    gripOffset: { x: 3, y: 8 },
    initialRotation: -0.3,
    renderSize: { w: 10, h: 10 },
    defaultHand: 'right',
  },
  {
    resourceId: 'hammer',
    spritePath: '/assets/resources/hammer.png',
    gripOffset: { x: 3, y: 8 },
    initialRotation: -0.2,
    renderSize: { w: 10, h: 10 },
    defaultHand: 'right',
  },
  {
    resourceId: 'pickaxe',
    spritePath: '/assets/resources/pickaxe.png',
    gripOffset: { x: 3, y: 8 },
    initialRotation: -0.35,
    renderSize: { w: 10, h: 10 },
    defaultHand: 'right',
  },
  {
    resourceId: 'shovel',
    spritePath: '/assets/resources/shovel.png',
    gripOffset: { x: 2, y: 8 },
    initialRotation: 0,
    renderSize: { w: 10, h: 10 },
    defaultHand: 'right',
  },
  {
    resourceId: 'fishing_rod',
    spritePath: '/assets/resources/fishing_rod.png',
    gripOffset: { x: 1, y: 8 },
    initialRotation: -0.15,
    renderSize: { w: 10, h: 10 },
    defaultHand: 'right',
  },
  {
    resourceId: 'sword',
    spritePath: '/assets/resources/sword.png',
    gripOffset: { x: 3, y: 6 },
    initialRotation: 0.1,
    renderSize: { w: 9, h: 9 },
    defaultHand: 'right',
  },
  {
    resourceId: 'shield',
    spritePath: '/assets/resources/shield.png',
    gripOffset: { x: 4, y: 6 },
    initialRotation: 0,
    renderSize: { w: 9, h: 9 },
    defaultHand: 'left',
  },

  // ── Overhead carry items ────────────────────────────────────────────────
  // All use gripOffset {x:2, y:7} so the item appears at the correct overhead
  // position above the worker's hands.
  {
    resourceId: 'wood_log',
    spritePath: '/assets/resources/wood_log.png',
    gripOffset: { x: 2, y: 7 },
    initialRotation: 0,
    renderSize: { w: 10, h: 10 },
    defaultHand: 'left',
  },
  {
    resourceId: 'water',
    spritePath: '/assets/resources/water.png',
    gripOffset: { x: 2, y: 7 },
    initialRotation: 0,
    renderSize: { w: 10, h: 10 },
    defaultHand: 'left',
  },
  {
    resourceId: 'flour',
    spritePath: '/assets/resources/flour.png',
    gripOffset: { x: 2, y: 7 },
    initialRotation: 0,
    renderSize: { w: 10, h: 10 },
    defaultHand: 'left',
  },
  {
    resourceId: 'stone',
    spritePath: '/assets/resources/stone.png',
    gripOffset: { x: 2, y: 7 },
    initialRotation: 0,
    renderSize: { w: 10, h: 10 },
    defaultHand: 'left',
  },
  {
    resourceId: 'board',
    spritePath: '/assets/resources/board.png',
    gripOffset: { x: 2, y: 7 },
    initialRotation: 0,
    renderSize: { w: 10, h: 10 },
    defaultHand: 'left',
  },
  {
    resourceId: 'bread',
    spritePath: '/assets/resources/bread.png',
    gripOffset: { x: 2, y: 7 },
    initialRotation: 0,
    renderSize: { w: 8, h: 8 },
    defaultHand: 'left',
  },
  {
    resourceId: 'fish',
    spritePath: '/assets/resources/fish.png',
    gripOffset: { x: 2, y: 7 },
    initialRotation: 0,
    renderSize: { w: 10, h: 10 },
    defaultHand: 'left',
  },
  {
    resourceId: 'ham',
    spritePath: '/assets/resources/ham.png',
    gripOffset: { x: 2, y: 7 },
    initialRotation: 0,
    renderSize: { w: 10, h: 10 },
    defaultHand: 'left',
  },
  {
    resourceId: 'gold_coin',
    spritePath: '/assets/resources/gold_coin.png',
    gripOffset: { x: 2, y: 7 },
    initialRotation: 0,
    renderSize: { w: 8, h: 8 },
    defaultHand: 'left',
  },
];

/** Look up a tool definition by resource id. Returns undefined if not found. */
export function getToolDef(resourceId: string): WorkerToolDef | undefined {
  return TOOL_DEFS.find(t => t.resourceId === resourceId);
}
