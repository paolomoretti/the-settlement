import { TileMap } from '@/map/TileMap';

export interface RoadNode {
  x: number;
  y: number;
  type: 'junction' | 'dead_end' | 'building';
  entityId?: number;
}

export interface RoadSegment {
  id: number;
  tiles: { x: number; y: number }[];
  endpoints: [RoadNode, RoadNode];
  assignedWorkerId: number | null;
}

export class RoadSegmentManager {
  private segments: RoadSegment[] = [];
  /** During `reconcile`, worker callbacks run before `this.segments` is swapped to the new graph. */
  private reconcileCallbackSegmentGraph: RoadSegment[] | null = null;
  private roadTiles: Set<string> = new Set();
  private nextSegmentId = 1;

  private onSpawnWorker: ((segment: RoadSegment) => number | null) | null = null;
  private onFreeWorker: ((workerId: number) => void) | null = null;
  private onMoveWorker: ((workerId: number, segment: RoadSegment) => void) | null = null;

  setCallbacks(callbacks: {
    spawnWorker: (segment: RoadSegment) => number | null;
    freeWorker: (workerId: number) => void;
    moveWorker: (workerId: number, segment: RoadSegment) => void;
  }): void {
    this.onSpawnWorker = callbacks.spawnWorker;
    this.onFreeWorker = callbacks.freeWorker;
    this.onMoveWorker = callbacks.moveWorker;
  }

  addRoad(x: number, y: number): void {
    this.roadTiles.add(`${x},${y}`);
  }

  removeRoad(x: number, y: number): void {
    this.roadTiles.delete(`${x},${y}`);
  }

  getSegments(): RoadSegment[] {
    return this.segments;
  }

  /**
   * Segment list that matches the map **after** the current `recalculate` pass, including
   * while `reconcile` spawn/move/free callbacks are running (where `getSegments()` is still stale).
   */
  getSegmentsGraphForWorkerCallbacks(): RoadSegment[] {
    return this.reconcileCallbackSegmentGraph ?? this.segments;
  }

  getWorkerCount(): number {
    let count = 0;
    for (const seg of this.segments) {
      if (seg.assignedWorkerId !== null) count++;
    }
    return count;
  }

  getSegmentForWorker(workerId: number): RoadSegment | undefined {
    return this.segments.find(s => s.assignedWorkerId === workerId);
  }

  /**
   * True midpoint along the segment polyline (fractional grid coords when the
   * geometric center lies between two tiles, e.g. a 2-tile strip).
   */
  getCenterRestPosition(segment: RoadSegment): { x: number; y: number } {
    const tiles = segment.tiles;
    const n = tiles.length;
    if (n === 0) return { x: 0, y: 0 };
    if (n === 1) return { x: tiles[0]!.x, y: tiles[0]!.y };
    const mid = (n - 1) / 2;
    const lo = Math.floor(mid);
    const hi = Math.ceil(mid);
    if (lo === hi) return { x: tiles[lo]!.x, y: tiles[lo]!.y };
    const t = mid - lo;
    return {
      x: tiles[lo]!.x + (tiles[hi]!.x - tiles[lo]!.x) * t,
      y: tiles[lo]!.y + (tiles[hi]!.y - tiles[lo]!.y) * t,
    };
  }

