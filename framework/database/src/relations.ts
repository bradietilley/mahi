/**
 * Relationship option shapes for `Model`'s `belongsTo`/`hasMany`/
 * `hasOne`/`belongsToMany` helpers — see `model.ts`'s "Relationships"
 * docstring section for the full rationale and usage.
 *
 * Every key is an explicit column name. There is **no convention-based
 * key guessing** (Eloquent's "`post_id` because the parent class is
 * `Post`") — deliberately, matching this codebase's stance against
 * name-derived magic elsewhere (`gates()` requires an explicit
 * `gate.policy(Todo, TodoPolicy)` rather than guessing `TodoPolicy` from
 * `Todo`; the container has no auto-wiring). The only defaults are the
 * two that can't be wrong: `localKey`/`ownerKey`/`relatedKey` fall back
 * to the relevant model's own `primaryKeyColumn`.
 */

import type { Collection } from "@mahi/core";
import type { AttributesOf, RelationKeys, RelationKind, RelationMarker } from "./markers.js";

/**
 * A many-to-one / "child points at parent" relationship: the foreign key
 * lives on **this** model's table.
 *
 *   Todo.user(todo) -> { foreignKey: "user_id" }   // todos.user_id -> users.id
 */
export interface BelongsToOptions<
  TRow extends Record<string, any>,
  TRelatedRow extends Record<string, any>,
> {
  /** Column on THIS table holding the related row's key, e.g. `"user_id"`. */
  foreignKey: keyof TRow & string;
  /** Column on the RELATED table the foreign key points at. Defaults to the related model's `primaryKeyColumn`. */
  ownerKey?: keyof TRelatedRow & string;
}

/**
 * A one-to-many / "parent owns children" relationship: the foreign key
 * lives on the **related** model's table.
 *
 *   User.todos(user) -> { foreignKey: "user_id" }  // todos.user_id -> users.id
 */
export interface HasManyOptions<
  TRow extends Record<string, any>,
  TRelatedRow extends Record<string, any>,
> {
  /** Column on the RELATED table pointing back at this row, e.g. `"user_id"`. */
  foreignKey: keyof TRelatedRow & string;
  /** Column on THIS table the related foreign key points at. Defaults to this model's `primaryKeyColumn`. */
  localKey?: keyof TRow & string;
}

/** `hasOne` is `hasMany` with a `.first()` at the end — same key shape. */
export type HasOneOptions<
  TRow extends Record<string, any>,
  TRelatedRow extends Record<string, any>,
> = HasManyOptions<TRow, TRelatedRow>;

/**
 * A many-to-many relationship joined through a pivot table.
 *
 *   Todo.tags(todo) -> {
 *     pivotTable: "todo_tag",
 *     foreignPivotKey: "todo_id",   // pivot column pointing at THIS model
 *     relatedPivotKey: "tag_id",    // pivot column pointing at the RELATED model
 *   }
 *
 * Without `withPivot`/`withTimestamps` the pivot is pure plumbing: the
 * relation compiles to a subquery, the returned rows are exactly the
 * related model's own, and no pivot column is readable. Request columns
 * to change that — they arrive under a `pivot` accessor on each related
 * instance (see `withPivot`).
 */
export interface BelongsToManyOptions<
  TRow extends Record<string, any>,
  TRelatedRow extends Record<string, any>,
> {
  /** The join/pivot table name, e.g. `"todo_tag"`. */
  pivotTable: string;
  /** Column on the pivot table pointing at THIS model. */
  foreignPivotKey: string;
  /** Column on the pivot table pointing at the RELATED model. */
  relatedPivotKey: string;
  /** Column on THIS table `foreignPivotKey` points at. Defaults to this model's `primaryKeyColumn`. */
  localKey?: keyof TRow & string;
  /** Column on the RELATED table `relatedPivotKey` points at. Defaults to the related model's `primaryKeyColumn`. */
  relatedKey?: keyof TRelatedRow & string;
  /**
   * Pivot columns to read alongside the related rows, exposed as
   * `tag.pivot.weight` on each returned instance — Laravel's
   * `withPivot()`.
   *
   *   options: { pivotTable: "todo_tag", ..., withPivot: ["weight"] }
   *   (await todo.relations.tags().get()).first()!.pivot.weight
   *
   * Requesting columns switches the compiled query from the subquery
   * form to an inner join, since the values have to come back with the
   * row. Omit it and nothing changes: no join, no extra columns, no
   * behavioural difference for existing callers.
   */
  withPivot?: string[];
  /** Adds `created_at`/`updated_at` to `withPivot` — Laravel's `withTimestamps()`. */
  withTimestamps?: boolean;
}

