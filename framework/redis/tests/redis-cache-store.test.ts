import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Lock } from "@mahi/cache";
import { RedisQueueDriver } from "../src/drivers/redis-queue-driver.js";
import { RedisCacheStore, DEFAULT_CACHE_PREFIX } from "../src/drivers/redis-cache-store.js";
import type { RedisConnection } from "../src/redis-connection.js";
import { REDIS_UNAVAILABLE, testConnection, testPrefix } from "./redis-test-helpers.js";

describe.skipIf(REDIS_UNAVAILABLE)("RedisCacheStore (integration)", () => {
  const connections: RedisConnection[] = [];

  /**
   * A store on its own connection, prefixed the way the shipped template
   * prefixes one: a connection-level `keyPrefix` (there, `"mahi:"`) and
   * the store's *default* namespace inside it. The store prefix is NOT
   * passed: using the same string for both the connection and the store
   * prefix is the one configuration in which a broken `flush()` happens
   * to work, so it hides the bug rather than catching it.
   */
  async function store(): Promise<{
    store: RedisCacheStore;
    connection: RedisConnection;
    prefix: string;
  }> {
    const prefix = testPrefix();
    const connection = await testConnection({ keyPrefix: prefix });
    connections.push(connection);

    return { store: new RedisCacheStore(connection), connection, prefix };
  }

  afterEach(async () => {
    for (const connection of connections.splice(0)) {
      // Delete only this run's keys. `FLUSHDB` is global, and these
      // suites are not the only thing that may be using the dev Redis.
      const keys = await connection.client().keys(`${connection.keyPrefix()}*`);

      if (keys.length > 0) {
        await connection
          .client()
          .unlink(...keys.map((k) => k.slice(connection.keyPrefix().length)));
      }

      await connection.disconnect();
    }
  });

  afterAll(async () => {
    for (const connection of connections.splice(0)) {
      await connection.disconnect();
    }
  });

  it("put()/get() round-trips a structured value", async () => {
    const { store: s } = await store();
    await s.put("key", { a: 1, nested: [true, "x"] });
    expect(await s.get("key")).toEqual({ a: 1, nested: [true, "x"] });
  });

  it("get() returns undefined for a missing key", async () => {
    const { store: s } = await store();
    expect(await s.get("missing")).toBeUndefined();
  });

  it("forget() removes a key and has() reflects presence", async () => {
    const { store: s } = await store();
    await s.put("key", "value");
    expect(await s.has("key")).toBe(true);
    await s.forget("key");
    expect(await s.has("key")).toBe(false);
  });

  it("put() with a ttl expires the value", async () => {
    const { store: s } = await store();
    await s.put("key", "value", 1);
    expect(await s.get("key")).toBe("value");
    await new Promise((r) => setTimeout(r, 1200));
    expect(await s.get("key")).toBeUndefined();
  });

  it("increment() is atomic across concurrent callers", async () => {
    const { store: s } = await store();
    const results = await Promise.all([
      s.increment("hits"),
      s.increment("hits"),
      s.increment("hits"),
    ]);
    expect(results.sort()).toEqual([1, 2, 3]);
    expect(await s.get("hits")).toBe(3);
  });

  it("add() sets only when absent and is exclusive under a race", async () => {
    const { store: s } = await store();
    const results = await Promise.all([s.add("key", "A"), s.add("key", "B"), s.add("key", "C")]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("stores keys under the connection prefix AND the store's own namespace", async () => {
    const { store: s, connection, prefix } = await store();
    await s.put("greeting", "kia ora");

    // ioredis strips nothing from KEYS' output, so this is the literal
    // stored key — both prefixes, in order.
    const keys = await connection.client().keys(`${prefix}*`);
    expect(keys).toEqual([`${prefix}${DEFAULT_CACHE_PREFIX}greeting`]);
  });

  describe("flush()", () => {
    it("clears this store's keys", async () => {
      const { store: s } = await store();
      await s.put("a", 1);
      await s.put("b", 2);

      await s.flush();

      expect(await s.get("a")).toBeUndefined();
      expect(await s.get("b")).toBeUndefined();
    });

    /**
     * The template sets the *connection's* `keyPrefix` (`"mahi:"`) and
     * leaves `stores.redis` empty. A store that read its prefix from a
     * separate config key would get `""`, scan `MATCH *` — every key in
     * the logical DB, the queue's included — and then `DEL` each match
     * with the connection prefix applied a second time by ioredis,
     * matching nothing: `cache:clear` would silently do nothing, and the
     * obvious "fix" (drop the connection prefix) would turn it into a
     * command that deletes every queued and in-flight job.
     *
     * Both halves are asserted here: the cache is really gone, and the
     * queue — same connection, same prefix, different namespace — is
     * untouched.
     */
    it("never touches the queue's keys on the same connection", async () => {
      const { store: s, connection, prefix } = await store();
      const queue = new RedisQueueDriver(connection, "default");

      await queue.push("App\\Jobs\\SendInvoice", { id: 7 });
      // A second job, reserved rather than ready — losing an in-flight
      // job is the worse half of this bug, and it lives under a different
      // key from the ready list.
      await queue.push("App\\Jobs\\SendReceipt", { id: 8 });
      const reserved = await queue.pop();
      expect(reserved).toBeDefined();

      // Asserted by prefix rather than by naming the driver's keys: the
      // exact layout (`queues:{default}:reserved`, list vs sorted set) is
      // the queue's business and has changed under this test before. What
      // must hold is that `flush()` leaves EVERY `queues:*` key alone,
      // whatever they are called.
      const queueKeysBefore = await connection.client().keys(`${prefix}queues:*`);
      expect(queueKeysBefore.length).toBeGreaterThanOrEqual(2);

      await s.put("cached", "value");

      await s.flush();

      expect(await s.get("cached")).toBeUndefined();
      expect(await queue.size()).toBe(1);
      expect((await connection.client().keys(`${prefix}queues:*`)).sort()).toEqual(
        queueKeysBefore.sort(),
      );
    });

    it("leaves a co-tenant application's keys alone", async () => {
      const { store: s } = await store();

      const other = await testConnection({ keyPrefix: "other-app:" });
      connections.push(other);
      await other.client().set("survivor", "keep-me");

      await s.put("a", 1);
      await s.flush();

      expect(await s.get("a")).toBeUndefined();
      expect(await other.client().get("survivor")).toBe("keep-me");
    });

    it("clears more keys than one SCAN batch returns", async () => {
      const { store: s } = await store();
      // `flush()` scans with COUNT 100, so this forces several round
      // trips and a non-zero cursor in between.
      await Promise.all(Array.from({ length: 250 }, (_, i) => s.put(`key:${i}`, i)));

      await s.flush();

      expect(await s.get("key:0")).toBeUndefined();
      expect(await s.get("key:249")).toBeUndefined();
    });
  });

  describe("locking", () => {
    /** Two stores on separate connections but the SAME prefixes — i.e. two processes of one app. */
    async function contenders(): Promise<[RedisCacheStore, RedisCacheStore]> {
      const prefix = testPrefix();
      const a = await testConnection({ keyPrefix: prefix });
      const b = await testConnection({ keyPrefix: prefix });
      connections.push(a, b);

      return [new RedisCacheStore(a), new RedisCacheStore(b)];
    }

    it("a Lock built on the store is genuinely exclusive across connections", async () => {
      const [s1, s2] = await contenders();

      const lock1 = s1.lock({
        key: "job",
        automaticReleaseAfterSeconds: 5,
        maximumWaitForSeconds: 0,
      });
      const lock2 = s2.lock({
        key: "job",
        automaticReleaseAfterSeconds: 5,
        maximumWaitForSeconds: 0,
      });

      await lock1.acquire();
      await expect(lock2.acquire()).rejects.toThrow();
      await lock1.release();

      // Now free — the other contender can take it.
      await expect(lock2.acquire()).resolves.toBeUndefined();
      await lock2.release();
    });

    it("releaseLock() deletes the key only when the owner still matches", async () => {
      const { store: s } = await store();

      await s.add("job_lock", "owner-a", 30);

      expect(await s.releaseLock("job_lock", "owner-b")).toBe(false);
      expect(await s.get("job_lock")).toBe("owner-a");

      expect(await s.releaseLock("job_lock", "owner-a")).toBe(true);
      expect(await s.get("job_lock")).toBeUndefined();
    });

    /**
     * The release race, made deterministic. A `Lock.release()` built as
     * `get()` then `forget()` is two round-trips with a window between
     * them. If the lock's TTL expires inside that window and a second
     * holder acquires it, the first holder's `forget()` deletes the
     * *second* holder's lock, and both then believe they hold it.
     *
     * The window is forced open here by expiring the key between the two
     * calls; with the atomic `releaseLock()` path there is no "between"
     * to force.
     */
    it("a stale release() cannot delete a lock a new owner has since acquired", async () => {
      const [s1, s2] = await contenders();

      const first = new Lock(s1, { key: "job", automaticReleaseAfterSeconds: 1 });
      await first.acquire();

      // The lock's TTL elapses (Redis EX has 1s granularity, so this is
      // the real thing rather than a simulation) and a second holder
      // legitimately takes it.
      await new Promise((r) => setTimeout(r, 1100));
      const second = new Lock(s2, {
        key: "job",
        automaticReleaseAfterSeconds: 30,
        maximumWaitForSeconds: 0,
      });
      await second.acquire();

      // The first holder's belated release must be a no-op.
      await first.release();

      expect(await s2.get("job_lock")).toBeDefined();
      await second.release();
      expect(await s2.get("job_lock")).toBeUndefined();
    });
  });
});
