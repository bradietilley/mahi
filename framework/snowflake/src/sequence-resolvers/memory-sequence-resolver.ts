import type { SequenceResolver } from "./sequence-resolver.js";

/**
 * In-process sequence counter. Does not coordinate across processes —
 * safe when each process has a unique worker (and/or cluster) id, or
 * when a single process generates IDs. Not recommended as the only
 * sequencer in a multi-process deployment that shares worker ids.
 */
export class MemorySequenceResolver implements SequenceResolver {
  protected lastTime = 0;
  protected lastSequence = 0;

  sequence(currentTime: number): number {
    if (this.lastTime === currentTime) {
      return ++this.lastSequence;
    }

    this.lastTime = currentTime;

    return (this.lastSequence = 0);
  }
}