/**
 * A "has-many-through" relationship — reaches a distant related model via
 * an intermediate model, e.g. `Country hasManyThrough Post through User`
 * (a country's posts, via its users). Two foreign-key hops, expressed as
 * a subquery rather than a JOIN so the returned rows stay exactly the
 * related model's row type (no intermediate columns bleeding in).
 *
 *   Country.posts(row) -> {
 *     through: () => User,
 *     firstKey: "country_id",   // users.country_id -> countries.id
 *     secondKey: "user_id",     // posts.user_id    -> users.id
 *   }
 *
 * All keys explicit (no guessing); `localKey`/`secondLocalKey` default to
 * this model's / the through model's `primaryKeyColumn`.
 */
export interface HasManyThroughOptions<
  TRow extends Record<string, any>,
  TThroughRow extends Record<string, any>,
  TRelatedRow extends Record<string, any>,
> {
  /** Thunk returning the intermediate model, e.g. `() => User`. */
  through: () => ModelLike;
  /** FK on the THROUGH table pointing back at this model (e.g. `users.country_id`). */
  firstKey: keyof TThroughRow & string;
  /** FK on the RELATED table pointing back at the through model (e.g. `posts.user_id`). */
  secondKey: keyof TRelatedRow & string;
  /** Column on THIS table `firstKey` points at. Defaults to this model's `primaryKeyColumn`. */
  localKey?: keyof TRow & string;
  /** Column on the THROUGH table `secondKey` points at. Defaults to the through model's `primaryKeyColumn`. */
  secondLocalKey?: keyof TThroughRow & string;
}

/** `hasOneThrough` is `hasManyThrough` with a `.first()` at the end — same option shape. */
export type HasOneThroughOptions<
  TRow extends Record<string, any>,
  TThroughRow extends Record<string, any>,
  TRelatedRow extends Record<string, any>,
> = HasManyThroughOptions<TRow, TThroughRow, TRelatedRow>;

/**
 * A polymorphic "child points at one of several parents" relationship —
 * the inverse side (`morphTo`). This model's table carries an explicit
 * `{morphType}`/`{morphId}` column pair (named explicitly here, NOT
 * guessed `{name}_type`/`{name}_id` the way Eloquent does — matching this
 * framework's no-key-guessing stance for every other relation).
 *
 * `types` maps each discriminant value stored in `morphType` to a thunk
 * returning the model it selects — so `morphTo()`'s resolved type is a
 * proper TS union of the mapped models rather than `any` (something TS
 * expresses far better than PHP's duck-typed `morphTo`, whose return is
 * always `Model`).
 *
 *   Comment.commentable(row) -> {
 *     morphType: "commentable_type",   // e.g. "post" | "video"
 *     morphId: "commentable_id",
 *     types: { post: () => Post, video: () => Video },
 *   }
 *
 * `types` is **optional**: omitted, the discriminant is resolved through
 * the global morph map (`Relation.getMorphedModel()`) at runtime. But the
 * two are not interchangeable — the global map is a *runtime* mechanism
 * registered from arbitrary strings, so omitting `types` degrades the
 * static type to `Model`. Declare `types` when you want the union;
 * rely on the map when you want central configuration. Declaring both is
 * fine and common: `types` is consulted first, the map is the fallback.
 */
export interface MorphToOptions<
  TRow extends Record<string, any>,
  TTypes extends Record<string, () => ModelLike> = Record<string, () => ModelLike>,
> {
  /** Column on THIS table holding the related model's discriminant value (a key of `types`, or a morph-map alias). */
  morphType: keyof TRow & string;
  /** Column on THIS table holding the related row's key. */
  morphId: keyof TRow & string;
  /**
   * Discriminant value -> related-model thunk; the `morphType` column's
   * value selects which one. Optional — falls back to the global morph
   * map — but declaring it is what produces a precise instance union
   * instead of a bare `Model`. Consulted before the map.
   */
  types?: TTypes;
  /** Column on the RELATED table `morphId` points at. Defaults to the resolved model's `primaryKeyColumn`. */
  ownerKey?: string;
}

/**
 * A polymorphic "parent owns children" relationship — the owning side
 * (`morphMany`/`morphOne`). The foreign key + type discriminant live on
 * the **related** model's table; this model matches related rows whose
 * `{morphType}` column equals a fixed `type` value and whose `{morphId}`
 * column points back at this row.
 *
 *   Post.comments(row) -> {
 *     morphType: "commentable_type",
 *     morphId: "commentable_id",
 *     type: "post",                  // this model's discriminant value
 *   }
 *
 * `type` is **optional**, defaulting to the declaring model's
 * `morphAlias()` — so the discriminant is owned by the model it names
 * rather than restated at every declaration that points at it. Supply it
 * explicitly to store something else; explicit always wins.
 */
export interface MorphManyOptions<
  TRow extends Record<string, any>,
  TRelatedRow extends Record<string, any>,
