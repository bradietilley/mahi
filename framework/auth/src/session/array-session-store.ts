import type { SessionRecord, SessionStore } from "./session-store.js";

/**
 * In-memory sessions in a plain `Map`, with zero setup, no database, no
 * cache, no I/O. For tests: a `SessionGuard` can be exercised end to end
 * without a DB round-trip or a cache backend.
 *
 * Not for production: everything vanishes on restart and nothing is
 * shared across processes. Unlike `CacheSessionStore`, this one CAN back
 * `destroyForUser()`/`destroyForUserExcept()`. It holds the records
 * directly, so it can scan them by value.
 *
 * Behaviourally identical to the other stores (expiry enforced on read,
 * sliding via `touch()`), so it's a faithful stand-in in tests.
 */
export class ArraySessionStore implements SessionStore {
  private records = new Map<string, SessionRecord>();

  async read(id: string): Promise<SessionRecord | null> {
    const record = this.records.get(id);

    if (record === undefined) {
      return null;
    }

    // Expiry enforced on read, matching the database/cache stores rather
    // than trusting gc() to have run.
    if (new Date(record.expiresAt).getTime() <= Date.now()) {
      this.records.delete(id);

      return null;
    }

    return record;
  }

  async write(id: string, userId: string, expiresAt: string): Promise<void> {
    this.records.set(id, { id, userId, expiresAt });
  }

  async touch(id: string, expiresAt: string): Promise<void> {
    const existing = this.records.get(id);

    if (existing === undefined) {
      return;
    }

    this.records.set(id, { ...existing, expiresAt });
  }

  async destroy(id: string): Promise<void> {
    this.records.delete(id);
  }

  async destroyForUser(userId: string): Promise<void> {
    for (const [id, record] of this.records) {
      if (record.userId === userId) {
        this.records.delete(id);
      }
    }
  }

  async destroyForUserExcept(userId: string, exceptId: string): Promise<void> {
    for (const [id, record] of this.records) {
      if (record.userId === userId && id !== exceptId) {
        this.records.delete(id);
      }
    }
  }

  async gc(): Promise<number> {
    const now = Date.now();
    let removed = 0;

    for (const [id, record] of this.records) {
      if (new Date(record.expiresAt).getTime() <= now) {
        this.records.delete(id);
        removed++;
      }
    }

    return removed;
  }
}
