/**
 * ActionPlayer — runtime engine for the V2 worker animation system.
 *
 * One instance per worker. Only one action plays at a time.
 * Calling play() immediately replaces any current action.
 */
import type { WorkerActionDef, BodyPartTransform } from './ActionDef';
import { interpolateTrack } from './ActionDef';
import type { BodyPartName } from './WorkerBodyDef';

/** Final per-part transforms for one frame, keyed by BodyPartName. */
export type WorkerBodyPose = Map<BodyPartName, BodyPartTransform>;

export class ActionPlayer {
  private current: WorkerActionDef | null = null;
  private startMs = 0;

  /**
   * Start playing an action. Immediately replaces any currently active action.
   * @param def    The action to play.
   * @param nowMs  Current simulation/wall-clock time in ms.
   */
  play(def: WorkerActionDef, nowMs: number): void {
    this.current = def;
    this.startMs = nowMs;
  }

  /** Stop the current action; worker reverts to base pose. */
  stop(): void {
    this.current = null;
  }

  /** The id of the currently playing action, or null if idle. */
  get currentId(): string | null {
    return this.current?.id ?? null;
  }

  /**
   * Returns true when a non-looping action has played past its full duration.
   * Always false for looping actions or when no action is playing.
   */
  isFinished(nowMs: number): boolean {
    if (!this.current || this.current.loop) return false;
    return nowMs - this.startMs >= this.current.duration;
  }

  /**
   * Compute the current pose at `nowMs`.
   * Returns a Map of per-part transforms; parts absent from the map use base pose.
   */
  computePose(nowMs: number): WorkerBodyPose {
    const pose: WorkerBodyPose = new Map();
    if (!this.current) return pose;

    const elapsed = nowMs - this.startMs;
    const dur = this.current.duration;
    let t: number;

    if (this.current.loop) {
      t = dur > 0 ? (elapsed % dur) / dur : 0;
    } else {
      t = dur > 0 ? Math.min(elapsed / dur, 1) : 1;
    }

    for (const [partName, track] of Object.entries(this.current.tracks) as [
      BodyPartName,
      (typeof this.current.tracks)[BodyPartName],
    ][]) {
      if (!track) continue;
      const transform = interpolateTrack(track, t);
      if (transform) pose.set(partName, transform);
    }

    return pose;
  }
}