> {
  /** Column on the RELATED table holding the discriminant value. */
  morphType: keyof TRelatedRow & string;
  /** Column on the RELATED table pointing back at this row's key. */
  morphId: keyof TRelatedRow & string;
  /**
   * This model's discriminant value — related rows must have
   * `{morphType} = type`. Defaults to the declaring model's
   * `morphAlias()` (morph map -> `morphName` -> `table`).
   */
  type?: string;
  /** Column on THIS table `morphId` points at. Defaults to this model's `primaryKeyColumn`. */
  localKey?: keyof TRow & string;
}

/** `morphOne` is `morphMany` with a `.first()` at the end — same option shape. */
export type MorphOneOptions<
  TRow extends Record<string, any>,
  TRelatedRow extends Record<string, any>,
> = MorphManyOptions<TRow, TRelatedRow>;

/**
 * A polymorphic many-to-many — the **morphed** side. This model is one of
 * several types sharing one pivot table, and the pivot carries a
 * discriminant naming which:
 *
 *   // A post's tags. `taggables` also holds videos' tags.
 *   Post.tags -> {
 *     pivotTable: "taggables",
 *     morphType: "taggable_type",     // pivot column: "post" | "video"
 *     morphId: "taggable_id",         // pivot column -> posts.id
 *     relatedPivotKey: "tag_id",      // pivot column -> tags.id
 *   }
 *
 *   -- select * from tags where id in (
 *   --   select tag_id from taggables
 *   --   where taggable_id = ? and taggable_type = 'post')
 *
 * `type` names **this** (the declaring) model, since this is the side the
 * pivot discriminates. That is the opposite of `MorphedByManyOptions`,
 * where it names the related model — the single easiest thing to get
 * wrong here. Laravel hides the difference behind an internal `$inverse`
 * flag; it's surfaced in the defaulting rules instead.
 */
export interface MorphToManyOptions<
  TRow extends Record<string, any>,
  TRelatedRow extends Record<string, any>,
> {
  /** The pivot table shared by every morphed type, e.g. `"taggables"`. */
  pivotTable: string;
  /** Discriminant column ON THE PIVOT, naming which model `morphId` points at. */
  morphType: string;
  /** Pivot column pointing at the MORPHED (declaring) model's key. */
  morphId: string;
  /** Pivot column pointing at the RELATED model's key. */
  relatedPivotKey: string;
  /** Discriminant value for THIS model. Defaults to the declaring model's `morphAlias()`. */
  type?: string;
  /** Column on THIS table `morphId` points at. Defaults to this model's `primaryKeyColumn`. */
  localKey?: keyof TRow & string;
  /** Column on the RELATED table `relatedPivotKey` points at. Defaults to the related model's `primaryKeyColumn`. */
  relatedKey?: keyof TRelatedRow & string;
  /** Pivot columns to read back, exposed as `related.pivot.x` — see `BelongsToManyOptions.withPivot`. */
  withPivot?: string[];
  /** Adds `created_at`/`updated_at` to `withPivot`. */
  withTimestamps?: boolean;
}

/**
 * A polymorphic many-to-many — the **inverse** side. The mirror of
 * `morphToMany`: this model is the one the pivot points at *without* a
 * discriminant, and the related models are the morphed types.
 *
 *   // A tag's posts. The same `taggables` pivot, read the other way.
 *   Tag.posts -> {
 *     pivotTable: "taggables",
 *     morphType: "taggable_type",     // pivot column: "post" | "video"
 *     morphId: "taggable_id",         // pivot column -> posts.id  (the RELATED model)
 *     foreignPivotKey: "tag_id",      // pivot column -> tags.id   (THIS model)
 *   }
 *
 *   -- select * from posts where id in (
 *   --   select taggable_id from taggables
 *   --   where tag_id = ? and taggable_type = 'post')
 *
 * **`type` names the RELATED model here**, not this one — the pivot
 * discriminates the other side. It therefore defaults to the *related*
 * model's `morphAlias()`. Compare `MorphToManyOptions`, where the same
 * key names the declaring model.
 */
export interface MorphedByManyOptions<
  TRow extends Record<string, any>,
  TRelatedRow extends Record<string, any>,
> {
  /** The pivot table shared by every morphed type, e.g. `"taggables"`. */
  pivotTable: string;
  /** Discriminant column ON THE PIVOT, naming which model `morphId` points at. */
  morphType: string;
  /** Pivot column pointing at the RELATED (morphed) model's key. */
  morphId: string;
  /** Pivot column pointing at THIS model's key. */
  foreignPivotKey: string;
  /** Discriminant value for the RELATED model. Defaults to the RELATED model's `morphAlias()`. */
  type?: string;
  /** Column on THIS table `foreignPivotKey` points at. Defaults to this model's `primaryKeyColumn`. */
  localKey?: keyof TRow & string;
  /** Column on the RELATED table `morphId` points at. Defaults to the related model's `primaryKeyColumn`. */
  relatedKey?: keyof TRelatedRow & string;
  /** Pivot columns to read back, exposed as `related.pivot.x` — see `BelongsToManyOptions.withPivot`. */
  withPivot?: string[];
  /** Adds `created_at`/`updated_at` to `withPivot`. */
  withTimestamps?: boolean;
}

