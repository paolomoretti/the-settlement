import { RoadSegment, RoadNode } from './RoadSegmentManager';

export interface JunctionItem {
  resourceType: string;
  destinationEntityId: number | null;
}

export class TransportManager {
  private junctionItems = new Map<string, JunctionItem[]>();
  private baseCampDirection = new Map<number, number>();
  private buildingDirections = new Map<number, Map<number, number>>();
  private baseCampEntityId: number | null = null;

  addJunctionItem(x: number, y: number, resourceType: string, destinationEntityId: number | null = null): void {
    const key = `${x},${y}`;
    const items = this.junctionItems.get(key) || [];
    items.push({ resourceType, destinationEntityId });
    this.junctionItems.set(key, items);
  }

  takeJunctionItem(x: number, y: number): JunctionItem | null {
    const key = `${x},${y}`;
    const items = this.junctionItems.get(key);
    if (!items || items.length === 0) return null;
    return items.shift()!;
  }

  takeJunctionItemForDirection(x: number, y: number, segmentId: number, pickupEndpointIdx: number): JunctionItem | null {
    const key = `${x},${y}`;
    const items = this.junctionItems.get(key);
    if (!items || items.length === 0) return null;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const dirIdx = this.getDirectionIndex(segmentId, item.destinationEntityId);
      if (dirIdx !== undefined && dirIdx !== pickupEndpointIdx) {
        items.splice(i, 1);
        return item;
      }
    }
    return null;
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

  peekJunctionItemForDirection(x: number, y: number, segmentId: number, pickupEndpointIdx: number): JunctionItem | null {
    const items = this.junctionItems.get(`${x},${y}`);
    if (!items || items.length === 0) return null;

    for (const item of items) {
      const dirIdx = this.getDirectionIndex(segmentId, item.destinationEntityId);
      if (dirIdx !== undefined && dirIdx !== pickupEndpointIdx) {
        return item;
      }
    }
    return null;
  }

  getJunctionItemsMap(): ReadonlyMap<string, JunctionItem[]> {
    return this.junctionItems;
  }

  getDirectionIndex(segmentId: number, destEntityId: number | null): number | undefined {
    if (destEntityId === null || destEntityId === this.baseCampEntityId) {
      return this.baseCampDirection.get(segmentId);
    }
    return this.buildingDirections.get(destEntityId)?.get(segmentId);
  }

  private buildPositionToSegments(segments: RoadSegment[]): Map<string, { seg: RoadSegment; endpointIdx: number }[]> {
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
    return posToSegments;
  }

  computeRoutes(segments: RoadSegment[], baseCampEntityId: number): void {
    this.baseCampDirection.clear();
    this.baseCampEntityId = baseCampEntityId;

    const posToSegments = this.buildPositionToSegments(segments);

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

  computeRoutesToBuilding(segments: RoadSegment[], buildingEntityId: number): void {
    const dirMap = new Map<number, number>();
    const posToSegments = this.buildPositionToSegments(segments);

    const queue: number[] = [];

    for (const seg of segments) {
      for (let i = 0; i < 2; i++) {
        if (seg.endpoints[i].entityId === buildingEntityId) {
          dirMap.set(seg.id, i);
          queue.push(seg.id);
          break;
        }
      }
    }

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const current = segments.find(s => s.id === currentId)!;
      const towardIdx = dirMap.get(currentId)!;
      const awayEnd = current.endpoints[1 - towardIdx];
      const awayKey = `${awayEnd.x},${awayEnd.y}`;

      const adjacent = posToSegments.get(awayKey) || [];
      for (const { seg: other, endpointIdx } of adjacent) {
        if (dirMap.has(other.id)) continue;
        dirMap.set(other.id, endpointIdx);
        queue.push(other.id);
      }
    }

    this.buildingDirections.set(buildingEntityId, dirMap);
  }

  clearBuildingRoutes(): void {
    this.buildingDirections.clear();
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
    this.buildingDirections.clear();
    this.baseCampEntityId = null;
  }

  serialize(): object {
    const items: { x: number; y: number; resourceType: string; destinationEntityId: number | null }[] = [];
    for (const [key, junctionItems] of this.junctionItems) {
      const [x, y] = key.split(',').map(Number);
      for (const item of junctionItems) {
        items.push({ x, y, resourceType: item.resourceType, destinationEntityId: item.destinationEntityId });
      }
    }
    return { junctionItems: items };
  }

  deserialize(data: any): void {
    this.junctionItems.clear();
    if (!data?.junctionItems) return;
    for (const item of data.junctionItems) {
      this.addJunctionItem(item.x, item.y, item.resourceType, item.destinationEntityId ?? null);
    }
  }
}

export const transportManager = new TransportManager();
