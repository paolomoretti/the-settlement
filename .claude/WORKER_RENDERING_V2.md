# Worker Rendering V2 — Architecture Plan

A complete redesign of how workers are drawn. The goal is to replace the ~700 lines of
imperative `if/else` branches in `WorkerSpritePainter.ts` with a composable **skeleton +
actions + tools** system that is easy to extend without touching a monolithic painter.

---

## What We Are Replacing

The current system (`src/rendering/WorkerSpritePainter.ts`) has these problems:

- Every body part is drawn with hardcoded `fillRect` coordinate literals.
- Every animation is an `if/else` branch that directly mutates arm/leg Y-offset variables.
- Animations cannot be composed (you cannot "walk while scratching your head").
- Tools are pasted at fixed positions with no concept of a grip point or rotation origin.
- Hat type is bundled into the `variant` field along with body shape, making them hard to
  vary independently.
- Military workers are an entirely separate code path that duplicates all the geometry.

---

## High-Level Architecture

```
WorkerAppearanceV2      ← named colour slots + hat type
      │
WorkerBodyDef           ← skeletal hierarchy (base geometry, pivot points)
      │
ActionDef[]             ← declarative per-body-part keyframe animations
      │
ActionStack (runtime)   ← layers active actions → final WorkerBodyPose
      │
ToolDef[]               ← grip origin, initial rotation, hand assignment
      │
WorkerBodyRenderer      ← walks the skeleton + pose, paints to canvas
```

---

## 1 — Appearance (`WorkerAppearanceV2`)

Replace the flat `WorkerAppearance` with named colour slots and explicit hat/body enums.

```typescript
// src/rendering/workerV2/WorkerAppearanceV2.ts

export type HatType =
  | 'none' // bare hair
  | 'cap' // small round cap
  | 'wide_brim' // current peasant straw hat
  | 'hood' // cloth hood
  | 'helmet_leather' // rank-1 military cap
  | 'helmet_steel' // rank-2 metal helmet
  | 'crown'; // rank-3 gold crown on top of steel

export type BodyVariant = 'default' | 'dress';

export interface WorkerAppearanceV2 {
  skinColor: string;
  hairColor: string;
  shirtColor: string; // formerly "tunic"
  trouserColor: string; // formerly "pants"
  footColor: string; // formerly "boots"
  hatType: HatType;
  hatColor: string; // primary hat/helmet colour
  hatAccentColor?: string; // brim band, crown trim, visor notch, etc.
  bodyVariant: BodyVariant; // formerly "variant === 'dress'"
}
```

**Migration from `WorkerAppearance`:**

| Old field                    | New field                  |
| ---------------------------- | -------------------------- |
| `tunic`                      | `shirtColor`               |
| `pants`                      | `trouserColor`             |
| `boots`                      | `footColor`                |
| `variant:'hat'`              | `hatType:'wide_brim'`      |
| `variant:'dress'`            | `bodyVariant:'dress'`      |
| `variant:'default'/'tunic2'` | `bodyVariant:'default'`    |
| military rank 1              | `hatType:'helmet_leather'` |
| military rank 2              | `hatType:'helmet_steel'`   |
| military rank 3              | `hatType:'crown'`          |

---

## 2 — Skeleton (`WorkerBodyDef`)

The worker body is a **tree of named parts**. Each part is a coloured rectangle
(or a custom paint function for complex shapes like hats).
Every child is positioned relative to its parent's local space.

### Part Names

```typescript
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
  | 'rightHand' // small square — tool attachment point
  | 'head'
  | 'leftEye'
  | 'rightEye'
  | 'hair'; // also covers hat geometry (driven by hatType)
```

### Hierarchy

