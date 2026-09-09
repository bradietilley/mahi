import type { AnyModelClass } from "./model.js";

/**
 * A morph-map entry: the model class a discriminant value names, behind a
 * thunk. Thunks rather than bare class references for the same reason
 * `RelationDefinition.related` is one — a provider's `register()` runs at
 * import time, and a direct class reference in the map literal would be
 * evaluated then, hitting a TDZ `ReferenceError` whichever module the
 * bundler entered a cycle through.
 */
export type MorphMapEntry = () => AnyModelClass;

/** A discriminant value → model-class-thunk map, as passed to `Relation.morphMap()`. */
export type MorphMap = Record<string, MorphMapEntry>;

/**
 * Thrown when a model has no morph-map entry and `Relation.requireMorphMap()`
 * is on — the analogue of Laravel's `ClassMorphViolationException`.
 */
export class ClassMorphViolationError extends Error {
  constructor(public readonly modelName: string) {
    super(
      `No morph alias is registered for [${modelName}], and the morph map is required. ` +
        `Add it to Relation.morphMap({ ... }) in a provider's register().`,
    );
    this.name = "ClassMorphViolationError";
  }
}

// Module-level, not container-bound: a morph alias is class *metadata*,
// not a service. Same storage decision as `bootedModels` (`model.ts`) and
// `observerRegistry` (`model-events.ts`), and the same tradeoff Laravel
// makes with its static `$morphMap` — two Applications in one test
// process share it. `resetMorphMap()` exists for teardown.
const aliasToThunk = new Map<string, MorphMapEntry>();

/**
 * The reverse index, kept in sync on every write so `getMorphAlias()` is
 * O(1) rather than Laravel's `array_search` over the whole map.
 *
 * Populated lazily: a thunk can't be invoked at registration time (that
 * would defeat the point of deferring it), so a class only enters this
 * map once something has actually resolved it. `getMorphAlias()` forces
 * the remaining thunks on a miss before concluding a class is absent.
 */
const classToAlias = new Map<AnyModelClass, string>();

/** Aliases whose thunk has been invoked and recorded in `classToAlias`. */
const resolvedAliases = new Set<string>();

let morphMapRequired = false;

/** Invokes `alias`'s thunk and records the class → alias direction. */
function resolveEntry(alias: string): AnyModelClass | undefined {
  const thunk = aliasToThunk.get(alias);

  if (!thunk) {
    return undefined;
  }

  const modelClass = thunk();

  if (!resolvedAliases.has(alias)) {
    classToAlias.set(modelClass, alias);
    resolvedAliases.add(alias);
  }

  return modelClass;
}

/**
 * The polymorphic-relation configuration surface — Laravel's
 * `Illuminate\Database\Eloquent\Relations\Relation`, narrowed to the
 * morph map (the rest of that class is a base-class hierarchy this
 * framework deliberately doesn't have; relations here are plain data
 * descriptors, see `relations.ts`).
 *
 * ## What the map is for
 *
 * A polymorphic column stores a short string naming the model it points
 * at. Without a map that string is derived from the model itself
 * (`morphName`, else `table`), which couples the *database's* contents to
 * the *code's* naming — rename a table and every stored discriminant is
 * orphaned. Registering a map pins the stored values:
 *
 *   // In a provider's register():
 *   Relation.morphMap({
 *     post: () => Post,
 *     user: () => User,
 *   });
 *
 * Do this in `register()`, not `boot()` — the map is class metadata with
 * no container dependencies, and relations may resolve during another
 * provider's boot.
 *
 * ## The alias chain
 *
 * `Model.morphAlias()` resolves in three steps, first match winning:
 *
 *   1. a morph-map entry for the class
 *   2. `static morphName`
 *   3. `static table`
 *
 * Laravel's fallback is `static::class`, which is always unique. There is
 * no equivalent here (a JS class name doesn't survive minification), so
 * the fallback is a chain instead. `morphName` is unique by construction
 * — `ModelRegistry` throws on collision — but is opt-in and `undefined`
 * by default; `table` always exists but two models *can* share one.
 *
 * `enforceMorphMap()` disables rungs 2 and 3, which makes it more
 * meaningful here than in Laravel, where it only disables one.
 *
 * ## The map is runtime, `types` is compile-time
 *
 * This map resolves a discriminant to a class **at runtime**. It cannot
 * type anything: `morphMap()` accepts an arbitrary `Record<string, …>`,
 * so a `morphTo` relying on it types its value as `Model`. To get a
 * precise union (`Post | Video | undefined`), declare a local `types` map
 * on the relation. The two are complementary, not interchangeable — see
 * the relationships guide.
 */
