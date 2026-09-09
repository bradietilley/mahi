/**
 * Ordered-map collection wrapper — a near 1:1 port of Laravel's
 * `Illuminate\Support\Collection` (`Collection.php` +
 * `Traits/EnumeratesValues.php` + `Traits/Conditionable.php`).
 *
 * PHP arrays are ordered maps (`array-key => value`), which is why
 * Laravel's Collection has key-based methods (`get`/`put`/`has`/`forget`/
 * `keys`/`keyBy`) alongside list-style ones (`push`/`map`/`filter`).
 * To support that faithfully — e.g. `Collection.make(users).keyBy("email")`
 * returning a further-chainable `Collection<UserRow, string>`, not a
 * native `Map` — this class stores its items in an internal ordered
 * `Map<K, V>`, not a plain array. `K` defaults to `number` so a
 * freshly-`.make()`d collection behaves like a normal 0-indexed list
 * (mirroring PHP's default array keys), and re-keying operations
 * (`keyBy`, `flip`, `mapWithKeys`, ...) narrow `K` to whatever the new
 * key type is.
 *
 * Mutability matches Laravel exactly, method-by-method: methods that
 * mutate `$this->items` in Laravel (`push`, `pop`, `shift`, `unshift`,
 * `put`, `pull`, `forget`, `splice`, `transform`, `prepend`, `add`,
 * `getOrPut`) mutate this collection in place here too. Every other
 * method returns a new `Collection` (or plain value/Map), exactly as
 * `newInstance(...)` does in Laravel. `Collection.make()` defensively
 * clones its input, so mutations only ever affect the specific instance
 * returned by `.make()`, never the caller's original array/iterable.
 *
 * `push`/`unshift`/`add`/`pop`/`shift` are only available when
 * `K = number` (a "list-shaped" collection) — TypeScript enforces this
 * at the type level rather than silently reinterpreting keys the way
 * PHP does when you `array_push()` onto a string-keyed array.
 *
 * Not ported (no meaningful TS equivalent — see PR/plan discussion):
 * `dd`/`dump` (use `console.log`), `__toString`/`escapeWhenCastingToString`
 * (Blade-specific), `getCachingIterator` (SPL internals), `ArrayAccess`
 * offset* methods (use `get`/`put`/`has`/`forget` instead), `Macroable`
 * (no macro system here), `lazy()`/`LazyCollection` (doesn't exist in
 * this codebase), `toBase()`/`newInstance` PHP polymorphism plumbing,
 * `collapseWithKeys()`, `value()` (redundant with real TS types),
 * deprecated `containsOneItem`/`containsManyItems` aliases, `dot`/`undot`,
 * the `*Assoc`/`*Keys`/`intersectByKeys` set-op variants, and
 * `HigherOrderCollectionProxy` (dynamic `__call`-forwarding — same
 * rejection category as facades). All strict/loose (`*Strict`) pairs are
 * collapsed into a single strict-only (`===`) implementation, since
 * idiomatic TS doesn't use PHP's loose `==`.
 */

/** Thrown by `firstOrFail()`/`sole()` when no item matches. */
export class ItemNotFoundError extends Error {
  constructor(message = "Item not found.") {
    super(message);
    this.name = "ItemNotFoundError";
  }
}

/** Thrown by `sole()` when more than one item matches. */
export class MultipleItemsFoundError extends Error {
  constructor(public readonly count: number) {
    super(`${count} items found.`);
    this.name = "MultipleItemsFoundError";
  }
}

/** A value, or a thunk producing one — mirrors Laravel's `value($default)` helper for lazy defaults. */
type MaybeThunk<T> = T | (() => T);

