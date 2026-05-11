import type { FactionVisualStyle } from '@/components/ownerUtils';

/** Cloth colours for the waving banner (pole uses fixed browns matching military entrance flags). */
export type WavingFlagFabricStyle = Pick<
  FactionVisualStyle,
  'flag' | 'flagStroke' | 'flagHighlight'
>;

/** Survey tile marker: same geometry / animation as `paintWavingEntranceFlag`, dark green cloth. */
export const SURVEY_WAVING_FLAG_FABRIC: WavingFlagFabricStyle = {
  flag: 'rgba(22, 58, 36, 0.96)',
  flagStroke: 'rgba(8, 26, 14, 0.92)',
  flagHighlight: 'rgba(110, 175, 105, 0.42)',
};

/**
 * Procedural waving flag used at enemy military entrances and survey markers.
 * Pole styling matches the brown wooden mast used on conquered / enemy building markers.
 */
export function paintWavingEntranceFlag(
  ctx: CanvasRenderingContext2D,
  footX: number,
  footY: number,
  poleH: number,
  waveTime: number,
  fabric: WavingFlagFabricStyle,
  scale: number = 0.8
): void {
  const s = scale;
  const topY = footY - poleH;
  const wave = Math.sin(waveTime) * 2.2 * s;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
  ctx.beginPath();
  ctx.ellipse(footX, footY + 1.4 * s, 4.2 * s, 2 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(70, 22, 16, 0.96)';
  ctx.lineWidth = 4 * s;
  ctx.beginPath();
  ctx.moveTo(footX, footY);
  ctx.lineTo(footX, topY);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(165, 58, 42, 0.78)';
  ctx.lineWidth = 1.4 * s;
  ctx.beginPath();
  ctx.moveTo(footX - 0.9 * s, footY - 1 * s);
  ctx.lineTo(footX - 0.9 * s, topY + 1 * s);
  ctx.stroke();

  ctx.fillStyle = fabric.flag;
  ctx.strokeStyle = fabric.flagStroke;
  ctx.lineWidth = 1.1 * s;
  ctx.beginPath();
  ctx.moveTo(footX + 1.5 * s, topY + 3 * s);
  ctx.quadraticCurveTo(footX + 13 * s, topY + 1 * s + wave, footX + 23 * s, topY + 6 * s);
  ctx.quadraticCurveTo(
    footX + 13 * s,
    topY + 10 * s - wave * 0.45,
    footX + 1.5 * s,
    topY + 12 * s
  );
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = fabric.flagHighlight;
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  ctx.moveTo(footX + 4 * s, topY + 5 * s);
  ctx.quadraticCurveTo(
    footX + 13 * s,
    topY + 4 * s + wave * 0.7,
    footX + 20 * s,
    topY + 7 * s
  );
  ctx.stroke();
  ctx.restore();
}
