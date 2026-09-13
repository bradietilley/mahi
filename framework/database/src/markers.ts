/**
 * Type-only markers a model's attributes interface uses to declare
 * relations and computed attributes, plus the machinery that derives the
 * column / relation / computed views of that interface.
 *
 * The whole model redesign hangs off one idea: a model is described by a
 * single interface (`interface PostAttributes { … }`) where plain columns
 * are plain types, relations are `BelongsTo<User>`/`HasMany<Comment>`
 * markers, and computed attributes are `Computed<string>` markers.
 * Everything else, the instance shape, the DB row shape, the builder,
 * the finder return types, is derived from it, so there is exactly one
 * declaration to keep in sync.
 *
 * These are erased at runtime (each is a phantom brand over a `unique
 * symbol` key), so importing them costs nothing and they never appear on
 * an instance. `markers.ts` imports only a type (`Collection`), so it can
 * be depended on from anywhere in the package without a cycle.
 */

import type { Collection } from "@mahiframework/core";

declare const RELATION_BRAND: unique symbol;
declare const COMPUTED_BRAND: unique symbol;
declare const ATTRIBUTES_BRAND: unique symbol;

/**
 * A phantom carrying a model instance's *unresolved* attributes map `A`.
 *
 * `ModelInstance<A>` resolves every marker to its loaded value, which
 * erases the markers, so from an instance type alone there is no way
 * back to `A`. Nested eager loading needs exactly that trip: to know
 * whether `"author.team"` is valid, the path walker has to get from
 * `Post`'s `author` relation to `User`'s *declared relations*, i.e. to
 * `User`'s `A`. This brand is that link.
 *
 * Optional and keyed by a `unique symbol`, so it is erased at runtime,
 * never appears on an instance, and never affects assignability.
 */
export interface HasAttributes<A> {
  readonly [ATTRIBUTES_BRAND]?: A;
}

/** Recovers the attributes map `A` from a model instance type. */
export type AttributesOf<I> = I extends HasAttributes<infer A> ? A : never;

/** The kinds of relation a marker can name, mirrors `RelationDefinition`'s discriminant. */
export type RelationKind =
  | "belongsTo"
  | "hasOne"
  | "hasMany"
  | "belongsToMany"
  | "hasOneThrough"
  | "hasManyThrough"
  | "morphTo"
  | "morphOne"
  | "morphMany"
  | "morphToMany"
  | "morphedByMany";

/**
 * The phantom payload every relation marker carries: the relation kind,
 * the related **instance** type `R`, whether the loaded value is a
 * collection, the pivot-attributes type (for many-to-many), and an
 * optional custom builder type so `post.relations.author()` can narrow.
 */
export interface RelationMarker<K extends RelationKind, R, ToMany extends boolean, Pivot, B> {
  readonly [RELATION_BRAND]: {
    kind: K;
    related: R;
    toMany: ToMany;
    pivot: Pivot;
    builder: B;
  };
}

/**
 * The empty-pivot type, a relation with no `withPivot` attributes.
 *
 * Deliberately an empty interface rather than `Record<string, never>`:
 * `keyof Record<string, never>` is `string`, not `never`, so the
 * `[keyof Pivot] extends [never]` test in `WithPivot` would never fire
 * and every to-many relation would wrongly resolve to
 * `Collection<R & { pivot: NoPivot }>`. An empty interface has
 * `keyof` = `never`, which is the question actually being asked.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NoPivot {}

/** Many-to-one. The FK lives on this model's table. Loaded value: `R | undefined`. */
export type BelongsTo<R, B = unknown> = RelationMarker<"belongsTo", R, false, NoPivot, B>;
/** One-to-one. The FK lives on the related table. Loaded value: `R | undefined`. */
export type HasOne<R, B = unknown> = RelationMarker<"hasOne", R, false, NoPivot, B>;
/** One-to-many. The FK lives on the related table. Loaded value: `Collection<R> | undefined`. */
export type HasMany<R, B = unknown> = RelationMarker<"hasMany", R, true, NoPivot, B>;
/** Many-to-many through a pivot. Loaded value: `Collection<R & { pivot: Pivot }> | undefined`. */
export type BelongsToMany<R, Pivot = NoPivot, B = unknown> = RelationMarker<
  "belongsToMany",
  R,
  true,
  Pivot,
  B
