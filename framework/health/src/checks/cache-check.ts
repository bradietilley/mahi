import { CACHE_TOKEN, Str } from "@mahiframework/core";
import type { HealthCheck } from "../health-check.js";
import type { CacheManagerLike } from "./contracts.js";

/**
 * Round-trips a unique value through the default cache store.
 *
 * A round trip, **not** a bare `put`. A `put` that succeeds against a
 * store whose reads are broken — a full disk under `FileCacheStore`, a
 * Redis replica that accepts writes and discards them — reports healthy.
 * Reading back a value only this invocation could have written is the
 * only assertion that catches that.
 *
 * `Str.uuid()` rather than `Math.random()` because two instances probing
 * concurrently must not collide on the key. The 60s TTL bounds the key's
 * life if `forget` fails, and `forget` is swallowed in the `finally`
 * because failing to clean up a 60-second key is not a cache outage.
 */
export const cacheCheck: HealthCheck = {
  name: "cache",
  group: "core",

  async run(app) {
    if (!app.has(CACHE_TOKEN)) {
      return null;
    }

    const store = app.make<CacheManagerLike>(CACHE_TOKEN).store();
    const key = `health-check:${Str.uuid()}`;
    const value = Str.uuid();

    try {
      await store.put(key, value, 60);
      const read = await store.get<string>(key);

      if (read !== value) {
        return `Cache read back ${JSON.stringify(read)}, expected the written value.`;
      }
    } finally {
      await store.forget(key).catch(() => {});
    }

    return true;
  },
};
