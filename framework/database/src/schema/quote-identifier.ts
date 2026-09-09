/**
 * Quote a SQL identifier (table, column, index name) for interpolation
 * into a raw DDL string, doubling any embedded quote character so the
 * identifier can't break out of its quoting.
 *
 * These are used only where a statement has to be assembled with
 * `sql.raw` — Kysely's builder quotes identifiers itself, but a handful
 * of DDL shapes (schema-qualified `DROP TABLE ... CASCADE`, MySQL
 * `DROP FOREIGN KEY`, `CREATE FULLTEXT INDEX`) have no builder and must
 * be emitted raw. Identifiers there still come from migration code rather
 * than request input, so this is defence in depth, not a request-facing
 * injection fix — but an unescaped `"` or `` ` `` in a table name would
 * otherwise produce broken or dangerous SQL.
 */

/** Quote with ANSI double quotes (Postgres, SQLite): `foo"bar` -> `"foo""bar"`. */
export function quoteDoubleQuoted(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote with MySQL backticks: `` foo`bar `` -> `` `foo``bar` ``. */
export function quoteBacktick(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}
