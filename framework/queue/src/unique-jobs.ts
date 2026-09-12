import type { Application } from "@mahiframework/core";
import {
  CACHE_TOKEN,
  LockTimeoutError,
  type CacheManager,
  type CacheStore,
} from "@mahiframework/cache";
import type { Job, JobClass } from "./job.js";
import { uniqueModeOf } from "./job.js";
import { decodeJob, type JobState } from "./job-serialization.js";

/**
 * Dispatch-time uniqueness for jobs — Laravel's `ShouldBeUnique` /
 * `ShouldBeUniqueUntilProcessing`, built on `@mahiframework/cache` locks.
 *
 * A job opts in with a `static unique` marker (see `Job.uniqueId`/
 * `UniqueJobClass`). At dispatch, `QueueManager.dispatch()` tries to
 * acquire a lock keyed by the job's registered name + `uniqueId()`; if it
 * is already held, the dispatch is a **silent no-op** (a duplicate is
 * dropped), which is what stops a burst of N dispatches enqueuing N rows.
 * The lock is released when the job finishes (`untilFinished`) or when a
 * worker starts processing it (`untilProcessing`).
 *
 * The lock is acquired in the dispatching process and released in
 * whichever worker later runs the job — a cross-process handoff — so
 * release goes through `Lock.forceRelease()` (owner-less, keyed) rather
 * than the owner-checked `release()`. The worker reconstructs the exact
 * same key from the job's class name and `uniqueId()`, so nothing about
 * the lock needs persisting in the payload. `uniqueFor()` is the TTL: a
 * worker that dies mid-job lets the lock expire rather than wedging the
 * job class forever.
 */

/** Default uniqueness lock TTL in seconds when a job/connection sets none. */
export const DEFAULT_UNIQUE_FOR_SECONDS = 3600;

/**
 * The cache lock key for a unique job: `mahi:unique:<registryName>:<id>`,
 * where `id` is the job's `uniqueId()` (or `""` for class-wide
 * uniqueness). The registry name — not `constructor.name` — is used so the
 * key survives minification and matches on both the dispatch and worker
 * sides.
 */
export function uniqueLockKey(registryName: string, job: Job): string {
  const id = job.uniqueId?.() ?? "";

  return `mahi:unique:${registryName}:${id}`;
}

/**
 * Resolve the `CacheStore` backing a job's uniqueness lock: the job's own
 * `uniqueVia()` (a live store or a store name) when given, else the cache
 * manager's default store.
 *
 * Returns `undefined` when no cache is available at all (the `@mahiframework/cache`
 * manager isn't bound and the job named no explicit store) — the caller
 * treats that as "uniqueness cannot be enforced", allowing the dispatch to
 * proceed rather than throwing, so a queue-only app without a configured
 * cache does not hard-fail on a unique job.
 */
export function resolveUniqueStore(app: Application, job: Job): CacheStore | undefined {
  const via = job.uniqueVia?.();

  if (via && typeof via !== "string") {
    return via;
  }

  if (!app.has(CACHE_TOKEN)) {
    return undefined;
  }

  const cache = app.make<CacheManager>(CACHE_TOKEN);

  return cache.store(typeof via === "string" ? via : undefined);
}

/**
 * Acquire the uniqueness lock for a job about to be dispatched.
 *
 * Returns `true` when the lock was acquired (or uniqueness does not apply,
 * or cannot be enforced) — i.e. "go ahead and push". Returns `false` when
 * the lock is already held, meaning an identical job is already queued (or
 * running) and this dispatch should be dropped.
 *
 * A non-unique job returns `true` without touching the cache. A unique job
 * whose store cannot be resolved also returns `true` (fail open — better a
 * possible duplicate than a dispatch that throws because the cache is
 * unconfigured), after logging a warning.
 */
