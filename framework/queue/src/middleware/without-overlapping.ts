import {
  CACHE_TOKEN,
  LockTimeoutError,
  type CacheManager,
  type CacheStore,
} from "@mahiframework/cache";
import { JOB_REGISTRY_TOKEN } from "../tokens.js";
import type { JobRegistry } from "../job-registry.js";
import type { JobMiddleware, JobMiddlewarePassable } from "./job-middleware.js";
import { ReleaseJobError } from "./release-job-error.js";

/** Options controlling how {@link WithoutOverlapping} behaves when the lock is held. */
export interface WithoutOverlappingOptions {
  /**
   * Seconds to wait before retrying when the lock is held, or `false`
   * to drop the job instead of releasing it.
   *
   * Default `5`, **not** `0`: a zero delay means the blocked job is
   * popped, finds the lock still held, and is released again
   * immediately, a hot loop that burns a worker slot and a database
   * write per iteration for the entire duration of the first job's
   * run. The release still counts an attempt either way, so the loop
   * is now bounded by `maxAttempts` too (see `QueueWorkCommand`), but
   * a sane delay is what stops it being pathological in the first
   * place.
   */
  releaseAfterSeconds?: number | false;
  /** Lock auto-release TTL (seconds) guarding against a crashed holder. Default `60`. */
  expireAfterSeconds?: number;
  /**
   * The cache store backing the lock. A live `CacheStore`, or a store
   * name resolved from the cache manager, or omitted to use the cache
   * manager's default store (resolved from the container via `CACHE_TOKEN`
   * at run time). Passing a live store keeps `@mahiframework/cache` an optional
   * peer for jobs that would rather resolve it themselves.
   */
  store?: CacheStore | string;
  /**
   * Share the lock across job *classes* (Laravel's
   * `WithoutOverlapping::shared()`). By default the lock key is prefixed
   * with the job's registered class name, so two different job classes
   * using the same key (e.g. `"invoice:1"`) do NOT block each other. Set
   * this to lock purely on the key, ignoring the class, for coordinating
   * distinct job classes that touch the same resource.
   */
  shared?: boolean;
}

/**
 * Job middleware ensuring no two jobs sharing the same lock key run
 * concurrently, wraps `@mahiframework/cache`'s `Lock` (backed by a
 * `CacheStore`'s atomic `add()`). While one instance holds the lock, other
 * instances are either **released** back onto the queue to retry later
 * (the default) or silently dropped, matching Laravel's
 * `WithoutOverlapping` `releaseAfter`/`dontRelease` semantics.
 *
 * This is run-time exclusivity. It stops two instances *running* at once.
 * It does NOT prevent duplicate *dispatch*; for that, mark the job class
 * `static unique` (see `ShouldBeUnique`).
 *
 * The `CacheStore` can be passed in explicitly (`new WithoutOverlapping
 * (store, key)`) or resolved from the container by omitting it:
 *
 *   middleware() {
 *     // explicit store:
 *     return [new WithoutOverlapping(this.cache.store(), `invoice:${this.invoice.id}`)];
 *   }
 *
 *   middleware() {
 *     // resolve the default cache store from the app:
 *     return [WithoutOverlapping.for(`invoice:${this.invoice.id}`)];
 *   }
 *
 * The lock is acquired before `next()` and released in a `finally`, so a
 * throwing job still frees the lock. `expireAfterSeconds` is the lock's
 * automatic-release safety net for a crashed holder (default 60s).
 *
 * The lock key is namespaced by the job's registered name by default
 * (`overlap:<jobName>:<key>`) so two unrelated job classes using the same
 * key don't collide; opt out with `shared: true` / `.shared()` to
 * coordinate across classes.
 */
export class WithoutOverlapping implements JobMiddleware {
  private readonly store: CacheStore | string | undefined;
  private readonly options: Omit<WithoutOverlappingOptions, "store">;

  constructor(
    store: CacheStore | string | undefined,
    private readonly key: string,
    options: Omit<WithoutOverlappingOptions, "store"> = {},
  ) {
    this.store = store;
    this.options = options;
  }

  /**
   * Build a `WithoutOverlapping` that resolves its store from the
   * container's default cache (`CACHE_TOKEN`) at run time, sugar for
   * `new WithoutOverlapping(undefined, key, options)`, so a job need not
   * thread a `CacheStore` through itself.
   */
  static for(
    key: string,
    options: Omit<WithoutOverlappingOptions, "store"> = {},
  ): WithoutOverlapping {
    return new WithoutOverlapping(undefined, key, options);
  }

