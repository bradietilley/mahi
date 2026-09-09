import {
  dataFill,
  dataForget,
  dataGet,
  dataHas,
  dataSet,
  type DataList,
  type DataObject,
  type DataValue,
  type Paths,
  type PathValue,
} from "./data.js";
import { ItemNotFoundError, MultipleItemsFoundError } from "./collection.js";
import { value } from "./helpers.js";

function arrPull<T extends object, const P extends Paths<T>>(target: T, key: P): PathValue<T, P>;
function arrPull<T extends object, const P extends Paths<T>, F>(
  target: T,
  key: P,
  fallback: F,
): PathValue<T, P> | F;
function arrPull(target: object, key: string, fallback?: unknown): unknown {
  const found = dataGet(target as DataObject, key, fallback);
  dataForget(target as DataObject, key);

  return found;
}

function isIndexKey(key: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(key);
}

/**
 * One row of `Arr.crossJoin()`'s cartesian product: a tuple whose element
 * types line up positionally with the arrays passed in, so
 * `crossJoin([1, 2], ["a", "b"])` is `Array<[number, string]>` rather than
 * the lossy `Array<(number | string)[]>` a single type parameter yields.
 */
export type CrossJoined<T extends ReadonlyArray<readonly unknown[]>> = {
  [K in keyof T]: T[K] extends readonly (infer U)[] ? U : never;
};