  /** Integer tile on the segment whose cell is closest to `(gx, gy)`. */
  nearestSegmentTileToPoint(
    segment: RoadSegment,
    gx: number,
    gy: number
  ): { x: number; y: number } {
    let best = segment.tiles[0]!;
    let bestD = Infinity;
    for (const t of segment.tiles) {
      const d = (t.x - gx) ** 2 + (t.y - gy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  /** Nearest segment tile to the geometric center (for integer-only callers). */
  getCenterTile(segment: RoadSegment): { x: number; y: number } {
    const r = this.getCenterRestPosition(segment);
    return this.nearestSegmentTileToPoint(segment, r.x, r.y);
  }

  /** Null out any assignedWorkerId that no longer points to a live entity.
   * Call before recalculate so stale IDs don't masquerade as assigned workers. */
  clearDeadWorkers(isAlive: (id: number) => boolean): void {
    for (const seg of this.segments) {
      if (seg.assignedWorkerId !== null && !isAlive(seg.assignedWorkerId)) {
        seg.assignedWorkerId = null;
      }
    }
  }

  recalculate(tileMap: TileMap): void {
    const newSegments = this.computeSegments(tileMap);
    this.reconcile(this.segments, newSegments);
    this.segments = newSegments;
  }

  rebuildRoadTileSet(tileMap: TileMap): void {
    this.roadTiles.clear();
    for (let y = 0; y < tileMap.height; y++) {
      for (let x = 0; x < tileMap.width; x++) {
        const tile = tileMap.getTile(x, y);
        if (tile && tile.hasRoad && !tile.isOccupied()) {
          this.roadTiles.add(`${x},${y}`);
        }
      }
    }
  }

  private getRoadNeighbors(x: number, y: number): { x: number; y: number }[] {
    const neighbors: { x: number; y: number }[] = [];
    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (const [dx, dy] of dirs) {
      if (this.roadTiles.has(`${x + dx},${y + dy}`)) {
        neighbors.push({ x: x + dx, y: y + dy });
      }
    }
    return neighbors;
  }

  private isAdjacentToBuilding(x: number, y: number, tileMap: TileMap): number | undefined {
    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (const [dx, dy] of dirs) {
      const tile = tileMap.getTile(x + dx, y + dy);
      // Only count building *entrance* tiles (occupied + hasRoad) as building nodes.
      // Plain footprint tiles (occupied, no road) must NOT make adjacent road tiles into
      // building nodes — otherwise a road running alongside the side of a 2×2+ building
      // creates one extra segment per footprint tile it passes, spawning extra workers on
      // what should be a single unbroken corridor.
      // Entrance tiles are the sole access point: they are tagged hasRoad=true in
      // occupyBuildingTiles (and oneByOneTaggedForTransport for 1×1 buildings).
      if (tile && tile.isOccupied() && tile.hasRoad) {
        return tile.occupiedBy;
      }
    }
    return undefined;
  }

  private classifyTile(x: number, y: number, tileMap: TileMap): RoadNode | null {
    const neighbors = this.getRoadNeighbors(x, y);
    const adjacentBuildingId = this.isAdjacentToBuilding(x, y, tileMap);

    if (neighbors.length === 0) {
      return {
        x,
        y,
        type: adjacentBuildingId !== undefined ? 'building' : 'dead_end',
        entityId: adjacentBuildingId,
      };
    }
    if (neighbors.length === 1) {
      return {
        x,
        y,
        type: adjacentBuildingId !== undefined ? 'building' : 'dead_end',
        entityId: adjacentBuildingId,
      };
    }
    // Junctions next to a building *entrance* must keep entityId so transport can seed
    // computeRoutesToBuilding; otherwise construction materials never get a direction map
    // and sit at base camp forever while the builder arrives via off-road A*.
    // (adjacentBuildingId is already entrance-only from isAdjacentToBuilding above.)
    if (neighbors.length >= 3) {
      return { x, y, type: 'junction', entityId: adjacentBuildingId };
    }
    // 2 neighbors — only a node if adjacent to a building
    if (adjacentBuildingId !== undefined) {
      return { x, y, type: 'building', entityId: adjacentBuildingId };
    }
    return null; // corridor tile, not a node
  }

  private computeSegments(tileMap: TileMap): RoadSegment[] {
    if (this.roadTiles.size === 0) return [];

    const segments: RoadSegment[] = [];
    const visitedEdges = new Set<string>();

    const nodes = new Map<string, RoadNode>();
    for (const key of this.roadTiles) {
      const [x, y] = key.split(',').map(Number);
      const node = this.classifyTile(x, y, tileMap);
      if (node) {
        nodes.set(key, node);
      }
    }

    // If no nodes found (pure loop), pick an arbitrary tile as a node
    if (nodes.size === 0) {
      const firstKey = this.roadTiles.values().next().value!;
      const [x, y] = firstKey.split(',').map(Number);
      nodes.set(firstKey, { x, y, type: 'dead_end' });
    }

    for (const [, node] of nodes) {
      const neighbors = this.getRoadNeighbors(node.x, node.y);

      for (const neighbor of neighbors) {
        const firstEdge = this.edgeKey(node.x, node.y, neighbor.x, neighbor.y);
        if (visitedEdges.has(firstEdge)) continue;
        visitedEdges.add(firstEdge);

        const tiles: { x: number; y: number }[] = [{ x: node.x, y: node.y }];
        let current = neighbor;
        let previous = { x: node.x, y: node.y };

        // Walk until we hit another node
        while (!nodes.has(`${current.x},${current.y}`)) {
          tiles.push({ x: current.x, y: current.y });
          const nextNeighbors = this.getRoadNeighbors(current.x, current.y).filter(
            n => !(n.x === previous.x && n.y === previous.y)
          );

          if (nextNeighbors.length === 0) break;

          const next = nextNeighbors[0];
          visitedEdges.add(this.edgeKey(current.x, current.y, next.x, next.y));
          previous = current;
          current = next;
        }

        tiles.push({ x: current.x, y: current.y });
        if (previous.x !== node.x || previous.y !== node.y) {
          visitedEdges.add(this.edgeKey(previous.x, previous.y, current.x, current.y));
        }

        const endNode = nodes.get(`${current.x},${current.y}`) || {
          x: current.x,
          y: current.y,
          type: 'dead_end' as const,
        };

        segments.push({
          id: this.nextSegmentId++,
          tiles,
          endpoints: [node, endNode],
          assignedWorkerId: null,
        });
      }
    }

    return segments;
  }

  private reconcile(oldSegments: RoadSegment[], newSegments: RoadSegment[]): void {
    this.reconcileCallbackSegmentGraph = newSegments;
    try {
      this.reconcileInner(oldSegments, newSegments);
    } finally {
      this.reconcileCallbackSegmentGraph = null;
    }
  }

  private reconcileInner(oldSegments: RoadSegment[], newSegments: RoadSegment[]): void {
    // Build fingerprint map for exact matches (workers-only — null-worker segments
    // are not in this map and fall through to spawn attempts below).
    const oldByFingerprint = new Map<string, RoadSegment>();
    for (const seg of oldSegments) {
      if (seg.assignedWorkerId !== null) {
        oldByFingerprint.set(this.fingerprint(seg), seg);
      }
    }

    const claimedOld = new Set<string>();

    // Pass 1: exact fingerprint matches — keep existing worker on unchanged segments.
    for (const newSeg of newSegments) {
      const fp = this.fingerprint(newSeg);
      const oldMatch = oldByFingerprint.get(fp);
      if (oldMatch) {
        newSeg.assignedWorkerId = oldMatch.assignedWorkerId;
        claimedOld.add(fp);
      }
    }

    // Pass 2: fuzzy match by tile overlap — move a worker from the best-overlapping
    // old segment to each new segment that still needs one.
    // NOTE: this pass ONLY does moves; spawning is deferred to Pass 4 so that freed
    // workers from Pass 3 can be reused without touching the population budget.
    const unmatchedOld = oldSegments.filter(
      s => s.assignedWorkerId !== null && !claimedOld.has(this.fingerprint(s))
    );

    for (const newSeg of newSegments) {
      if (newSeg.assignedWorkerId !== null) continue;

      const newTileSet = new Set(newSeg.tiles.map(t => `${t.x},${t.y}`));
      let bestMatch: RoadSegment | null = null;
      let bestOverlap = 0;

      for (const oldSeg of unmatchedOld) {
        if (claimedOld.has(this.fingerprint(oldSeg))) continue;
        let overlap = 0;
        for (const t of oldSeg.tiles) {
          if (newTileSet.has(`${t.x},${t.y}`)) overlap++;
        }
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestMatch = oldSeg;
        }
      }

      if (bestMatch) {
        newSeg.assignedWorkerId = bestMatch.assignedWorkerId;
        claimedOld.add(this.fingerprint(bestMatch));
        this.onMoveWorker?.(bestMatch.assignedWorkerId!, newSeg);
      }
      // Spawning deliberately omitted here — handled in Pass 4.
    }

    // Collect what's left after Passes 1–2.
    const workersToFree = oldSegments.filter(
      s => s.assignedWorkerId !== null && !claimedOld.has(this.fingerprint(s))
    );
    // Sort: building-endpoint segments first so the most critical legs get covered.
    const segmentsNeedingWorkers = newSegments
      .filter(s => s.assignedWorkerId === null)
      .sort((a, b) => {
        const aHasBuilding = a.endpoints.some(ep => ep.type === 'building') ? 0 : 1;
        const bHasBuilding = b.endpoints.some(ep => ep.type === 'building') ? 0 : 1;
        return aHasBuilding - bHasBuilding;
      });

    // Pass 3: directly reassign freed workers to segments still needing one.
    // This avoids both the population cost AND the round-trip to HQ: the worker simply
    // walks to the new segment's centre.  Only truly net-new segments (road additions)
    // that exceed the freed-worker supply will fall through to the spawn in Pass 4.
    const reassignCount = Math.min(workersToFree.length, segmentsNeedingWorkers.length);
    for (let i = 0; i < reassignCount; i++) {
      const freed = workersToFree[i]!;
      const needy = segmentsNeedingWorkers[i]!;
      needy.assignedWorkerId = freed.assignedWorkerId;
      this.onMoveWorker?.(freed.assignedWorkerId!, needy);
    }

    // Pass 4: free workers that have no new segment to serve.
    for (let i = reassignCount; i < workersToFree.length; i++) {
      this.onFreeWorker?.(workersToFree[i]!.assignedWorkerId!);
    }

    // Pass 5: spawn fresh workers for any segments still uncovered.
    for (let i = reassignCount; i < segmentsNeedingWorkers.length; i++) {
      const seg = segmentsNeedingWorkers[i]!;
      const workerId = this.onSpawnWorker?.(seg) ?? null;
      seg.assignedWorkerId = workerId;
    }
  }

  private edgeKey(x1: number, y1: number, x2: number, y2: number): string {
    if (x1 < x2 || (x1 === x2 && y1 < y2)) {
      return `${x1},${y1}-${x2},${y2}`;
    }
    return `${x2},${y2}-${x1},${y1}`;
  }

  private fingerprint(seg: RoadSegment): string {
    return seg.tiles
      .map(t => `${t.x},${t.y}`)
      .sort()
      .join(';');
  }

  reset(): void {
    this.segments = [];
    this.reconcileCallbackSegmentGraph = null;
    this.roadTiles.clear();
    this.nextSegmentId = 1;
  }

  serialize(): object {
    return {
      segments: this.segments.map(s => ({
        id: s.id,
        tiles: s.tiles,
        endpoints: s.endpoints,
        assignedWorkerId: s.assignedWorkerId,
      })),
    };
  }

  deserialize(data: any): void {
    if (!data?.segments) return;
    this.segments = data.segments;
    let maxId = 0;
    for (const seg of this.segments) {
      if (seg.id > maxId) maxId = seg.id;
    }
    this.nextSegmentId = maxId + 1;
  }
}

export const roadSegmentManager = new RoadSegmentManager();
