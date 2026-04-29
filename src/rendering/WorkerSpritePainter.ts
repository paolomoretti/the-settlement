/**
 * Procedural worker body drawing (shared by RenderSystem and debug catalogue).
 */

import type { Worker, IdleAnim, WorkerAppearance } from '@/components/Worker';

const RESOURCE_ICON_DRAW_SCALE = 1.25;

function clampColorChannel(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function parseCssColor(color: string): { r: number; g: number; b: number } {
  const rgb = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
    };
  }
  const hex = color.replace('#', '');
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function darkenColor(color: string, factor: number): string {
  const { r, g, b } = parseCssColor(color);
  return `rgb(${Math.floor(r * factor)}, ${Math.floor(g * factor)}, ${Math.floor(b * factor)})`;
}

function tintClothEnemyRed(color: string): string {
  const { r, g, b } = parseCssColor(color);
  const lum = r * 0.3 + g * 0.59 + b * 0.11;
  const rr = Math.floor(55 + lum * 0.72);
  const gg = Math.floor(10 + lum * 0.18);
  const bb = Math.floor(14 + lum * 0.16);
  return `rgb(${clampColorChannel(rr)}, ${clampColorChannel(gg)}, ${clampColorChannel(bb)})`;
}

function enemyTintAppearance(appearance: WorkerAppearance): WorkerAppearance {
  return {
    ...appearance,
    tunic: tintClothEnemyRed(appearance.tunic),
    pants: tintClothEnemyRed(appearance.pants),
    boots: tintClothEnemyRed(appearance.boots),
  };
}

function paintMilitaryWarrior(
  ctx: CanvasRenderingContext2D,
  loadSprite: (path: string) => HTMLImageElement | null,
  s: number,
  facing: number,
  isMoving: boolean,
  frame: number,
  now: number,
  worker: Worker,
  enemyTint: boolean = false
): void {
  const a = enemyTint ? enemyTintAppearance(worker.appearance) : worker.appearance;
  const rank = worker.militaryRank;
  const mirror = facing === 1 || facing === 2;
  const showBack = facing === 2 || facing === 3;
  const isCombatDuel = worker.visualActivity === 'combat_duel';
  if (mirror) ctx.scale(-1, 1);

  const legOffsets = [[0, 0], [-1, 1], [0, 0], [1, -1]] as const;
  const [leftLeg, rightLeg] = isCombatDuel ? [0, 0] : legOffsets[frame];
  const duelT = isCombatDuel ? now / 145 : 0;
  const duelSwing = isCombatDuel ? Math.sin(duelT) * 2.2 + Math.sin(duelT * 0.47) * 0.9 : 0;
  const shieldBrace = isCombatDuel ? Math.cos(duelT * 0.85) * 1.15 : 0;
  const walkArmSwing = isCombatDuel ? duelSwing : isMoving ? (frame === 1 ? 1 : frame === 3 ? -1 : 0) : 0;
  if (isCombatDuel) {
    ctx.translate(0, Math.sin(duelT * 0.7) * 0.35 * s);
  }

  const px = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x * s, y * s, w * s, h * s);
  };

  ctx.globalAlpha = 0.2;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(0, 0, 4 * s, 1.5 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  px(-2 + leftLeg, -2, 2, 2, a.boots);
  px(1 + rightLeg, -2, 2, 2, a.boots);
  px(-2, -9, 5, 5, a.tunic);
  px(-2, -5, 5, 1, darkenColor(a.tunic, 0.75));

  if (rank >= 2) {
    // Helmet is visible from both front and back.
    px(-3, -14, 7, 4, '#5a5a5a');
    px(-2, -15, 1, 1, '#4a4a4a');
    px(2, -15, 1, 1, '#4a4a4a');
    if (rank >= 3) {
      // Rank-3: thinner gold helm, only as wide as the head.
      px(-2, -16, 5, 2, '#d4af37');
      px(-1, -17, 3, 1, '#f0d060');
      px(0, -18, 1, 1, '#f8e090');
      px(-3, -16, 1, 2, '#3a2a1e');
      px(3, -16, 1, 2, '#3a2a1e');
    }
  } else {
    // Rank-1 keeps hair silhouette even while back-facing.
    px(-2, -15, 5, 3, a.hair);
  }

  if (!showBack) {
    px(-2, -13, 5, 4, a.skin);
    px(-1, -12, 1, 1, '#1a1008');
    px(1, -12, 1, 1, '#1a1008');
  } else {
    // Back view still needs a visible head mass (avoid "legs + square" look).
    px(-2, -13, 5, 3, darkenColor(a.tunic, 0.72));
  }

  const goldTrim = rank >= 3;
  const swordSprite = loadSprite('/assets/resources/sword.png');
  const shieldSprite = loadSprite('/assets/resources/shield.png');
  const itemPx = 9 * RESOURCE_ICON_DRAW_SCALE;
  if (!showBack) {
    const sx = isCombatDuel ? walkArmSwing : walkArmSwing * 0.3;
    if (swordSprite) {
      ctx.save();
      if (isCombatDuel) {
        ctx.translate((5.8 + sx * 0.35) * s, (-8.5 + Math.abs(sx) * -0.15) * s);
        ctx.rotate((0.18 + Math.sin(duelT) * 0.42) * (mirror ? -1 : 1));
        ctx.drawImage(swordSprite, -4.7 * s, -4.7 * s, itemPx * s, itemPx * s);
      } else {
        ctx.drawImage(swordSprite, (1.1 + sx) * s, (-12.5) * s, itemPx * s, itemPx * s);
      }
      ctx.restore();
    } else {
      // Fallback sword if sprite fails to load.
      px(2 + sx, -12, 1, 9, goldTrim ? '#f0d060' : '#d9dde2');
      px(3 + sx, -12, 1, 8, goldTrim ? '#ffe27f' : '#f2f5f8');
      px(1 + sx, -4, 4, 1, goldTrim ? '#d4af37' : '#9ea5ad');
    }
    // Keep the explicit hand marker at the grip for readability.
    px(2 + sx * 0.35, -1, 2, 2, '#b64040');

    if (shieldSprite) {
      ctx.drawImage(shieldSprite, (-7.8 - shieldBrace) * s, (-10.3 + Math.abs(shieldBrace) * 0.18) * s, itemPx * s, itemPx * s);
    } else {
      // Fallback shield if sprite fails to load.
      px(-6 - shieldBrace, -9, 4, 6, '#5a3e2a');
      px(-5 - shieldBrace, -8, 2, 4, '#6c4a33');
      px(-4 - shieldBrace, -7, 2, 2, '#7a5539');
    }
    // Removed old rank-3 gold rectangle accent.
  } else {
    // Back-facing sprites: still show actual sword + shield when available.
    const sx = isCombatDuel ? walkArmSwing * 0.45 : walkArmSwing * 0.2;
    if (swordSprite) {
      ctx.drawImage(swordSprite, (1.3 + sx) * s, (-12.2) * s, itemPx * s, itemPx * s);
    } else {
      px(2 + sx, -12, 2, 8, '#bfc5cb');
      px(1 + sx, -4, 4, 1, '#8e959e');
    }
    if (shieldSprite) {
      ctx.drawImage(shieldSprite, (-7.4 - sx) * s, (-10.1) * s, itemPx * s, itemPx * s);
    } else {
      px(-6 - sx, -9, 4, 6, '#5a3e2a');
    }
    // Removed old rank-3 gold rectangle accent.
  }
}