```
root  (0, 0) = ground centre, screen-space Y negative = upward
 ├─ shadow       (ellipse at ground)
 ├─ leftLeg      pivot: top-centre of leg
 │   └─ leftFoot pivot: top-centre of foot
 ├─ rightLeg     pivot: top-centre
 │   └─ rightFoot
 └─ torso        pivot: bottom-centre (hip)
     ├─ leftArm  pivot: top-centre (shoulder)
     │   └─ leftHand  pivot: top-centre (wrist)  ← tool slot
     ├─ rightArm pivot: top-centre (shoulder)
     │   └─ rightHand pivot: top-centre (wrist)  ← tool slot
     └─ head     pivot: bottom-centre (neck)
         ├─ leftEye   (fixed offset, no rotation)
         ├─ rightEye  (fixed offset, no rotation)
         └─ hair      pivot: bottom-centre (forehead)
```

Legs are children of `root`, not of `torso`, so the torso can sway without pulling
the legs with it — matching how the current code bobs the torso independently.

### Part Definition

```typescript
export interface BodyPartDef {
  name: BodyPartName;
  parent: BodyPartName | 'root';

  /**
   * Where this part's pivot lands, expressed in the PARENT's local coordinate
   * space (with parent's own pivot at 0,0).
   * All values are in "pixel units" before multiplying by the scale factor s.
   */
  origin: { x: number; y: number };

  /**
   * The rotation/scale centre, expressed in this part's own rectangle space
   * as an offset from the rect's top-left corner.
   * e.g. { x: 1, y: 0 } = top-centre of a 2-wide arm = the shoulder.
   */
  pivot: { x: number; y: number };

  /** Rectangle size in pixel units. */
  size: { w: number; h: number };

  /** Which slot in WorkerAppearanceV2 determines the fill colour. */
  colorSlot: AppearanceColorSlot;

  /**
   * Optional custom paint function — used for things like the hat brim,
   * eye whites, or hair shapes that are not simple filled rectangles.
   * Receives the part's already-transformed ctx at (0,0) = pivot.
   */
  customPaint?: (ctx: CanvasRenderingContext2D, s: number, a: WorkerAppearanceV2) => void;
}
```

Where the rendering algorithm for each part is:

```
ctx.save()
ctx.translate(part.origin.x * s, part.origin.y * s)   // move to parent attachment point
ctx.rotate(pose.rotation)                               // action-driven rotation
ctx.scale(pose.scaleX, pose.scaleY)                    // action-driven scale
// Now (0,0) is the pivot point
drawRect(
  -part.pivot.x * s,
  -part.pivot.y * s,
  part.size.w * s,
  part.size.h * s,
  color
)
if (part.customPaint) part.customPaint(ctx, s, appearance)
// render children (all children defined relative to THIS pivot)
ctx.restore()
```

### Base Geometry (pixel units, ground = y=0, up = more negative)

Based on the current painter measurements, the default body uses these values:

| Part      | origin in parent          | pivot in rect    | size  |
| --------- | ------------------------- | ---------------- | ----- |
| shadow    | root (0, 0)               | (0, 0)           | —     |
| leftLeg   | root (−1, −4)             | (1, 0) top-ctr   | 2 × 2 |
| leftFoot  | leftLeg (1, 2) = ankle    | (1, 0) top-ctr   | 2 × 2 |
| rightLeg  | root (2, −4)              | (1, 0) top-ctr   | 2 × 2 |
| rightFoot | rightLeg (1, 2)           | (1, 0) top-ctr   | 2 × 2 |
| torso     | root (0, −4)              | (2.5, 5) hip-ctr | 5 × 5 |
| leftArm   | torso (−3.5, −4) shoulder | (1, 0) top-ctr   | 2 × 3 |
| rightArm  | torso (1.5, −4) shoulder  | (1, 0) top-ctr   | 2 × 3 |
| leftHand  | leftArm (1, 3) wrist      | (1, 0) top-ctr   | 2 × 1 |
| rightHand | rightArm (1, 3) wrist     | (1, 0) top-ctr   | 2 × 1 |
| head      | torso (2.5, −4) neck      | (2.5, 4) chin    | 5 × 4 |
| leftEye   | head (1, 2) inner eye     | (0.5, 0.5)       | 1 × 1 |
| rightEye  | head (3, 2) outer eye     | (0.5, 0.5)       | 1 × 1 |
| hair      | head (2.5, 0) crown       | (2.5, 3) base    | 5 × 3 |

