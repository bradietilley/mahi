/**
 * Wraps a single model row and exposes a `toJson()` method defining the
 * API-facing shape explicitly, decoupled from the DB row shape — Laravel's
 * `JsonResource` equivalent. A plain class, not a decorator or magic
 * serialization layer: every subclass writes its own explicit `toJson()`.
 *
 *   export class TodoResource extends Resource<TodoTable, TodoJson> {
 *     toJson(): TodoJson {
 *       return { id: this.model.id, title: this.model.title, done: this.model.done === 1, ... };
 *     }
 *   }
 *
 *   return c.json(new TodoResource(todo).toJson());
 *   return c.json(TodoResource.collection(rows));
 */
/** Awaited return of a value's `toJson()` — a resource's serialized shape. */
type ResourceShapeOf<R> = R extends { toJson(): infer S } ? Awaited<S> : never;

/**
 * The type a relation value becomes after `normalizeResourceValue` runs
 * over it (the runtime post-processing the no-mapper `whenLoaded()` output
 * flows through):
 *
 *   - a `Model` with a default resource (`toJsonResource(): SomeResource`)
 *     -> that resource's serialized shape;
 *   - a `Collection<T>` (via `toArray(): T[]`) -> `NormalizedRelation<T>[]`;
 *   - an array -> element-wise normalized;
 *   - anything else -> unchanged.
 *
 * The `Model` case is detected via the `toJsonResource` method the app adds
 * through its per-model declaration merge; a model without one falls
 * through to the identity branch (its `toJSON()` output is structurally its
 * own attributes anyway).
 */
export type NormalizedRelation<T> =
  NonNullable<T> extends {
    toJsonResource(): infer R;
  }
    ? ResourceShapeOf<R> | Extract<T, undefined | null>
    : NonNullable<T> extends { toArray(): (infer E)[] }
      ? NormalizedRelation<E>[] | Extract<T, undefined | null>
      : T extends (infer E)[]
        ? NormalizedRelation<E>[]
        : T;

export abstract class Resource<TModel, TShape = unknown> {
  constructor(protected model: TModel) {
    // Wrap the subclass's own `toJson()` so its output is post-processed by
    // `normalizeResourceValue` before reaching a caller: any `Model`
    // instance left in the shape (e.g. a bare `this.whenLoaded("author")`
    // with no mapper) is converted to its default resource's JSON, and the
    // same conversion recurses through `Collection`s, arrays, and plain
    // object values. Subclasses keep authoring a plain `toJson()`; the
    // normalization is transparent. Because a nested resource's `toJson()`
    // is itself wrapped, its output is already normalized, so the outer
    // walk is a cheap idempotent no-op over it. Wrapping in the constructor
    // (rather than renaming to a separate terminal method) keeps every
    // existing `new XResource(m).toJson()` call site working unchanged.
    const authored = this.toJson.bind(this) as () => TShape | Promise<TShape>;
    this.toJson = (() => {
      const result = authored();

      return (
        isThenable(result) ? result.then(normalizeResourceValue) : normalizeResourceValue(result)
      ) as TShape | Promise<TShape>;
    }) as typeof this.toJson;
  }

  /**
   * The API-facing shape. May be synchronous or return a `Promise` — a
   * resource whose shape needs async work (e.g. awaiting a per-row gate
   * `can()` method) declares `async toJson()`; callers `await` it (and
   * `collection()` resolves them in parallel).
   *
   * The value a subclass returns is post-processed: any `Model` instance
   * still present in the shape is replaced by its default resource's JSON
   * (`model.toJsonResource()`) — or the model's own `toJSON()` when it
   * declares no default resource — recursing through `Collection`s, arrays,
   * and nested object values. So `author: this.whenLoaded("author")` (no
   * mapper) emits the `User`'s `UserResource` shape automatically; supply a
   * mapper to override. The normalization preserves sync-ness: a resource
   * whose shape (and every nested resource it reaches) is synchronous stays
   * synchronous, so existing sync `toJson()` call sites (spreads, un-awaited
   * `.map`) keep working; it becomes a `Promise` only when the authored
   * shape or a nested resource is async.
   */
  abstract toJson(): TShape | Promise<TShape>;

