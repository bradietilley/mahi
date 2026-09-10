import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../__fixtures__/test-database.js";
import { DatabaseSessionStore } from "../../src/session/database-session-store.js";
import {
  CacheSessionStore,
  type SessionCacheStore,
} from "../../src/session/cache-session-store.js";
import { ArraySessionStore } from "../../src/session/array-session-store.js";
import type { SessionStore } from "../../src/session/session-store.js";

/** Bare in-memory stand-in for `@mahi/cache`'s CacheStore. */
class FakeCache implements SessionCacheStore {
  private entries = new Map<string, { value: unknown; expiresAt: number | null }>();

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return undefined;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);

      return undefined;
    }

    return entry.value as T;
  }

  async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000,
    });
  }

  async forget(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

describe.each([
  ["DatabaseSessionStore", async () => new DatabaseSessionStore()],
  ["ArraySessionStore", async () => new ArraySessionStore()],
  ["CacheSessionStore", async () => new CacheSessionStore(new FakeCache())],
])("%s", (name, make) => {
  // Both implementations are held to the same contract — a behavioural
  // divergence between them is a bug, since config swaps them freely.
  let database: TestDatabase;
  let store: SessionStore;

  beforeEach(async () => {
    database = await createTestDatabase();
    store = await make();
  });

  afterEach(() => database.cleanup());

  it("reads back a session it wrote", async () => {
    await store.write("session-1", "alice", inMinutes(60));

    await expect(store.read("session-1")).resolves.toMatchObject({
      id: "session-1",
      userId: "alice",
    });
  });

  it("returns null for an unknown session", async () => {
    await expect(store.read("nope")).resolves.toBeNull();
  });

  it("returns null for an expired session", async () => {
    // Expiry is enforced on read, not left to gc()/TTL — a cleanup job
    // lagging must never mean a stale session is honoured.
    await store.write("stale", "alice", inMinutes(-1));
    await expect(store.read("stale")).resolves.toBeNull();
  });

  it("touch() extends the expiry", async () => {
    await store.write("session-1", "alice", inMinutes(1));
    await store.touch("session-1", inMinutes(120));

    const session = await store.read("session-1");
    expect(new Date(session!.expiresAt).getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
  });

  it("touch() on a missing session is a no-op, not an error", async () => {
    await expect(store.touch("missing", inMinutes(60))).resolves.toBeUndefined();
    await expect(store.read("missing")).resolves.toBeNull();
  });

  it("destroy() removes the session", async () => {
    await store.write("session-1", "alice", inMinutes(60));
    await store.destroy("session-1");

    await expect(store.read("session-1")).resolves.toBeNull();
  });

  it("destroy() on a missing session is a no-op", async () => {
    await expect(store.destroy("missing")).resolves.toBeUndefined();
  });

  // Stores that hold records directly (DB rows / an in-memory map) can be
  // queried by value, so they back destroyForUser* and a counting gc();
  // the cache store can't and instead fails loudly / relies on TTL.
  if (name === "DatabaseSessionStore" || name === "ArraySessionStore") {
    it("destroyForUser() removes only that user's sessions", async () => {
      await store.write("a1", "alice", inMinutes(60));
      await store.write("a2", "alice", inMinutes(60));
      await store.write("b1", "bob", inMinutes(60));

      await store.destroyForUser("alice");

      await expect(store.read("a1")).resolves.toBeNull();
      await expect(store.read("a2")).resolves.toBeNull();
      await expect(store.read("b1")).resolves.not.toBeNull();
    });

    it("destroyForUserExcept() removes the user's other sessions but keeps the excepted one", async () => {
      await store.write("current", "alice", inMinutes(60));
      await store.write("other-1", "alice", inMinutes(60));
      await store.write("bob-1", "bob", inMinutes(60));

      await store.destroyForUserExcept("alice", "current");

      await expect(store.read("current")).resolves.not.toBeNull();
      await expect(store.read("other-1")).resolves.toBeNull();
      await expect(store.read("bob-1")).resolves.not.toBeNull();
    });

    it("gc() deletes only expired sessions and reports the count", async () => {
      await store.write("live", "alice", inMinutes(60));
      await store.write("stale-1", "alice", inMinutes(-1));
      await store.write("stale-2", "bob", inMinutes(-5));

      await expect(store.gc()).resolves.toBe(2);
      await expect(store.read("live")).resolves.not.toBeNull();
    });
  } else {
    it("destroyForUser() throws a directive error rather than silently doing nothing", async () => {
      // Failing loudly matters here: silently no-op'ing "log this user
      // out everywhere" would look like it worked.
      await expect(store.destroyForUser("alice")).rejects.toThrow(/database.*session store/i);
    });

    it("destroyForUserExcept() throws the same directive error", async () => {
      await expect(store.destroyForUserExcept("alice", "current")).rejects.toThrow(
        /database.*session store/i,
      );
    });

    it("gc() is a no-op because the cache expires entries itself", async () => {
      await store.write("stale", "alice", inMinutes(-1));
      await expect(store.gc()).resolves.toBe(0);
    });
  }
});