The dress `bodyVariant` uses the same hierarchy but overrides torso width = 7,
merges legs into the torso rect, and uses a different `customPaint` for the skirt.

---

## 3 — Actions (`WorkerActionDef`)

An **action** is a named keyframe animation that describes **delta transforms** for
specific body parts. Actions are additive on top of the base pose.

### Transform Types

```typescript
/** Delta applied to a single body part's base pose. All fields optional. */
export interface BodyPartTransform {
  /** Position offset in pixel units from base origin. */
  dx?: number;
  dy?: number;
  /** Rotation in radians around the part's pivot. */
  rotation?: number;
  /** Scale multiplier (1.0 = no change). */
  scaleX?: number;
  scaleY?: number;
}
```

### Per-Part Tracks

Each action uses **per-part tracks** rather than shared keyframes. This lets different
body parts run at different speeds within the same action (e.g. the arm swings fast
while the torso bobs slow, or only the head moves during a look-around).

```typescript
/** One keyframe within a single body-part track. */
export interface PartKeyframe {
  /** Normalised time within the action cycle: 0.0 → 1.0 */
  t: number;
  transform: BodyPartTransform;
}

export type ActionEasing = 'linear' | 'ease_in_out' | 'step';

export interface WorkerActionDef {
  id: string;
  /** Duration of one full cycle in ms. */
  duration: number;
  loop: boolean;
  /**
   * Per-part keyframe tracks. Only the parts listed here are animated;
   * all others revert to their base pose for the duration of this action.
   */
  tracks: Partial<Record<BodyPartName, PartKeyframe[]>>;
}
```

Interpolation between keyframes is always **linear** by default. Per-track easing can
be added if needed but is not required for the initial implementation.

### Example: Walk Action

Arms and legs share the same 4-step cycle but are out of phase with each other:

```typescript
const walkAction: WorkerActionDef = {
  id: 'walk',
  duration: 800, // 4 × 200 ms
  loop: true,
  tracks: {
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
    leftArm: [
      { t: 0, transform: {} },
      { t: 0.25, transform: { dy: 1 } },
      { t: 0.5, transform: {} },
      { t: 0.75, transform: { dy: -1 } },
      { t: 1, transform: {} },
    ],
    rightArm: [
      { t: 0, transform: {} },
      { t: 0.25, transform: { dy: -1 } },
      { t: 0.5, transform: {} },
      { t: 0.75, transform: { dy: 1 } },
      { t: 1, transform: {} },
    ],
  },
};
```

### Example: Hammer Action

The arm strikes fast (6 keyframes in 500 ms) while the torso bobs slowly (3 keyframes).
Leg tracks are absent — they stay at base pose:

```typescript
const hammerAction: WorkerActionDef = {
  id: 'hammer',
  duration: 500,
  loop: true,
  tracks: {
    torso: [
      { t: 0, transform: {} },
      { t: 0.5, transform: { dy: 1 } },
      { t: 1, transform: {} },
    ],
    rightArm: [
      { t: 0, transform: { dy: 0 } },
      { t: 0.15, transform: { dy: -8 } },
      { t: 0.5, transform: { dy: 0 } },
      { t: 0.65, transform: { dy: -8 } },
      { t: 1, transform: { dy: 0 } },
    ],
    rightHand: [
      { t: 0, transform: { dy: 0 } },
      { t: 0.15, transform: { dy: -8 } },
      { t: 0.5, transform: { dy: 0 } },
      { t: 0.65, transform: { dy: -8 } },
      { t: 1, transform: { dy: 0 } },
    ],
  },
};
```