export interface WorkerBodyPaintInput {
  worker: Worker;
  s: number;
  facing: number;
  isMoving: boolean;
  frame: number;
  now: number;
  anim: IdleAnim;
  animT: number;
  isCarrying: boolean;
  isHammerConstruct: boolean;
  isPlantDigging: boolean;
  isFisherFishing: boolean;
  isStoneGathering: boolean;
  isSideCarryTool: boolean;
  isOverheadCarry: boolean;
  armAnim: IdleAnim;
  drawRoundFootShadow: boolean;
  napPillowArms: boolean;
  enemyTint?: boolean;
}

export function paintWorkerSpriteBody(
  ctx: CanvasRenderingContext2D,
  loadSprite: (path: string) => HTMLImageElement | null,
  p: WorkerBodyPaintInput
): void {
  const {
    worker,
    s,
    facing,
    isMoving,
    frame,
    now,
    anim,
    animT,
    isCarrying,
    isHammerConstruct,
    isPlantDigging,
    isFisherFishing,
    isStoneGathering,
    isSideCarryTool,
    isOverheadCarry,
    armAnim,
    drawRoundFootShadow,
    napPillowArms,
    enemyTint = false,
  } = p;
  const a = enemyTint ? enemyTintAppearance(worker.appearance) : worker.appearance;

  ctx.save();

  if (worker.role === 'military') {
    paintMilitaryWarrior(ctx, loadSprite, s, facing, isMoving, frame, now, worker, enemyTint);
    ctx.restore();
    return;
  }

  const px = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x * s, y * s, w * s, h * s);
  };

  const mirror = facing === 1 || facing === 2;
  const showBack = facing === 2 || facing === 3;
  if (mirror) ctx.scale(-1, 1);

  const isWellDrawing =
    worker.visualActivity === 'production_well' &&
    worker.state === 'working' &&
    !isMoving &&
    worker.carryingResource === 'water';
  const isMillDrawing =
    worker.visualActivity === 'production_mill' &&
    worker.state === 'working' &&
    !isMoving &&
    !!worker.carryingResource;
  if (isWellDrawing || isMillDrawing) {
    const bob = Math.sin(now / 420) * 1.8;
    const sway = Math.sin(now / 510) * 0.5;
    ctx.translate(sway * s, bob * s);
  }

  if (isPlantDigging) {
    const bob = Math.sin(now / 380) * 2.2;
    const lean = Math.sin(now / 520) * 0.6;
    ctx.translate(lean * s, bob * s);
  }

  if (isFisherFishing) {
    const squat = Math.sin(now / 1100) * 0.22 * s;
    const bankEdge = worker.fisherTowardWater ? 0.32 * s : 0;
    ctx.translate(0, 2.65 * s + squat + bankEdge);
  }

  const legOffsets = [[0, 0], [-1, 1], [0, 0], [1, -1]];
  const [leftLeg, rightLeg] = isFisherFishing ? ([1, -1] as [number, number]) : legOffsets[frame];
  const walkArmSwing = isMoving ? (frame === 1 ? 1 : frame === 3 ? -1 : 0) : 0;

  if (drawRoundFootShadow) {
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, 0, 4 * s, 1.5 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  const isDress = a.variant === 'dress';

  if (isDress) {
    px(-1 + leftLeg, -1, 1, 1, a.boots);
    px(1 + rightLeg, -1, 1, 1, a.boots);
    px(-3, -9, 7, 8, a.tunic);
    px(-3, -2, 7, 1, darkenColor(a.tunic, 0.8));
    if (!showBack) {
      px(-1, -7, 4, 5, '#d8cbb8');
    }
  } else {
    px(-2 + leftLeg, -2, 2, 2, a.boots);
    px(1 + rightLeg, -2, 2, 2, a.boots);
    px(-2 + leftLeg, -4, 2, 2, a.pants);
    px(1 + rightLeg, -4, 2, 2, a.pants);
    px(-2, -9, 5, 5, a.tunic);
    px(-2, -5, 5, 1, '#2a1f14');
  }

  let leftArmY = -8 + walkArmSwing;
  let rightArmY = -8 - walkArmSwing;
  let leftHandY = -5 + walkArmSwing;
  let rightHandY = -5 - walkArmSwing;
  let leftArmX = -4;
  let rightArmX = 3;
  let extraDraw: (() => void) | null = null;

  let hammerSwingT = 0;

  if (isHammerConstruct) {
    hammerSwingT = (Math.sin(now / 130) + 1) / 2;
    const strike = Math.floor(hammerSwingT * 8);
    leftArmX = -4;
    rightArmX = 4;
    leftArmY = -8;
    rightArmY = -7 - strike;
    leftHandY = -5;
    rightHandY = rightArmY + 3;
  } else if (isStoneGathering) {
    const phase = now / 105;
    const swing = Math.sin(phase) * 3.4;
    leftArmX = -4;
    rightArmX = 4;
    leftArmY = -8 + swing * 0.28;
    rightArmY = -8 + swing * 1.05;
    leftHandY = -5 + swing * 0.28;
    rightHandY = rightArmY + 3;
  } else if (isSideCarryTool || isFisherFishing) {
    /** Fisher uses the same hip/tool rig as other side tools so the rod stays glued to the hands. */
    const wobble = isSideCarryTool && isMoving ? walkArmSwing * 0.5 : 0;
    leftArmX = -4;
    rightArmX = 4;
    leftArmY = -8 + wobble;
    rightArmY = -8 - wobble;
    leftHandY = -4 + wobble;
    rightHandY = -4 - wobble;
  } else if (
    isOverheadCarry &&
    ((worker.visualActivity === 'production_well' && worker.carryingResource === 'water') ||
      (worker.visualActivity === 'production_mill' && worker.carryingResource))
  ) {
    const pull = Math.sin(now / 200);
    const a1 = pull * 2.5;
    const a2 = -pull * 2.5;
    leftArmY = -12 + a1;
    rightArmY = -12 + a2;
    leftHandY = -14 + a1;
    rightHandY = -14 + a2;
    leftArmX = -3;
    rightArmX = 2;
  } else if (isOverheadCarry) {
    leftArmY = -13;
    rightArmY = -13;
    leftHandY = -15;
    rightHandY = -15;
    leftArmX = -3;
    rightArmX = 2;
  } else if (!isMoving) {
    if (armAnim === 'scratch_head') {
      rightArmY = -13;
      rightHandY = -14;
      rightArmX = 2;
      const wiggle = Math.sin(animT * Math.PI * 6) > 0 ? 1 : 0;
      rightHandY += wiggle;
    } else if (armAnim === 'hands_on_hips') {
      leftArmX = -3;
      rightArmX = 2;
      leftArmY = -7;
      rightArmY = -7;
      leftHandY = -5;
      rightHandY = -5;
    } else if (armAnim === 'stretch') {
      const lift = Math.sin(animT * Math.PI);
      leftArmY = -8 - Math.floor(lift * 5);
      rightArmY = -8 - Math.floor(lift * 5);
      leftHandY = leftArmY - 1;
      rightHandY = rightArmY - 1;
    } else if (armAnim === 'read') {
      leftArmX = -2;
      rightArmX = 1;
      leftArmY = -7;
      rightArmY = -7;
      leftHandY = -5;
      rightHandY = -5;
      if (!showBack) {
        extraDraw = () => {
          px(-1, -8, 4, 3, '#e8dcc8');
          px(-1, -8, 4, 1, '#c8b898');
        };
      }
    }
  }

  if (
    napPillowArms &&
    !isMoving &&
    !isCarrying &&
    !isHammerConstruct &&
    !isStoneGathering &&
    !isFisherFishing &&
    !isSideCarryTool &&
    !isOverheadCarry
  ) {
    leftArmX = -4;
    leftArmY = -9;
    leftHandY = -7;
    rightArmX = 2;
    rightArmY = -11;
    rightHandY = -13;
  }

  px(leftArmX, leftArmY, 2, 3, a.tunic);
  px(rightArmX, rightArmY, 2, 3, a.tunic);
  px(leftArmX, leftHandY, 2, 1, a.skin);
  px(rightArmX, rightHandY, 2, 1, a.skin);

  if (extraDraw) extraDraw();

  let headShift = 0;
  if (anim === 'look_around') {
    headShift = Math.round(Math.sin(animT * Math.PI * 2) * 1.5);
  }

  if (showBack) {
    if (a.variant === 'hat') {
      px(-2 + headShift, -14, 5, 5, a.hair);
      px(-4 + headShift, -14, 9, 1, '#c8a868');
      px(-3 + headShift, -15, 7, 1, '#c8a868');
      px(-1 + headShift, -16, 3, 1, '#b89858');
    } else if (isDress) {
      px(-2 + headShift, -14, 5, 5, a.hair);
      px(-1 + headShift, -9, 3, 2, a.hair);
    } else {
      px(-2 + headShift, -14, 5, 5, a.hair);
      px(0 + headShift, -15, 1, 1, a.hair);
    }
  } else {
    px(-2 + headShift, -13, 5, 4, a.skin);

    if (a.variant === 'hat') {
      px(-4 + headShift, -14, 9, 1, '#c8a868');
      px(-3 + headShift, -15, 7, 1, '#c8a868');
      px(-1 + headShift, -16, 3, 1, '#b89858');
      px(-3 + headShift, -14, 7, 1, '#7a5a30');
    } else if (isDress) {
      px(-2 + headShift, -15, 5, 3, a.hair);
      px(-3 + headShift, -13, 1, 3, a.hair);
      px(3 + headShift, -13, 1, 3, a.hair);
    } else {
      px(-2 + headShift, -15, 5, 3, a.hair);
      px(-2 + headShift, -13, 5, 1, '#3a2a1a');
    }
    px(1 + headShift, -12, 1, 1, '#1a1008');
  }

  if (isCarrying && worker.carryingResource) {
    const resSprite = loadSprite(`/assets/resources/${worker.carryingResource}.png`);
    const drawFallback = () => {
      px(-2, -19, 5, 4, '#d4a03c');
      px(-1, -20, 3, 1, '#f0c060');
    };

    const toolDrawPx = 10 * RESOURCE_ICON_DRAW_SCALE;
    const carryW = 8 * RESOURCE_ICON_DRAW_SCALE;

    if (isHammerConstruct) {
      const strike = Math.floor(hammerSwingT * 8);
      const ty = -11 - strike;
      const tx = 0.5;
      if (resSprite) {
        ctx.drawImage(resSprite, tx * s, ty * s, toolDrawPx * s, toolDrawPx * s);
      } else {
        px(tx - 1, ty, 5, 5, '#8a7a68');
      }
    } else if (isPlantDigging) {
      const dip = Math.sin(now / 290) * 0.8 * s;
      if (resSprite) {
        ctx.drawImage(resSprite, -1 * s, -6 * s + dip, toolDrawPx * s, toolDrawPx * s);
      } else {
        px(-2, -8, 6, 5, '#d4a03c');
        px(-1, -9, 4, 1, '#f0c060');
      }
    } else if (isStoneGathering) {
      const swing = Math.sin(now / 105) * 3.4;
      const ty = -10 + swing * 1.08;
      const tx = 0.5;
      if (resSprite) {
        ctx.drawImage(resSprite, tx * s, ty * s, toolDrawPx * s, toolDrawPx * s);
      } else {
        px(tx - 1, ty, 5, 5, '#8a7a68');
      }
    } else if (isSideCarryTool || isFisherFishing) {
      if (resSprite) {
        ctx.drawImage(resSprite, -0.5 * s, -11 * s, toolDrawPx * s, toolDrawPx * s);
      } else {
        px(-2, -20, 6, 5, '#d4a03c');
        px(-1, -21, 4, 1, '#f0c060');
      }
    } else if (
      isOverheadCarry &&
      ((worker.visualActivity === 'production_well' && worker.carryingResource === 'water') ||
        (worker.visualActivity === 'production_mill' && worker.carryingResource))
    ) {
      const wob = Math.sin(now / 200) * 1.2 * s;
      if (resSprite) {
        ctx.drawImage(resSprite, -4 * s, -22 * s + wob, carryW * s, carryW * s);
      } else {
        drawFallback();
      }
    } else if (isOverheadCarry) {
      if (resSprite) {
        ctx.drawImage(resSprite, -4 * s, -22 * s, carryW * s, carryW * s);
      } else {
        drawFallback();
      }
    }
  }

  ctx.restore();
}

