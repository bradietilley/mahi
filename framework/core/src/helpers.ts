import { Collection } from "./collection.js";

/**
 * Values `blank()`/`filled()` inspect — every runtime type those helpers
 * actually branch on. `symbol` is omitted; passing one is a type error
 * rather than a silent `false`.
 */
export type Blankable = string | number | boolean | bigint | object | null | undefined;

/**
 * Laravel's `blank()` — null/empty check that treats `false` and `0` as
 * **not** blank (matching PHP `empty()`'s exceptions for those two, plus
 * Laravel's own string-trim rule). Empty arrays, empty Collections, empty
 * Maps/Sets, empty plain objects, `null`, `undefined`, and whitespace-only
 * strings are blank.
 */
export function blank(value: Blankable): boolean {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value === "string") {
    return value.trim() === "";
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  if (value instanceof Collection) {
    return value.isEmpty();
  }

  if (value instanceof Map || value instanceof Set) {
    return value.size === 0;
  }

  // Only *plain* objects are "countable" (blank when they have no keys).
  // A `Date`, class instance, function, etc. is never blank — matching
  // Laravel, where only Countables/arrays/strings can be blank and any
  // other object is `filled`. `Object.keys(new Date())` is `[]`, so the
  // old key-count check wrongly reported dates/instances as blank.
  const proto = Object.getPrototypeOf(value);

  if (proto === Object.prototype || proto === null) {
    return Object.keys(value).length === 0;
  }

  return false;
}

/** Inverse of `blank()`. */
export function filled(value: Blankable): boolean {
  return !blank(value);
}

/**
 * Resolve a value-or-thunk — Laravel's `value()`. If `val` is a function
 * it is called with `args`; otherwise `val` is returned as-is.
 */
export function value<T>(val: T | (() => T)): T;
export function value<T, A>(val: (arg: A) => T, arg: A): T;
export function value<T, A, B>(val: (a: A, b: B) => T, a: A, b: B): T;
export function value<T, A = never, B = never>(
  val: T | (() => T) | ((a: A) => T) | ((a: A, b: B) => T),
  a?: A,
  b?: B,
): T {
  return typeof val === "function" ? (val as (arg0: A, arg1: B) => T)(a as A, b as B) : val;
}

/**
 * Pass `value` through an optional callback and return the callback's
 * result (or `value` itself when no callback is given).
 *
 * Named `withValue` because `with` is a reserved word in JavaScript —
 * this is Laravel's `with($value, $callback)` helper. Distinct from
 * `tap()`, which always returns the original value.
 */
export function withValue<T, R>(value: T, callback: (value: T) => R): R;
export function withValue<T>(value: T, callback?: undefined): T;
export function withValue<T, R>(value: T, callback?: (value: T) => R): T | R {
  return callback ? callback(value) : value;
}

/**
 * Call `callback` for side effects and return the original `value`.
 * Top-level equivalent of `Collection.tap()` that works on any value.
 */
export function tap<T>(value: T, callback?: (value: T) => void): T {
  callback?.(value);

  return value;
}

/**
 * Retry `callback` up to `times` attempts (the first call counts).
 * `sleepMs` is a fixed delay between attempts, an array of per-attempt
 * delays (the last value is reused if attempts outlast the array), or a
 * function computing the delay from the attempt number and the error that
 * caused it — which is how a caller honours a server's `Retry-After`.
 * `when` gates whether a thrown error is retryable — returning `false`
 * rethrows immediately.
 *
 * `error` stays `unknown` because `catch` clauses are `unknown` — a
 * callback may throw anything, not only `Error`.
 */
export async function retry<T>(
  times: number,
  callback: (attempt: number) => T | Promise<T>,
  sleepMs: number | readonly number[] | ((attempt: number, error: unknown) => number) = 0,
  when?: (error: unknown) => boolean,
): Promise<T> {
  if (times < 1) {
    throw new RangeError("retry() requires times >= 1.");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= times; attempt++) {
    try {
      return await callback(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= times || (when && !when(error))) {
        throw error;
      }

      const delay =
        typeof sleepMs === "number"
          ? sleepMs
          : typeof sleepMs === "function"
            ? sleepMs(attempt, error)
            : (sleepMs[attempt - 1] ?? sleepMs.at(-1) ?? 0);

      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Run `tasks` with an optional concurrency cap, preserving array position
 * (or record keys) in the result, and surfacing a rejection as an `Error`
 * *value* rather than rejecting the pool — so one failure never discards
 * the other results. The general form of Laravel's `Http::pool()`, which
 * has nothing HTTP-specific about it: queue batches, storage uploads, and
 * per-model lazy loads want exactly this.
 *
 * Takes **thunks**, not promises. A `Promise` is already running by the
 * time you hold one, so an array of promises cannot be
 * concurrency-limited — Laravel needs its whole `LazyPromise`/`EachPromise`
 * apparatus precisely to defer construction so it can throttle.
 * `() => Promise<T>` is the same idea in one line of type signature.
 *
 *   const [a, b] = await pooled([() => fetchA(), () => fetchB()]);
 *   const { user } = await pooled({ user: () => fetchUser() }, { concurrency: 2 });
 *
 * `concurrency` defaults to unlimited; `1` is strictly sequential. Values
 * thrown that aren't `Error`s are wrapped in one, since `throw` accepts
 * any value.
 */
export async function pooled<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  options?: { concurrency?: number },
): Promise<Array<T | Error>>;
export async function pooled<T, K extends string>(
  tasks: Record<K, () => Promise<T>>,
  options?: { concurrency?: number },
): Promise<Record<K, T | Error>>;
export async function pooled<T>(
  tasks: ReadonlyArray<() => Promise<T>> | Record<string, () => Promise<T>>,
  options: { concurrency?: number } = {},
): Promise<Array<T | Error> | Record<string, T | Error>> {
  const isArray = Array.isArray(tasks);
  const entries: Array<[PropertyKey, () => Promise<T>]> = isArray
    ? (tasks as ReadonlyArray<() => Promise<T>>).map((task, index) => [index, task])
    : Object.entries(tasks as Record<string, () => Promise<T>>);

  if (options.concurrency !== undefined && options.concurrency < 1) {
    throw new RangeError("pooled() requires concurrency >= 1.");
  }

  const limit = options.concurrency ?? entries.length;

  const results: Array<T | Error> = new Array(entries.length);

  // A shared cursor consumed by `limit` workers running in parallel: each
  // takes the next index and runs it to completion, so at most `limit`
  // tasks are ever in flight regardless of how long any one of them takes.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const entry = entries[index];

      if (!entry) {
        return;
      }

      try {
        results[index] = await entry[1]();
      } catch (error) {
        results[index] = error instanceof Error ? error : new Error(String(error));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));

  if (isArray) {
    return results;
  }

  const record: Record<string, T | Error> = {};
  entries.forEach(([key], index) => {
    record[key as string] = results[index] as T | Error;
  });

  return record;
}

/**
 * Shorthand for `Collection.wrap(value)` — `null`/`undefined` become an
 * empty collection. Purely ergonomic; every call site that currently
 * writes `Collection.make(...)` can use this instead when wrapping a
 * value that might already be a collection, array, or scalar.
 */
export function collect<V>(
  value?: Collection<V, PropertyKey> | readonly V[] | V | null,
): Collection<V, number> {
  if (value === undefined || value === null) {
    return Collection.empty<V>();
  }

  return Collection.wrap(value);
}
