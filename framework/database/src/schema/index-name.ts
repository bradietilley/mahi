/**
 * Laravel's `Blueprint::createIndexName`:
 * `strtolower(table_col1_col2_type)` with `-`/`.` replaced by `_`.
 */
export function createIndexName(table: string, type: string, columns: string[]): string {
  const index = `${table}_${columns.join("_")}_${type}`.toLowerCase();

  return index.replace(/[-.]/g, "_");
}