/**
 * The minimal shape `RelationDefinition.related()` needs to return for
 * `RelatedRowOf<Def>` to recover a related model's row type without
 * `relations.ts` importing `Model` (which would create a circular
 * import — `model.ts` imports from `relations.ts` for the option types
 * above). Every real `Model` subclass satisfies this structurally via
 * its own `declare static Row: SomeTable;` marker.
 */
export type ModelLike = (abstract new (...args: any[]) => any) & {
  Row?: Record<string, any>;
};

/**
 * A named, **batchable** relation declaration — what `static relations`
 * on a `Model` maps a name to, and what `EloquentBuilder.with(name)`
 * looks up to eager-load it. Distinct from the per-row `belongsTo`/
 * `hasMany`/`hasOne`/`belongsToMany` static methods (`Todo.user(row)`,
 * see `model.ts`'s "Relationships" docstring): those build a builder
 * scoped to ONE row and are meant to be called explicitly; this shape
 * captures the same key configuration but in a form `with()` can run
 * against an entire page of rows in one batched query (or two, for
 * `belongsToMany`, since a pivot table is involved).
 *
 * `related` is a thunk (`() => SomeModel`), not the model class
 * directly, so two models can declare relations pointing at each other
 * without a circular-import ordering problem at module-evaluation time
 * (the thunk is only invoked when `with()` actually runs).
 *
 *   class Post extends Model {
 *     static override relations = {
 *       author: { type: "belongsTo", related: () => User, options: { foreignKey: "user_id" } },
 *       images: { type: "hasMany", related: () => PostImage, options: { foreignKey: "post_id" } },
 *       hashtags: {
 *         type: "belongsToMany",
 *         related: () => Hashtag,
 *         options: { pivotTable: "post_hashtag", foreignPivotKey: "post_id", relatedPivotKey: "hashtag_id" },
 *       },
 *     } satisfies RelationDefinitions;
 *   }
 *
 *   const posts = await Post.query().with("author", "images", "hashtags").get();
 *   posts.first()!.author   // UserTable | undefined — fully typed, inferred from `() => User`
 *   posts.first()!.images   // PostImageTable[]
 *   posts.first()!.hashtags // HashtagTable[]
 *
 * Dot paths nest to any depth (`with("author.team")`), and the object
 * form constrains what loads (`with({ images: (q) => q.where(...) })`) —
 * see `RelationPath` and `EloquentBuilder.with()`. The batching cost is
 * one query per relation **node**, independent of row count.
 */
/** The related model's row type when it declares one, else a permissive bag. */
export type RowOfLike<M> = M extends { Row: infer R } ? R : Record<string, any>;

export type RelationDefinition<
  TRow extends Record<string, any> = any,
  TRelatedModel extends ModelLike = ModelLike,
> =
  | {
      type: "belongsTo";
      related: () => TRelatedModel;
      options: BelongsToOptions<TRow, RowOfLike<TRelatedModel>>;
    }
  | {
      type: "hasMany";
      related: () => TRelatedModel;
      options: HasManyOptions<TRow, RowOfLike<TRelatedModel>>;
    }
  | {
      type: "hasOne";
      related: () => TRelatedModel;
      options: HasOneOptions<TRow, RowOfLike<TRelatedModel>>;
    }
  | {
      type: "belongsToMany";
      related: () => TRelatedModel;
      options: BelongsToManyOptions<TRow, RowOfLike<TRelatedModel>>;
    }
  | {
      type: "morphMany";
      related: () => TRelatedModel;
      options: MorphManyOptions<TRow, RowOfLike<TRelatedModel>>;
    }
  | {
      type: "morphOne";
      related: () => TRelatedModel;
      options: MorphOneOptions<TRow, RowOfLike<TRelatedModel>>;
    }
  | {
      type: "morphToMany";
      related: () => TRelatedModel;
      options: MorphToManyOptions<TRow, RowOfLike<TRelatedModel>>;
    }
  | {
      type: "morphedByMany";
      related: () => TRelatedModel;
      options: MorphedByManyOptions<TRow, RowOfLike<TRelatedModel>>;
    }
  // The one member with NO `related` thunk — a morphTo points at several
  // models, chosen at runtime by the discriminant, so there is no single
  // class to name here. Its targets live in `options.types` (optional;
  // see `MorphToOptions`) or the global morph map. Any code reaching for
  // `definition.related()` must therefore do so INSIDE a switch that has
  // already excluded this member.
  | { type: "morphTo"; options: MorphToOptions<TRow, Record<string, () => ModelLike>> }
  | {
      type: "hasManyThrough";
      related: () => TRelatedModel;
      options: HasManyThroughOptions<TRow, Record<string, any>, RowOfLike<TRelatedModel>>;
    }
  | {
      type: "hasOneThrough";
      related: () => TRelatedModel;
      options: HasOneThroughOptions<TRow, Record<string, any>, RowOfLike<TRelatedModel>>;
    };

