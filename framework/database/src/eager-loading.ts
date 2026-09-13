import { Collection } from "@mahiframework/core";
import {
  MorphToSpec,
  parseEagerLoad,
  type EagerLoadNode,
  type EagerLoadRequest,
  type EagerLoadTree,
} from "./eager-load-tree.js";
import { resolveMorphType, type Model, type ModelClass } from "./model.js";
import type { EloquentBuilder } from "./eloquent-builder.js";
import { PIVOT_PREFIX, pivotColumns } from "./pivot.js";
import type { RelationDefinition } from "./relations.js";

/**
 * The batched eager-loading engine behind `EloquentBuilder.with()` and
 * the instance `load()` method. See `relations.ts`'s `RelationDefinition`
 * docstring for the declaration side. Not exported from `index.ts`;
 * called internally once one or more relation names have been queued.
 *
 * Operates on **model instances**: it reads foreign/local keys via each
 * instance's raw (DB-shape) attributes, hydrates the related rows into
 * their own model instances, and attaches them with `setRelation()`, so
 * `post.author` (a loaded belongsTo) is a `User` instance and
 * `post.images` (a loaded hasMany) is a `PostImage[]`. Every relation
 * type batches into a small, constant number of extra queries regardless
 * of how many `instances` are passed in (never one query per row);
 * `belongsToMany` additionally batches its pivot lookup across the whole
 * array.
 */
/**
 * Batch-loads declared relations onto an array of already-fetched
 * instances, Laravel's `$collection->load(...)`. One batched query per
 * relation name across the WHOLE array (never one per instance), so it's
 * the N+1-free way to attach relations to a page of rows fetched without
 * `with()` (e.g. after `cursorPaginate()`). Infers the model class from
 * the first instance; a no-op on an empty array.
 */
export async function loadMany(instances: Model[], ...relationNames: string[]): Promise<Model[]> {
  if (instances.length === 0) {
    return instances;
  }

  // NB: read the constructor off the prototype, not `instance.constructor`
  // directly. A Model instance is a Proxy whose `get` trap binds every
  // function-valued property (including `constructor`) to the target, and
  // a bound function loses its static properties (`table`/`relations`).
  const model = Object.getPrototypeOf(instances[0]!).constructor as unknown as ModelClass;

  return loadRelations(model, instances, relationNames);
}

/**
 * Runs a parsed eager-load request against a set of instances.
 *
 * Accepts either the parsed tree or the raw `with()`-style argument
 * (names/dot paths, or a `{ path: constraint }` map), so callers that
 * never needed the tree, `Model.load()`, `loadMany()`, keep passing a
 * plain string array.
 *
 * ## The recursion, and what it costs
 *
 * Each level runs one batched query per node against the *whole* current
 * instance set, then descends into the union of whatever those nodes
 * attached. So the query count is one per **node in the tree**, not per
 * instance and not per row: `with("author.team")` over 500 posts is 2
 * queries, and would be 2 over 500,000. That is the same "constant, never
 * N+1" promise the flat version made, expressed over a tree.
 *
 * Siblings at a level are loaded sequentially rather than in parallel.
 * A transaction-scoped connection is not safe to issue concurrent
 * statements on, and ordering keeps failure modes deterministic.
 */
export async function loadRelations(
  model: ModelClass,
  instances: Model[],
  request: EagerLoadTree | EagerLoadRequest,
  options: { missingOnly?: boolean } = {},
): Promise<Model[]> {
  if (instances.length === 0) {
    return instances;
  }

  const tree = request instanceof Map ? request : parseEagerLoad(request);
  await loadTree(model, instances, tree, options.missingOnly ?? false);

  return instances;
}