export async function acquireUniqueLock(
  app: Application,
  registryName: string,
  job: Job,
  uniqueForDefault?: number,
): Promise<boolean> {
  if (uniqueModeOf(job) === undefined) {
    return true;
  }

  const store = resolveUniqueStore(app, job);

  if (!store) {
    app.logger.warning(
      "queue: a unique job was dispatched but no cache store is available to enforce uniqueness; " +
        "the dispatch proceeded without a lock.",
      { job: registryName },
    );

    return true;
  }

  const ttl = job.uniqueFor?.() ?? uniqueForDefault ?? DEFAULT_UNIQUE_FOR_SECONDS;
  const lock = store.lock({
    key: uniqueLockKey(registryName, job),
    automaticReleaseAfterSeconds: ttl,
    // Try once: uniqueness is a non-blocking "is one already queued?"
    // check, never a wait — waiting would stall the dispatcher.
    maximumWaitForSeconds: 0,
  });

  try {
    await lock.acquire();

    return true;
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return false;
    } // already queued

    throw error; // a real store failure belongs on the dispatch's error path
  }
}

/**
 * Acquire the uniqueness lock for an already-**serialized** job about to
 * be pushed — the chain-advance path, where the worker has a
 * `{ jobClass, state }` pair rather than a live instance.
 *
 * Uniqueness applies to each link of a chain independently (matching
 * Laravel), but only the *head* of a chain goes through
 * `QueueManager.dispatch()`; every tail link is pushed straight onto the
 * driver by the worker as its predecessor succeeds. Without this, a
 * `ShouldBeUnique` job enqueued as a tail link skipped its lock entirely
 * — so a chain could enqueue a duplicate of a job that was already
 * queued, which is the exact thing the marker exists to prevent.
 *
 * Returns `true` when the push should proceed. Rebuilding the instance is
 * necessary because the lock key depends on `uniqueId()` (and the store
 * on `uniqueVia()`), both of which are methods on the class. A rebuild
 * that throws — most often a referenced model deleted while the chain was
 * mid-flight — returns `true` rather than propagating: the push then
 * proceeds and the *worker* deals with the missing model on its own
 * established path (skip or fail per `deleteWhenMissingModels`), instead
 * of the chain silently stalling here with no record anywhere.
 */
export async function acquireUniqueLockForState(
  app: Application,
  registryName: string,
  JobClass: JobClass,
  state: JobState,
  uniqueForDefault?: number,
): Promise<boolean> {
  // Cheap gate first: a non-unique job (the overwhelming majority) must
  // not pay for a decode, which can hit the database to rehydrate models.
  if ((JobClass as { unique?: unknown }).unique === undefined) {
    return true;
  }

  let job: Job;
  try {
    job = await decodeJob(app, JobClass, state);
  } catch {
    return true;
  }

  return acquireUniqueLock(app, registryName, job, uniqueForDefault);
}

/**
 * Release a job's uniqueness lock, by reconstructing the same key the
 * dispatcher locked and force-releasing it (owner-less, since the releasing
 * process is not the one that acquired it). Best-effort: never throws, so a
 * cache blip cannot fail an otherwise-successful job — a stale lock will
 * expire via `uniqueFor` regardless.
 *
 * A no-op for a non-unique job, or when no store can be resolved.
 */
export async function releaseUniqueLock(
  app: Application,
  registryName: string,
  job: Job,
): Promise<void> {
  if (uniqueModeOf(job) === undefined) {
    return;
  }

  try {
    const store = resolveUniqueStore(app, job);

    if (!store) {
      return;
    }

    const ttl = job.uniqueFor?.() ?? DEFAULT_UNIQUE_FOR_SECONDS;
    const lock = store.lock({
      key: uniqueLockKey(registryName, job),
      automaticReleaseAfterSeconds: ttl,
    });
    await lock.forceRelease();
  } catch (error) {
    app.logger.error(
      "queue: failed to release a unique job's lock (it will expire via uniqueFor).",
      {
        job: registryName,
        error,
      },
    );
  }
}
