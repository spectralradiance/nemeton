import type { ChangesResponse } from '@nemeton/shared';

/** A batch plus its JSON, serialized once however many streams it goes to. */
export interface PublishedBatch {
  batch: ChangesResponse;
  data: string;
}

/**
 * In-process fan-out of published change batches to open event streams. One server instance is
 * enough for a single festival; scaling out would put Postgres LISTEN/NOTIFY or Redis behind this.
 */
export class ChangeHub {
  private listeners = new Set<(published: PublishedBatch) => void>();

  subscribe(listener: (published: PublishedBatch) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(batch: ChangesResponse) {
    const published = { batch, data: JSON.stringify(batch) };
    for (const listener of this.listeners) listener(published);
  }

  get size() {
    return this.listeners.size;
  }
}
