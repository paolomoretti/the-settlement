import { getSimulationNowMs } from '@/core/simulationClock';

export type TransportStatus = 'waiting' | 'assigned' | 'in_transit' | 'delivered';

export interface TransportRequest {
  id: number;
  sourceEntityId: number;
  destinationEntityId: number | null;
  resourceType: string;
  amount: number;
  status: TransportStatus;
  assignedWorkerId: number | null;
  createdAt: number;
}

let nextTransportId = 1;

export class TransportQueue {
  private requests: Map<number, TransportRequest> = new Map();

  createRequest(
    sourceEntityId: number,
    resourceType: string,
    amount: number
  ): TransportRequest {
    const request: TransportRequest = {
      id: nextTransportId++,
      sourceEntityId,
      destinationEntityId: null,
      resourceType,
      amount,
      status: 'waiting',
      assignedWorkerId: null,
      createdAt: getSimulationNowMs(),
    };
    this.requests.set(request.id, request);
    return request;
  }

  assignWorker(requestId: number, workerId: number, destinationEntityId: number): boolean {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'waiting') return false;
    request.status = 'assigned';
    request.assignedWorkerId = workerId;
    request.destinationEntityId = destinationEntityId;
    return true;
  }

  markInTransit(requestId: number): boolean {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'assigned') return false;
    request.status = 'in_transit';
    return true;
  }

  markDelivered(requestId: number): boolean {
    const request = this.requests.get(requestId);
    if (!request) return false;
    request.status = 'delivered';
    this.requests.delete(requestId);
    return true;
  }

  cancelRequest(requestId: number): void {
    this.requests.delete(requestId);
  }

  cancelBySource(sourceEntityId: number): void {
    for (const [id, request] of this.requests) {
      if (request.sourceEntityId === sourceEntityId) {
        this.requests.delete(id);
      }
    }
  }

  cancelByWorker(workerId: number): void {
    for (const request of this.requests.values()) {
      if (request.assignedWorkerId === workerId) {
        request.status = 'waiting';
        request.assignedWorkerId = null;
        request.destinationEntityId = null;
      }
    }
  }

  getWaitingRequests(): TransportRequest[] {
    return Array.from(this.requests.values())
      .filter(r => r.status === 'waiting');
  }

  getRequestsBySource(sourceEntityId: number): TransportRequest[] {
    return Array.from(this.requests.values())
      .filter(r => r.sourceEntityId === sourceEntityId);
  }

  getRequestByWorker(workerId: number): TransportRequest | undefined {
    return Array.from(this.requests.values())
      .find(r => r.assignedWorkerId === workerId);
  }

  getInTransitAmount(resourceType: string): number {
    let total = 0;
    for (const request of this.requests.values()) {
      if (request.resourceType === resourceType &&
          (request.status === 'assigned' || request.status === 'in_transit')) {
        total += request.amount;
      }
    }
    return total;
  }

  getAllRequests(): TransportRequest[] {
    return Array.from(this.requests.values());
  }

  getWaitingCountForSource(sourceEntityId: number): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.sourceEntityId === sourceEntityId && request.status === 'waiting') {
        count += request.amount;
      }
    }
    return count;
  }

  clear(): void {
    this.requests.clear();
  }

  serialize(): object[] {
    return Array.from(this.requests.values()).map(r => ({
      ...r,
    }));
  }

  deserialize(data: any[]): void {
    this.requests.clear();
    for (const item of data) {
      this.requests.set(item.id, item);
      if (item.id >= nextTransportId) {
        nextTransportId = item.id + 1;
      }
    }
  }
}
