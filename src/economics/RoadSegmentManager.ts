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

  getCenterTile(segment: RoadSegment): { x: number; y: number } {
    const mid = Math.floor(segment.tiles.length / 2);
    return segment.tiles[mid];
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
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dx, dy] of dirs) {
      if (this.roadTiles.has(`${x + dx},${y + dy}`)) {
        neighbors.push({ x: x + dx, y: y + dy });
      }
    }
    return neighbors;
  }

  private isAdjacentToBuilding(x: number, y: number, tileMap: TileMap): number | undefined {
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dx, dy] of dirs) {
      const tile = tileMap.getTile(x + dx, y + dy);
      if (tile && tile.isOccupied() && tile.hasRoad) {
        return tile.occupiedBy;
      }
    }
    return undefined;
  }

  private classifyTile(
    x: number,
    y: number,
    tileMap: TileMap
  ): RoadNode | null {
    const neighbors = this.getRoadNeighbors(x, y);
    const adjacentBuildingId = this.isAdjacentToBuilding(x, y, tileMap);

    if (neighbors.length === 0) {
      return { x, y, type: adjacentBuildingId !== undefined ? 'building' : 'dead_end', entityId: adjacentBuildingId };
    }
    if (neighbors.length === 1) {
      return { x, y, type: adjacentBuildingId !== undefined ? 'building' : 'dead_end', entityId: adjacentBuildingId };
    }
    // Same as the 2-neighbor case: intersections next to a building entrance must
    // keep entityId so transport can seed computeRoutesToBuilding; otherwise
    // construction materials never get a direction map and sit at base camp forever
    // while the builder still arrives via off-road A*.
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
          const nextNeighbors = this.getRoadNeighbors(current.x, current.y)
            .filter(n => !(n.x === previous.x && n.y === previous.y));

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

        const endNode = nodes.get(`${current.x},${current.y}`) ||
          { x: current.x, y: current.y, type: 'dead_end' as const };

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
    // Build fingerprint map for exact matches
    const oldByFingerprint = new Map<string, RoadSegment>();
    for (const seg of oldSegments) {
      if (seg.assignedWorkerId !== null) {
        oldByFingerprint.set(this.fingerprint(seg), seg);
      }
    }

    const claimedOld = new Set<string>();

    // Pass 1: exact fingerprint matches
    for (const newSeg of newSegments) {
      const fp = this.fingerprint(newSeg);
      const oldMatch = oldByFingerprint.get(fp);
      if (oldMatch) {
        newSeg.assignedWorkerId = oldMatch.assignedWorkerId;
        claimedOld.add(fp);
      }
    }

    // Pass 2: fuzzy match by tile overlap for unmatched new segments
    const unmatchedOld = oldSegments.filter(s =>
      s.assignedWorkerId !== null && !claimedOld.has(this.fingerprint(s))
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
      } else {
        const workerId = this.onSpawnWorker?.(newSeg) ?? null;
        newSeg.assignedWorkerId = workerId;
      }
    }

    // Free workers from unmatched old segments
    for (const oldSeg of oldSegments) {
      if (oldSeg.assignedWorkerId === null) continue;
      if (!claimedOld.has(this.fingerprint(oldSeg))) {
        this.onFreeWorker?.(oldSeg.assignedWorkerId);
      }
    }
  }

  private edgeKey(x1: number, y1: number, x2: number, y2: number): string {
    if (x1 < x2 || (x1 === x2 && y1 < y2)) {
      return `${x1},${y1}-${x2},${y2}`;
    }
    return `${x2},${y2}-${x1},${y1}`;
  }

  private fingerprint(seg: RoadSegment): string {
    return seg.tiles.map(t => `${t.x},${t.y}`).sort().join(';');
  }

  reset(): void {
    this.segments = [];
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