async function loadTree(
  model: ModelClass,
  instances: Model[],
  tree: EagerLoadTree,
  missingOnly: boolean,
): Promise<void> {
  if (instances.length === 0 || tree.size === 0) {
    return;
  }

  for (const [name, node] of tree) {
    const definition = model.relations[name];

    if (!definition) {
      // Names the failing SEGMENT, not the whole path: on a deep path the
      // segment is the actionable half, and the model it's missing from
      // is the non-obvious half.
      throw new Error(
        `with("${name}"): no relation named "${name}" is declared in ${model.table}'s "static relations".`,
      );
    }

    // `loadMissing()` skips the query only when EVERY instance already has
    // the relation. A partially-loaded set still needs the batch, and
    // re-attaching an already-loaded value is harmless. The skip applies
    // per level, so `loadMissing("author.team")` can reuse an attached
    // `author` and still go fetch its missing `team`.
    const targets = missingOnly ? instances.filter((i) => !i.relationLoaded(name)) : instances;

    // A morphTo's per-type constraints and nested loads are both declared
    // inside its constraining callback, so the callback has to be run to
    // find out what they are. Resolved HERE rather than in `loadOne`
    // because `loadMissing()` skips `loadOne` for an already-attached
    // relation, and a morphWith under a loaded morphTo must still apply.
    const morphSpec = definition.type === "morphTo" ? resolveMorphSpec(node) : undefined;

    if (targets.length > 0) {
      await loadOne(model, targets, name, definition, node, morphSpec);
    }

    const hasMorphChildren = (node.morphWith?.size ?? 0) > 0;

    if (node.children.size === 0 && !hasMorphChildren) {
      continue;
    }

    // A morphTo's children are per-discriminant, so they're resolved
    // against each type's own related class rather than one shared one.
    if (definition.type === "morphTo") {
      await loadMorphChildren(instances, name, node, definition.options.morphType, missingOnly);
      continue;
    }

    const related = definition.related() as unknown as ModelClass;
    await loadTree(related, collectRelated(instances, name), node.children, missingOnly);
  }
}

/**
 * Runs a `morphTo` node's constraining callback to collect its per-type
 * constraints and `morphWith` trees, caching the latter onto the node.
 *
 * Idempotent, and safe to call before the relation loads: the callback
 * only records intent, it doesn't query.
 */
function resolveMorphSpec(node: EagerLoadNode): MorphToSpec {
  const spec = new MorphToSpec();

  if (node.constrain) {
    node.constrain(spec);
  }

  node.morphWith = spec.morphWithTreesByType();

  return spec;
}

/**
 * Descends into a `morphTo` node's children, split by the discriminant
 * each attached parent resolved from.
 *
 * ## Why the grouping key is the raw `*_type` value
 *
 * `morphWith({ post: [...] })` is keyed by whatever the caller writes in
 * the declaration's `types` map. Which is a **local** name, resolved by
 * `resolveMorphType` through local `types` FIRST and only then the global
 * morph map. So a relation declaring `types: { post: () => Post }` uses
 * `"post"` even when `Post.morphAlias()` says `"posts"` (the table-name
 * fallback) or the global map registers it as something else entirely.
 * Keying the lookup on `morphAlias()` would silently miss in exactly
 * those cases: the children just wouldn't load, with no error.
 *
 * Grouping walks the PARENT rows rather than the loaded instances so the
 * discriminant is read from the same column the loader matched on. Two
 * discriminants pointing at one class stay separate groups, which is the
 * point. `morphWith` is per declared type, not per class.
 */
async function loadMorphChildren(
  instances: Model[],
  name: string,
  node: EagerLoadNode,
  morphType: string,
  missingOnly: boolean,
): Promise<void> {
  const byType = new Map<string, { parents: Model[]; seen: Set<Model> }>();

  for (const instance of instances) {
    const parent = instance.getRelation(name) as Model | undefined;

    if (parent == null) {
      continue;
    }

    const typeValue = String(instance.getRawAttribute(morphType));
    const bucket = byType.get(typeValue) ?? { parents: [], seen: new Set<Model>() };

    // The same parent is shared by every row pointing at it, descend
    // once, as `collectRelated` does for the non-morph path.
    if (!bucket.seen.has(parent)) {
      bucket.seen.add(parent);
      bucket.parents.push(parent);
    }

    byType.set(typeValue, bucket);
  }

  for (const [typeValue, { parents }] of byType) {
    const parentClass = Object.getPrototypeOf(parents[0]!).constructor as unknown as ModelClass;

    // A type listed in neither place loads nothing, a mixed page
    // routinely holds types the caller had nothing extra to load for.
    const perType = node.morphWith?.get(typeValue);

    if (perType) {
      await loadTree(parentClass, parents, perType, missingOnly);
    }

    if (node.children.size > 0) {
      await loadTree(parentClass, parents, node.children, missingOnly);
    }
  }
}

