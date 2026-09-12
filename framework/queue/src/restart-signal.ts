import { CACHE_TOKEN, type Application } from "@mahiframework/core";
import type { CacheManager } from "@mahiframework/cache";

/**
 * The cache key holding the epoch-milliseconds timestamp of the most
 * recent `queue:restart`. Namespaced so it can't collide with an
 * application's own cached values.
 */
export const QUEUE_RESTART_KEY = "mahi:queue:restart";

/**
 * When the last `queue:restart` was issued, or `undefined` if never (or
 * if there is no cache to ask).
 *
 * A worker reads this after each job and compares it with its own start
 * time: a restart signalled *after* the worker started means the worker
 * is running stale code and should exit for its supervisor to replace.
 * That's the whole mechanism — deliberately a shared cache value rather
 * than a signal, because a deploy has no way to enumerate the PIDs of
 * workers spread across hosts, but every one of them can read one key.
 *
 * Requires a **shared** cache store (Redis, or any other cross-process
 * store) to work across hosts; with the array store this is per-process
 * and therefore useless, which is why it fails soft rather than throwing.
 */
export async function restartSignalledAt(app: Application): Promise<number | undefined> {
  const cache = resolveCache(app);

  if (!cache) {
    return undefined;
  }

  try {
    const value = await cache.store().get<number | string>(QUEUE_RESTART_KEY);

    if (value === undefined || value === null) {
      return undefined;
    }

    const at = Number(value);

    return Number.isFinite(at) ? at : undefined;
  } catch (error) {
    // A cache outage must not stop a worker that is otherwise healthy —
    // the worst case of failing soft here is that a restart signal is
    // missed until the next poll.
    app.logger.error("queue: could not read the restart signal.", { error });

    return undefined;
  }
}

/** Record "every worker started before now should stop". */
export async function signalRestart(app: Application): Promise<boolean> {
  const cache = resolveCache(app);

  if (!cache) {
    return false;
  }

  // No TTL: the timestamp must outlive any worker that might still be
  // running, and there is no upper bound on that. It is one key.
  await cache.store().put(QUEUE_RESTART_KEY, Date.now());

  return true;
}

function resolveCache(app: Application): CacheManager | undefined {
  if (!app.has(CACHE_TOKEN)) {
    return undefined;
  }

  return app.make<CacheManager>(CACHE_TOKEN);
}
