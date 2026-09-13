/**
 * Dot-notation get/set/fill/has/forget over nested objects and arrays,
 * Laravel's `data_get`/`data_set`/`data_fill`/`data_has`/`data_forget`.
 *
 * The path argument is type-checked against `T`: invalid paths fail at
 * compile time, and `dataGet`/`dataSet` propagate the type at that path
 * (`PathValue` / `PathAssigned`). `*` is a wildcard over array/object
 * values; remaining `*` segments collapse one array level, matching
 * Laravel. Runtime walks plain objects and arrays only, no reflection.
 *
 *   const country = dataGet(user, "address.country"); // string
 *   dataSet(user, "address.country", "NZ");
 */

import type { JoinPath, PathAssigned, Paths, PathValue } from "./data-path.js";

export type { JoinPath, PathAssigned, Paths, PathValue } from "./data-path.js";

/** A nested plain object `dataGet`/`dataSet` can walk. */
export type DataObject = { [key: string]: DataValue };

/** A nested array `dataGet`/`dataSet` can walk. */
export type DataList = DataValue[];

/**
 * A value those helpers can traverse or return: JSON-like scalars, nested
 * objects/arrays, plus leftover object leaves (`Date`, class instances)
 * that are stored but not walked. Excludes `symbol` (nothing here has a
 * reason to accept one).
 */
export type DataValue =
  string | number | boolean | bigint | null | undefined | DataObject | DataList | object;

type Accessible = DataObject | DataList;

function isPlainObject(value: DataValue): value is DataObject {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

function isAccessible(value: DataValue): value is Accessible {
  return Array.isArray(value) || isPlainObject(value);
}

function exists(target: Accessible, key: string): boolean {
  if (Array.isArray(target)) {
    const index = toIndex(key);

    return index !== undefined && index in target;
  }

  return Object.prototype.hasOwnProperty.call(target, key);
}

function read(target: Accessible, key: string): DataValue {
  if (Array.isArray(target)) {
    const index = toIndex(key);

    return index === undefined ? undefined : target[index];
  }

  return target[key];
}

function write(target: Accessible, key: string, value: DataValue): void {
  if (Array.isArray(target)) {
    const index = toIndex(key);

    if (index !== undefined) {
      target[index] = value;

      return;
    }
  }

  (target as DataObject)[key] = value;
}

function remove(target: Accessible, key: string): void {
  if (Array.isArray(target)) {
    const index = toIndex(key);

    if (index !== undefined && index in target) {
      target.splice(index, 1);
    }

    return;
  }

  delete target[key];
}

function toIndex(key: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) {
    return undefined;
  }

  return Number(key);
}

function isIndexSegment(segment: string): boolean {
  return toIndex(segment) !== undefined;
}

function collapse(values: DataValue[]): DataValue[] {
  const out: DataValue[] = [];

  for (const value of values) {
    if (Array.isArray(value)) {
      out.push(...value);
    } else {
      out.push(value);
    }
  }

  return out;
}

function pathSegments(key: string | readonly string[]): string[] {
  return typeof key === "string" ? key.split(".") : [...key];
}

function iterate(target: Accessible): DataValue[] {
  return Array.isArray(target) ? target : Object.values(target);
}

function getImpl(
  target: DataValue,
  key: string | readonly string[] | null | undefined,
  fallback?: unknown,
): unknown {
  if (key === null || key === undefined || key === "") {
    return target;
  }

  const segments = pathSegments(key);
  let cursor: DataValue = target;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;

    if (segment === "*") {
      if (!isAccessible(cursor)) {
        return fallback;
      }

      const rest = segments.slice(i + 1);
      const mapped = iterate(cursor).map((item) => getImpl(item, rest, fallback));

      return rest.includes("*") ? collapse(mapped as DataValue[]) : mapped;
    }

    if (!isAccessible(cursor) || !exists(cursor, segment)) {
      return fallback;
    }

    cursor = read(cursor, segment);
  }

  return cursor;
}

