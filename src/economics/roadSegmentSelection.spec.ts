import { describe, it, expect } from 'vitest';
import {
  findRoadSegmentAtTile,
  fingerprintRoadSegment,
  getDeletableSegmentTiles,
} from '@/economics/roadSegmentSelection';
import type { RoadSegment, RoadNode } from '@/economics/RoadSegmentManager';

function segment(
  id: number,
  tiles: Array<[number, number]>,
  endpoints: [RoadNode['type'], RoadNode['type']]
): RoadSegment {
  const ts = tiles.map(([x, y]) => ({ x, y }));
  return {
    id,
    tiles: ts,
    endpoints: [
      { x: ts[0]!.x, y: ts[0]!.y, type: endpoints[0] },
      {
        x: ts[ts.length - 1]!.x,
        y: ts[ts.length - 1]!.y,
        type: endpoints[1],
      },
    ],
    assignedWorkerId: null,
  };
}

describe('findRoadSegmentAtTile — corridor click resolution', () => {
  it('returns the segment for any interior tile of a dead-end corridor', () => {
    const a = segment(
      1,
      [
        [4, 5],
        [5, 5],
        [6, 5],
        [7, 5],
      ],
      ['dead_end', 'dead_end']
    );
    expect(findRoadSegmentAtTile([a], 5, 5)?.id).toBe(1);
    expect(findRoadSegmentAtTile([a], 6, 5)?.id).toBe(1);
  });

  it('returns the segment when its endpoints are dead-ends, even on the endpoint tile', () => {
    const a = segment(
      1,
      [
        [4, 5],
        [5, 5],
        [6, 5],
      ],
      ['dead_end', 'dead_end']
    );
    expect(findRoadSegmentAtTile([a], 4, 5)?.id).toBe(1);
    expect(findRoadSegmentAtTile([a], 6, 5)?.id).toBe(1);
  });

  it('returns null when the click lands on a junction endpoint shared by multiple segments', () => {
    // T-junction at (5,5): one leg west (3..5), one leg east (5..7), one leg south (5..7).
    const west = segment(
      1,
      [
        [3, 5],
        [4, 5],
        [5, 5],
      ],
      ['dead_end', 'junction']
    );
    const east = segment(
      2,
      [
        [5, 5],
        [6, 5],
        [7, 5],
      ],
      ['junction', 'dead_end']
    );
    const south = segment(
      3,
      [
        [5, 5],
        [5, 6],
        [5, 7],
      ],
      ['junction', 'dead_end']
    );

    // Junction tile (5,5) — ambiguous, no segment.
    expect(findRoadSegmentAtTile([west, east, south], 5, 5)).toBeNull();
    // Interior or non-shared end of each leg — resolves uniquely.
    expect(findRoadSegmentAtTile([west, east, south], 4, 5)?.id).toBe(1);
    expect(findRoadSegmentAtTile([west, east, south], 6, 5)?.id).toBe(2);
    expect(findRoadSegmentAtTile([west, east, south], 5, 6)?.id).toBe(3);
    // The two free (dead-end) endpoints of the legs should still resolve.
    expect(findRoadSegmentAtTile([west, east, south], 3, 5)?.id).toBe(1);
    expect(findRoadSegmentAtTile([west, east, south], 7, 5)?.id).toBe(2);
  });

  it('returns null when the click lands on a building entrance endpoint', () => {
    const corridor = segment(
      1,
      [
        [5, 5],
        [6, 5],
        [7, 5],
      ],
      ['building', 'dead_end']
    );
    expect(findRoadSegmentAtTile([corridor], 5, 5)).toBeNull();
    expect(findRoadSegmentAtTile([corridor], 6, 5)?.id).toBe(1);
    expect(findRoadSegmentAtTile([corridor], 7, 5)?.id).toBe(1);
  });

  it('still resolves a single-tile segment whose only cell is its endpoint', () => {
    const tiny = segment(1, [[5, 5]], ['junction', 'junction']);
    expect(findRoadSegmentAtTile([tiny], 5, 5)?.id).toBe(1);
  });
});

describe('getDeletableSegmentTiles — preserves shared endpoints', () => {
  it('returns every tile of a corridor with two dead-end caps', () => {
    const corridor = segment(
      1,
      [
        [4, 5],
        [5, 5],
        [6, 5],
      ],
      ['dead_end', 'dead_end']
    );
    expect(getDeletableSegmentTiles(corridor)).toEqual([
      { x: 4, y: 5 },
      { x: 5, y: 5 },
      { x: 6, y: 5 },
    ]);
  });

  it('keeps a junction endpoint but deletes everything else', () => {
    const corridor = segment(
      1,
      [
        [5, 5],
        [6, 5],
        [7, 5],
      ],
      ['junction', 'dead_end']
    );
    expect(getDeletableSegmentTiles(corridor)).toEqual([
      { x: 6, y: 5 },
      { x: 7, y: 5 },
    ]);
  });

  it('keeps a building entrance endpoint (preserves building access tile)', () => {
    const corridor = segment(
      1,
      [
        [5, 5],
        [6, 5],
        [7, 5],
      ],
      ['dead_end', 'building']
    );
    expect(getDeletableSegmentTiles(corridor)).toEqual([
      { x: 5, y: 5 },
      { x: 6, y: 5 },
    ]);
  });

  it('keeps both endpoints when both are shared (junction <-> building)', () => {
    const corridor = segment(
      1,
      [
        [5, 5],
        [6, 5],
        [7, 5],
      ],
      ['junction', 'building']
    );
    expect(getDeletableSegmentTiles(corridor)).toEqual([{ x: 6, y: 5 }]);
  });
});

describe('fingerprintRoadSegment — relinking after a recalc', () => {
  it('is identical regardless of which tile is the segment "start"', () => {
    const forward = segment(
      11,
      [
        [4, 5],
        [5, 5],
        [6, 5],
      ],
      ['dead_end', 'dead_end']
    );
    const reverse = segment(
      99,
      [
        [6, 5],
        [5, 5],
        [4, 5],
      ],
      ['dead_end', 'dead_end']
    );
    expect(fingerprintRoadSegment(forward)).toEqual(fingerprintRoadSegment(reverse));
  });

  it('differs when the corridor changes length or endpoints', () => {
    const a = segment(
      11,
      [
        [4, 5],
        [5, 5],
        [6, 5],
      ],
      ['dead_end', 'dead_end']
    );
    const longer = segment(
      11,
      [
        [4, 5],
        [5, 5],
        [6, 5],
        [7, 5],
      ],
      ['dead_end', 'dead_end']
    );
    expect(fingerprintRoadSegment(a)).not.toEqual(fingerprintRoadSegment(longer));
  });
});