  static collection<TModel, TShape>(
    this: new (model: TModel) => Resource<TModel, TShape>,
    models: TModel[],
  ): Promise<TShape[]> {
    return Promise.all(models.map((m) => new this(m).toJson()));
  }

  // Laravel's `JsonResource::when()`/`whenLoaded()`/`whenNotNull()` /
  // `mergeWhen()`. All of them rely on the same wire-format trick: a field
  // whose value is `undefined` disappears from the JSON entirely (unlike
  // `null`), because `JSON.stringify` omits `undefined`-valued keys — which
  // is exactly what `c.json(...)` / `Response.json(...)` runs. So a field
  // written as `author: this.whenLoaded("author", ...)` really vanishes
  // from the response when the relation was never loaded, rather than
  // serializing as `null`. (Ported verbatim from the app-level
  // `when-loaded.ts` workaround this replaces.)

  /**
   * Include a field only when `condition` is truthy, otherwise omit it.
   * `value` may be a plain value or a lazy `() => value` (only evaluated
   * when the condition holds — matching Laravel, and useful when producing
   * the value is expensive or would throw on absent data).
   *
   *   avatarUrl: this.when(this.model.avatar_path !== null, () => this.buildAvatarUrl()),
   */
  protected when<T>(condition: boolean, value: T | (() => T)): T | undefined {
    if (!condition) {
      return undefined;
    }

    return typeof value === "function" ? (value as () => T)() : value;
  }

  /**
   * Include a mapped relation only when it was actually loaded onto the
   * model (the key `EloquentBuilder.with()` populates), otherwise omit it.
   * A relation left unloaded is `undefined` on the row and disappears from
   * the JSON; a loaded-but-empty hasMany is an empty array and is kept.
   *
   *   author: this.whenLoaded("author", (u) => new UserResource(u).toJson()),
   *
   * Without a mapper the relation value is returned as-is and then flows
   * through `normalizeResourceValue` (see the constructor): a related
   * `Model` with a default resource emits that resource's JSON, a
   * `Collection` maps its members through theirs, etc. So the no-mapper
   * form's type is `NormalizedRelation<TModel[K]>` — the shape after that
   * conversion — not the raw model type.
   */
  protected whenLoaded<K extends keyof TModel & string>(
    relationName: K,
  ): NormalizedRelation<TModel[K]> | undefined;
  protected whenLoaded<K extends keyof TModel & string, TResult>(
    relationName: K,
    map: (value: NonNullable<TModel[K]>) => TResult,
  ): TResult | undefined;
  protected whenLoaded<K extends keyof TModel & string, TResult>(
    relationName: K,
    map?: (value: NonNullable<TModel[K]>) => TResult,
  ): TResult | TModel[K] | undefined {
    const value = (this.model as TModel)[relationName];

    if (value === undefined) {
      return undefined;
    }

    return map ? map(value as NonNullable<TModel[K]>) : value;
  }

  /**
   * Include a mapped appended value only when one was attached onto the
   * model (via `Model.append()`/`setAppended()`), otherwise omit it — the
   * appended-attribute counterpart to `whenLoaded()`. Distinguishes "never
   * appended" (omitted) from "appended as `undefined`/`null`" (kept) by
   * asking the model's `hasAppended()`, so a deliberately-`null` appended
   * value still reaches the wire.
   *
   *   likesCount: this.whenAppended("likesCount"),
   *   special: this.whenAppended("special_thing", (v) => shape(v)),
   */
  protected whenAppended<TResult = unknown>(name: string): TResult | undefined;
  protected whenAppended<TResult>(
    name: string,
    map: (value: unknown) => TResult,
  ): TResult | undefined;
  protected whenAppended<TResult>(
    name: string,
    map?: (value: unknown) => TResult,
  ): TResult | undefined {
    const model = this.model as {
      hasAppended?(n: string): boolean;
      getAppended?(n: string): unknown;
    };

    if (typeof model?.hasAppended !== "function" || !model.hasAppended(name)) {
      return undefined;
    }

    const value = model.getAppended!(name);

    return map ? map(value) : (value as TResult);
  }