function setImpl(
  target: object,
  key: string | readonly string[],
  value: unknown,
  overwrite = true,
): object {
  const segments = pathSegments(key);

  if (segments.length === 0) {
    return target;
  }

  const root: Accessible = isAccessible(target)
    ? target
    : isIndexSegment(segments[0]!) && segments[0] !== "*"
      ? []
      : {};

  setAt(root, segments, value as DataValue, overwrite);

  return root;
}

/**
 * Read a dotted path from a nested object/array.
 *
 *   dataGet({ a: { b: 1 } }, "a.b")           // 1
 *   dataGet({ users: [{ name: "Ada" }] }, "users.*.name")  // ["Ada"]
 *
 * Missing *runtime* keys return `fallback` (default `undefined`). A
 * `null`/empty key returns `target` itself. Paths that don't exist on
 * `T` are a compile-time error, use an optional property on the type
 * (and a fallback) for keys that may be absent.
 *
 * @deprecated Prefer the Laravel-matching snake_case `data_get`.
 */
export function dataGet<T extends object>(target: T, key: null | undefined | ""): T;
export function dataGet<T extends object, const P extends Paths<T>, F>(
  target: T,
  key: P,
  fallback: F,
): PathValue<T, P> | F;
export function dataGet<T extends object, const P extends Paths<T>>(
  target: T,
  key: P,
): PathValue<T, P>;
export function dataGet<T extends object, const P extends readonly string[], F>(
  target: T,
  key: JoinPath<P> extends Paths<T> ? P : never,
  fallback: F,
): PathValue<T, JoinPath<P>> | F;
export function dataGet<T extends object, const P extends readonly string[]>(
  target: T,
  key: JoinPath<P> extends Paths<T> ? P : never,
): PathValue<T, JoinPath<P>>;
export function dataGet(
  target: object,
  key: string | readonly string[] | null | undefined,
  fallback?: unknown,
): unknown {
  return getImpl(target, key, fallback);
}

/**
 * Write `value` at a dotted path, creating missing objects/arrays along
 * the way. Mutates `target` when it is already an object/array; otherwise
 * builds a fresh structure and returns it. Callers should use the return
 * value (JS has no PHP-style pass-by-reference for primitives).
 *
 * `overwrite` (default `true`) controls whether an existing leaf is
 * replaced. `dataFill` is `dataSet` with `overwrite = false`. The path
 * must exist on `T`; the value must match `PathAssigned<T, P>`.
 *
 * @deprecated Prefer the Laravel-matching snake_case `data_set`.
 */
export function dataSet<T extends object, const P extends Paths<T>>(
  target: T,
  key: P,
  value: PathAssigned<T, P>,
  overwrite?: boolean,
): T;
export function dataSet<T extends object, const P extends readonly string[]>(
  target: T,
  key: JoinPath<P> extends Paths<T> ? P : never,
  value: PathAssigned<T, JoinPath<P>>,
  overwrite?: boolean,
): T;
export function dataSet(
  target: object,
  key: string | readonly string[],
  value: unknown,
  overwrite = true,
): object {
  return setImpl(target, key, value, overwrite);
}

/** Path segments that could reach an object's prototype and must never be written through. */
function isUnsafeSegment(segment: string): boolean {
  return segment === "__proto__" || segment === "constructor" || segment === "prototype";
}

function setAt(target: Accessible, segments: string[], value: DataValue, overwrite: boolean): void {
  const segment = segments[0]!;
  const rest = segments.slice(1);

  // Refuse to walk through a prototype-reaching segment, so a crafted path
  // like `__proto__.polluted` can never mutate `Object.prototype` (or an
  // instance's prototype). Global pollution was already impossible here, but
  // this makes the guard explicit and covers the per-object case too.
  if (isUnsafeSegment(segment)) {
    return;
  }

  if (segment === "*") {
    for (const item of iterate(target)) {
      if (isAccessible(item)) {
        setAt(item, rest, value, overwrite);
      }
    }

    return;
  }

  if (rest.length === 0) {
    if (overwrite || !exists(target, segment)) {
      write(target, segment, value);
    }

    return;
  }

  const existing = exists(target, segment) ? read(target, segment) : undefined;
  const next: Accessible = isAccessible(existing)
    ? existing
    : rest[0] === "*" || isIndexSegment(rest[0]!)
      ? []
      : {};

  if (!isAccessible(existing)) {
    write(target, segment, next);
  }

  setAt(next, rest, value, overwrite);
}