function resolveThunk<T>(value: MaybeThunk<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

/** Either a plain value to compare for equality, or a predicate over (item, key). */
type ItemPredicate<V, K extends PropertyKey> = V | ((item: V, key: K) => boolean);

function toPredicate<V, K extends PropertyKey>(
  value: ItemPredicate<V, K>,
): (item: V, key: K) => boolean {
  if (typeof value === "function") {
    return value as (item: V, key: K) => boolean;
  }

  return (item) => item === value;
}

/** A property key on `V`, or a callback deriving a comparison value from an item. */
type ValueSelector<V, K extends PropertyKey, R = unknown> = keyof V | ((item: V, key: K) => R);

function valueRetriever<V, K extends PropertyKey, R = unknown>(
  selector: ValueSelector<V, K, R> | null | undefined,
): (item: V, key: K) => R {
  if (selector == null) {
    return (item: V) => item as unknown as R;
  }

  if (typeof selector === "function") {
    return selector as (item: V, key: K) => R;
  }

  return (item: V) => item[selector as keyof V] as unknown as R;
}

type WhereOperator = "=" | "==" | "===" | "!=" | "<>" | "!==" | "<" | ">" | "<=" | ">=";

function operatorForWhere<V, K extends PropertyKey>(
  key: keyof V,
  operator: WhereOperator = "=",
  value?: unknown,
): (item: V, k: K) => boolean {
  return (item: V) => {
    const retrieved = item[key];
    switch (operator) {
      case "=":
      case "==":
      case "===":
        return retrieved === value;
      case "!=":
      case "<>":
      case "!==":
        return retrieved !== value;
      case "<":
        return (retrieved as any) < (value as any);
      case ">":
        return (retrieved as any) > (value as any);
      case "<=":
        return (retrieved as any) <= (value as any);
      case ">=":
        return (retrieved as any) >= (value as any);
      default:
        return retrieved === value;
    }
  };
}

export class Collection<V, K extends PropertyKey = number> {
  private items: Map<K, V>;
  /** Tracks the next auto-assigned integer key, mirroring PHP's `$items[] = $value` semantics. */
  private nextIndex: number;

  private constructor(items: Map<K, V>, nextIndex: number) {
    this.items = items;
    this.nextIndex = nextIndex;
  }

  /** Build a Collection from a plain array — items are keyed `0, 1, 2, ...`, matching PHP's default list-array keys. */
  static make<V>(items: readonly V[]): Collection<V, number>;
  /**
   * Clone an existing Collection, preserving both keys and value type.
   * Declared explicitly because a `Collection` iterates its *values*, not
   * `[key, value]` entries, so it matches neither of the other overloads
   * — even though the implementation has always special-cased it (the
   * `items instanceof Collection` branch below).
   */
  static make<V, K extends PropertyKey>(items: Collection<V, K>): Collection<V, K>;
  /** Build a Collection from an existing Map of entries, preserving keys. */
  static make<V, K extends PropertyKey>(items: Iterable<readonly [K, V]>): Collection<V, K>;
  static make(items: any): Collection<any, any> {
    if (items instanceof Collection) {
      return new Collection(new Map(items.items), items.nextIndex);
    }

    if (Array.isArray(items)) {
      const map = new Map<number, unknown>();
      items.forEach((v, i) => map.set(i, v));

      return new Collection(map, items.length);
    }

    // Iterable<[K, V]> (e.g. a Map, or entries())
    const map = new Map<PropertyKey, unknown>();
    let maxInt = -1;

    for (const [k, v] of items as Iterable<[PropertyKey, unknown]>) {
      map.set(k, v);

      if (typeof k === "number" && Number.isInteger(k) && k > maxInt) {
        maxInt = k;
      }
    }

    return new Collection(map, maxInt + 1);
  }

  /** Create a new instance with no items. */
  static empty<V = never>(): Collection<V, number> {
    return new Collection(new Map(), 0);
  }

  /** Wrap the given value in a collection if it isn't one already (arrays/iterables pass through, scalars become a single-item collection). */
  static wrap<V>(value: Collection<V, any> | readonly V[] | V): Collection<V, number> {
    if (value instanceof Collection) {
      return Collection.make(value.toArray());
    }

    if (Array.isArray(value)) {
      return Collection.make(value);
    }

    return Collection.make([value] as V[]);
  }

  /** Get the underlying array from the given collection, or return the value unchanged if it isn't one. */
  static unwrap<V>(value: Collection<V, any> | V[]): V[] {
    return value instanceof Collection ? value.toArray() : value;
  }

  /** Create a Collection with the given inclusive numeric range. */
  static range(from: number, to: number, step = 1): Collection<number, number> {
    const values: number[] = [];

    if (step > 0) {
      for (let i = from; i <= to; i += step) {
        values.push(i);
      }
    } else if (step < 0) {
      for (let i = from; i >= to; i += step) {
        values.push(i);
      }
    }

    return Collection.make(values);
  }

  /** Create a new collection by invoking the callback `number` times (1-indexed, like Laravel's `times`). */
  static times<T>(number: number, callback?: (n: number) => T): Collection<T, number> {
    if (number < 1) {
      return Collection.empty();
    }

    const range = Collection.range(1, number, 1);

    return callback ? range.map(callback) : (range as unknown as Collection<T, number>);
  }

  /** Create a new collection by decoding a JSON string (must decode to an array). */
  static fromJson<T = unknown>(json: string): Collection<T, number> {
    return Collection.make(JSON.parse(json) as T[]);
  }

  private newInstance<V2, K2 extends PropertyKey = number>(
    items: Map<K2, V2>,
    nextIndex = 0,
  ): Collection<V2, K2> {
    return new Collection(items, nextIndex);
  }

  private entriesArray(): [K, V][] {
    return [...this.items.entries()];
  }

  /** @internal exposed for module-level helper functions (`toEntries`) that need raw entries from an arbitrary Collection. */
  static entriesOf<V, K extends PropertyKey>(collection: Collection<V, K>): [K, V][] {
    return collection.entriesArray();
  }

  /**
   * @internal True when the collection is "list-shaped": its keys are the
   * sequential integers `0, 1, …, n-1`. Used by `toEntries` so that merging
   * one list-like collection into another renumbers/appends (matching PHP's
   * `array_merge`) instead of overwriting by position.
   */
  static isListLike<V, K extends PropertyKey>(collection: Collection<V, K>): boolean {
    let expected = 0;

    for (const key of collection.items.keys()) {
      if (key !== expected) {
        return false;
      }

      expected++;
    }

    return true;
  }

  /** Get all items as a plain array (values only, keys discarded) — matches Laravel's `all()`/`toArray()` for list-shaped collections. */
  all(): V[] {
    return [...this.items.values()];
  }

  toArray(): V[] {
    return this.all();
  }

  /** Serialize to a plain array of values — makes `JSON.stringify(collection)` work automatically. */
  toJSON(): V[] {
    return this.all();
  }

  toJson(indent?: number): string {
    return JSON.stringify(this.all(), null, indent);
  }

  get length(): number {
    return this.items.size;
  }

  count(): number {
    return this.items.size;
  }

  isEmpty(): boolean {
    return this.items.size === 0;
  }

  isNotEmpty(): boolean {
    return !this.isEmpty();
  }

  [Symbol.iterator](): Iterator<V> {
    return this.items.values();
  }

  get(key: K, defaultValue?: MaybeThunk<V>): V | undefined {
    if (this.items.has(key)) {
      return this.items.get(key);
    }

    return defaultValue === undefined ? undefined : resolveThunk(defaultValue);
  }

  /** Get an item by key, or set it (via `put`) to `value`/`value()` if it doesn't exist yet. Mutates. */
  getOrPut(key: K, value: MaybeThunk<V>): V {
    if (this.items.has(key)) {
      return this.items.get(key) as V;
    }

    const resolved = resolveThunk(value);
    this.put(key, resolved);

    return resolved;
  }

  has(key: K | K[]): boolean {
    const keys = Array.isArray(key) ? key : [key];

    return keys.every((k) => this.items.has(k));
  }

  hasAny(keys: K[]): boolean {
    if (this.isEmpty()) {
      return false;
    }

    return keys.some((k) => this.items.has(k));
  }

  /** Set the item at the given key. Mutates. */
  put(key: K, value: V): this {
    this.items.set(key, value);

    if (typeof key === "number" && Number.isInteger(key) && key >= this.nextIndex) {
      this.nextIndex = key + 1;
    }

    return this;
  }

  /** Get and remove an item from the collection by key. Mutates. */
  pull(key: K, defaultValue?: MaybeThunk<V>): V | undefined {
    if (this.items.has(key)) {
      const value = this.items.get(key) as V;
      this.items.delete(key);

      return value;
    }

    return defaultValue === undefined ? undefined : resolveThunk(defaultValue);
  }

  /** Remove one or more items from the collection by key. Mutates. */
  forget(keys: K | K[]): this {
    const list = Array.isArray(keys) ? keys : [keys];

    for (const k of list) {
      this.items.delete(k);
    }

    return this;
  }

  /** Get the items with only the specified keys. */
  only(keys: K[]): Collection<V, K> {
    const set = new Set(keys);
    const map = new Map<K, V>();

    for (const [k, v] of this.items) {
      if (set.has(k)) {
        map.set(k, v);
      }
    }

    return this.newInstance(map, this.nextIndex);
  }

  /** Get all items except for those with the specified keys. */
  except(keys: K[]): Collection<V, K> {
    const set = new Set(keys);
    const map = new Map<K, V>();

    for (const [k, v] of this.items) {
      if (!set.has(k)) {
        map.set(k, v);
      }
    }

    return this.newInstance(map, this.nextIndex);
  }

  keys(): Collection<K, number> {
    return Collection.make([...this.items.keys()]);
  }

  /** Reset the keys on the underlying collection to sequential integers, discarding the current keys. */
  values(): Collection<V, number> {
    return Collection.make(this.all());
  }

  /** Push one or more items onto the end of the collection. Only available on list-shaped (`K = number`) collections. Mutates. */
  push(this: Collection<V, number>, ...values: V[]): Collection<V, number> {
    for (const v of values) {
      this.items.set(this.nextIndex, v);
      this.nextIndex += 1;
    }

    return this;
  }

  /** Alias for a single-item `push()`. Mutates. */
  add(this: Collection<V, number>, item: V): Collection<V, number> {
    return this.push(item);
  }

  /** Prepend one or more items to the beginning of the collection, renumbering all keys. Only available on list-shaped collections. Mutates. */
  unshift(this: Collection<V, number>, ...values: V[]): Collection<V, number> {
    const rest = [...this.items.values()];
    this.items = new Map();
    this.nextIndex = 0;

    for (const v of values) {
      this.items.set(this.nextIndex++, v);
    }

    for (const v of rest) {
      this.items.set(this.nextIndex++, v);
    }

    return this;
  }

  /**
   * Prepend a single item to the beginning of the collection. With no
   * explicit `key`, all integer keys are renumbered from 0 (like
   * `unshift`, matching PHP's `array_unshift`); with an explicit `key`,
   * only that key/value pair is inserted at the front and every other
   * key is left untouched. Mutates.
   */
  prepend(value: V, key?: K): this {
    const rest = this.entriesArray();
    this.items = new Map();

    if (key !== undefined) {
      this.items.set(key, value);

      for (const [k, v] of rest) {
        this.items.set(k, v);
      }

      if (typeof key === "number" && Number.isInteger(key) && key >= this.nextIndex) {
        this.nextIndex = key + 1;
      }

      return this;
    }

    let nextIndex = 0;
    this.items.set(nextIndex++ as unknown as K, value);

    for (const [, v] of rest) {
      this.items.set(nextIndex++ as unknown as K, v);
    }

    this.nextIndex = nextIndex;

    return this;
  }

  /** Get and remove the last item (or last `count` items) from the collection. Only available on list-shaped collections. Mutates. */
  pop(this: Collection<V, number>): V | undefined;
  pop(this: Collection<V, number>, count: number): Collection<V, number>;
  pop(this: Collection<V, number>, count?: number): V | undefined | Collection<V, number> {
    const keys = [...this.items.keys()];

    if (count === undefined) {
      const lastKey = keys[keys.length - 1];

      if (lastKey === undefined) {
        return undefined;
      }

      const value = this.items.get(lastKey);
      this.items.delete(lastKey);

      return value;
    }

    if (count < 1) {
      return Collection.empty();
    }

    const removedKeys = keys.slice(Math.max(0, keys.length - count));
    const removed: V[] = [];

    // Laravel's `pop($count)` returns the removed items in the order they
    // were popped — last item first — so `pop(2)` on `[1,2,3,4,5]` yields
    // `[5,4]`, not `[4,5]`. Walk the removed keys back-to-front.
    for (let i = removedKeys.length - 1; i >= 0; i--) {
      const k = removedKeys[i]!;
      removed.push(this.items.get(k) as V);
      this.items.delete(k);
    }

    return Collection.make(removed);
  }

  /** Get and remove the first item (or first `count` items) from the collection. Only available on list-shaped collections. Mutates. */
  shift(this: Collection<V, number>): V | undefined;
  shift(this: Collection<V, number>, count: number): Collection<V, number>;
  shift(this: Collection<V, number>, count?: number): V | undefined | Collection<V, number> {
    const keys = [...this.items.keys()];

    if (count === undefined) {
      const firstKey = keys[0];

      if (firstKey === undefined) {
        return undefined;
      }

      const value = this.items.get(firstKey);
      this.items.delete(firstKey);

      return value;
    }

    if (count < 1) {
      return Collection.empty();
    }

    const removedKeys = keys.slice(0, count);
    const removed: V[] = [];

    for (const k of removedKeys) {
      removed.push(this.items.get(k) as V);
      this.items.delete(k);
    }

    return Collection.make(removed);
  }

  /**
   * Splice a portion of the underlying collection, optionally replacing
   * it — mutates `this` and **returns the removed portion**, exactly
   * like `array_splice`/Laravel's `splice()` (not a pure `toSpliced`).
   * Only available on list-shaped collections.
   */
  splice(
    this: Collection<V, number>,
    offset: number,
    length?: number,
    replacement: V[] = [],
  ): Collection<V, number> {
    const values = this.all();
    const removed =
      length === undefined ? values.splice(offset) : values.splice(offset, length, ...replacement);
    this.items = new Map();
    this.nextIndex = 0;

    for (const v of values) {
      this.items.set(this.nextIndex++, v);
    }

    return Collection.make(removed);
  }

  /** Transform each item in the collection using a callback, in place. Mutates. */
  transform(callback: (item: V, key: K) => V): this {
    for (const [k, v] of this.items) {
      this.items.set(k, callback(v, k));
    }

    return this;
  }

  /** Execute a callback over each item; returning `false` from the callback stops iteration early (matches Laravel). */
  each(callback: (item: V, key: K) => unknown): this {
    for (const [k, v] of this.items) {
      if (callback(v, k) === false) {
        break;
      }
    }

    return this;
  }

  /** Run a map over each item, returning a new list-shaped Collection. */
  map<U>(callback: (item: V, key: K) => U): Collection<U, number> {
    const out: U[] = [];

    for (const [k, v] of this.items) {
      out.push(callback(v, k));
    }

    return Collection.make(out);
  }

  /**
   * Transform values while keeping every key exactly as it is.
   *
   * `map()` renumbers — it always returns a list-shaped
   * `Collection<U, number>` — which is what you want for a list and
   * silently wrong for a keyed collection, since the keys are the point.
   * The alternative was `mapWithKeys((v, k) => [k, f(v)])`, which restates
   * the key only to say "unchanged" and quietly rebuilds the collection
   * around whatever that expression evaluates to.
   *
   *   const c = Collection.make(new Map(Object.entries({ a: 1, b: 2 })));
   *
   *   c.mapValues((n) => n * 2);  // keys a, b — values 2, 4
   *   c.map((n) => n * 2);        // keys 0, 1 — values 2, 4
   *
   * Note the `new Map(...)`: `Object.entries()` returns an *array*, so
   * `make()` takes the array overload and produces a list of `[k, v]`
   * pairs rather than a keyed collection.
   *
   * Insertion order is preserved, as it is everywhere else here.
   */
  mapValues<U>(callback: (item: V, key: K) => U): Collection<U, K> {
    const map = new Map<K, U>();

    for (const [k, v] of this.items) {
      map.set(k, callback(v, k));
    }

    return this.newInstance(map);
  }

  /** Run a map over each item, mapping keys as well as values via a callback returning a single-entry object. */
  mapWithKeys<K2 extends PropertyKey, V2>(
    callback: (item: V, key: K) => [K2, V2],
  ): Collection<V2, K2> {
    const map = new Map<K2, V2>();

    for (const [k, v] of this.items) {
      const [k2, v2] = callback(v, k);
      map.set(k2, v2);
    }

    return this.newInstance(map);
  }

  /**
   * Group callback results by their first tuple element, collecting all
   * second elements into arrays. Returns a key→array Collection (like
   * Laravel's `mapToDictionary`), so the result keeps chaining.
   */
  mapToDictionary<K2 extends PropertyKey, V2>(
    callback: (item: V, key: K) => [K2, V2],
  ): Collection<V2[], K2> {
    const map = new Map<K2, V2[]>();

    for (const [k, v] of this.items) {
      const [k2, v2] = callback(v, k);
      const bucket = map.get(k2);

      if (bucket) {
        bucket.push(v2);
      } else {
        map.set(k2, [v2]);
      }
    }

    return this.newInstance(map);
  }

  /** Like `mapToDictionary`, but each group's values are wrapped in a Collection. */
  mapToGroups<K2 extends PropertyKey, V2>(
    callback: (item: V, key: K) => [K2, V2],
  ): Collection<Collection<V2, number>, K2> {
    const out = new Map<K2, Collection<V2, number>>();

    for (const [k, values] of this.mapToDictionary(callback).entriesArray()) {
      out.set(k, Collection.make(values));
    }

    return this.newInstance(out);
  }

  /** Map a collection and flatten the result by a single level. */
  flatMap<U>(callback: (item: V, key: K) => U | readonly U[]): Collection<U, number> {
    return this.map(callback).collapse() as unknown as Collection<U, number>;
  }

  /** Map each `[a, b, ...]`-tuple-shaped item by spreading it as positional args to the callback, plus the key as the final arg. */
  mapSpread<U>(callback: (...args: unknown[]) => U): Collection<U, number> {
    return this.map((item, key) => {
      const args = Array.isArray(item) ? [...item] : [item];
      args.push(key);

      return callback(...args);
    });
  }

  /** Map the values into new instances of `ctor`. */
  mapInto<U>(ctor: new (value: V, key: K) => U): Collection<U, number> {
    return this.map((v, k) => new ctor(v, k));
  }

  /** Execute a callback over each `[a, b, ...]`-tuple-shaped chunk, spread as positional args, plus the key as the final arg. */
  eachSpread(callback: (...args: unknown[]) => unknown): this {
    return this.each((item, key) => {
      const args = Array.isArray(item) ? [...item] : [item];
      args.push(key);

      return callback(...args);
    });
  }

  /** Reduce the collection to a single value. */
  reduce<R>(callback: (result: R, item: V, key: K) => R, initial: R): R {
    let result = initial;

    for (const [k, v] of this.items) {
      result = callback(result, v, k);
    }

    return result;
  }

  /** Reduce the collection into a mutated `initial` value (the callback mutates `initial` and returns nothing meaningful). */
  reduceInto<R>(initial: R, callback: (result: R, item: V, key: K) => void): R {
    for (const [k, v] of this.items) {
      callback(initial, v, k);
    }

    return initial;
  }

  /** Reduce the collection to multiple aggregate values, spread as positional args into the callback alongside each item/key. */
  reduceSpread(callback: (...args: unknown[]) => unknown[], ...initial: unknown[]): unknown[] {
    let result = initial;

    for (const [k, v] of this.items) {
      const next = callback(...result, v, k);

      if (!Array.isArray(next)) {
        throw new TypeError("Collection::reduceSpread expects reducer to return an array.");
      }

      result = next;
    }

    return result;
  }

  /** Filter items by a predicate (or, with no args, drop falsy items — matches PHP's `array_filter`). */
  filter(callback?: (item: V, key: K) => boolean): Collection<V, K> {
    const test = callback ?? ((item: V) => Boolean(item));
    const map = new Map<K, V>();

    for (const [k, v] of this.items) {
      if (test(v, k)) {
        map.set(k, v);
      }
    }

    return this.newInstance(map, this.nextIndex);
  }

  /** Create a collection of all elements that do NOT pass the given truth test (or don't equal the given value). */
  reject(callback: ItemPredicate<V, K> = true as unknown as V): Collection<V, K> {
    const predicate = toPredicate(callback);

    return this.filter((item, key) => !predicate(item, key));
  }

  /** Filter items by the given key/value pair, or `key` (operator `=`) value, or `key`/`operator`/`value` triple. */
  where<Kk extends keyof V>(key: Kk, value: V[Kk]): Collection<V, K>;
  where<Kk extends keyof V>(key: Kk, operator: WhereOperator, value: V[Kk]): Collection<V, K>;
  where(key: keyof V, operatorOrValue: unknown, value?: unknown): Collection<V, K> {
    const predicate =
      value === undefined
        ? operatorForWhere<V, K>(key, "=", operatorOrValue)
        : operatorForWhere<V, K>(key, operatorOrValue as WhereOperator, value);

    return this.filter(predicate);
  }

  whereNull<Kk extends keyof V>(key: Kk): Collection<V, K> {
    return this.filter((item) => item[key] === null || item[key] === undefined);
  }

  whereNotNull<Kk extends keyof V>(key: Kk): Collection<V, K> {
    return this.filter((item) => item[key] !== null && item[key] !== undefined);
  }

  whereIn<Kk extends keyof V>(key: Kk, values: readonly V[Kk][]): Collection<V, K> {
    const set = new Set(values);

    return this.filter((item) => set.has(item[key]));
  }

  whereNotIn<Kk extends keyof V>(key: Kk, values: readonly V[Kk][]): Collection<V, K> {
    const set = new Set(values);

    return this.filter((item) => !set.has(item[key]));
  }

  whereBetween<Kk extends keyof V>(key: Kk, values: readonly [V[Kk], V[Kk]]): Collection<V, K> {
    const [min, max] = values;

    return this.filter((item) => item[key] >= min && item[key] <= max);
  }

  whereNotBetween<Kk extends keyof V>(key: Kk, values: readonly [V[Kk], V[Kk]]): Collection<V, K> {
    const [min, max] = values;

    return this.filter((item) => item[key] < min || item[key] > max);
  }

  /** Filter the items, keeping only those that are instances of the given constructor(s) — narrows the item type. */
  whereInstanceOf<U extends V>(ctor: new (...args: any[]) => U): Collection<U, K> {
    return this.filter((item) => item instanceof ctor) as unknown as Collection<U, K>;
  }

  first(callback?: (item: V, key: K) => boolean): V | undefined {
    for (const [k, v] of this.items) {
      if (!callback || callback(v, k)) {
        return v;
      }
    }

    return undefined;
  }

  /** Like `first()`, but throws if no item matches. */
  firstOrFail(callback?: (item: V, key: K) => boolean): V {
    const placeholder = Symbol("not-found");
    let found: V | typeof placeholder = placeholder;

    for (const [k, v] of this.items) {
      if (!callback || callback(v, k)) {
        found = v;
        break;
      }
    }

    if (found === placeholder) {
      throw new ItemNotFoundError();
    }

    return found as V;
  }

  /** Get the first item matching the given key/operator/value condition. */
  firstWhere<Kk extends keyof V>(key: Kk, value: V[Kk]): V | undefined;
  firstWhere<Kk extends keyof V>(key: Kk, operator: WhereOperator, value: V[Kk]): V | undefined;
  firstWhere(key: keyof V, operatorOrValue: unknown, value?: unknown): V | undefined {
    const predicate =
      value === undefined
        ? operatorForWhere<V, K>(key, "=", operatorOrValue)
        : operatorForWhere<V, K>(key, operatorOrValue as WhereOperator, value);

    return this.first(predicate);
  }

  last(callback?: (item: V, key: K) => boolean): V | undefined {
    let result: V | undefined;

    for (const [k, v] of this.items) {
      if (!callback || callback(v, k)) {
        result = v;
      }
    }

    return result;
  }

  /** Get the first item in the collection, throwing unless exactly one item exists (optionally matching a predicate first). */
  sole(callback?: (item: V, key: K) => boolean): V {
    const matches = callback ? this.filter(callback) : this;

    if (matches.count() === 0) {
      throw new ItemNotFoundError();
    }

    if (matches.count() > 1) {
      throw new MultipleItemsFoundError(matches.count());
    }

    return matches.first() as V;
  }

  /** Whether the collection contains exactly one item (optionally matching a predicate). */
  hasSole(callback?: (item: V, key: K) => boolean): boolean {
    const matches = callback ? this.filter(callback) : this;

    return matches.count() === 1;
  }

  /** Whether the collection contains more than one item (optionally matching a predicate). */
  hasMany(callback?: (item: V, key: K) => boolean): boolean {
    const matches = callback ? this.filter(callback) : this;

    return matches.count() > 1;
  }

  contains(callback: ItemPredicate<V, K>): boolean {
    const predicate = toPredicate(callback);

    for (const [k, v] of this.items) {
      if (predicate(v, k)) {
        return true;
      }
    }

    return false;
  }

  /** Alias for `contains()`. */
  some(callback: ItemPredicate<V, K>): boolean {
    return this.contains(callback);
  }

  doesntContain(callback: ItemPredicate<V, K>): boolean {
    return !this.contains(callback);
  }

  every(callback: ItemPredicate<V, K>): boolean {
    const predicate = toPredicate(callback);

    for (const [k, v] of this.items) {
      if (!predicate(v, k)) {
        return false;
      }
    }

    return true;
  }

  /** Search the collection for a value or predicate match; returns the key, or `false` if not found (matching Laravel's `search()`). */
  search(callback: ItemPredicate<V, K>): K | false {
    const predicate = toPredicate(callback);

    for (const [k, v] of this.items) {
      if (predicate(v, k)) {
        return k;
      }
    }

    return false;
  }

  /** Get the item immediately before the first match for `value`/predicate, in iteration order. */
  before(callback: ItemPredicate<V, K>): V | undefined {
    const keysArr = [...this.items.keys()];
    const key = this.search(callback);

    if (key === false) {
      return undefined;
    }

    const position = keysArr.indexOf(key);

    if (position <= 0) {
      return undefined;
    }

    return this.items.get(keysArr[position - 1] as K);
  }

  /** Get the item immediately after the first match for `value`/predicate, in iteration order. */
  after(callback: ItemPredicate<V, K>): V | undefined {
    const keysArr = [...this.items.keys()];
    const key = this.search(callback);

    if (key === false) {
      return undefined;
    }

    const position = keysArr.indexOf(key);

    if (position === -1 || position === keysArr.length - 1) {
      return undefined;
    }

    return this.items.get(keysArr[position + 1] as K);
  }

  /** Throw if any item fails the given type check (constructor, or a predicate). */
  ensure(check: (new (...args: any[]) => unknown) | ((item: V) => boolean)): this {
    // A class (has a non-empty `.prototype`) is an `instanceof` check; a
    // plain function is a predicate. Never *call* a class — invoking one
    // without `new` throws "Class constructor cannot be invoked without
    // 'new'", masking the real "item failed the check" error.
    const isClass =
      typeof check === "function" && check.prototype && check.prototype.constructor === check;
    const predicate = isClass
      ? (item: V) => item instanceof (check as new (...args: any[]) => unknown)
      : (check as (item: V) => boolean);

    let index = 0;

    for (const v of this.items.values()) {
      if (!predicate(v)) {
        throw new TypeError(`Collection item at position ${index} failed the ensure() check.`);
      }

      index += 1;
    }

    return this;
  }

  /** Group items by a derived key; returns a key→Collection Collection (like Laravel), so the result keeps chaining. */
  groupBy<K2 extends PropertyKey>(
    selector: ValueSelector<V, K, K2>,
  ): Collection<Collection<V, number>, K2> {
    const retrieve = valueRetriever(selector);
    const buckets = new Map<K2, V[]>();

    for (const [k, v] of this.items) {
      const groupKey = retrieve(v, k);
      const bucket = buckets.get(groupKey);

      if (bucket) {
        bucket.push(v);
      } else {
        buckets.set(groupKey, [v]);
      }
    }

    const out = new Map<K2, Collection<V, number>>();

    for (const [k, values] of buckets) {
      out.set(k, Collection.make(values));
    }

    return this.newInstance(out);
  }

  keyBy<K2 extends PropertyKey>(selector: ValueSelector<V, K, K2>): Collection<V, K2> {
    const retrieve = valueRetriever(selector);
    const map = new Map<K2, V>();

    for (const [k, v] of this.items) {
      map.set(retrieve(v, k), v);
    }

    return this.newInstance(map);
  }

  /** Count occurrences per derived key; returns a key→count Collection (like Laravel), so the result keeps chaining. */
  countBy<K2 extends PropertyKey>(selector?: ValueSelector<V, K, K2>): Collection<number, K2> {
    const retrieve = valueRetriever<V, K, K2>(selector);
    const counts = new Map<K2, number>();

    for (const [k, v] of this.items) {
      const key = retrieve(v, k);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return this.newInstance(counts);
  }

  /** Partition the collection into `[matching, notMatching]` based on the given predicate. */
  partition(callback: ItemPredicate<V, K>): [Collection<V, number>, Collection<V, number>] {
    const predicate = toPredicate(callback);
    const pass: V[] = [];
    const fail: V[] = [];

    for (const [k, v] of this.items) {
      (predicate(v, k) ? pass : fail).push(v);
    }

    return [Collection.make(pass), Collection.make(fail)];
  }

  /** Retrieve duplicate values from the collection (by identity, or by a derived key), preserving their original keys. */
  duplicates<R = V>(selector?: ValueSelector<V, K, R>): Collection<V, K> {
    const retrieve = valueRetriever<V, K, R>(selector);
    const seen = new Set<R>();
    const dupes = new Map<K, V>();

    for (const [k, v] of this.items) {
      const id = retrieve(v, k);

      if (seen.has(id)) {
        dupes.set(k, v);
      } else {
        seen.add(id);
      }
    }

    return this.newInstance(dupes);
  }

  sum(selector?: ValueSelector<V, K, number>): number {
    const retrieve = valueRetriever<V, K, number>(selector);

    return this.reduce((acc, v, k) => acc + retrieve(v, k), 0);
  }

  avg(selector?: ValueSelector<V, K, number>): number | undefined {
    const retrieve = valueRetriever<V, K, number>(selector);
    let total = 0;
    let count = 0;

    for (const [k, v] of this.items) {
      const resolved = retrieve(v, k);

      if (resolved !== null && resolved !== undefined) {
        total += resolved;
        count += 1;
      }
    }

    return count ? total / count : undefined;
  }

  /** Alias for `avg()`. */
  average(selector?: ValueSelector<V, K, number>): number | undefined {
    return this.avg(selector);
  }

  min(selector?: ValueSelector<V, K, number>): number | undefined {
    const retrieve = valueRetriever<V, K, number>(selector);
    let result: number | undefined;

    for (const [k, v] of this.items) {
      const value = retrieve(v, k);

      if (value === null || value === undefined) {
        continue;
      }

      if (result === undefined || value < result) {
        result = value;
      }
    }

    return result;
  }

  max(selector?: ValueSelector<V, K, number>): number | undefined {
    const retrieve = valueRetriever<V, K, number>(selector);
    let result: number | undefined;

    for (const [k, v] of this.items) {
      const value = retrieve(v, k);

      if (value === null || value === undefined) {
        continue;
      }

      if (result === undefined || value > result) {
        result = value;
      }
    }

    return result;
  }

  median(selector?: ValueSelector<V, K, number>): number | undefined {
    const retrieve = valueRetriever<V, K, number>(selector);
    const values = this.all()
      .map((v, i) => retrieve(v, i as K))
      .filter((v): v is number => v !== null && v !== undefined)
      .sort((a, b) => a - b);
    const count = values.length;

    if (count === 0) {
      return undefined;
    }

    const middle = Math.floor(count / 2);

    if (count % 2) {
      return values[middle];
    }

    return (values[middle - 1]! + values[middle]!) / 2;
  }

  mode(selector?: ValueSelector<V, K, number>): number[] | undefined {
    if (this.isEmpty()) {
      return undefined;
    }

    const retrieve = valueRetriever<V, K, number>(selector);
    const counts = new Map<number, number>();

    for (const [k, v] of this.items) {
      const value = retrieve(v, k);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    const highest = Math.max(...counts.values());

    return [...counts.entries()]
      .filter(([, count]) => count === highest)
      .map(([value]) => value)
      .sort((a, b) => a - b);
  }

  /** Percentage (0-100) of items passing the given predicate, rounded to `precision` decimal places. */
  percentage(callback: (item: V, key: K) => boolean, precision = 2): number | undefined {
    if (this.isEmpty()) {
      return undefined;
    }

    const factor = 10 ** precision;

    return Math.round((this.filter(callback).count() / this.count()) * 100 * factor) / factor;
  }

  take(limit: number): Collection<V, K> {
    if (limit < 0) {
      return this.slice(limit);
    }

    return this.slice(0, limit);
  }

  skip(count: number): Collection<V, K> {
    return this.slice(count);
  }

  slice(offset: number, length?: number): Collection<V, K> {
    const entries = this.entriesArray();
    const start = offset < 0 ? Math.max(entries.length + offset, 0) : offset;
    const end = length === undefined ? entries.length : start + length;
    const map = new Map(entries.slice(start, end));

    return this.newInstance(map, this.nextIndex);
  }

  /** "Paginate" the collection by slicing it (1-indexed page number). */
  forPage(page: number, perPage: number): Collection<V, K> {
    const offset = Math.max(0, (page - 1) * perPage);

    return this.slice(offset, perPage);
  }

  takeUntil(callback: ItemPredicate<V, K>): Collection<V, K> {
    const predicate = toPredicate(callback);
    const map = new Map<K, V>();

    for (const [k, v] of this.items) {
      if (predicate(v, k)) {
        break;
      }

      map.set(k, v);
    }

    return this.newInstance(map, this.nextIndex);
  }

  takeWhile(callback: ItemPredicate<V, K>): Collection<V, K> {
    const predicate = toPredicate(callback);
    const map = new Map<K, V>();

    for (const [k, v] of this.items) {
      if (!predicate(v, k)) {
        break;
      }

      map.set(k, v);
    }

    return this.newInstance(map, this.nextIndex);
  }

  skipUntil(callback: ItemPredicate<V, K>): Collection<V, K> {
    const predicate = toPredicate(callback);
    const map = new Map<K, V>();
    let skipping = true;

    for (const [k, v] of this.items) {
      if (skipping && predicate(v, k)) {
        skipping = false;
      }

      if (!skipping) {
        map.set(k, v);
      }
    }

    return this.newInstance(map, this.nextIndex);
  }

  skipWhile(callback: ItemPredicate<V, K>): Collection<V, K> {
    const predicate = toPredicate(callback);
    const map = new Map<K, V>();
    let skipping = true;

    for (const [k, v] of this.items) {
      if (skipping && !predicate(v, k)) {
        skipping = false;
      }

      if (!skipping) {
        map.set(k, v);
      }
    }

    return this.newInstance(map, this.nextIndex);
  }

  /** Create a new collection consisting of every n-th element. */
  nth(step: number, offset = 0): Collection<V, number> {
    if (step < 1) {
      throw new RangeError("Step value must be at least 1.");
    }

    const values = this.slice(offset).all();

    return Collection.make(values.filter((_, i) => i % step === 0));
  }

  /** Split into chunks of the given `size`; returns a Collection of Collections (like Laravel), so the result keeps chaining. */
  chunk(size: number): Collection<Collection<V, number>, number> {
    if (size <= 0) {
      return Collection.empty();
    }

    const values = this.all();
    const chunks: Collection<V, number>[] = [];

    for (let i = 0; i < values.length; i += size) {
      chunks.push(Collection.make(values.slice(i, i + size)));
    }

    return Collection.make(chunks);
  }

  /** Chunk the collection using a callback that decides whether the next item starts a new chunk. */
  chunkWhile(
    callback: (item: V, key: K, chunk: Collection<V, number>) => boolean,
  ): Collection<Collection<V, number>, number> {
    const entries = this.entriesArray();
    const chunks: Collection<V, number>[] = [];
    let current: V[] = [];

    for (const [k, v] of entries) {
      if (current.length === 0 || callback(v, k, Collection.make(current))) {
        current.push(v);
      } else {
        chunks.push(Collection.make(current));
        current = [v];
      }
    }

    if (current.length > 0) {
      chunks.push(Collection.make(current));
    }

    return Collection.make(chunks);
  }

  /** Sliding-window chunks of `size`, advancing `step` items each time; returns a Collection of Collections. */
  sliding(size = 2, step = 1): Collection<Collection<V, number>, number> {
    if (size < 1) {
      throw new RangeError("Size value must be at least 1.");
    }

    if (step < 1) {
      throw new RangeError("Step value must be at least 1.");
    }

    const values = this.all();
    const windows: Collection<V, number>[] = [];
    const count = Math.floor((values.length - size) / step) + 1;

    for (let i = 0; i < count; i++) {
      windows.push(Collection.make(values.slice(i * step, i * step + size)));
    }

    return Collection.make(windows);
  }

  /** Split into `numberOfGroups` roughly-equal groups (remainder distributed to the first groups); returns a Collection of Collections. */
  split(numberOfGroups: number): Collection<Collection<V, number>, number> {
    if (numberOfGroups < 1) {
      throw new RangeError("Number of groups must be at least 1.");
    }

    if (this.isEmpty()) {
      return Collection.empty();
    }

    const values = this.all();
    const groupSize = Math.floor(values.length / numberOfGroups);
    const remainder = values.length % numberOfGroups;
    const groups: Collection<V, number>[] = [];
    let start = 0;

    for (let i = 0; i < numberOfGroups; i++) {
      const size = groupSize + (i < remainder ? 1 : 0);

      if (size > 0) {
        groups.push(Collection.make(values.slice(start, start + size)));
        start += size;
      }
    }

    return Collection.make(groups);
  }

  /** Split into `numberOfGroups` groups, filling earlier groups completely first; returns a Collection of Collections. */
  splitIn(numberOfGroups: number): Collection<Collection<V, number>, number> {
    if (numberOfGroups < 1) {
      throw new RangeError("Number of groups must be at least 1.");
    }

    return this.chunk(Math.ceil(this.count() / numberOfGroups));
  }

  /** Sort items ascending using the default `<`/`>` comparison, or a custom comparator. Preserves keys. */
  sort(compareFn?: (a: V, b: V) => number): Collection<V, K> {
    const entries = this.entriesArray();
    entries.sort((a, b) => (compareFn ? compareFn(a[1], b[1]) : defaultCompare(a[1], b[1])));

    return this.newInstance(new Map(entries), this.nextIndex);
  }

  sortDesc(): Collection<V, K> {
    return this.sort((a, b) => defaultCompare(b, a));
  }

  sortBy<R = unknown>(selector: ValueSelector<V, K, R>, descending = false): Collection<V, K> {
    const retrieve = valueRetriever(selector);
    const entries = this.entriesArray();
    entries.sort((a, b) => {
      const result = defaultCompare(retrieve(a[1], a[0]), retrieve(b[1], b[0]));

      return descending ? -result : result;
    });

    return this.newInstance(new Map(entries), this.nextIndex);
  }

  sortByDesc<R = unknown>(selector: ValueSelector<V, K, R>): Collection<V, K> {
    return this.sortBy(selector, true);
  }

  sortKeys(descending = false): Collection<V, K> {
    const entries = this.entriesArray();
    entries.sort((a, b) => {
      const result = defaultCompare(a[0], b[0]);

      return descending ? -result : result;
    });

    return this.newInstance(new Map(entries), this.nextIndex);
  }

  sortKeysDesc(): Collection<V, K> {
    return this.sortKeys(true);
  }

  sortKeysUsing(compareFn: (a: K, b: K) => number): Collection<V, K> {
    const entries = this.entriesArray();
    entries.sort((a, b) => compareFn(a[0], b[0]));

    return this.newInstance(new Map(entries), this.nextIndex);
  }

  reverse(): Collection<V, K> {
    return this.newInstance(new Map(this.entriesArray().reverse()), this.nextIndex);
  }

  shuffle(): Collection<V, K> {
    const entries = this.entriesArray();

    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [entries[i], entries[j]] = [entries[j] as [K, V], entries[i] as [K, V]];
    }

    return this.newInstance(new Map(entries), this.nextIndex);
  }

  /** One random item, or a Collection of `count` random items (without replacement). */
  random(): V | undefined;
  random(count: number): Collection<V, number>;
  random(count?: number): V | undefined | Collection<V, number> {
    const values = this.all();

    if (count === undefined) {
      if (values.length === 0) {
        return undefined;
      }

      return values[Math.floor(Math.random() * values.length)];
    }

    const shuffled = [...values];

    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j] as V, shuffled[i] as V];
    }

    return Collection.make(shuffled.slice(0, count));
  }

  unique<R = V>(selector?: ValueSelector<V, K, R>): Collection<V, K> {
    const retrieve = valueRetriever<V, K, R>(selector);
    const seen = new Set<R>();

    return this.reject((item, key) => {
      const id = retrieve(item, key);

      if (seen.has(id)) {
        return true;
      }

      seen.add(id);

      return false;
    });
  }

  /** Merge with the given items — later values win on key collision. Returns a new Collection. */
  merge(items: Collection<V, K> | Iterable<readonly [K, V]> | readonly V[]): Collection<V, K> {
    const map = new Map(this.items);

    for (const [k, v] of toEntries<V, K>(items, this.nextIndex)) {
      map.set(k, v);
    }

    return this.newInstance(map, nextIndexFor(map, this.nextIndex));
  }

  /** Recursively merge with the given items — array/object values at the same key are merged deeply. */
  mergeRecursive(
    items: Collection<V, K> | Iterable<readonly [K, V]> | readonly V[],
  ): Collection<V, K> {
    const map = new Map(this.items);

    for (const [k, v] of toEntries<V, K>(items, this.nextIndex)) {
      const existing = map.get(k);
      map.set(k, mergeRecursiveValue(existing, v) as V);
    }

    return this.newInstance(map, nextIndexFor(map, this.nextIndex));
  }

  /** Union with the given items — existing keys are NOT overwritten (opposite bias from `merge`). */
  union(items: Collection<V, K> | Iterable<readonly [K, V]> | readonly V[]): Collection<V, K> {
    const map = new Map(this.items);

    for (const [k, v] of toEntries<V, K>(items, this.nextIndex)) {
      if (!map.has(k)) {
        map.set(k, v);
      }
    }

    return this.newInstance(map, nextIndexFor(map, this.nextIndex));
  }

  /** Replace items at matching keys with the given items (like `merge`, but only for values already present would be identical — matches PHP's `array_replace`: adds new keys too). */
  replace(items: Collection<V, K> | Iterable<readonly [K, V]> | readonly V[]): Collection<V, K> {
    return this.merge(items);
  }

  replaceRecursive(
    items: Collection<V, K> | Iterable<readonly [K, V]> | readonly V[],
  ): Collection<V, K> {
    return this.mergeRecursive(items);
  }

  /** Push all items from `source` onto the end (as a new list), discarding original keys. */
  concat(source: Iterable<V>): Collection<V, number> {
    const values = this.all();

    for (const v of source) {
      values.push(v);
    }

    return Collection.make(values);
  }

  /** Repeat every item `n` times, flattened into a new list-shaped collection. */
  multiply(n: number): Collection<V, number> {
    if (n <= 0) {
      return Collection.empty<V>();
    }

    const items = this.all();
    const values: V[] = [];

    for (let i = 0; i < n; i++) {
      values.push(...items);
    }

    return Collection.make(values);
  }

  diff(items: Iterable<V>): Collection<V, K> {
    const set = new Set(items);

    return this.filter((v) => !set.has(v));
  }

  diffUsing(items: Iterable<V>, compareFn: (a: V, b: V) => number): Collection<V, K> {
    const others = [...items];

    return this.filter((v) => !others.some((o) => compareFn(v, o) === 0));
  }

  intersect(items: Iterable<V>): Collection<V, K> {
    const set = new Set(items);

    return this.filter((v) => set.has(v));
  }

  intersectUsing(items: Iterable<V>, compareFn: (a: V, b: V) => number): Collection<V, K> {
    const others = [...items];

    return this.filter((v) => others.some((o) => compareFn(v, o) === 0));
  }

  /** Cross join with the given lists, returning all possible combinations. */
  crossJoin(...lists: readonly (readonly unknown[])[]): Collection<unknown[], number> {
    let result: unknown[][] = this.all().map((v) => [v]);

    for (const list of lists) {
      const next: unknown[][] = [];

      for (const combo of result) {
        for (const item of list) {
          next.push([...combo, item]);
        }
      }

      result = next;
    }

    return Collection.make(result);
  }

  /** Create a Collection using this collection's values as keys and `values` as the values. */
  combine<V2>(values: Iterable<V2>): Collection<V2, V extends PropertyKey ? V : never> {
    const map = new Map<any, V2>();
    const valuesArr = [...values];
    let i = 0;

    for (const key of this.items.values()) {
      map.set(key as any, valuesArr[i] as V2);
      i += 1;
    }

    return this.newInstance(map) as unknown as Collection<V2, V extends PropertyKey ? V : never>;
  }

  /** Flip keys and values (values become keys). */
  flip(): Collection<K, V extends PropertyKey ? V : never> {
    const map = new Map<any, K>();

    for (const [k, v] of this.items) {
      map.set(v as any, k);
    }

    return this.newInstance(map) as unknown as Collection<K, V extends PropertyKey ? V : never>;
  }

  /** Zip together with one or more arrays: `[[a0,b0], [a1,b1], ...]`. */
  zip(...arrays: readonly (readonly unknown[])[]): Collection<unknown[], number> {
    const values = this.all();
    const out: unknown[][] = values.map((v, i) => [v, ...arrays.map((arr) => arr[i])]);

    return Collection.make(out);
  }

  /** Pad to `size` with `value` — positive `size` pads at the end, negative pads at the start. */
  pad(size: number, value: V): Collection<V, number> {
    const values = this.all();
    const diff = Math.abs(size) - values.length;

    if (diff <= 0) {
      return Collection.make(values);
    }

    const padding = Array.from({ length: diff }, () => value);

    return Collection.make(size < 0 ? [...padding, ...values] : [...values, ...padding]);
  }

  /** Recursively flatten a multi-dimensional collection/array to `depth` levels (default: fully flatten). */
  flatten(depth: number = Infinity): Collection<unknown, number> {
    const flattenValues = (values: unknown[], remaining: number): unknown[] => {
      const out: unknown[] = [];

      for (const v of values) {
        const inner = v instanceof Collection ? v.all() : v;

        if (Array.isArray(inner) && remaining > 0) {
          out.push(...flattenValues(inner, remaining - 1));
        } else {
          out.push(v);
        }
      }

      return out;
    };

    return Collection.make(flattenValues(this.all() as unknown[], depth));
  }

  /** Collapse a collection of arrays/Collections into a single flat (one-level) list. */
  collapse(): Collection<unknown, number> {
    const out: unknown[] = [];

    for (const v of this.items.values()) {
      if (v instanceof Collection) {
        out.push(...v.all());
      } else if (Array.isArray(v)) {
        out.push(...v);
      } else {
        out.push(v);
      }
    }

    return Collection.make(out);
  }

  /** Extract a single column's values into a Collection, optionally re-keyed by another column. */
  pluck<Kk extends keyof V>(value: Kk): Collection<V[Kk], number>;
  pluck<Kk extends keyof V, KeyK extends keyof V>(
    value: Kk,
    key: KeyK,
  ): Collection<V[Kk], V[KeyK] & PropertyKey>;
  pluck(value: keyof V, key?: keyof V): Collection<any, any> {
    if (key === undefined) {
      return Collection.make(this.all().map((item) => item[value]));
    }

    const map = new Map<any, any>();

    for (const item of this.items.values()) {
      map.set(item[key] as any, item[value]);
    }

    return this.newInstance(map);
  }

  /** Select only the given properties from each item. */
  select<Kk extends keyof V>(keys: Kk[]): Collection<Pick<V, Kk>, K> {
    const map = new Map<K, Pick<V, Kk>>();

    for (const [k, v] of this.items) {
      const picked = {} as Pick<V, Kk>;

      for (const key of keys) {
        picked[key] = v[key];
      }

      map.set(k, picked);
    }

    return this.newInstance(map, this.nextIndex);
  }

  /** Concatenate a column's (or the whole item's, for scalar items) values as a string. */
  implode(value: keyof V | ((item: V, key: K) => unknown), glue = ""): string {
    if (typeof value === "function") {
      return this.all()
        .map((v, i) => String(value(v, i as K)))
        .join(glue);
    }

    return this.all()
      .map((item) => String((item as any)?.[value] ?? item))
      .join(glue);
  }

  /** Join items into a string, using a different glue before the final item ("A, B and C"). */
  join(glue: string, finalGlue = ""): string {
    if (finalGlue === "") {
      return this.implode(String as unknown as (item: V) => unknown, glue);
    }

    const count = this.count();

    if (count === 0) {
      return "";
    }

    const values = this.all().map((v) => String(v));

    if (count === 1) {
      return values[0] as string;
    }

    const last = values.pop() as string;

    return values.join(glue) + finalGlue + last;
  }

  /** Pass the collection to a callback and return its result. */
  pipe<R>(callback: (collection: this) => R): R {
    return callback(this);
  }

  pipeInto<R>(ctor: new (collection: this) => R): R {
    return new ctor(this);
  }

  pipeThrough<R>(callbacks: readonly ((carry: unknown) => unknown)[]): R {
    return callbacks.reduce((carry, fn) => fn(carry), this as unknown) as R;
  }

  /** Pass the collection to a callback (for side effects) and return `this` unchanged. */
  tap(callback: (collection: this) => unknown): this {
    callback(this);

    return this;
  }

  // `R` (callback) and `D` (default) are independent type parameters. With
  // a single shared `R`, the two branches are forced to agree, so the
  // natural `when(cond, (c) => c.count(), () => "default")` — a number from
  // one arm, a string from the other — fails to compile. The return type is
  // the union of whichever arms can actually run.
  when<R = this, D = this>(
    value: unknown,
    callback: (collection: this, value: unknown) => R,
    defaultCb?: (collection: this, value: unknown) => D,
  ): this | R | D {
    if (value) {
      return callback(this, value);
    }

    if (defaultCb) {
      return defaultCb(this, value);
    }

    return this;
  }

  unless<R = this, D = this>(
    value: unknown,
    callback: (collection: this, value: unknown) => R,
    defaultCb?: (collection: this, value: unknown) => D,
  ): this | R | D {
    return this.when(!value, callback, defaultCb);
  }

  whenEmpty<R = this, D = this>(
    callback: (collection: this) => R,
    defaultCb?: (collection: this) => D,
  ): this | R | D {
    return this.when(this.isEmpty(), callback, defaultCb);
  }

  whenNotEmpty<R = this, D = this>(
    callback: (collection: this) => R,
    defaultCb?: (collection: this) => D,
  ): this | R | D {
    return this.when(this.isNotEmpty(), callback, defaultCb);
  }

  unlessEmpty<R = this, D = this>(
    callback: (collection: this) => R,
    defaultCb?: (collection: this) => D,
  ): this | R | D {
    return this.whenNotEmpty(callback, defaultCb);
  }

  unlessNotEmpty<R = this, D = this>(
    callback: (collection: this) => R,
    defaultCb?: (collection: this) => D,
  ): this | R | D {
    return this.whenEmpty(callback, defaultCb);
  }
}

