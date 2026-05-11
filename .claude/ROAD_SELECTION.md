# Road segment selection

The player interacts with road carriers (workers, donkeys) by clicking the **road corridor itself**, not the moving sprite. Chasing a sprite was unreliable, and a static road tile is an obvious, precise click target.

## Visual model

- **Hover (view mode, on an open road tile):** every tile of that road **segment** gets a warm golden rim + translucent fill. The cursor turns into a pointer.
- **Click:** the segment stays highlighted (selected) and the **Road** popover opens.
- **Click again on the same segment** (or click elsewhere / press Escape): deselects, closes the popover.

Selection state lives on `Game.selectedRoadSegmentId`. Hover and selection both feed into the renderer through `RenderSystem.hoveredRoadSegmentTiles` / `RenderSystem.selectedRoadSegmentTiles`, drawn in `renderRoadSegmentHighlights()` immediately after `renderRoads()`.

## What counts as "the road"

A **segment** is the corridor between two endpoint nodes (`RoadSegmentManager`). Endpoints are:

- `junction` — 3+ road neighbours (shared with neighbouring segments)
- `building` — entrance tile next to a building footprint (shared with the building)
- `dead_end` — terminal cell with 0 or 1 neighbours

A click on a **shared endpoint tile** (junction or building) is intentionally ignored — those cells belong to more than one corridor or to a building, so picking one is ambiguous. The player must click somewhere along the visible interior of the corridor (or its non-shared dead-end). A single-tile segment whose only cell is its endpoint is the one exception: that cell *is* the segment, so we still resolve it.

Both rules live in `src/economics/roadSegmentSelection.ts` (pure helpers, unit-tested by `roadSegmentSelection.spec.ts`):

| Helper | Used by |
|--------|---------|
| `findRoadSegmentAtTile(segments, x, y)` | `Game.findRoadSegmentAtTile` (hover + click) |
| `getDeletableSegmentTiles(seg)` | `Game.deleteRoadSegment` |
| `fingerprintRoadSegment(seg)` | `Game.refreshRoadSegmentSelection` after a recalc |

## Popover (`showRoadSegmentPopover` in `src/main.ts`)

| Row | Behaviour |
|-----|-----------|
| Stats | Corridor length, current carrier (`Worker` / `Donkey` / `Unassigned`), HQ donkey count |
| **Use donkey for transportation** | Visible only when a worker is on the segment. Disabled when there is no donkey available (none idle at HQ **and** no donor donkey on another segment). Emits `road_segment:replace_with_donkey`. |
| **Use worker for transportation** | Visible only when a donkey is on the segment. Disabled when HQ cannot spawn the replacement worker. Emits `road_segment:return_donkey`. |
| **Delete road** | Always visible. Emits `road_segment:delete`. Removes every corridor tile except shared endpoints (junctions, building entrances). |

Underneath, those events route through `Game.replaceRoadSegmentWorkerWithDonkey`, `Game.returnRoadSegmentDonkeyToHq`, and `Game.deleteRoadSegment`, which delegate to the existing entity-id-based `replaceRoadWorkerWithDonkey` / `returnRoadDonkeyToHq` (their semantics, including the no-donkey donor-segment fallback, are unchanged).

## Selection lifecycle vs. `RoadSegmentManager.recalculate`

`RoadSegmentManager.recalculate` mints **brand new numeric ids** on every pass, so the popover cannot remember "segment 17 is selected" across an edit. We persist a structural **fingerprint** (`fingerprintRoadSegment`) alongside the id; after every recalc (`scheduleSegmentRecalc` / `flushSegmentRecalc`) the game calls `refreshRoadSegmentSelection()`:

1. Try `selectedRoadSegmentId` first — works if the segment id survived (rare).
2. Otherwise look up the matching segment by fingerprint and rebind id + tiles + popover payload.
3. If nothing matches (the corridor was deleted or merged), `deselectRoadSegment()` closes the popover.

## Mutual exclusion with the building popover

Building selection and road segment selection are mutually exclusive — `Game.updateSelectionUI` drops any active segment selection whenever a building is selected, and clicking on empty ground deselects both. This keeps `BuildingPopover` and the road popover from ever appearing at the same time.

## Events

| Event | Payload | Direction |
|-------|---------|-----------|
| `road_segment:selected` | `{ segmentId, tiles, assignedWorkerId, carrierType, donkeysAtHq, canReplaceWithDonkey, canReturnDonkeyToHq }` | Game → UI |
| `road_segment:deselected` | none | Game → UI |
| `road_segment:deselect` | none | UI → Game (popover closed by user) |
| `road_segment:replace_with_donkey` | `{ segmentId }` | UI → Game |
| `road_segment:return_donkey` | `{ segmentId }` | UI → Game |
| `road_segment:delete` | `{ segmentId }` | UI → Game |

## Tests

| Spec | Intent |
|------|--------|
| `src/economics/roadSegmentSelection.spec.ts` | `findRoadSegmentAtTile` / `getDeletableSegmentTiles` / `fingerprintRoadSegment` corner cases (junctions, building endpoints, dead-ends, single-tile segments, fingerprint stability) |

For donkey ↔ worker swap mechanics (donor-segment fallback, HQ population accounting) see `.claude/ROAD_WORKER_DISPATCH.md`.
