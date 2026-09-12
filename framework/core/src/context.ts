import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A key/value store for cross-cutting "context" that should ride along
 * with everything the application does during its lifetime — most
 * visibly, every log line (see `formatLogLine()` in `logger.ts`, which
 * appends `all()` as a trailing JSON object to each formatted line).
 * Mirrors the pragmatic subset of Laravel's
 * `Illuminate\Log\Context\Repository` that this framework needs today:
 * add/get/forget/only/except plus the `push` stack helper, `remember`,
 * and `scope`.
 *
 * PER-REQUEST ISOLATION. Laravel gets per-request isolation for free from
 * PHP's process-per-request model; a Node process serving concurrent
 * requests would otherwise share one repository across all of them, so
 * request-scoped data (request id, correlation id…) written by one request
 * would bleed into another's log lines. To avoid that, this repository has
 * TWO layers, resolved automatically per call:
 *
 *   - a **process-global** store — data added at boot (app version, deploy
 *     id, worker name…), visible to every request; and
 *   - a **per-request overlay** — an `AsyncLocalStorage`-scoped store
 *     opened by `runScoped()` for the duration of each request (the HTTP
 *     kernel wraps request handling in it, the same mechanism
 *     `@mahiframework/auth`'s `auth-context.ts` and `@mahiframework/database`'s
 *     `transaction-context.ts` use). It starts as a shallow copy of the
 *     global store, so a request sees all global context immediately, and
 *     every subsequent read/write/forget inside the request targets the
 *     overlay only — so nothing a request adds (or forgets) leaks into the
 *     global store or into any other concurrent request, and the overlay
 *     is discarded when the request ends.
 *
 * Outside any `runScoped()` scope (boot, a queue job, a CLI command, a
 * test) every operation falls back to the process-global store, so the API
 * is identical whether or not a request scope is active — you never have
 * to check.
 *
 * Omitted from Laravel's API: hidden data (`addHidden()` et al.),
 * counters (`increment()`/`decrement()`), and the dehydrate/hydrate
 * serialization hooks (Laravel's cross-queue-job context propagation).
 */
export class ContextRepository {
  private globalData: Record<string, unknown> = {};
  private readonly requestScope = new AsyncLocalStorage<Record<string, unknown>>();

  /**
   * The store the current call targets: the per-request overlay when a
   * `runScoped()` scope is active on this async call stack, otherwise the
   * process-global store. Every read/write goes through here so callers
   * never have to know which layer they're in.
   */
  private active(): Record<string, unknown> {
    return this.requestScope.getStore() ?? this.globalData;
  }

  /**
   * Run `fn` inside a fresh per-request context overlay, seeded with a
   * shallow copy of the current global context. Every `Context`
   * read/write inside `fn` (across `await` boundaries) targets that
   * overlay, isolated from other concurrent scopes; the overlay is
   * discarded when `fn` settles. The HTTP kernel opens exactly one of
   * these per request — see the class docstring.
   */
  runScoped<T>(fn: () => T): T {
    return this.requestScope.run({ ...this.globalData }, fn);
  }

  /** Whether a per-request scope is currently active on this call stack. */
  hasScope(): boolean {
    return this.requestScope.getStore() !== undefined;
  }

  /**
   * Add one key/value pair — or, given a record, merge every entry of it
   * in — overwriting any existing values. Laravel's `Context::add()`.
   */
  add(key: string, value: unknown): this;
  add(values: Record<string, unknown>): this;
  add(keyOrValues: string | Record<string, unknown>, value?: unknown): this {
    const data = this.active();

    if (typeof keyOrValues === "string") {
      data[keyOrValues] = value;
    } else {
      Object.assign(data, keyOrValues);
    }

    return this;
  }

  /** Add the key only if it isn't already present. Laravel's `addIf()`. */
  addIf(key: string, value: unknown): this {
    if (this.missing(key)) {
      this.active()[key] = value;
    }

    return this;
  }

  /** Retrieve a value, or `defaultValue` when the key is absent. */
  get<T = unknown>(key: string, defaultValue?: T): T | undefined {
    return this.has(key) ? (this.active()[key] as T) : defaultValue;
  }

  /** Retrieve a value and remove it in one step. Laravel's `pull()`. */
  pull<T = unknown>(key: string, defaultValue?: T): T | undefined {
    const value = this.get<T>(key, defaultValue);
    this.forget(key);

    return value;
  }

  /** True when the key has been set (even to `undefined`-adjacent values like `null`). */
  has(key: string): boolean {
    return Object.hasOwn(this.active(), key);
  }

  /** Inverse of `has()`. Laravel's `missing()`. */
  missing(key: string): boolean {
    return !this.has(key);
  }

  /**
   * All current context data, as a shallow copy — mutating the returned
   * object never mutates the repository. Inside a request scope this is
   * the overlay (global data plus anything the request added); outside
   * one it's the process-global store.
   */
  all(): Record<string, unknown> {
    return { ...this.active() };
  }

  /** Only the given keys (absent keys are simply omitted). Laravel's `only()`. */
  only(keys: string[]): Record<string, unknown> {
    const data = this.active();
    const result: Record<string, unknown> = {};

    for (const key of keys) {
      if (Object.hasOwn(data, key)) {
        result[key] = data[key];
      }
    }

    return result;
  }

  /** Everything except the given keys. Laravel's `except()`. */
  except(keys: string[]): Record<string, unknown> {
    const result = this.all();

    for (const key of keys) {
      delete result[key];
    }

    return result;
  }

  /** Remove one key, or several. Laravel's `forget()`. */
  forget(key: string | string[]): this {
    const data = this.active();

    for (const k of Array.isArray(key) ? key : [key]) {
      delete data[k];
    }

    return this;
  }

  /**
   * Append value(s) to the array stored at `key`, creating the array if
   * the key is new. Throws if the key already holds a non-array — same
   * guard as Laravel's `push()`.
   */
  push(key: string, ...values: unknown[]): this {
    const data = this.active();
    const existing = Object.hasOwn(data, key) ? data[key] : [];

    if (!Array.isArray(existing)) {
      throw new Error(
        `Unable to push value onto context stack for key "${key}" — existing value is not an array.`,
      );
    }

    data[key] = [...existing, ...values];

    return this;
  }

  /**
   * Return the value at `key`, first computing and storing it via
   * `factory` when absent. Laravel's `remember()`.
   */
  remember<T = unknown>(key: string, factory: () => T): T {
    if (this.missing(key)) {
      this.active()[key] = factory();
    }

    return this.active()[key] as T;
  }

  /**
   * Run `callback` with `data` temporarily merged into the active store,
   * restoring the previous context afterwards — even when the callback
   * throws, and (for async callbacks) only after the returned promise
   * settles. Changes the callback itself makes to the context are
   * discarded along with `data`, matching Laravel's `scope()` snapshot
   * semantics.
   *
   * Inside a request scope this snapshots/restores the per-request overlay
   * (so concurrent requests don't interfere); outside one it operates on
   * the process-global store — in which case, as before, an async
   * `scope()` is not isolated from other concurrent async work sharing the
   * global store.
   */
  scope<T>(callback: () => T, data: Record<string, unknown> = {}): T {
    const store = this.active();
    const snapshot = { ...store };
    Object.assign(store, data);

    const restore = () => this.replaceContents(store, snapshot);

    let result: T;
    try {
      result = callback();
    } catch (error) {
      restore();
      throw error;
    }

    if (result instanceof Promise) {
      return result.finally(restore) as T;
    }

    restore();

    return result;
  }

  /**
   * Replace every key of `target` in place with those of `source` — used
   * by `scope()` to restore a snapshot without reassigning the store
   * reference (which, for an `AsyncLocalStorage` overlay, is owned by the
   * scope and can't be swapped out).
   */
  private replaceContents(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const key of Object.keys(target)) {
      delete target[key];
    }

    Object.assign(target, source);
  }

  /** Remove all context data from the active store. Laravel's `flush()`. */
  flush(): this {
    this.replaceContents(this.active(), {});

    return this;
  }

  /** True when no context data has been set in the active store. */
  isEmpty(): boolean {
    return Object.keys(this.active()).length === 0;
  }
}