/**
 * Coerce a value to a number for comparison if it is meaningfully numeric:
 * a `number`/`bigint`, or an object exposing a finite numeric `valueOf()`
 * (`Date`, `@mahi/datetime`'s `DateTime`, `BigInt` boxes, …). Returns
 * `undefined` for values that should be compared some other way (strings,
 * plain objects, `null`). This keeps `Collection` free of a hard dependency
 * on `@mahi/datetime` while still ordering dates chronologically.
 */
function numericComparisonValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isNaN(value) ? undefined : value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    const primitive = (value as { valueOf?: () => unknown }).valueOf?.();

    if (typeof primitive === "number" && !Number.isNaN(primitive)) {
      return primitive;
    }

    if (typeof primitive === "bigint") {
      return Number(primitive);
    }
  }

  return undefined;
}

/**
 * Total ordering used by `sort()`/`sortBy()` when no comparator is given.
 * Numbers, `bigint`s, `Date`s and `DateTime`s compare by their numeric
 * value (so dates sort chronologically, not lexically by `String(...)`);
 * strings compare with `localeCompare`; everything else falls back to a
 * stable string comparison. Mixed types are ordered by a coarse type rank
 * so a sort of heterogeneous values is at least deterministic.
 */
function defaultCompare(a: unknown, b: unknown): number {
  if (a === b) {
    return 0;
  }

  const an = numericComparisonValue(a);
  const bn = numericComparisonValue(b);

  if (an !== undefined && bn !== undefined) {
    return an < bn ? -1 : an > bn ? 1 : 0;
  }

  // One side numeric, the other not — order all numerics before non-numerics.
  if (an !== undefined) {
    return -1;
  }

  if (bn !== undefined) {
    return 1;
  }

  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b);
  }

  const as = String(a);
  const bs = String(b);

  return as < bs ? -1 : as > bs ? 1 : 0;
}