/** A model's full set of named, `with()`-batchable relations — see `RelationDefinition`'s docstring. */
export type RelationDefinitions = Record<string, RelationDefinition>;

/**
 * Extracts the related model's row type from a single `RelationDefinition`.
 *
 * Derived from the constructor's INSTANCE type (as `RelatedInstanceOf`
 * below does), not from a `Row` static. The model redesign replaced
 * `declare static Row: PostTable` with the `Model<A>()` factory, so the
 * static no longer exists — reading `M["Row"]` off it yielded
 * `Record<string, any> | undefined`, which collapsed the constraint on
 * `whereHas()`'s constraint callback to `never` and made
 * `whereHas("tags", (q) => q.where("name", …))` uncallable.
 */
export type RelatedRowOf<Def> = Def extends { related: () => infer M }
  ? M extends abstract new (...args: any) => infer I
    ? I
    : never
  : never;

/**
 * Extracts the related model's INSTANCE type from a single
 * `RelationDefinition` — what a loaded relation value actually holds, a
 * live model instance rather than a bare row. A type-only local so
 * `relations.ts` needn't import `model.ts` (whose `RelatedInstanceOf`
 * this mirrors).
 *
 * Reads the phantom `__brand` first and the `related` thunk only as a
 * fallback, because the two carry the related type with different
 * fidelity. A helper definition (`belongsTo(() => User, …)`) declares its
 * thunk as `() => ModelLike` — an `abstract new (...args: any[]) => any`
 * — so inferring the instance off it yields `any`, not `User`. The brand
 * is where the helper's `R` survives. A hand-written definition has no
 * brand but does name its class concretely, so the thunk is exact there.
 * Preferring the brand makes both spellings resolve to the same instance
 * type instead of one of them silently degrading to `any`.
 */
export type RelatedInstanceOf<Def> = [RelatedInstanceOfBrand<Def>] extends [never]
  ? RelatedInstanceOfThunk<Def>
  : RelatedInstanceOfBrand<Def>;

/** The related instance type named by a definition's `related: () => SomeModel` thunk. */
type RelatedInstanceOfThunk<Def> = Def extends { related: () => infer M }
  ? M extends abstract new (...args: any) => infer I
    ? I
    : never
  : never;

/**
 * The related model's instance type for a `morphTo` definition, recovered
 * from its `types` thunk-record as a union — so a relation declaring
 * `types: { post: () => Post, video: () => Video }` reads back as
 * `Post | Video`, a discriminated union Laravel's `morphTo` (always
 * `Model`) cannot express.
 *
 * Degrades to `Model` when `types` is absent, which is the honest answer:
 * without it the discriminant resolves through the **global morph map**,
 * a runtime registry keyed by arbitrary strings with nothing for the
 * compiler to read. The global map is for resolution; the local `types`
 * map is for typing. See `MorphToOptions`.
 *
 * `Model` is referenced structurally (via `ModelLike`'s owner) rather
 * than imported, keeping `relations.ts` free of a `model.ts` import — see
 * `ModelLike`'s docstring for why that matters.
 */
export type MorphTargetOf<Def, TFallback = unknown> = Def extends { options: { types: infer T } }
  ? T extends Record<string, () => infer M>
    ? M extends abstract new (...args: any) => infer I
      ? I
      : never
    : never
  : TFallback;

/**
 * What a loaded relation value holds, for a single `RelationDefinition` —
 * the single source of truth for the to-one/to-many split.
 *
 * `EagerLoadResult` here and `LoadedRelations` in `model.ts` both
 * delegate to this rather than restating the conditional, so they cannot
 * disagree about the shape.
 *
 *   morphTo                                  -> target | undefined
 *   belongsTo/hasOne/morphOne/hasOneThrough  -> instance | undefined
 *   everything else                          -> Collection<instance>
 */
export type RelationValueOf<Def, TMorphFallback = unknown> = Def extends { type: "morphTo" }
  ? MorphTargetOf<Def, TMorphFallback> | undefined
  : Def extends { type: "belongsTo" | "hasOne" | "morphOne" | "hasOneThrough" }
    ? RelatedInstanceOf<Def> | undefined
    : Collection<RelatedInstanceOf<Def>>;