  /**
   * Include a field only when `value` is neither `null` nor `undefined`,
   * otherwise omit it. Unlike a bare value, a `null` here is dropped from
   * the wire format rather than serialized.
   */
  protected whenNotNull<T>(value: T | null | undefined): T | undefined {
    return value === null || value === undefined ? undefined : value;
  }

  /**
   * Spread an object of extra fields into the output only when `condition`
   * holds, otherwise contribute nothing. Spread the result into `toJson()`:
   *
   *   return { id: this.model.id, ...this.mergeWhen(isAdmin, { secret: ... }) };
   */
  protected mergeWhen(
    condition: boolean,
    values: Record<string, unknown> | (() => Record<string, unknown>),
  ): Record<string, unknown> {
    if (!condition) {
      return {};
    }

    return typeof values === "function" ? values() : values;
  }
}

/** Duck-typed `Model` — carries `toJsonResource()`/`toJSON()` (see `@mahiframework/database`). */
interface ModelInstance {
  toJsonResource(): { toJson(): unknown | Promise<unknown> } | undefined;
  toJSON(): unknown;
}

/** Duck-typed `Collection` — carries `toArray()` (see `@mahiframework/core`). */
interface CollectionLike {
  toArray(): unknown[];
}

function isModelInstance(value: object): value is ModelInstance {
  return (
    typeof (value as ModelInstance).toJsonResource === "function" &&
    typeof (value as ModelInstance).toJSON === "function"
  );
}

function isCollectionLike(value: object): value is CollectionLike {
  return typeof (value as CollectionLike).toArray === "function";
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Normalize each element of `items`, preserving sync-ness: returns a plain
 * array when every element normalized synchronously, a `Promise` of one
 * only when at least one element was async. Keeps the whole pass sync for
 * the common all-sync case (see `normalizeResourceValue`).
 */
function normalizeEach(items: unknown[]): unknown[] | Promise<unknown[]> {
  const out = items.map(normalizeResourceValue);

  return out.some(isThenable) ? Promise.all(out) : (out as unknown[]);
}

/**
 * Recursively converts any `Model` instances embedded in a resource's
 * `toJson()` output into their default resource's JSON, so a relation
 * returned raw (e.g. `this.whenLoaded("author")` with no mapper) still
 * emits the related model's `Resource` shape. Walks:
 *
 *   - **Model instance** -> `model.toJsonResource()?.toJson()` (itself
 *     normalized), falling back to `model.toJSON()` when the model declares
 *     no default resource;
 *   - **Collection** (anything with `toArray()`) -> its items, normalized;
 *   - **Array** -> each element, normalized;
 *   - **plain object** -> each own enumerable value, normalized (keys with
 *     `undefined` values are preserved so `JSON.stringify` still omits
 *     them — the `whenLoaded`/`when` omission trick keeps working);
 *   - anything else (primitives, `Date`, etc.) -> returned unchanged.
 *
 * Models and Collections are detected structurally (duck-typed) rather than
 * via `instanceof`, so `@mahiframework/http` needs no runtime import of
 * `@mahiframework/database`/`@mahiframework/core`. Sync-preserving: only
 * returns a `Promise` when a nested resource's `toJson()` (or an already-
 * present value) is asynchronous, so synchronous shapes stay synchronous.
 */
export function normalizeResourceValue(value: unknown): unknown | Promise<unknown> {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (isModelInstance(value)) {
    const resource = value.toJsonResource();

    if (resource === undefined) {
      return value.toJSON();
    }

    const shape = resource.toJson();

    return isThenable(shape) ? shape.then(normalizeResourceValue) : normalizeResourceValue(shape);
  }

  if (isCollectionLike(value)) {
    return normalizeEach(value.toArray());
  }

  if (Array.isArray(value)) {
    return normalizeEach(value);
  }

  // Leave non-plain objects (Date, etc.) untouched; only walk plain objects.
  const proto = Object.getPrototypeOf(value);

  if (proto !== Object.prototype && proto !== null) {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const normalized = entries.map(([key, item]) => [key, normalizeResourceValue(item)] as const);

  if (!normalized.some(([, item]) => isThenable(item))) {
    return Object.fromEntries(normalized);
  }

  return Promise.all(normalized.map(async ([key, item]) => [key, await item] as const)).then(
    Object.fromEntries,
  );
}
