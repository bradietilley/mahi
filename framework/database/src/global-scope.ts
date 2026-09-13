import type { EloquentBuilder } from "./eloquent-builder.js";

/**
 * A cross-cutting default filter applied automatically to every `query()`
 * call for a `Model` subclass that declares it, `SoftDeletes`'s
 * `deleted_at IS NULL` filter is the primary/motivating use case (see
 * `soft-deletes.ts` / `softDeletes: true`), but the mechanism is general (multi-tenancy
 * `tenant_id = ?`, publish-state `published = true`, etc).
 *
 * `apply()` mutates the given builder in place (matching
 * `EloquentBuilder`'s own mutate-and-return-`this` chainable style).
 * No return value.
 */
export interface GlobalScope<TRow extends Record<string, any> = any> {
  apply(builder: EloquentBuilder<TRow>): void;
}
