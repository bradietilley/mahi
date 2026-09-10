/**
 * The current numeric value of a cache entry for `increment()`/
 * `decrement()`: `0` when absent, the number itself when it is one, and
 * an error otherwise.
 *
 * Throws on a non-numeric existing value rather than coercing, so every
 * store agrees: Redis `INCRBY` rejects it, and silently producing
 * `"5" + 1 === "51"` here would make a bug visible only under one
 * `CACHE_STORE`.
 */
export function numericValue(store: string, key: string, value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new Error(
    `${store}: cannot increment "${key}" — it holds ${JSON.stringify(value)}, which is not a number.`,
  );
}
