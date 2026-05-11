import type { RoadSegment } from '@/economics/RoadSegmentManager';

/**
 * Selecting a road segment by clicking on a corridor tile.
 *
 * `Game.selectEntityAt` resolves a player click on a road cell to the segment
 * the player intends to act on. We deliberately *ignore* junction endpoints
 * (3+ road neighbours) and building entrance endpoints, because those cells
 * are shared with neighbouring segments — picking one of them would be
 * ambiguous (delete which corridor? swap which carrier?). The player must
 * click somewhere along the visible interior of the corridor.
 *
 * Single-tile segments (a corridor whose only cell is also its endpoint) are
 * a fallback: the player has no "interior" to click, so we still return the
 * segment when that lone tile is clicked.
 *
 * @returns the matched segment, or `null` if the tile is an ambiguous shared
 *   endpoint or not part of any segment.
 */
export function findRoadSegmentAtTile(
  segments: ReadonlyArray<RoadSegment>,
  gridX: number,
  gridY: number
): RoadSegment | null {
  for (const seg of segments) {
    if (seg.tiles.length === 0) continue;
    const start = seg.tiles[0]!;
    const end = seg.tiles[seg.tiles.length - 1]!;
    for (let i = 0; i < seg.tiles.length; i++) {
      const t = seg.tiles[i]!;
      if (t.x !== gridX || t.y !== gridY) continue;
      if (seg.tiles.length === 1) return seg;
      const isStart = t.x === start.x && t.y === start.y;
      const isEnd = t.x === end.x && t.y === end.y;
      if (!isStart && !isEnd) return seg;
      const epType = isStart ? seg.endpoints[0]?.type : seg.endpoints[1]?.type;
      if (epType !== 'junction' && epType !== 'building') return seg;
    }
  }
  return null;
}

/**
 * Tiles of a segment that should actually be unmade when the player asks to
 * "delete the road". Shared endpoints — junctions used by other segments and
 * building entrance tiles — are preserved so the rest of the network and the
 * building footprints are left intact.
 */
export function getDeletableSegmentTiles(seg: RoadSegment): { x: number; y: number }[] {
  if (seg.tiles.length === 0) return [];
  const out: { x: number; y: number }[] = [];
  const start = seg.tiles[0]!;
  const end = seg.tiles[seg.tiles.length - 1]!;
  const startKeep =
    seg.endpoints[0]?.type === 'junction' || seg.endpoints[0]?.type === 'building';
  const endKeep =
    seg.endpoints[1]?.type === 'junction' || seg.endpoints[1]?.type === 'building';
  for (let i = 0; i < seg.tiles.length; i++) {
    const t = seg.tiles[i]!;
    const isStart = t.x === start.x && t.y === start.y;
    const isEnd = t.x === end.x && t.y === end.y;
    if (isStart && startKeep) continue;
    if (isEnd && endKeep) continue;
    out.push({ x: t.x, y: t.y });
  }
  return out;
}

/**
 * Selection key for a road segment used when the segment list is recalculated.
 * `RoadSegmentManager.recalculate` mints brand new numeric ids on every pass,
 * so the road popover relocates "the same corridor" after a recalc by
 * matching this structural fingerprint (start tile, end tile, length).
 */
export function fingerprintRoadSegment(seg: RoadSegment): string {
  if (seg.tiles.length === 0) return '';
  const a = seg.tiles[0]!;
  const b = seg.tiles[seg.tiles.length - 1]!;
  const k1 = `${a.x},${a.y}`;
  const k2 = `${b.x},${b.y}`;
  return k1 < k2 ? `${k1}|${k2}|${seg.tiles.length}` : `${k2}|${k1}|${seg.tiles.length}`;
}