/**
 * The names in a relation map whose relation is a `morphTo` — what the
 * morph-aware query methods (`whereMorphedTo()`, `whereHasMorph()`, ...)
 * narrow their `name` argument to.
 *
 * Makes `whereMorphedTo("author", user)` a compile error when `author` is
 * an ordinary `belongsTo`, rather than a runtime throw. The inverse of
 * how `whereHas()` rejects a `morphTo` — that one can only throw, since
 * excluding a single member from an otherwise-permissive key union would
 * make the common case unusable.
 *
 * This bites at every entry point: `Model.query()` supplies the real
 * relation map (`BuilderOf<M>` threads `RelationsOf<M>` through), and a
 * custom builder subclass names it directly. It degrades to `never` —
 * i.e. no accepted name — for a builder with no declared relations,
 * which is the honest answer for a model that declared none.
 */
export type MorphToKeys<TRelations extends RelationDefinitions> = {
  [K in keyof TRelations]: TRelations[K]["type"] extends "morphTo" ? K : never;
}[keyof TRelations] &
  string;

/**
 * The shape `with(...names)` merges onto `TRow` for a given set of
 * requested relation names `K`. Matches the runtime the batched loader
 * attaches (`eager-loading.ts` sets a single instance, `undefined`, or a
 * `Collection`) and the value-side `LoadedRelations` accessors
 * (`model.ts`), so `Post.query().with("comments").get()` and
 * `post.comments` agree on type — both are `RelationValueOf` now.
 */
export type EagerLoadResult<TRelations extends RelationDefinitions, K extends keyof TRelations> = {
  [P in K]: RelationValueOf<TRelations[P]>;
};

/**
 * The related model's declared relation map, for one `RelationDefinition`
 * — the step that lets a dot path walk from one model to the next.
 *
 * A local mirror of `model.ts`'s `RelationsOf<RelatedClassOf<Def>>`,
 * inlined here to keep `relations.ts` free of a `model.ts` import (see
 * `ModelLike`). Resolves to `never` for a relation whose target declares
 * nothing — which is what stops a path from continuing past a leaf.
 *
 * Takes the related instance from `RelatedInstanceOf` (brand first, thunk
 * as fallback) and reads its declared relationships back off the
 * `HasAttributes` phantom, so a helper definition and a hand-written one
 * step to the same place. A model class carrying a concrete `relations`
 * static is honoured directly; a `string` key set means the map was
 * widened to `Record<string, …>` and names nothing checkable.
 *
 * A `morphTo` stops the walk outright. Its brand names a *union* of
 * targets, and descending into a union would accept any relation name the
 * targets happen to share — which the loader then rejects at runtime,
 * since it resolves a morph node's children per discriminant rather than
 * by path. `morphWith()` is how those are nested.
 */
type RelatedRelationsOf<Def> = Def extends { type: "morphTo" }
  ? never
  : Def extends { related: () => infer M }
    ? M extends { relations: infer R extends RelationDefinitions }
      ? string extends keyof R
        ? RelationshipsOfInstance<RelatedInstanceOf<Def>>
        : R
      : RelationshipsOfInstance<RelatedInstanceOf<Def>>
    : RelationshipsOfInstance<RelatedInstanceOf<Def>>;

/** The related instance type recorded in a helper definition's phantom brand. */
type RelatedInstanceOfBrand<Def> = Def extends { __brand?: { related: infer R } } ? R : never;

/**
 * The `Relationships<A>` map of a related model, reached from its
 * instance type via the `HasAttributes<A>` phantom. `never` when the
 * target isn't a marker-driven model or declares no relations — which is
 * what stops a dot path at a leaf.
 */
type RelationshipsOfInstance<I> = [I] extends [never]
  ? never
  : AttributesOf<I> extends infer A
    ? [A] extends [never]
      ? never
      : [RelationKeys<A>] extends [never]
        ? never
        : Relationships<A> extends infer Rels
          ? Rels extends RelationDefinitions
            ? Rels
            : never
          : never
    : never;

/** Decrements the depth counter in `RelationPath`. Index 0 is `never` so the recursion has a floor. */
type PrevDepth = [never, 0, 1, 2, 3, 4, 5];

/**
 * The maximum dot-path depth `with()` type-checks — five segments
 * (`"a.b.c.d.e"`).
 *
 * A **compile-time budget**, not a runtime limit: the loader recurses to
 * any depth, and a longer path still works at runtime. What the cap buys
 * is a bounded type: `RelationPath` is a recursive template-literal union
 * over a graph that is routinely cyclic (`Post.author.posts.author…`) and
 * self-referential (`Post.replies.replies…`), so without a floor it never
 * terminates.
 *
 * Five was measured. Against a pathological graph — ten models, each
 * declaring a relation to all ten, i.e. 100,000 expressible paths —
 * `tsc --extendedDiagnostics` checked in 1.11s against a 0.86s baseline
 * of the same models with the path type unused: 0.25s and ~5,300 extra
 * type instantiations for the whole union. A realistic graph is far
 * below that. The cap is here because unbounded recursion over a cyclic
 * graph is a language-server trap, not because 5 is near a cliff.
 */
