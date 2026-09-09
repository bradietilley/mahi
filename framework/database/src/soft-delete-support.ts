import type { GlobalScope } from "./global-scope.js";
import type { EloquentBuilder } from "./eloquent-builder.js";

/**
 * The shape `SoftDeletes`' global scope exposes so the rest of the ORM
 * can recognise "this model soft-deletes, and here is the column" without
 * importing `soft-deletes.ts`.
 *
 * That import would be a cycle: `soft-deletes.ts` needs `Model` (it
 * defines statics whose `this` is the model class), while `model.ts` and
 * `eloquent-builder.ts` need to *ask* whether soft deletes are in play —
 * `EloquentBuilder.delete()` has to know whether to emit `DELETE` or
 * `UPDATE ... SET deleted_at`, and the instance-side `trashed()`/
 * `restore()`/`forceDelete()` need the column name. Declaring the
 * contract here, in a module that imports nothing but a type, lets both
 * sides depend on it instead of on each other.
 */
export interface SoftDeleteScopeLike extends GlobalScope {
  /** The nullable timestamp column a soft delete writes to. */
  readonly deletedAtColumn: string;
}

/**
 * The soft-delete scope among a model's declared `scopes`, or
 * `undefined` for a model that doesn't soft-delete.
 *
 * Structural, not an `instanceof` check, so an application that writes
 * its own soft-delete scope (a different column, an extra condition)
 * gets the same builder behaviour by declaring `deletedAtColumn` on it —
 * and so this module stays free of the import it exists to avoid.
 */
export function findSoftDeleteScope(
  scopes: readonly GlobalScope[],
): SoftDeleteScopeLike | undefined {
  return scopes.find(
    (scope): scope is SoftDeleteScopeLike =>
      typeof (scope as Partial<SoftDeleteScopeLike>).deletedAtColumn === "string",
  );
}

/**
 * The `deleted_at IS NULL` global scope installed by `softDeletes: true`
 * (or `{ column }`) config. Lives here — the import-free support module —
 * so the model factory can install it without importing `soft-deletes.ts`
 * (which imports `Model`, a cycle). The column is qualified with the
 * model's table so it survives joins against another soft-deletable table
 * or a timestamped pivot.
 */
export class ConfigSoftDeleteScope implements SoftDeleteScopeLike {
  constructor(readonly deletedAtColumn: string) {}

  apply(builder: EloquentBuilder<any>): void {
    builder.whereNull(`${builder.getModel().table}.${this.deletedAtColumn}`);
  }
}
