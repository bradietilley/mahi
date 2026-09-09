/**
 * Soft deletes are configuration now — `Model<A>()({ softDeletes: true })`
 * (or `{ column }`) installs the global scope and enables the builder /
 * instance soft-delete behaviour. This module re-exports the scope class
 * for `withoutGlobalScope(SoftDeleteScope)` and documents the surface.
 *
 *   interface TodoAttributes {
 *     id: string; title: string;
 *     deleted_at: DateTime | null;   // required nullable column
 *   }
 *
 *   class Todo extends Model<TodoAttributes>()({ table: "todos", softDeletes: true }) {}
 *
 *   await todo.delete();               // soft delete — sets deleted_at
 *   await Todo.all();                  // excludes soft-deleted rows automatically
 *   await Todo.withTrashed().get();    // includes them
 *   await todo.restore();              // un-deletes
 *   await todo.forceDelete();          // permanent delete
 *
 * The runtime scope lives in `soft-delete-support.ts` (the import-free
 * module) so the model factory can install it without a cycle; it is
 * re-exported here under the historical name.
 */

export { ConfigSoftDeleteScope as SoftDeleteScope } from "./soft-delete-support.js";