export type MaxRelationPathDepth = 5;

/**
 * Every dot path `with()` accepts for a relation map — each declared name,
 * plus each name joined to a valid path on its related model, to
 * `MaxRelationPathDepth` segments.
 *
 *   RelationPath<RelationsOf<typeof Post>>
 *   // "author" | "author.team" | "comments.author.team" | "replies.replies" | ...
 *
 * Bottoms out on three conditions, all of which matter: the depth counter
 * hitting zero, a related model declaring no relations (`never` — nothing
 * to append), and a `morphTo`, which `RelatedRelationsOf` stops on
 * explicitly — nest those with `morphWith()` instead.
 */
export type RelationPath<R extends RelationDefinitions, D extends number = MaxRelationPathDepth> = [
  R,
] extends [never]
  ? never
  : D extends 0
    ? never
    : {
        [K in keyof R & string]: K | `${K}.${RelationPath<RelatedRelationsOf<R[K]>, PrevDepth[D]>}`;
      }[keyof R & string];

/** The first segment of a dot path — `"author"` for `"author.team"`. */
type PathHead<P extends string> = P extends `${infer H}.${string}` ? H : P;

/** The remainder of a dot path below head `H`, or `never` if `P` is just `H`. */
type PathRest<P extends string, H extends string> = P extends `${H}.${infer Rest}` ? Rest : never;

/**
 * Merges a nested result shape `C` into a relation value `V`, preserving
 * whether the relation is to-one or to-many — so `with("comments.author")`
 * types `post.comments` as `Collection<Comment & { author: … }>` rather
 * than losing the `Collection` wrapper or the element type.
 */
type MergeNested<V, C> = [C] extends [never]
  ? V
  : V extends Collection<infer I>
    ? Collection<I & C>
    : V extends undefined
      ? undefined
      : V & C;

/**
 * The shape `with(...paths)` merges onto `TRow` — `EagerLoadResult`'s
 * dot-path-aware replacement.
 *
 * Groups the requested paths by their first segment, so sibling paths
 * under one head merge into a single value type the way the runtime
 * merges them into a single node: `with("author.team", "author.posts")`
 * yields one `author` carrying both, matching the one `author` query the
 * loader actually issues.
 */
export type NestedEagerLoadResult<R extends RelationDefinitions, K extends string> = {
  [H in PathHead<K> & keyof R & string]: MergeNested<
    RelationValueOf<R[H]>,
    [PathRest<K, H>] extends [never]
      ? never
      : NestedEagerLoadResult<RelatedRelationsOf<R[H]>, PathRest<K, H>>
  >;
};

/**
 * A thunk returning the related model **class** — `() => User`. Kept
 * structural (a constructor whose instances are `R`) so `relations.ts`
 * needn't import `Model`.
 */
export type RelatedThunk<R> = () => abstract new (...args: any[]) => R;

/**
 * A branded relation definition produced by a helper (`belongsTo(...)`,
 * `hasMany(...)`, …). Structurally a `RelationDefinition` at runtime (so
 * the eager loader and builder consume it unchanged) plus a phantom brand
 * carrying the marker kind + related instance type, which is what makes
 * `static relationships` assignable-checkable against the model's markers.
 */
export type RelationHelperDefinition<K extends RelationKind, R> = K extends "morphTo"
  ? {
      readonly type: "morphTo";
      readonly options: MorphToOptions<any, Record<string, () => ModelLike>>;
      /** Phantom — never present at runtime. */
      readonly __brand?: { kind: K; related: R };
    }
  : {
      readonly type: K;
      readonly related: () => ModelLike;
      // Option shape for the specific relation kind, so the branded
      // definition is assignable to `RelationDefinition` (and the whole
      // `relationships` map to `RelationDefinitions`).
      readonly options: OptionsForKind<K>;
      /** Phantom — never present at runtime. */
      readonly __brand?: { kind: K; related: R };
    };

/** The option interface for a non-morphTo relation kind — matches `RelationDefinition`'s member. */
type OptionsForKind<K extends RelationKind> = K extends "belongsTo"
  ? BelongsToOptions<any, any>
  : K extends "hasOne"
    ? HasOneOptions<any, any>
    : K extends "hasMany"
      ? HasManyOptions<any, any>
      : K extends "belongsToMany"
        ? BelongsToManyOptions<any, any>
        : K extends "hasManyThrough"
          ? HasManyThroughOptions<any, any, any>
          : K extends "hasOneThrough"
            ? HasOneThroughOptions<any, any, any>
            : K extends "morphOne"
              ? MorphOneOptions<any, any>
              : K extends "morphMany"
                ? MorphManyOptions<any, any>
                : K extends "morphToMany"
                  ? MorphToManyOptions<any, any>
                  : K extends "morphedByMany"
                    ? MorphedByManyOptions<any, any>
                    : Record<string, any>;

