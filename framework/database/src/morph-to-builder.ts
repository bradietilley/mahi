import { MorphToSpec } from "./eager-load-tree.js";
import type { EloquentBuilder } from "./eloquent-builder.js";
import type { Model, ModelClass, AnyModelClass } from "./model.js";
import { resolveMorphType } from "./model.js";
import { SoftDeleteScope } from "./soft-deletes.js";

/** A per-type constraining callback, keyed by discriminant value — see `MorphToBuilder.constrain()`. */
export type MorphConstraints = Record<string, (query: any) => void>;

/** Which soft-delete variant a deferred `withTrashed()`/`onlyTrashed()` selects. */
type TrashedMode = "default" | "with" | "only";

/**
 * The query-side handle for a declared `morphTo` relation —
 * `comment.relations.commentable()`.
 *
 * ## Why this isn't an `EloquentBuilder`
 *
 * Every other relation resolves to a single related model, so its
 * accessor returns that model's own `EloquentBuilder<TRow>`. A `morphTo`
 * cannot: its target is a *type*, unknown until the row's discriminant is
 * read at runtime, so there is no sound `TRow` to parameterise on and no
 * single table to build a query against.
 *
 * This is the only genuine divergence from the other relations. It is
 * **not** a `Promise` either — that would break the uniform
 * `relations.x()` call shape every other relation has. Instead it's a
 * real builder that defers: constraints accumulate here, and the first
 * terminal call resolves the discriminant, picks the target model, and
 * delegates to that model's actual `EloquentBuilder`.
 *
 *   const parent = await comment.relations.commentable().first();
 *
 *   await comment.relations
 *     .commentable()
 *     .constrain({ post: (q) => q.where("published", 1) })
 *     .first();
 *
 * ## Why `constrain()` is per-type
 *
 * `whereHas("x", (q) => q.where("published", 1))` works because there's
 * one related model and `published` is known to be its column. Across a
 * morph union there is no such column — `Post` has `published`, `Video`
 * might not. So constraints are keyed by discriminant, mirroring
 * Laravel's `MorphTo::constrain()`. A type with no entry is unconstrained.
 *
 * `constrain()` and `morphWith()` both come from `MorphToSpec`, which the
 * batched eager loader also uses — so the callback in
 * `with({ commentable: (m) => … })` sees exactly the same API whether it
 * ends up running against one row or a whole page of them. Only the
 * terminals below (`first()`/`exists()`, which need a specific parent
 * row) are unique to this class.
 */
export class MorphToBuilder<TTarget = Model> extends MorphToSpec {
  private trashed: TrashedMode = "default";

  /**
   * `relationName` is the name this relation is declared under, used
   * only by `associate()`/`dissociate()` to set and clear the *loaded*
   * relation so `comment.commentable` reflects the new target.
   *
   * It is optional because `morphToBuilder()` is also callable for an
   * **undeclared** morphTo, which by definition has no name. In that
   * case the columns are still written; there is simply no named
   * relation slot to keep in step.
   */
  constructor(
    private readonly parent: Model,
    private readonly options: {
      morphType: string;
      morphId: string;
      types?: Record<string, () => AnyModelClass>;
      ownerKey?: string;
    },
    private readonly relationName?: string,
  ) {
    super();
  }

  /** Include soft-deleted parents. A no-op for target models without `SoftDeletes`. */
  withTrashed(): this {
    this.trashed = "with";

    return this;
  }

  /** Exclude soft-deleted parents — the default, so this only undoes a prior `withTrashed()`/`onlyTrashed()`. */
  withoutTrashed(): this {
    this.trashed = "default";

    return this;
  }

  /** Return ONLY soft-deleted parents. A no-op for target models without `SoftDeletes`. */
  onlyTrashed(): this {
    this.trashed = "only";

    return this;
  }

  /**
   * The model class this row's discriminant names, or `undefined` if
   * either polymorphic column is null or the value resolves through
   * neither the local `types` map nor the global morph map.
   *
   * Useful for branching before querying (`if (builder.targetClass() ===
   * Post)`), and what `first()` calls internally.
   */
  targetClass(): AnyModelClass | undefined {
    const typeValue = this.parent.getRawAttribute(this.options.morphType);
    const idValue = this.parent.getRawAttribute(this.options.morphId);

    if (typeValue == null || idValue == null) {
      return undefined;
    }

    return resolveMorphType(String(typeValue), this.options.types);
  }

