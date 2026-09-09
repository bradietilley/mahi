import { dataGet } from "./data.js";

/**
 * Dot-notation configuration store, e.g. `config.get("database.default")`.
 * Providers contribute default config via `merge(namespace, defaults)`,
 * typically inside their own `register()` — later merges win on conflicting
 * leaf keys but the merge is deep, so namespaces contributed by different
 * providers don't clobber each other.
 */

type PlainObject = Record<string, unknown>;

/**
 * A genuine plain object: `{}` or `Object.create(null)`, not an array,
 * `Date`, `Map`, class instance, etc. (whose own enumerable properties we
 * must not deep-merge into config). Mirrors `data.ts`'s check.
 */
function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

/** Segments we refuse to write through, so a dotted path can never walk an object's prototype. */
function isUnsafeSegment(segment: string): boolean {
  return segment === "__proto__" || segment === "constructor" || segment === "prototype";
}

function deepMerge<T extends PlainObject>(target: T, source: PlainObject): T {
  const output: PlainObject = { ...target };

  for (const [key, sourceValue] of Object.entries(source)) {
    if (isUnsafeSegment(key)) {
      continue;
    }

    const targetValue = output[key];

    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      output[key] = deepMerge(targetValue, sourceValue);
    } else {
      output[key] = sourceValue;
    }
  }

  return output as T;
}

/** Deep structural clone of config-shaped data (plain objects/arrays), leaving leaf values by reference. */
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }

  if (isPlainObject(value)) {
    const out: PlainObject = {};

    for (const [key, v] of Object.entries(value)) {
      out[key] = cloneValue(v);
    }

    return out;
  }

  return value;
}

export class ConfigRepository {
  private items: PlainObject = {};

  /**
   * Deeply merge a set of values into the given top-level namespace, e.g.
   * `merge("database", { default: "sqlite", connections: {...} })`.
   * Generic + `object`-constrained (rather than `Record<string, unknown>`)
   * so concrete config interfaces without an index signature (e.g.
   * `TodosConfig`) can be passed directly without a cast.
   */
  merge<T extends object>(namespace: string, values: T): void {
    const existing = isPlainObject(this.items[namespace])
      ? (this.items[namespace] as PlainObject)
      : {};
    this.items[namespace] = deepMerge(existing, values as PlainObject);
  }

  /**
   * Set a value by dot-notation key, e.g. `set("app.debug", true)` writes
   * the nested `{ app: { debug: true } }`, creating intermediate objects as
   * needed (matching Laravel's `Config::set`). A bare top-level key
   * (`set("app", {...})`) replaces that namespace outright.
   */
  set(key: string, value: unknown): void {
    const segments = key.split(".");
    let cursor: PlainObject = this.items;

    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i]!;

      if (isUnsafeSegment(segment)) {
        return;
      }

      const next = cursor[segment];

      if (!isPlainObject(next)) {
        cursor[segment] = {};
      }

      cursor = cursor[segment] as PlainObject;
    }

    const last = segments[segments.length - 1]!;

    if (isUnsafeSegment(last)) {
      return;
    }

    cursor[last] = value;
  }

  /**
   * Dot-notation getter, e.g. `get("database.connections.sqlite.filename")`.
   * Returns `fallback` (default `undefined`) if any segment is missing.
   * Returns a deep clone of object/array values so callers can't mutate the
   * repository through the returned reference.
   */
  get<T = unknown>(key: string, fallback: T): T;
  get<T = unknown>(key: string): T | undefined;
  get<T = unknown>(key: string, fallback?: T): T | undefined {
    const value = dataGet(this.items, key, fallback);

    return cloneValue(value) as T | undefined;
  }

  /**
   * As `get()`, but throws when the key is missing — for a service
   * provider whose subsystem cannot run without its config block, so a
   * forgotten `config/mail.ts` fails at boot with a clear message rather
   * than as `undefined` deep inside a manager.
   */
  require<T = unknown>(key: string): T {
    const missing = Symbol("missing");
    const value = dataGet(this.items, key, missing);

    if (value === missing) {
      throw new Error(`Required config key "${key}" is not set.`);
    }

    return cloneValue(value) as T;
  }

  /** Whether a dot-notation key exists (even when its value is `null`). Laravel's `Config::has`. */
  has(key: string): boolean {
    const missing = Symbol("missing");

    return dataGet(this.items, key, missing) !== missing;
  }

  /** Append `value` to the array at `key`, creating the array if absent. Laravel's `Config::push`. */
  push(key: string, value: unknown): void {
    const existing = dataGet(this.items, key, undefined);
    const array = Array.isArray(existing) ? [...existing] : [];
    array.push(value);
    this.set(key, array);
  }

  /** Prepend `value` to the array at `key`, creating the array if absent. Laravel's `Config::prepend`. */
  prepend(key: string, value: unknown): void {
    const existing = dataGet(this.items, key, undefined);
    const array = Array.isArray(existing) ? [...existing] : [];
    array.unshift(value);
    this.set(key, array);
  }

  /** A deep clone of the entire config tree — mutating it never mutates the repository. */
  all(): PlainObject {
    return cloneValue(this.items) as PlainObject;
  }
}