export class Relation {
  /**
   * Registers morph-map entries, or reads the current map when called
   * with no arguments. Merges into the existing map by default; pass
   * `merge = false` to replace it wholesale.
   *
   *   Relation.morphMap({ post: () => Post });
   *   Relation.morphMap();                      // read it back
   *
   * Registering the same alias twice is allowed (last write wins) — a
   * model listed by two providers shouldn't error. Registering two
   * aliases for the same *class* is also allowed, but only the last is
   * returned by `getMorphAlias()`, so it's a misconfiguration in
   * practice; `Model.morphAlias()` is what writes new rows.
   */
  static morphMap(map?: MorphMap, merge = true): Readonly<MorphMap> {
    if (map === undefined) {
      return Object.freeze({ ...Object.fromEntries(aliasToThunk) });
    }

    if (!merge) {
      aliasToThunk.clear();
      classToAlias.clear();
      resolvedAliases.clear();
    }

    for (const [alias, thunk] of Object.entries(map)) {
      // A re-registration under the same alias may point at a different
      // class, so drop the memoized resolution rather than trusting it.
      resolvedAliases.delete(alias);
      aliasToThunk.set(alias, thunk);
    }

    return Object.freeze({ ...Object.fromEntries(aliasToThunk) });
  }

  /**
   * `morphMap(map, merge)` plus `requireMorphMap()` — registers the map
   * and makes it mandatory in one call, matching Laravel's
   * `enforceMorphMap()`. The recommended form for a new application:
   * every polymorphic model is named explicitly, and adding one without
   * registering it fails loudly rather than silently writing a `table`
   * name into the database.
   */
  static enforceMorphMap(map: MorphMap, merge = true): void {
    Relation.morphMap(map, merge);
    Relation.requireMorphMap(true);
  }

  /**
   * Requires every polymorphic model to have a morph-map entry. With this
   * on, `Model.morphAlias()` throws `ClassMorphViolationError` rather
   * than falling back to `morphName`/`table`.
   */
  static requireMorphMap(require = true): void {
    morphMapRequired = require;
  }

  /** Whether the morph map is currently mandatory — see `requireMorphMap()`. */
  static requiresMorphMap(): boolean {
    return morphMapRequired;
  }

  /**
   * The model class a discriminant value names, or `undefined` if the
   * alias isn't registered. Invokes the entry's thunk (and memoizes the
   * class → alias direction for `getMorphAlias()`).
   *
   * Returns `undefined` rather than throwing on an unknown alias: a
   * discriminant read from a database row is *data*, and stale data
   * should resolve to "no parent" the way a dangling foreign key does,
   * not crash the query.
   */
  static getMorphedModel(alias: string): AnyModelClass | undefined {
    return resolveEntry(alias);
  }

  /**
   * The alias registered for `modelClass`, or `undefined` if it isn't in
   * the map. Prefer `Model.morphAlias()`, which applies the full chain;
   * this is the map-only rung.
   *
   * O(1) on the common path via the reverse index. On a miss it forces
   * any not-yet-resolved thunks before concluding the class is absent —
   * a class registered but never resolved would otherwise read as
   * unregistered.
   */
  static getMorphAlias(modelClass: AnyModelClass): string | undefined {
    const known = classToAlias.get(modelClass);

    if (known !== undefined) {
      return known;
    }

    if (resolvedAliases.size < aliasToThunk.size) {
      for (const alias of aliasToThunk.keys()) {
        if (resolvedAliases.has(alias)) {
          continue;
        }

        if (resolveEntry(alias) === modelClass) {
          return alias;
        }
      }
    }

    return classToAlias.get(modelClass);
  }

  /**
   * Clears the map and the `requireMorphMap()` flag. Exists because the
   * map is module-level and therefore shared by every `Application` in a
   * process — call it in test teardown to keep files isolated:
   *
   *   afterEach(() => Relation.resetMorphMap());
   */
  static resetMorphMap(): void {
    aliasToThunk.clear();
    classToAlias.clear();
    resolvedAliases.clear();
    morphMapRequired = false;
  }
}