/** Resource PNGs referenced by worker body painting (preload for catalogue / tools). */
export const WORKER_BODY_RESOURCE_SPRITE_PATHS: string[] = [
  '/assets/resources/hammer.png',
  '/assets/resources/axe.png',
  '/assets/resources/pickaxe.png',
  '/assets/resources/shovel.png',
  '/assets/resources/fishing_rod.png',
  '/assets/resources/wood_log.png',
  '/assets/resources/water.png',
  '/assets/resources/flour.png',
  '/assets/resources/sword.png',
  '/assets/resources/shield.png',
];

/** Comic “Z” letters above a napping worker (same layout as `RenderSystem`). */
export function drawWorkerNapZLetters(
  ctx: CanvasRenderingContext2D,
  worker: Worker,
  now: number,
  s: number
): void {
  const started = worker.floorSleepStartedAtMs ?? now;
  const comic = ['z', 'Z', '2'];
  ctx.font = '600 7px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < comic.length; i++) {
    const phase = (now - started) / 480 + i * 2.1;
    const ox = Math.sin(phase) * 1.2 * s;
    const oy = -Math.abs(Math.cos(phase * 0.9)) * 1 * s - i * 2 * s;
    const tx = (-7 + i * 2.2) * s + ox;
    const ty = -5.2 * s + oy;
    ctx.strokeStyle = '#0a0610';
    ctx.lineWidth = 1.5;
    ctx.strokeText(comic[i]!, tx, ty);
    ctx.fillStyle = '#e8eefc';
    ctx.fillText(comic[i]!, tx, ty);
  }
}

/** Lying-down nap pose + Z letters; caller should `translate` to worker anchor first. */
export function paintWorkerFloorNap(
  ctx: CanvasRenderingContext2D,
  loadSprite: (path: string) => HTMLImageElement | null,
  worker: Worker,
  now: number,
  s: number,
  facing: number,
  enemyTint: boolean = false
): void {
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(0, 2.8 * s, 14 * s, 2.1 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.save();
  ctx.translate(0, 2.5 * s - 10);
  ctx.rotate(-Math.PI / 2);
  ctx.translate(-2 * s, 8.5 * s);

  paintWorkerSpriteBody(ctx, loadSprite, {
    worker,
    s,
    facing,
    isMoving: false,
    frame: 0,
    now,
    anim: 'none',
    animT: 0,
    isCarrying: false,
    isHammerConstruct: false,
    isPlantDigging: false,
    isFisherFishing: false,
    isStoneGathering: false,
    isSideCarryTool: false,
    isOverheadCarry: false,
    armAnim: 'none',
    drawRoundFootShadow: false,
    napPillowArms: true,
    enemyTint,
  });

  ctx.restore();
  drawWorkerNapZLetters(ctx, worker, now, s);
  ctx.restore();
}