/** A genuine plain object (`{}` / `Object.create(null)`), not a `Date`, class instance, etc. */
function isPlainObject(value: unknown): value is DataObject {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

export const Arr = {
  wrap<T>(value: T | T[] | undefined | null): T[] {
    if (value === undefined || value === null) {
      return [];
    }

    return Array.isArray(value) ? value : [value];
  },

  flatten<T>(value: readonly (T | readonly T[])[]): T[] {
    return value.flat() as T[];
  },

  only<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
    return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]])) as Pick<T, K>;
  },

  except<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
    const excluded = new Set(keys.map((k) => String(k)));

    return Object.fromEntries(Object.entries(obj).filter(([k]) => !excluded.has(k))) as Omit<T, K>;
  },

  get: dataGet,
  set: dataSet,
  fill: dataFill,
  has: dataHas,
  forget: dataForget,

  hasAny<T extends object>(target: T, keys: Paths<T> | readonly Paths<T>[]): boolean {
    const list = typeof keys === "string" ? [keys] : [...keys];

    return list.some((key) => dataHas(target, key));
  },

  /** Get a value by dotted path and remove it from `target` in one call. */
  pull: arrPull,

  first<T>(
    array: readonly T[],
    predicate?: ((item: T) => boolean) | null,
    fallback?: T | (() => T),
  ): T | undefined {
    const source = predicate ? array.filter(predicate) : array;

    if (source.length > 0) {
      return source[0];
    }

    return fallback === undefined ? undefined : value(fallback);
  },

  last<T>(
    array: readonly T[],
    predicate?: ((item: T) => boolean) | null,
    fallback?: T | (() => T),
  ): T | undefined {
    const source = predicate ? array.filter(predicate) : array;

    if (source.length > 0) {
      return source[source.length - 1];
    }

    return fallback === undefined ? undefined : value(fallback);
  },

  /**
   * Whether `value` is a list (array, or a plain object whose keys are
   * `"0".."n-1"`). Empty arrays/objects are lists, matching PHP 8.1
   * `array_is_list([])`.
   */
  isList(value: DataValue): boolean {
    if (Array.isArray(value)) {
      return true;
    }

    if (value === null || typeof value !== "object") {
      return false;
    }

    const keys = Object.keys(value);

    return keys.every((key, index) => key === String(index));
  },

  /** Inverse of `isList()` for objects/arrays; `false` for non-objects. */
  isAssoc(value: DataValue): boolean {
    if (value === null || typeof value !== "object") {
      return false;
    }

    return !Arr.isList(value);
  },

  /** Flatten a nested object/array into a single-level `{ "a.b.0": value }` map. */
  dot(target: DataValue, prefix = ""): Record<string, DataValue> {
    const out: Record<string, DataValue> = {};

    if (target === null || typeof target !== "object") {
      if (prefix !== "") {
        out[prefix] = target;
      }

      return out;
    }

    const entries = Array.isArray(target)
      ? target.map((v, i) => [String(i), v] as const)
      : Object.entries(target);

    if (entries.length === 0 && prefix !== "") {
      out[prefix] = Array.isArray(target) ? [] : {};

      return out;
    }

    for (const [key, nested] of entries) {
      const path = prefix === "" ? key : `${prefix}.${key}`;

      // Only recurse into plain objects/arrays; a `Date`, class instance,
      // etc. is a leaf value (recursing into one yields `{}` since it has no
      // own enumerable keys). `Arr.dot({ when: new Date() })` → `{ when: <Date> }`.
      if (Array.isArray(nested) || isPlainObject(nested)) {
        Object.assign(out, Arr.dot(nested, path));
      } else {
        out[path] = nested;
      }
    }

    return out;
  },

  /** Inverse of `dot()` — expand `{ "a.b": 1 }` back into `{ a: { b: 1 } }`. */
  undot(target: Record<string, DataValue>): DataObject | DataList {
    const out: DataObject = {};

    for (const [path, nested] of Object.entries(target)) {
      dataSet(out, path, nested);
    }

    return collapseList(out);
  },

  divide<T extends object>(obj: T): [Array<keyof T & string>, Array<T[keyof T]>] {
    return [Object.keys(obj) as Array<keyof T & string>, Object.values(obj) as Array<T[keyof T]>];
  },

  crossJoin<T extends ReadonlyArray<readonly unknown[]>>(...arrays: T): Array<CrossJoined<T>> {
    return arrays.reduce<unknown[][]>(
      (combos, array) => {
        const next: unknown[][] = [];

        for (const combo of combos) {
          for (const item of array) {
            next.push([...combo, item]);
          }
        }

        return next;
      },
      [[]],
    ) as Array<CrossJoined<T>>;
  },

  partition<T>(array: readonly T[], predicate: (item: T, index: number) => boolean): [T[], T[]] {
    const pass: T[] = [];
    const fail: T[] = [];
    array.forEach((item, index) => (predicate(item, index) ? pass : fail).push(item));

    return [pass, fail];
  },

  sole<T>(array: readonly T[], predicate?: (item: T) => boolean): T {
    const matches = predicate ? array.filter(predicate) : [...array];

    if (matches.length === 0) {
      throw new ItemNotFoundError();
    }

    if (matches.length > 1) {
      throw new MultipleItemsFoundError(matches.length);
    }

    return matches[0] as T;
  },

  where<T>(array: readonly T[], predicate: (item: T, index: number) => boolean): T[] {
    return array.filter(predicate);
  },

  whereNotNull<T>(array: readonly (T | null | undefined)[]): T[] {
    return array.filter((item): item is T => item !== null && item !== undefined);
  },

  /** Build an `application/x-www-form-urlencoded` query string from a nested object. */
  query(obj: DataObject): string {
    const params = new URLSearchParams();
    appendQuery(params, "", obj);

    return params.toString();
  },
} as const;

function collapseList(value: DataObject): DataObject | DataList {
  const keys = Object.keys(value);
  const asList =
    keys.length > 0 && keys.every((key, index) => key === String(index) && isIndexKey(key));

  if (!asList) {
    const nested: DataObject = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      nested[key] =
        nestedValue !== null && typeof nestedValue === "object" && !Array.isArray(nestedValue)
          ? collapseList(nestedValue as DataObject)
          : nestedValue;
    }

    return nested;
  }

  return keys.map((_, index) => {
    const nestedValue = value[String(index)];

    return nestedValue !== null && typeof nestedValue === "object" && !Array.isArray(nestedValue)
      ? collapseList(nestedValue as DataObject)
      : nestedValue;
  });
}

function appendQuery(params: URLSearchParams, prefix: string, value: DataValue): void {
  if (value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      appendQuery(params, prefix === "" ? String(index) : `${prefix}[${index}]`, item);
    });

    return;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      appendQuery(params, prefix === "" ? key : `${prefix}[${key}]`, nested);
    }

    return;
  }

  params.append(prefix, String(value));
}
