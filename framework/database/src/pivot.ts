/**
 * Column-name prefix for pivot values projected into a joined SELECT.
 *
 * A pivot join mixes two tables into one row, so `created_at` could mean
 * either side's. Every requested pivot column is therefore aliased
 * `pivot__{column}` and stripped back off at hydration, which keeps the
 * related model's own attributes exactly what its table declares.
 *
 * The prefix is explicit and documented rather than defended against: a
 * related table with a real `pivot__x` column would collide, but that is
 * a caller error, visible at hydration.
 */
export const PIVOT_PREFIX = "pivot__";

/** The pivot columns to project for a relation, with `withTimestamps` folded in and duplicates removed. */
export function pivotColumns(options: {
  withPivot?: string[];
  withTimestamps?: boolean;
}): string[] {
  const requested = [...(options.withPivot ?? [])];

  if (options.withTimestamps) {
    requested.push("created_at", "updated_at");
  }

  return [...new Set(requested)];
}

/** Whether a relation asked for any pivot data, the switch between the join and subquery compilations. */
export function wantsPivot(options: { withPivot?: string[]; withTimestamps?: boolean }): boolean {
  return pivotColumns(options).length > 0;
}

/** `["weight"]` -> `["taggables.weight as pivot__weight"]`, the projection list for a pivot join. */
export function pivotSelections(pivotTable: string, columns: string[]): string[] {
  return columns.map((column) => `${pivotTable}.${column} as ${PIVOT_PREFIX}${column}`);
}