/**
 * Flattens the relation values `name` attached across `instances` into
 * the instance set the next level runs against.
 *
 * Handles all three shapes the loader can set, a `Collection` (to-many),
 * a single instance (to-one), or `undefined` (a to-one that matched
 * nothing, or a `morphTo` whose discriminant didn't resolve), and
 * de-duplicates by identity, since the same related instance is routinely
 * shared by many parents (twenty posts by one author attach the *same*
 * `Author`). Without that, `with("author.team")` would issue the `team`
 * query against twenty duplicates of one author.
 */
function collectRelated(instances: Model[], name: string): Model[] {
  const seen = new Set<Model>();
  const collected: Model[] = [];

  const push = (value: unknown): void => {
    if (value == null) {
      return;
    }

    const instance = value as Model;

    if (seen.has(instance)) {
      return;
    }

    seen.add(instance);
    collected.push(instance);
  };

  for (const instance of instances) {
    const value = instance.getRelation(name);

    if (value instanceof Collection) {
      for (const item of value) {
        push(item);
      }
    } else {
      push(value);
    }
  }

  return collected;
}

async function loadOne(
  model: ModelClass,
  instances: Model[],
  name: string,
  definition: RelationDefinition,
  node: EagerLoadNode,
  morphSpec?: MorphToSpec,
): Promise<void> {
  // NB: `definition.related()` is resolved per-case rather than up front,
  // because `morphTo` has no `related` thunk. It points at several
  // models, chosen at runtime by each row's discriminant.
  switch (definition.type) {
    case "belongsTo": {
      const related = definition.related() as unknown as ModelClass;
      const { foreignKey, ownerKey = related.primaryKeyColumn } = definition.options;
      const ids = uniqueDefined(instances.map((i) => i.getRawAttribute(foreignKey)));
      const relatedRows =
        ids.length === 0
          ? Collection.make<Model>([])
          : ((await applyConstraint(
              related.query().whereIn(ownerKey, ids),
              node,
              name,
            ).get()) as unknown as Collection<Model>);
      const byKey = relatedRows.keyBy((r) => String(r.getRawAttribute(ownerKey)));

      for (const instance of instances) {
        const fk = instance.getRawAttribute(foreignKey);
        instance.setRelation(name, fk == null ? undefined : byKey.get(String(fk)));
      }

      return;
    }

    case "hasOne": {
      const related = definition.related() as unknown as ModelClass;
      const { foreignKey, localKey = model.primaryKeyColumn } = definition.options;
      const ids = uniqueDefined(instances.map((i) => i.getRawAttribute(localKey)));
      const relatedRows =
        ids.length === 0
          ? Collection.make<Model>([])
          : ((await applyConstraint(
              related.query().whereIn(foreignKey, ids),
              node,
              name,
            ).get()) as unknown as Collection<Model>);
      const grouped = relatedRows.groupBy((r) => String(r.getRawAttribute(foreignKey)));

      for (const instance of instances) {
        instance.setRelation(
          name,
          grouped.get(String(instance.getRawAttribute(localKey)))?.first(),
        );
      }

      return;
    }

    case "hasMany": {
      const related = definition.related() as unknown as ModelClass;
      const { foreignKey, localKey = model.primaryKeyColumn } = definition.options;
      const ids = uniqueDefined(instances.map((i) => i.getRawAttribute(localKey)));
      const relatedRows =
        ids.length === 0
          ? Collection.make<Model>([])
          : ((await applyConstraint(
              related.query().whereIn(foreignKey, ids),
              node,
              name,
            ).get()) as unknown as Collection<Model>);
      const grouped = relatedRows.groupBy((r) => String(r.getRawAttribute(foreignKey)));

      for (const instance of instances) {
        instance.setRelation(
          name,
          grouped.get(String(instance.getRawAttribute(localKey))) ?? Collection.make<Model>([]),
        );
      }

      return;
    }

    case "morphOne":
    case "morphMany": {
      const related = definition.related() as unknown as ModelClass;
      const { morphType, morphId, localKey = model.primaryKeyColumn } = definition.options;
      const type = definition.options.type ?? model.morphAlias();
      const ids = uniqueDefined(instances.map((i) => i.getRawAttribute(localKey)));
      const relatedRows =
        ids.length === 0
          ? Collection.make<Model>([])
          : ((await applyConstraint(
              related.query().where(morphType, type).whereIn(morphId, ids),
              node,
              name,
            ).get()) as unknown as Collection<Model>);
      const grouped = relatedRows.groupBy((r) => String(r.getRawAttribute(morphId)));

      for (const instance of instances) {
        const group = grouped.get(String(instance.getRawAttribute(localKey)));
        instance.setRelation(
          name,
          definition.type === "morphOne" ? group?.first() : (group ?? Collection.make<Model>([])),
        );
      }

      return;
    }

    case "hasOneThrough":
    case "hasManyThrough": {
      const related = definition.related() as unknown as ModelClass;
      const through = definition.options.through() as unknown as ModelClass;
      const { firstKey, secondKey } = definition.options;
      const localKey = definition.options.localKey ?? model.primaryKeyColumn;
      const secondLocalKey = definition.options.secondLocalKey ?? through.primaryKeyColumn;

      const localIds = uniqueDefined(instances.map((i) => i.getRawAttribute(localKey)));

      if (localIds.length === 0) {
        for (const instance of instances) {
          instance.setRelation(
            name,
            definition.type === "hasOneThrough" ? undefined : Collection.make<Model>([]),
          );
        }

        return;
      }

      // through rows: firstKey (this model) -> secondLocalKey (join key
      // to related). Goes through the through model's OWN builder so its
      // global scopes apply, a soft-deleted through row must stop
      // linking its related rows to the parent, exactly as the
      // non-batched `hasManyThrough()` helper now does.
      const throughRows = (await (
        through.query() as unknown as EloquentBuilder<Record<string, any>>
      )
        .select(firstKey, secondLocalKey)
        .whereIn(firstKey, localIds as any)
        .toBase()
        .get()) as Record<string, any>[];

      const secondIds = uniqueDefined(throughRows.map((r: any) => r[secondLocalKey]));
      const relatedRows =
        secondIds.length === 0
          ? Collection.make<Model>([])
          : ((await applyConstraint(
              related.query().whereIn(secondKey, secondIds),
              node,
              name,
            ).get()) as unknown as Collection<Model>);
      const relatedGrouped = relatedRows.groupBy((r) => String(r.getRawAttribute(secondKey)));

      // map each parent localKey -> the through-join keys it owns
      const throughGroups = new Map<string, unknown[]>();

      for (const throughRow of throughRows as any[]) {
        const key = String(throughRow[firstKey]);
        const list = throughGroups.get(key) ?? [];
        list.push(throughRow[secondLocalKey]);
        throughGroups.set(key, list);
      }

      for (const instance of instances) {
        const joinKeys = throughGroups.get(String(instance.getRawAttribute(localKey))) ?? [];
        const attached = joinKeys.flatMap((k) => relatedGrouped.get(String(k))?.toArray() ?? []);
        instance.setRelation(
          name,
          definition.type === "hasOneThrough" ? attached[0] : Collection.make<Model>(attached),
        );
      }

      return;
    }

    case "belongsToMany": {
      const related = definition.related() as unknown as ModelClass;
      const options = definition.options;

      return loadPivotRelation(model, related, instances, name, node, {
        pivotTable: options.pivotTable,
        thisPivotKey: options.foreignPivotKey,
        relatedPivotKey: options.relatedPivotKey,
        localKey: options.localKey ?? model.primaryKeyColumn,
        relatedKey: options.relatedKey ?? related.primaryKeyColumn,
        withPivot: options.withPivot,
        withTimestamps: options.withTimestamps,
      });
    }

    case "morphToMany": {
      const related = definition.related() as unknown as ModelClass;
      const options = definition.options;

      return loadPivotRelation(model, related, instances, name, node, {
        pivotTable: options.pivotTable,
        thisPivotKey: options.morphId,
        relatedPivotKey: options.relatedPivotKey,
        localKey: options.localKey ?? model.primaryKeyColumn,
        relatedKey: options.relatedKey ?? related.primaryKeyColumn,
        morphType: options.morphType,
        // Discriminates THIS model. See MorphToManyOptions.
        morphValue: options.type ?? model.morphAlias(),
        withPivot: options.withPivot,
        withTimestamps: options.withTimestamps,
      });
    }

    case "morphedByMany": {
      const related = definition.related() as unknown as ModelClass;
      const options = definition.options;

      return loadPivotRelation(model, related, instances, name, node, {
        pivotTable: options.pivotTable,
        thisPivotKey: options.foreignPivotKey,
        relatedPivotKey: options.morphId,
        localKey: options.localKey ?? model.primaryKeyColumn,
        relatedKey: options.relatedKey ?? related.primaryKeyColumn,
        morphType: options.morphType,
        // Discriminates the RELATED model on this side.
        morphValue: options.type ?? related.morphAlias(),
        withPivot: options.withPivot,
        withTimestamps: options.withTimestamps,
      });
    }

    case "morphTo": {
      const { morphType, morphId } = definition.options;

      // Collected by the caller (see `resolveMorphSpec`), which needs it
      // whether or not this load step runs.
      const spec = morphSpec ?? new MorphToSpec();

      // The one relation that is NOT O(1) in queries. Every other type
      // batches to a constant count because it targets a single table;
      // a morphTo's parents live in different tables, so the best
      // possible is one query per DISTINCT discriminant present in this
      // page of rows, same as Laravel. Grouping first is what keeps it
      // O(distinct types) rather than O(rows).
      const idsByType = new Map<string, Set<unknown>>();

      for (const instance of instances) {
        const typeValue = instance.getRawAttribute(morphType);
        const idValue = instance.getRawAttribute(morphId);

        if (typeValue == null || idValue == null) {
          continue;
        }

        const bucket = idsByType.get(String(typeValue)) ?? new Set<unknown>();
        bucket.add(idValue);
        idsByType.set(String(typeValue), bucket);
      }

      // Keyed by `{type}\u0000{id}`, a composite, because ids are only
      // unique WITHIN a type. Post 1 and Video 1 are different parents,
      // and a plain id key would collide them.
      const byTypeAndId = new Map<string, Model>();

      for (const [typeValue, ids] of idsByType) {
        const related = resolveMorphType(typeValue, definition.options.types as any) as unknown as
          ModelClass | undefined;

        // An unresolvable discriminant attaches `undefined` rather than
        // throwing, stale `*_type` data behaves like a dangling FK,
        // matching the non-batched `morphTo()` helper.
        if (!related) {
          continue;
        }

        const ownerKey = definition.options.ownerKey ?? related.primaryKeyColumn;
        const query = related.query().whereIn(ownerKey, [...ids] as any);
        // Per-type constraint, if the callback registered one for this
        // discriminant. Types with no entry stay unconstrained.
        applyMorphConstraint(query, spec.constraintFor(typeValue), name);
        const rows = (await query.get()) as unknown as Collection<Model>;

        for (const row of rows) {
          byTypeAndId.set(`${typeValue}\u0000${String(row.getRawAttribute(ownerKey))}`, row);
        }
      }

      for (const instance of instances) {
        const typeValue = instance.getRawAttribute(morphType);
        const idValue = instance.getRawAttribute(morphId);
        instance.setRelation(
          name,
          typeValue == null || idValue == null
            ? undefined
            : byTypeAndId.get(`${String(typeValue)}\u0000${String(idValue)}`),
        );
      }

      return;
    }
  }
}