  /**
   * The target model's real `EloquentBuilder`, scoped to this row's
   * parent and with any matching `constrain()` callback and soft-delete
   * variant applied — or `undefined` when the discriminant resolves to
   * nothing.
   *
   * The escape hatch for anything `first()` doesn't cover (`exists()`,
   * `count()`, a custom builder's scopes). Returns `undefined` rather
   * than throwing for the same reason `first()` does: an unresolvable
   * `*_type` is stale data, not a programming error.
   */
  toBuilder(): EloquentBuilder<Record<string, any>> | undefined {
    const target = this.targetClass();

    if (!target) {
      return undefined;
    }

    const related = target as unknown as ModelClass;
    const typeValue = String(this.parent.getRawAttribute(this.options.morphType));
    const idValue = this.parent.getRawAttribute(this.options.morphId);
    const ownerKey = this.options.ownerKey ?? related.primaryKeyColumn;

    const builder = this.startQuery(target) as EloquentBuilder<Record<string, any>>;
    builder.where(ownerKey, idValue as any);

    const constraint = this.constraintFor(typeValue);

    if (constraint) {
      constraint(builder);
    }

    return builder;
  }

  /**
   * Resolves the parent — `undefined` when the discriminant names
   * nothing, either column is null, or no matching row exists. Matches
   * `belongsTo()`'s "missing owner resolves to undefined".
   */
  async first(): Promise<TTarget | undefined> {
    const builder = this.toBuilder();

    if (!builder) {
      return undefined;
    }

    return (await builder.first()) as TTarget | undefined;
  }

  /** `true` if the parent row exists (and satisfies any `constrain()` callback). */
  async exists(): Promise<boolean> {
    const builder = this.toBuilder();

    return builder ? builder.exists() : false;
  }

  /**
   * Points this row at `target`, writing **both** polymorphic columns —
   * the discriminant (from the target's `morphAlias()`) and the key.
   *
   *   comment.relations.commentable().associate(post);
   *   await comment.save();
   *
   * Does not save, matching `belongsTo`'s `associate()`: it sets
   * attributes on the parent and leaves persisting to the caller.
   *
   * Unlike a `belongsTo`, this takes an **instance only** — a bare key
   * cannot work here, because the discriminant is derived from the
   * target's class and a key alone doesn't name one.
   *
   * The discriminant is written through `morphAlias()`, so it goes
   * through the morph map exactly as the read side's `resolveMorphType()`
   * does; a model registered under an alias stores the alias, not its
   * table name. `ownerKey` is honoured, so a morph pointing at a
   * non-primary column writes that column's value.
   */
  associate(target: Model): Model {
    const related = target.constructor as AnyModelClass;
    const ownerKey = this.options.ownerKey ?? related.primaryKeyColumn;

    this.parent.setAttribute(this.options.morphType, related.morphAlias());
    this.parent.setAttribute(this.options.morphId, target.getRawAttribute(ownerKey));

    if (this.relationName === undefined) {
      return this.parent;
    }

    return this.parent.setRelation(this.relationName, target);
  }

  /** Nulls both polymorphic columns and clears the loaded relation. Does not save. */
  dissociate(): Model {
    this.parent.setAttribute(this.options.morphType, null);
    this.parent.setAttribute(this.options.morphId, null);

    if (this.relationName === undefined) {
      return this.parent;
    }

    return this.parent.unsetRelation(this.relationName);
  }

  /**
   * Starts the target model's builder in the soft-delete mode selected by
   * `withTrashed()`/`onlyTrashed()`.
   *
   * `withTrashed()` is expressed as `withoutGlobalScope(SoftDeleteScope)`
   * rather than the `SoftDeletes.withTrashed()` helper: the helper is
   * `queryWithoutScopes()`, which drops *every* scope, and a morphTo has
   * no business silently disabling a target's unrelated global scopes.
   * Dropping only the soft-delete scope is the narrower, correct read of
   * "include trashed". Both are no-ops on a model without `SoftDeletes`,
   * since it has no such scope to remove.
   */
  private startQuery(target: AnyModelClass) {
    if (this.trashed === "default") {
      return target.query();
    }

    const builder = target.withoutGlobalScope(SoftDeleteScope) as unknown as EloquentBuilder<
      Record<string, any>
    >;

    if (this.trashed === "only") {
      builder.whereNotNull("deleted_at");
    }

    return builder;
  }
}