function define<K extends RelationKind, R>(
  type: K,
  related: (() => any) | undefined,
  options: Record<string, any>,
): RelationHelperDefinition<K, R> {
  return related === undefined
    ? ({ type, options } as RelationHelperDefinition<K, R>)
    : ({ type, related, options } as RelationHelperDefinition<K, R>);
}

/** Many-to-one — the FK lives on this model's table. */
export function belongsTo<R>(
  related: RelatedThunk<R>,
  options: { foreignKey: string; ownerKey?: string },
): RelationHelperDefinition<"belongsTo", R> {
  return define("belongsTo", related, options);
}

/** One-to-one — the FK lives on the related table. */
export function hasOne<R>(
  related: RelatedThunk<R>,
  options: { foreignKey: string; localKey?: string },
): RelationHelperDefinition<"hasOne", R> {
  return define("hasOne", related, options);
}

/** One-to-many — the FK lives on the related table. */
export function hasMany<R>(
  related: RelatedThunk<R>,
  options: { foreignKey: string; localKey?: string },
): RelationHelperDefinition<"hasMany", R> {
  return define("hasMany", related, options);
}

/** Many-to-many through a pivot table. */
export function belongsToMany<R>(
  related: RelatedThunk<R>,
  options: {
    pivotTable: string;
    foreignPivotKey: string;
    relatedPivotKey: string;
    localKey?: string;
    relatedKey?: string;
    withPivot?: string[];
    withTimestamps?: boolean;
  },
): RelationHelperDefinition<"belongsToMany", R> {
  return define("belongsToMany", related, options);
}

/** Has-one-through an intermediate model. */
export function hasOneThrough<R>(
  related: RelatedThunk<R>,
  options: {
    through: () => any;
    firstKey: string;
    secondKey: string;
    localKey?: string;
    secondLocalKey?: string;
  },
): RelationHelperDefinition<"hasOneThrough", R> {
  return define("hasOneThrough", related, options);
}

/** Has-many-through an intermediate model. */
export function hasManyThrough<R>(
  related: RelatedThunk<R>,
  options: {
    through: () => any;
    firstKey: string;
    secondKey: string;
    localKey?: string;
    secondLocalKey?: string;
  },
): RelationHelperDefinition<"hasManyThrough", R> {
  return define("hasManyThrough", related, options);
}

/** Polymorphic inverse — resolves the parent by a discriminant column. */
export function morphTo<R = unknown>(options: {
  morphType: string;
  morphId: string;
  types?: Record<string, () => any>;
  ownerKey?: string;
}): RelationHelperDefinition<"morphTo", R> {
  return define("morphTo", undefined, options);
}

/** Polymorphic one-to-one. */
export function morphOne<R>(
  related: RelatedThunk<R>,
  options: { morphType: string; morphId: string; type?: string; localKey?: string },
): RelationHelperDefinition<"morphOne", R> {
  return define("morphOne", related, options);
}

/** Polymorphic one-to-many. */
export function morphMany<R>(
  related: RelatedThunk<R>,
  options: { morphType: string; morphId: string; type?: string; localKey?: string },
): RelationHelperDefinition<"morphMany", R> {
  return define("morphMany", related, options);
}

/** Polymorphic many-to-many (morphed side). */
export function morphToMany<R>(
  related: RelatedThunk<R>,
  options: {
    pivotTable: string;
    morphType: string;
    morphId: string;
    relatedPivotKey: string;
    type?: string;
    localKey?: string;
    relatedKey?: string;
    withPivot?: string[];
    withTimestamps?: boolean;
  },
): RelationHelperDefinition<"morphToMany", R> {
  return define("morphToMany", related, options);
}

/** Polymorphic many-to-many (inverse side). */
export function morphedByMany<R>(
  related: RelatedThunk<R>,
  options: {
    pivotTable: string;
    morphType: string;
    morphId: string;
    foreignPivotKey: string;
    type?: string;
    localKey?: string;
    relatedKey?: string;
    withPivot?: string[];
    withTimestamps?: boolean;
  },
): RelationHelperDefinition<"morphedByMany", R> {
  return define("morphedByMany", related, options);
}

/** The helper definition a relation marker `V` in the attributes map requires. */
type DefinitionForMarker<V> =
  V extends RelationMarker<infer K, infer R, any, any, any>
    ? RelationHelperDefinition<K, R>
    : never;

/**
 * The shape a model's `static relationships` map must have, derived from
 * the relation markers in its attributes interface `A`. Each key must be
 * a declared relation name and its definition's kind + related type must
 * match the marker — this is what makes a wrong `foreignKey`'s *related
 * class* a compile error (via the helper's `R`) and a missing/extra
 * relation key a compile error.
 */
export type Relationships<A> = {
  [K in RelationKeys<A>]: DefinitionForMarker<A[K]>;
};