### Example: Look Around (head-only)

Only the `head` track is present; everything else is at base pose:

```typescript
const lookAroundAction: WorkerActionDef = {
  id: 'idle_look_around',
  duration: 2400,
  loop: false,
  tracks: {
    head: [
      { t: 0.0, transform: {} },
      { t: 0.25, transform: { dx: -1.5 } },
      { t: 0.75, transform: { dx: 1.5 } },
      { t: 1.0, transform: {} },
    ],
  },
};
```

---

## 4 — Action Player (`ActionPlayer`)

Only **one action plays at a time**. Starting a new action immediately overrides the
current one — there is no blending or layering. Parts not mentioned in the active action
return to their base pose.

```typescript
export type WorkerBodyPose = Map<BodyPartName, BodyPartTransform>;

export class ActionPlayer {
  private current: WorkerActionDef | null = null;
  private startMs = 0;

  /**
   * Start playing an action. Replaces any currently active action immediately.
   * @param def  The action to play.
   * @param nowMs  Current simulation time in ms.
   */
  play(def: WorkerActionDef, nowMs: number): void;

  /** Stop the current action and return to base pose. */
  stop(): void;

  /** Returns true if the current (non-looping) action has finished. */
  isFinished(nowMs: number): boolean;

  /**
   * Interpolate the current action at `nowMs` and return per-part transforms.
   * Parts not covered by the action are absent from the map (renderer uses base pose).
   */
  computePose(nowMs: number): WorkerBodyPose;
}
```

### Action Selection Logic (in `RenderSystem` / `GameWorkerRegistry`)

Because only one action plays, the caller is responsible for switching correctly:

| Worker state              | Action to play      |
| ------------------------- | ------------------- |
| Moving (any carry/tool)   | `walk`              |
| Idle, no job              | `idle_stand`        |
| Idle micro-anim           | `look_around`, etc. |
| Working (construct)       | `hammer`            |
| Working (chop tree)       | `chop_tree`         |
| Working (dig / survey)    | `dig`               |
| Working (fish)            | `fish`              |
| Working (well / mill)     | `pull_rope`         |
| Combat duel               | `combat_duel`       |
| Fallen / combat aftermath | `combat_fallen`     |
| Floor nap                 | `floor_nap`         |

When a non-looping action (`loop: false`) finishes, the caller resumes the previous
locomotion action (`walk` or `idle_stand`).

---

## 5 — Tools (`WorkerToolDef`)

