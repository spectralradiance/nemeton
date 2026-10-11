import type { ChangesResponse } from '@nemeton/shared';

/**
 * In-process fan-out of published change batches to open event streams. One server instance is
 * enough for a single festival; scaling out would put Postgres LISTEN/NOTIFY or Redis behind this.
 */
export class ChangeHub {
  private listeners = new Set<(batch: ChangesResponse) => void>();

  subscribe(listener: (batch: ChangesResponse) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(batch: ChangesResponse) {
    for (const listener of this.listeners) listener(batch);
  }

  get size() {
    return this.listeners.size;
  }
}