/**
 * `dataSet` that does not overwrite an existing leaf.
 *
 * @deprecated Prefer the Laravel-matching snake_case `data_fill`.
 */
export function dataFill<T extends object, const P extends Paths<T>>(
  target: T,
  key: P,
  value: PathAssigned<T, P>,
): T;
export function dataFill<T extends object, const P extends readonly string[]>(
  target: T,
  key: JoinPath<P> extends Paths<T> ? P : never,
  value: PathAssigned<T, JoinPath<P>>,
): T;
export function dataFill(target: object, key: string | readonly string[], value: unknown): object {
  return setImpl(target, key, value, false);
}

/**
 * Whether every given dotted path exists on `target` (key present,
 * even when the value is `null`/`undefined`). A string is one path;
 * an array of strings is several paths, all of which must exist,
 * matching Laravel's `Arr::has` / `data_has`.
 *
 * @deprecated Prefer the Laravel-matching snake_case `data_has`.
 */
export function dataHas<T extends object>(target: T, key: Paths<T> | readonly Paths<T>[]): boolean {
  const keys = typeof key === "string" ? [key] : [...key];

  if (keys.length === 0 || !isAccessible(target)) {
    return false;
  }

  return keys.every((path) => hasPath(target, pathSegments(path)));
}

function hasPath(target: DataValue, segments: string[]): boolean {
  let cursor: DataValue = target;

  for (const segment of segments) {
    if (!isAccessible(cursor) || !exists(cursor, segment)) {
      return false;
    }

    cursor = read(cursor, segment);
  }

  return true;
}

/**
 * Remove one or more dotted paths from `target` (mutates). An array of
 * strings is several paths, matching Laravel's `Arr::forget`.
 *
 * @deprecated Prefer the Laravel-matching snake_case `data_forget`.
 */
export function dataForget<T extends object>(target: T, key: Paths<T> | readonly Paths<T>[]): T {
  if (!isAccessible(target)) {
    return target;
  }

  const keys = typeof key === "string" ? [key] : [...key];

  for (const path of keys) {
    forgetPath(target, pathSegments(path));
  }

  return target;
}

function forgetPath(target: Accessible, segments: string[]): void {
  if (segments.length === 0) {
    return;
  }

  const segment = segments[0]!;
  const rest = segments.slice(1);

  if (segment === "*") {
    for (const item of iterate(target)) {
      if (isAccessible(item)) {
        forgetPath(item, rest);
      }
    }

    return;
  }

  if (rest.length === 0) {
    remove(target, segment);

    return;
  }

  if (exists(target, segment)) {
    const next = read(target, segment);

    if (isAccessible(next)) {
      forgetPath(next, rest);
    }
  }
}

// Laravel's global helpers are `data_get`/`data_set`/`data_fill`/
// `data_has`/`data_forget`. These snake_case names are the canonical
// export; the camelCase `dataGet`/etc. spellings above remain as
// `@deprecated` aliases so existing imports keep compiling. `as typeof`
// preserves the full overloaded signatures without re-declaring them.

/** Dot-notation getter over nested objects/arrays, Laravel's `data_get`. */
export const data_get = dataGet;

/** Dot-notation setter over nested objects/arrays, Laravel's `data_set`. */
export const data_set = dataSet;

/** `data_set` that does not overwrite an existing leaf, Laravel's `data_fill`. */
export const data_fill = dataFill;

/** Whether every given dotted path exists, Laravel's `data_has`. */
export const data_has = dataHas;

/** Remove one or more dotted paths (mutates), Laravel's `data_forget`. */
export const data_forget = dataForget;
