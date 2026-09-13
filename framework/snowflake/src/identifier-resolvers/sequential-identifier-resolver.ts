import type { IdentifierResolver } from "./identifier-resolver.js";

/**
 * Predictable, sequential IDs of realistic snowflake length, for tests
 * that want auto-increment-like values without giving up the 19-digit
 * string width JSON serialization requires.
 *
 * IDs are grouped by the `$group` argument (the model class name when
 * used via `HasSnowflake`), so `Product.create()` and `User.create()`
 * each start at `9000000000000000001` independently.
 */
export class SequentialIdentifierResolver implements IdentifierResolver {
  static readonly START_ID = 9000000000000000000n;

  protected models = new Map<string, bigint>();

  /**
   * Reset recorded counters, e.g. after truncating a table, so the
   * next test ID starts from `START_ID + 1` again.
   */
  reset(): void {
    this.models.clear();
  }

  identifier(_time: number, _sequence: number, group?: string | null): bigint {
    const key = group ?? "";
    const next = (this.models.get(key) ?? SequentialIdentifierResolver.START_ID) + 1n;
    this.models.set(key, next);

    return next;
  }
}
