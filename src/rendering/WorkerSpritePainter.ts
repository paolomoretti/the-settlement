/**
 * Procedural worker body drawing (shared by RenderSystem and debug catalogue).
 */

import type { Worker, IdleAnim } from '@/components/Worker';

const RESOURCE_ICON_DRAW_SCALE = 1.25;

function darkenColor(color: string, factor: number): string {
  const hex = color.replace('#', '');
  const r = Math.floor(parseInt(hex.slice(0, 2), 16) * factor);
  const g = Math.floor(parseInt(hex.slice(2, 4), 16) * factor);
  const b = Math.floor(parseInt(hex.slice(4, 6), 16) * factor);
  return `rgb(${r}, ${g}, ${b})`;
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
  isStoneGathering: boolean;
  isSideCarryTool: boolean;
  isOverheadCarry: boolean;
  armAnim: IdleAnim;
  drawRoundFootShadow: boolean;
  napPillowArms: boolean;
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
    isStoneGathering,
    isSideCarryTool,
    isOverheadCarry,
    armAnim,
    drawRoundFootShadow,
    napPillowArms,
  } = p;
  const a = worker.appearance;

  ctx.save();

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

  const legOffsets = [[0, 0], [-1, 1], [0, 0], [1, -1]];
  const [leftLeg, rightLeg] = legOffsets[frame];
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
  } else if (isSideCarryTool) {
    const wobble = isMoving ? walkArmSwing * 0.5 : 0;
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
    } else if (isSideCarryTool) {
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
  facing: number
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
    isStoneGathering: false,
    isSideCarryTool: false,
    isOverheadCarry: false,
    armAnim: 'none',
    drawRoundFootShadow: false,
    napPillowArms: true,
  });

  ctx.restore();
  drawWorkerNapZLetters(ctx, worker, now, s);
  ctx.restore();
}