function toEntries<V, K extends PropertyKey>(
  items: Collection<V, K> | Iterable<readonly [K, V]> | readonly V[],
  startIndex: number,
): [K, V][] {
  if (items instanceof Collection) {
    const entries = Collection.entriesOf(items);

    // A list-shaped collection merged into another behaves like an array:
    // its numeric keys are renumbered from `startIndex` so values append
    // rather than overwrite by position (PHP `array_merge` semantics).
    // Non-list collections (string/sparse keys) keep their keys and
    // overwrite on collision, matching `merge` for associative arrays.
    if (Collection.isListLike(items)) {
      return entries.map(([, v], i) => [(startIndex + i) as unknown as K, v]);
    }

    return entries;
  }

  if (Array.isArray(items)) {
    return items.map((v, i) => [(startIndex + i) as unknown as K, v as V]);
  }

  return [...(items as Iterable<[K, V]>)];
}

/** The next auto-index for a map: one past its largest sequential integer key, never below `fallback`. */
function nextIndexFor(map: Map<PropertyKey, unknown>, fallback: number): number {
  let next = fallback;

  for (const key of map.keys()) {
    if (typeof key === "number" && Number.isInteger(key) && key >= next) {
      next = key + 1;
    }
  }

  return next;
}

function mergeRecursiveValue(existing: unknown, incoming: unknown): unknown {
  if (
    existing !== undefined &&
    existing !== null &&
    incoming !== null &&
    typeof existing === "object" &&
    typeof incoming === "object" &&
    !Array.isArray(existing) &&
    !Array.isArray(incoming)
  ) {
    return { ...(existing as object), ...(incoming as object) };
  }

  return incoming;
}
