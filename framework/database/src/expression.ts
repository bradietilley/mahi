import { sql, type Expression as KyselyExpression } from "kysely";
import type { SqlBinding } from "./query-builder.js";

/**
 * A raw SQL fragment that can be passed anywhere this framework accepts
 * a value or subquery. This framework's port of Laravel's
 * `Illuminate\Database\Query\Expression` (constructed via `DB::raw()`).
 *
 * Unlike `whereRaw()`/`selectRaw()`/`orderByRaw()` (this framework's own
 * `?`-placeholder-string-plus-bindings methods, each bolted onto a
 * specific clause), an `Expression` is a standalone, reusable **value**,
 * the same shape a `QueryBuilder` subquery result is unwrapped to
 * internally, so anywhere a method accepts a subquery (`whereIn()`,
 * `whereExists()`, ...) it can accept a raw `Expression` instead,
 * matching Laravel's own `whereIn($column, $values)` accepting a
 * `Closure|Builder|Expression`.
 *
 * Like every other raw-SQL entry point in this framework, `?`
 * placeholders in `sqlText` are matched positionally against `bindings`
 * and always sent as real parameters, never string-interpolated.
 * `Expression` is a typed wrapper around that convention, not a
 * different (unsafe) one.
 *
 *   builder.whereIn("id", () => Expression.raw("select post_id from post_hashtag where hashtag_id = ?", [tagId]));
 */
export class Expression<T = unknown> {
  private constructor(private readonly compiled: KyselyExpression<T>) {}

  /** Builds an `Expression` from a `?`-placeholder SQL string and its positional bindings, matches `whereRaw()`'s convention. */
  static raw<T = unknown>(sqlText: string, bindings: SqlBinding[] = []): Expression<T> {
    const fragments = sqlText.split("?");

    if (fragments.length - 1 !== bindings.length) {
      throw new Error(
        `Expression.raw(): ${bindings.length} binding(s) provided but the SQL has ${fragments.length - 1} "?" placeholder(s).`,
      );
    }

    return new Expression<T>(sql(fragments as unknown as TemplateStringsArray, ...bindings));
  }

  /** Escape hatch, the underlying Kysely `Expression`, for `QueryBuilder` internals to compile against. Not part of the public "no Kysely syntax" surface; app code should never need this. */
  toKysely(): KyselyExpression<T> {
    return this.compiled;
  }
}
