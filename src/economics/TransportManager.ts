import { RoadSegment, RoadNode } from './RoadSegmentManager';

export interface JunctionItem {
  resourceType: string;
}

export class TransportManager {
  private junctionItems = new Map<string, JunctionItem[]>();
  private baseCampDirection = new Map<number, number>();

  addJunctionItem(x: number, y: number, resourceType: string): void {
    const key = `${x},${y}`;
    const items = this.junctionItems.get(key) || [];
    items.push({ resourceType });
    this.junctionItems.set(key, items);
  }

  takeJunctionItem(x: number, y: number): JunctionItem | null {
    const key = `${x},${y}`;
    const items = this.junctionItems.get(key);
    if (!items || items.length === 0) return null;
    return items.shift()!;
  }

  hasJunctionItems(x: number, y: number): boolean {
    const items = this.junctionItems.get(`${x},${y}`);
    return !!items && items.length > 0;
  }

  peekJunctionItem(x: number, y: number): JunctionItem | null {
    const items = this.junctionItems.get(`${x},${y}`);
    if (!items || items.length === 0) return null;
    return items[0];
  }

  getJunctionItemsMap(): ReadonlyMap<string, JunctionItem[]> {
    return this.junctionItems;
  }

  computeRoutes(segments: RoadSegment[], baseCampEntityId: number): void {
    this.baseCampDirection.clear();

    const posToSegments = new Map<string, { seg: RoadSegment; endpointIdx: number }[]>();
    for (const seg of segments) {
      for (let i = 0; i < 2; i++) {
        const ep = seg.endpoints[i];
        const key = `${ep.x},${ep.y}`;
        const list = posToSegments.get(key) || [];
        list.push({ seg, endpointIdx: i });
        posToSegments.set(key, list);
      }
    }

    const queue: number[] = [];

    for (const seg of segments) {
      for (let i = 0; i < 2; i++) {
        if (seg.endpoints[i].entityId === baseCampEntityId) {
          this.baseCampDirection.set(seg.id, i);
          queue.push(seg.id);
          break;
        }
      }
    }

    console.log(`[Transport] computeRoutes: ${segments.length} segments, ${queue.length} touch base camp (entityId=${baseCampEntityId})`);
    for (const seg of segments) {
      const dir = this.baseCampDirection.has(seg.id) ? `bcIdx=${this.baseCampDirection.get(seg.id)}` : 'no-route';
      console.log(`  seg#${seg.id}: ${seg.tiles.length} tiles, worker=${seg.assignedWorkerId}, ep0=[${seg.endpoints[0].type}:${seg.endpoints[0].entityId}] ep1=[${seg.endpoints[1].type}:${seg.endpoints[1].entityId}] ${dir}`);
    }

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const current = segments.find(s => s.id === currentId)!;
      const bcIdx = this.baseCampDirection.get(currentId)!;
      const awayEnd = current.endpoints[1 - bcIdx];
      const awayKey = `${awayEnd.x},${awayEnd.y}`;

      const adjacent = posToSegments.get(awayKey) || [];
      for (const { seg: other, endpointIdx } of adjacent) {
        if (this.baseCampDirection.has(other.id)) continue;
        this.baseCampDirection.set(other.id, endpointIdx);
        queue.push(other.id);
      }
    }
  }

  getPickupEndpoint(segment: RoadSegment): RoadNode | null {
    const bcIdx = this.baseCampDirection.get(segment.id);
    if (bcIdx === undefined) return null;
    return segment.endpoints[1 - bcIdx];
  }

  getDropoffEndpoint(segment: RoadSegment): RoadNode | null {
    const bcIdx = this.baseCampDirection.get(segment.id);
    if (bcIdx === undefined) return null;
    return segment.endpoints[bcIdx];
  }

  getBaseCampEndpointIndex(segmentId: number): number | undefined {
    return this.baseCampDirection.get(segmentId);
  }

  reset(): void {
    this.junctionItems.clear();
    this.baseCampDirection.clear();
  }

  serialize(): object {
    const items: { x: number; y: number; resourceType: string }[] = [];
    for (const [key, junctionItems] of this.junctionItems) {
      const [x, y] = key.split(',').map(Number);
      for (const item of junctionItems) {
        items.push({ x, y, resourceType: item.resourceType });
      }
    }
    return { junctionItems: items };
  }

  deserialize(data: any): void {
    this.junctionItems.clear();
    if (!data?.junctionItems) return;
    for (const item of data.junctionItems) {
      this.addJunctionItem(item.x, item.y, item.resourceType);
    }
  }
}

export const transportManager = new TransportManager();