>;
/** Has-one-through an intermediate model. Loaded value: `R | undefined`. */
export type HasOneThrough<R, B = unknown> = RelationMarker<"hasOneThrough", R, false, NoPivot, B>;
/** Has-many-through an intermediate model. Loaded value: `Collection<R> | undefined`. */
export type HasManyThrough<R, B = unknown> = RelationMarker<"hasManyThrough", R, true, NoPivot, B>;
/** Polymorphic inverse. `R` is the union of the target instance types. Loaded value: `R | undefined`. */
export type MorphTo<R> = RelationMarker<"morphTo", R, false, NoPivot, unknown>;
/** Polymorphic one-to-one. Loaded value: `R | undefined`. */
export type MorphOne<R, B = unknown> = RelationMarker<"morphOne", R, false, NoPivot, B>;
/** Polymorphic one-to-many. Loaded value: `Collection<R> | undefined`. */
export type MorphMany<R, B = unknown> = RelationMarker<"morphMany", R, true, NoPivot, B>;
/** Polymorphic many-to-many (morphed side). Loaded value: `Collection<R & { pivot: Pivot }> | undefined`. */
export type MorphToMany<R, Pivot = NoPivot, B = unknown> = RelationMarker<
  "morphToMany",
  R,
  true,
  Pivot,
  B
>;
/** Polymorphic many-to-many (inverse side). Loaded value: `Collection<R & { pivot: Pivot }> | undefined`. */
export type MorphedByMany<R, Pivot = NoPivot, B = unknown> = RelationMarker<
  "morphedByMany",
  R,
  true,
  Pivot,
  B
>;

/**
 * A computed (accessor) attribute, `excerpt: Computed<string>` in the
 * attributes interface, backed by `static accessors = { excerpt:
 * accessor((post) => …) }`. Reads back off the instance (`post.excerpt`)
 * and, when listed in `appends`, is included in `toJSON()`.
 */
export type Computed<T> = { readonly [COMPUTED_BRAND]: T };

/** `true` when `V` is any relation marker. */
export type IsRelationMarker<V> = V extends RelationMarker<any, any, any, any, any> ? true : false;
/** `true` when `V` is a `Computed<>` marker. */
export type IsComputedMarker<V> = [V] extends [Computed<any>] ? true : false;

/** The plain-column keys of an attributes map `A` (excludes relations and computed). */
export type ColumnKeys<A> = {
  [K in keyof A]: IsRelationMarker<A[K]> extends true
    ? never
    : IsComputedMarker<A[K]> extends true
      ? never
      : K;
}[keyof A] &
  string;

/** The relation-marker keys of `A`. */
export type RelationKeys<A> = {
  [K in keyof A]: IsRelationMarker<A[K]> extends true ? K : never;
}[keyof A] &
  string;

/** The relation-marker keys of `A` whose relation is a `morphTo`, for the morph-aware query methods. */
export type MorphToRelationKeys<A> = {
  [K in keyof A]: A[K] extends RelationMarker<"morphTo", any, any, any, any> ? K : never;
}[keyof A] &
  string;

/** The `Computed<>` keys of `A`. */
export type ComputedKeys<A> = {
  [K in keyof A]: IsComputedMarker<A[K]> extends true ? K : never;
}[keyof A] &
  string;

/** The plain columns of `A` as an ordinary object type (model-facing types). */
export type Columns<A> = { [K in ColumnKeys<A>]: A[K] };

/** The related instance type a single relation marker points at. */
export type RelatedOf<V> = V extends RelationMarker<any, infer R, any, any, any> ? R : never;
/** The relation kind of a single relation marker. */
export type KindOf<V> = V extends RelationMarker<infer K, any, any, any, any> ? K : never;
/** The pivot-attributes type of a single relation marker. */
export type PivotOf<V> = V extends RelationMarker<any, any, any, infer P, any> ? P : never;
/** The custom builder type a relation marker names, or `unknown`. */
export type BuilderMarkerOf<V> =
  V extends RelationMarker<any, any, any, any, infer B> ? B : unknown;

/** Attaches `{ pivot: Pivot }` onto the related instance when the pivot is non-empty. */
type WithPivot<R, Pivot> = [keyof Pivot] extends [never] ? R : R & { pivot: Pivot };

/** The loaded value a single relation marker resolves to (`R | undefined` / `Collection<R> | undefined`). */
export type LoadedValueOf<V> =
  V extends RelationMarker<any, infer R, infer ToMany, infer Pivot, any>
    ? ToMany extends true
      ? Collection<WithPivot<R, Pivot>> | undefined
      : R | undefined
    : never;

/** The value a `Computed<>` marker resolves to. */
export type ComputedValueOf<V> = V extends Computed<infer T> ? T : never;

/**
 * The instance-facing attribute shape derived from `A`: plain columns
 * stay as declared, relation markers become their loaded value, computed
 * markers become their type. This is the "one type" every finder,
 * builder terminal, and `this` inside a method agrees on.
 */
export type ResolvedAttributes<A> = {
  [K in keyof A]: IsRelationMarker<A[K]> extends true
    ? LoadedValueOf<A[K]>
    : IsComputedMarker<A[K]> extends true
      ? ComputedValueOf<A[K]>
      : A[K];
};

/** The relation markers of `A`, keyed by relation name, the map `Relations<M>` exposes. */
export type RelationMarkers<A> = { [K in RelationKeys<A>]: A[K] };