/**
 * The related model's builder with the node's constraining closure
 * applied, the `with({ comments: (q) => q.where("approved", 1) })` half.
 *
 * ## Why `limit()` is blocked rather than honoured
 *
 * The batched query fetches every parent's related rows in ONE statement,
 * so a `LIMIT` on it caps the whole batch, not each parent:
 * `.limit(3)` over 100 posts returns 3 comments *in total*, which almost
 * nobody means and which reads as "3 per post" at the call site.
 * Per-parent limits need window functions
 * (`ROW_NUMBER() OVER (PARTITION BY …)`), which this loader doesn't emit,
 * so it throws. Silently returning wrong rows is the one outcome worth
 * ruling out. It looks like it worked.
 *
 * `where()`/`orderBy()`/`whereIn()` etc. are all fine: they apply
 * row-wise, so batching doesn't change their meaning.
 */
function applyConstraint(builder: any, node: EagerLoadNode, relation: string): any {
  return applyMorphConstraint(builder, node.constrain, relation);
}

/** `applyConstraint` for a callback held somewhere other than `node.constrain`, the per-type morphTo case. */
function applyMorphConstraint(
  builder: any,
  constrain: ((query: any) => void) | undefined,
  relation: string,
): any {
  if (!constrain) {
    return builder;
  }

  for (const method of ["limit", "take", "offset", "skip"] as const) {
    builder[method] = (): never => {
      throw new Error(
        `with("${relation}"): ${method}() isn't supported inside an eager-load constraint. ` +
          `The relation is fetched for every parent in one batched query, so ${method}() would apply ` +
          `to the whole batch rather than per parent. Load the relation separately, or constrain it ` +
          `with where() instead.`,
      );
    };
  }

  constrain(builder);

  return builder;
}