  /** Fluent: don't release a blocked job, silently drop it. Laravel's `dontRelease()`. */
  dontRelease(): this {
    this.options.releaseAfterSeconds = false;

    return this;
  }

  /** Fluent: release a blocked job after `seconds`. Laravel's `releaseAfter()`. */
  releaseAfter(seconds: number): this {
    this.options.releaseAfterSeconds = seconds;

    return this;
  }

  /** Fluent: set the lock's crash-recovery TTL. Laravel's `expireAfter()`. */
  expireAfter(seconds: number): this {
    this.options.expireAfterSeconds = seconds;

    return this;
  }

  /** Fluent: share the lock across job classes (ignore the class prefix). Laravel's `shared()`. */
  shared(): this {
    this.options.shared = true;

    return this;
  }

  async handle(
    passable: JobMiddlewarePassable,
    next: (passable: JobMiddlewarePassable) => Promise<void>,
  ): Promise<void> {
    const releaseAfter = this.options.releaseAfterSeconds ?? 5;
    const expireAfter = this.options.expireAfterSeconds ?? 60;
    const store = this.resolveStore(passable);

    // Non-blocking acquire: try once. If the lock is held, either release
    // for a later retry or drop, per configuration. Never sit and wait,
    // which would tie up the worker slot.
    const lock = store.lock({
      key: this.lockKey(passable),
      automaticReleaseAfterSeconds: expireAfter,
      maximumWaitForSeconds: 0,
    });

    let acquired = false;
    try {
      await lock.acquire();
      acquired = true;
    } catch (error) {
      // ONLY a timeout means "someone else holds it". A bare `catch {}`
      // here also swallowed the store being unreachable, Redis down
      // looked exactly like contention, so every job on every worker
      // quietly released itself forever while the actual problem went
      // unreported. Anything that isn't a lock timeout is a real error
      // and belongs on the job's normal failure path.
      if (!(error instanceof LockTimeoutError)) {
        throw error;
      }

      acquired = false;
    }

    if (!acquired) {
      if (releaseAfter === false) {
        return;
      } // dontRelease: silently skip this run

      throw new ReleaseJobError(releaseAfter);
    }

    try {
      await next(passable);
    } finally {
      await lock.release();
    }
  }

  /**
   * The lock key: `overlap:<jobName>:<key>` by default, so two unrelated
   * job classes using the same `key` don't share a lock; `overlap:<key>`
   * when `shared`, Laravel's cross-class behaviour.
   *
   * The class part is the job's REGISTERED name, not `constructor.name`:
   * under a production bundle a minifier renames classes, so two different
   * job classes can collapse to the same `constructor.name` (`e`) and end
   * up sharing an overlap lock, or one class gets a different name across
   * deploys and loses exclusivity mid-rollout. The registry name is the
   * same stable string the persisted payload and `ShouldBeUnique` already
   * key on.
   *
   * Falls back to `constructor.name` when the registry can't answer:
   * either the queue provider isn't installed (this middleware works
   * standalone), or the job class was never registered. A lock key is not
   * worth failing a job over.
   */
  private lockKey(passable: JobMiddlewarePassable): string {
    if (this.options.shared) {
      return `overlap:${this.key}`;
    }

    return `overlap:${this.jobName(passable)}:${this.key}`;
  }

  /** The job's registry name, or its constructor name if unavailable. See `lockKey()`. */
  private jobName(passable: JobMiddlewarePassable): string {
    const fallback = passable.job.constructor?.name ?? "job";

    if (!passable.app.has(JOB_REGISTRY_TOKEN)) {
      return fallback;
    }

    try {
      return passable.app.make<JobRegistry>(JOB_REGISTRY_TOKEN).nameFor(passable.job);
    } catch {
      return fallback;
    }
  }

  /**
   * Resolve the `CacheStore` to lock on: a live store passed in as-is; a
   * store name or omitted store resolved from the container's cache
   * manager (`CACHE_TOKEN`), the default store when no name was given.
   */
  private resolveStore(passable: JobMiddlewarePassable): CacheStore {
    if (this.store && typeof this.store !== "string") {
      return this.store;
    }

    const cache = passable.app.make<CacheManager>(CACHE_TOKEN);

    return cache.store(typeof this.store === "string" ? this.store : undefined);
  }
}
