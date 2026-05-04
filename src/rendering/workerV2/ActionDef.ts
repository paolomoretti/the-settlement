/**
 * Declarative per-part keyframe animations for workers (V2 renderer).
 *
 * Only ONE action plays at a time. Starting a new action immediately replaces
 * the current one. Parts not present in the active action revert to base pose.
 */
import type { BodyPartName } from './WorkerBodyDef';

/**
 * A delta transform applied ON TOP of a body part's base pose.
 * All fields are optional; omitted fields leave the base pose unchanged.
 */
export interface BodyPartTransform {
  /** Position offset in pixel-units (before × s). */
  dx?: number;
  dy?: number;
  /** Rotation in radians around the part's pivot. Positive = clockwise. */
  rotation?: number;
  /** Scale factor (1.0 = no change). */
  scaleX?: number;
  scaleY?: number;
}

/** One keyframe within a single body-part animation track. */
export interface PartKeyframe {
  /** Normalised time within one action cycle: 0.0 → 1.0 (inclusive). */
  t: number;
  transform: BodyPartTransform;
}

export interface WorkerActionDef {
  id: string;
  /** Duration of one full cycle in ms. */
  duration: number;
  loop: boolean;
  /**
   * Per-part keyframe tracks.
   * Only the parts listed here are animated; all others stay at base pose.
   */
  tracks: Partial<Record<BodyPartName, PartKeyframe[]>>;
}

/**
 * Interpolate a single track at normalised time `t` (0–1).
 * Returns null if the track has no keyframes.
 */
export function interpolateTrack(track: PartKeyframe[], t: number): BodyPartTransform | null {
  if (track.length === 0) return null;
  if (track.length === 1) return track[0]!.transform;

  // Find surrounding keyframes
  let lo = track[0]!;
  let hi = track[track.length - 1]!;

  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i]!;
    const b = track[i + 1]!;
    if (t >= a.t && t <= b.t) {
      lo = a;
      hi = b;
      break;
    }
  }

  if (lo === hi) return lo.transform;

  const span = hi.t - lo.t;
  const alpha = span === 0 ? 0 : (t - lo.t) / span;

  return lerpTransform(lo.transform, hi.transform, alpha);
}

function lerp(a: number | undefined, b: number | undefined, t: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) * (1 - t) + (b ?? 0) * t;
}

function lerpTransform(a: BodyPartTransform, b: BodyPartTransform, t: number): BodyPartTransform {
  const result: BodyPartTransform = {};
  const dx = lerp(a.dx, b.dx, t);
  const dy = lerp(a.dy, b.dy, t);
  const rotation = lerp(a.rotation, b.rotation, t);
  const scaleX = lerp(a.scaleX, b.scaleX, t);
  const scaleY = lerp(a.scaleY, b.scaleY, t);
  if (dx !== undefined) result.dx = dx;
  if (dy !== undefined) result.dy = dy;
  if (rotation !== undefined) result.rotation = rotation;
  if (scaleX !== undefined) result.scaleX = scaleX;
  if (scaleY !== undefined) result.scaleY = scaleY;
  return result;
}