/** The normalised shape of a pivot-backed relation for the batched loader, the loader-side twin of `model.ts`'s `PivotQuerySpec`. */
interface PivotLoadSpec {
  pivotTable: string;
  thisPivotKey: string;
  relatedPivotKey: string;
  localKey: string;
  relatedKey: string;
  morphType?: string;
  morphValue?: string;
  withPivot?: string[];
  withTimestamps?: boolean;
}

/**
 * Batch-loads `belongsToMany`/`morphToMany`/`morphedByMany` in **two**
 * queries regardless of instance count: one over the pivot table, one
 * over the related table. The three relations differ only in which pivot
 * column points where and whether a discriminant filters the pivot read,
 * so they share this implementation.
 *
 * ## Why pivot columns force per-parent instances
 *
 * Without pivot columns, one related instance can be shared by every
 * parent that links to it. They're identical. With them it cannot: the
 * *same* tag attached to two posts carries a different `weight` for each,
 * so a shared instance would show one parent the other's pivot data.
 * When pivot columns are requested, each attachment therefore gets its
 * own hydrated instance carrying its own pivot values.
 */
async function loadPivotRelation(
  model: ModelClass,
  related: ModelClass,
  instances: Model[],
  name: string,
  node: EagerLoadNode,
  spec: PivotLoadSpec,
): Promise<void> {
  const columns = pivotColumns(spec);

  const localIds = uniqueDefined(instances.map((i) => i.getRawAttribute(spec.localKey)));

  if (localIds.length === 0) {
    for (const instance of instances) {
      instance.setRelation(name, Collection.make<Model>([]));
    }

    return;
  }

  let pivotQuery = model
    .resolveConnection()
    .selectFrom(spec.pivotTable)
    .select([spec.thisPivotKey, spec.relatedPivotKey, ...columns])
    .where(spec.thisPivotKey, "in", localIds);

  if (spec.morphType) {
    pivotQuery = pivotQuery.where(spec.morphType as any, "=", spec.morphValue as any);
  }

  const pivotRows = (await pivotQuery.execute()) as Record<string, any>[];

  const relatedIds = uniqueDefined(pivotRows.map((r) => r[spec.relatedPivotKey]));
  const relatedRows =
    relatedIds.length === 0
      ? Collection.make<Model>([])
      : ((await applyConstraint(
          related.query().whereIn(spec.relatedKey, relatedIds),
          node,
          name,
        ).get()) as unknown as Collection<Model>);
  const relatedByKey = relatedRows.keyBy((r) => String(r.getRawAttribute(spec.relatedKey)));

  const grouped = new Map<string, Record<string, any>[]>();

  for (const pivotRow of pivotRows) {
    const key = String(pivotRow[spec.thisPivotKey]);
    const list = grouped.get(key) ?? [];
    list.push(pivotRow);
    grouped.set(key, list);
  }

  for (const instance of instances) {
    const rowsForParent = grouped.get(String(instance.getRawAttribute(spec.localKey))) ?? [];
    const attached: Model[] = [];

    for (const pivotRow of rowsForParent) {
      const relatedInstance = relatedByKey.get(String(pivotRow[spec.relatedPivotKey]));

      if (!relatedInstance) {
        continue;
      }

      if (columns.length === 0) {
        attached.push(relatedInstance);
        continue;
      }

      // Re-hydrate per attachment so each carries its own pivot values.
      // See this function's docstring.
      const pivotAttributes: Record<string, any> = {};

      for (const column of columns) {
        pivotAttributes[`${PIVOT_PREFIX}${column}`] = pivotRow[column];
      }

      attached.push(related.hydrate({ ...relatedInstance.toObject(), ...pivotAttributes }));
    }

    instance.setRelation(name, Collection.make<Model>(attached));
  }
}

function uniqueDefined(values: unknown[]): unknown[] {
  const seen = new Set<unknown>();
  const result: unknown[] = [];

  for (const value of values) {
    if (value === null || value === undefined || seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}