Tools are PNG sprites attached to a specific hand. The key insight is that each tool has
a **grip point** — the pixel on the sprite where the hand holds it — and an **initial
rotation** for the at-rest pose. When an action rotates the hand, the tool rotates around
its grip point (i.e. around the hand's pivot).

```typescript
export interface WorkerToolDef {
  /** Must match a resource id, e.g. 'axe', 'hammer', 'fishing_rod'. */
  resourceId: string;
  spritePath: string;

  /**
   * Pixel offset from the tool sprite's top-left to the grip/hold point.
   * This is the point that will coincide with the hand's pivot when drawn.
   */
  gripOffset: { x: number; y: number };

  /**
   * Rotation (radians) applied to the sprite before any action-driven rotation.
   * Positive = clockwise. Defines the "resting" orientation.
   */
  initialRotation: number;

  /** Sprite render size in pixel units (before × s). */
  renderSize: { w: number; h: number };

  /** Which hand to attach to by default. Can be overridden per-worker. */
  defaultHand: 'left' | 'right';
}
```

### Tool Draw Algorithm

```
// At the hand's world position (hand pivot = 0,0):
ctx.save()
ctx.rotate(tool.initialRotation + poseRotation)  // poseRotation from action
ctx.drawImage(
  sprite,
  -tool.gripOffset.x * s,
  -tool.gripOffset.y * s,
  tool.renderSize.w * s,
  tool.renderSize.h * s
)
ctx.restore()
```

### Suggested Tool Definitions

| Tool        | gripOffset | initialRotation | defaultHand |
| ----------- | ---------- | --------------- | ----------- |
| axe         | (3, 8)     | −0.3 rad        | right       |
| hammer      | (3, 8)     | −0.2 rad        | right       |
| pickaxe     | (3, 8)     | −0.35 rad       | right       |
| shovel      | (2, 8)     | 0.0 rad         | right       |
| fishing_rod | (1, 8)     | −0.15 rad       | right       |
| sword       | (3, 6)     | 0.1 rad         | right       |
| shield      | (4, 6)     | 0.0 rad         | left        |

_(Exact values to be tuned once the renderer is live.)_

---

## 6 — Renderer (`WorkerBodyRenderer`)

```typescript
// src/rendering/workerV2/WorkerBodyRenderer.ts

export function paintWorkerV2(
  ctx: CanvasRenderingContext2D,
  loadSprite: (path: string) => HTMLImageElement | null,
  opts: {
    appearance: WorkerAppearanceV2;
    pose: WorkerBodyPose;
    scale: number; // "s" factor, typically 2.0
    facing: number; // 0 SE | 1 SW | 2 NW | 3 NE
    leftTool?: WorkerToolDef;
    rightTool?: WorkerToolDef;
    alpha?: number;
  }
): void;
```

Internally it:

1. Mirrors the canvas context if `facing === 1 || 2`.
2. Walks the skeleton in **draw order** (back parts first):
   `shadow → leftLeg → leftFoot → rightLeg → rightFoot → torso → leftArm → leftHand → rightArm → rightHand → head → hair → leftEye → rightEye`
   _(In back-facing view, eyes are skipped and hair/hat is drawn instead.)_
3. For each part, applies the parent-cumulative transform + pose delta.
4. Calls `customPaint` when defined (hat brim, dress shape, hair type).
5. After `leftHand` / `rightHand`, draws any assigned tool.

---

## 7 — Worker Component Changes

The `Worker` component needs:

```typescript
// Replace WorkerAppearance with WorkerAppearanceV2
appearance: WorkerAppearanceV2;

// Replace flat flags with a managed ActionStack
actionStack: ActionStack;

// Tool slots (null = bare hands)
leftTool: WorkerToolDef | null;
rightTool: WorkerToolDef | null;
```

`heldItemStyle`, `variant`, and the `isHammerConstruct`, `isPlantDigging`, etc. flags
in `RenderSystem` all go away — they are replaced by actions.

---

## 8 — Phased Migration Plan

### Phase 0 — Scaffolding (new files, no behaviour change)

- `src/rendering/workerV2/WorkerAppearanceV2.ts` — types + migration helper
  `migrateAppearance(old: WorkerAppearance): WorkerAppearanceV2`
- `src/rendering/workerV2/WorkerBodyDef.ts` — `BodyPartDef[]`, `BodyPartName`, geometry constants
- `src/rendering/workerV2/ActionDef.ts` — `WorkerActionDef`, `BodyPartTransform`, `ActionKeyframe`
- `src/rendering/workerV2/ActionStack.ts` — `ActionStack`, `WorkerBodyPose`
- `src/rendering/workerV2/WorkerToolDef.ts` — `WorkerToolDef` + default tool table
- `src/rendering/workerV2/WorkerBodyRenderer.ts` — stub (renders nothing yet)

### Phase 1 — Base Idle + Walk

- Implement the full skeleton render loop in `WorkerBodyRenderer`.
- Define `idle_stand` and `walk` actions in `src/rendering/workerV2/actions/locomotion.ts`.
- Wire `ActionStack` into the `Worker` component alongside the old appearance.
- In `RenderSystem`, route workers with a feature flag `useWorkerV2 = false` to the old painter
  and workers with `useWorkerV2 = true` to `paintWorkerV2`.
- Verify walk animation visually matches the old one.

### Phase 2 — Idle Micro-Animations

- Port `look_around`, `scratch_head`, `hands_on_hips`, `stretch`, `read` to `ActionDef` format.
- The idle scheduler in `RenderSystem` / `updateIdleAnimation()` switches to calling
  `worker.actionStack.play(idleAction, now, PRIORITY_IDLE)` instead of mutating flags.

### Phase 3 — Carry Poses

- Define `carry_overhead`, `carry_side` actions.
- Remove `isOverheadCarry`, `isSideCarryTool`, `heldItemStyle` flags.
- Attach the carried resource's `WorkerToolDef` to the appropriate hand slot.
- Tool is drawn with grip rotation coming from the action keyframe.

### Phase 4 — Job Activity Animations

- `hammer` — right arm swings down, body bobs.
- `chop_tree` — similar swing, tool is axe.
- `dig` — body lean + shovel dip.
- `fish` — squat + rod at hip.
- `pull_rope` — both arms raise with wobble.
- Each replaces the corresponding `visualActivity` branch in the old painter.

### Phase 5 — Military Worker

- Military warriors reuse the same skeleton (not a separate paint function).
- Rank is expressed via `hatType` + `shirtColor` only.
- Sword and shield are `WorkerToolDef`s assigned to right/left hand.
- `combat_duel` becomes an action at `PRIORITY_OVERRIDE`.
- `combat_fallen` becomes a floor-rotation action with alpha fade.

### Phase 6 — Floor Nap + Fallen

- `floor_nap` action: applies a −90° rotation to the root context, draws shadow ellipse.
- Z-letter animation moves to an `extraEffects` hook on the renderer.

### Phase 7 — Hat & Hair Custom Paint

- Implement `customPaint` for each `HatType` using pixel-art `fillRect` calls.
- This replaces the `if (a.variant === 'hat')` / `if (isDress)` branches for head drawing.

### Phase 8 — Cleanup

- Remove the old `WorkerSpritePainter.ts` functions.
- Remove the old `WorkerAppearance` type, `heldItemStyle`, `visualActivity` branches in
  `RenderSystem`, and all `isHammerConstruct` / `isPlantDigging` / `isFisherFishing` etc. flags.
- Update `WORKER_DEFS` to produce `WorkerAppearanceV2` variants.
- Update the debug catalogue (`debug.html`) per `DEBUG_CATALOGUE.md`.

---

## 9 — Resolved Design Decisions

1. **One action at a time, override** — `ActionStack` is replaced by the simpler
   `ActionPlayer`. Only one action plays at a time. Starting a new action immediately
   replaces the current one. Parts not in the active action revert to base pose.

2. **Back-facing view** — the `hair` part's `customPaint` draws a wider silhouette in
   back-facing mode that covers the full head (no face visible, hair wraps around).
   `leftEye` and `rightEye` are simply not drawn in back view. The renderer passes
   a `showBack: boolean` flag to `customPaint` functions.

3. **Dress bodyVariant** — same skeleton, affected parts use overridden `size` and
   `customPaint`. No separate `BodyPartDef[]`.

4. **Enemy tint** — `paintWorkerV2` accepts a `hueShiftDeg?: number` parameter.
   Positive values shift toward red for enemy faction colouring. The renderer applies
   this as a CSS `filter: hue-rotate(Xdeg)` on a temporary offscreen canvas or via
   per-channel math — TBD during implementation.

5. **Debug catalogue** — during Phase 1–7 migration, the catalogue shows both
   old and new renderers side by side (same worker set, two columns). After Phase 8
   cleanup the old column is removed.

6. **Fisher** — the `fish` action uses a body `dy` translate (pushes whole body
   toward the water bank) plus a horizontal leg spread (legs apart, not squatting).
   This matches the current visual while being expressible as body-part transforms.

7. **Donkey carrier** — `renderDonkeySprite` is out of scope. Donkeys remain on the
   old renderer indefinitely until a separate effort ports them.
