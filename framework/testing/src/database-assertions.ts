import type { Application } from "@mahiframework/core";
import { DATABASE_TOKEN, DatabaseManager } from "@mahiframework/database";

/**
 * A set of column/value equality constraints for a database assertion,
 * the TS analog of Laravel's `assertDatabaseHas($table, [...])` array. Each
 * key is a column name; each value is matched with `=` (or `is null` when
 * the value is `null`).
 */
export type DatabaseCriteria = Record<string, unknown>;

function kysely(app: Application) {
  return app.make<DatabaseManager>(DATABASE_TOKEN).driver().kysely;
}

/**
 * Count rows in `table` matching every column/value pair in `criteria`.
 * Exposed as its own function so a test can make a plain numeric assertion
 * (`expect(await countDatabaseRows(app, "posts", { author_id })).toBe(3)`)
 * when a boolean has/missing isn't quite enough.
 */
export async function countDatabaseRows(
  app: Application,
  table: string,
  criteria: DatabaseCriteria = {},
): Promise<number> {
  let query = kysely(app)
    .selectFrom(table)
    .select((eb) => eb.fn.countAll().as("count"));

  for (const [column, value] of Object.entries(criteria)) {
    query = value === null ? query.where(column, "is", null) : query.where(column, "=", value);
  }

  const row = (await query.executeTakeFirst()) as { count: number | bigint } | undefined;

  return Number(row?.count ?? 0);
}

/**
 * Assert at least one row in `table` matches every column/value pair in
 * `criteria`, the direct-DB equivalent of Laravel's `assertDatabaseHas`,
 * for asserting persisted state independent of what any API response body
 * claims (e.g. an internal `deleted_at`/`retry_count` column no endpoint
 * exposes). Throws a plain `Error` on failure so it stays runner-agnostic;
 * call it from a vitest test like any other `await`.
 *
 *   await assertDatabaseHas(app, "posts", { id: post.id, body: "Hello" });
 *   await assertDatabaseHas(app, "posts", { id: post.id, deleted_at: null });
 */
export async function assertDatabaseHas(
  app: Application,
  table: string,
  criteria: DatabaseCriteria,
): Promise<void> {
  const count = await countDatabaseRows(app, table, criteria);

  if (count === 0) {
    throw new Error(
      `Failed asserting that table [${table}] contains a row matching ${JSON.stringify(criteria)}. ` +
        `Found 0 matching rows.`,
    );
  }
}

/**
 * Assert **no** row in `table` matches every column/value pair in
 * `criteria`, the direct-DB equivalent of Laravel's
 * `assertDatabaseMissing`. Throws a plain `Error` (reporting how many rows
 * matched) on failure.
 *
 *   await assertDatabaseMissing(app, "posts", { id: deletedPost.id });
 */
export async function assertDatabaseMissing(
  app: Application,
  table: string,
  criteria: DatabaseCriteria,
): Promise<void> {
  const count = await countDatabaseRows(app, table, criteria);

  if (count > 0) {
    throw new Error(
      `Failed asserting that table [${table}] does not contain a row matching ${JSON.stringify(criteria)}. ` +
        `Found ${count} matching row(s).`,
    );
  }
}

/**
 * Assert `table` holds exactly `expected` rows in total (no `criteria`,
 * the whole table), the equivalent of Laravel's `assertDatabaseCount`.
 */
export async function assertDatabaseCount(
  app: Application,
  table: string,
  expected: number,
): Promise<void> {
  const count = await countDatabaseRows(app, table);

  if (count !== expected) {
    throw new Error(
      `Failed asserting that table [${table}] has ${expected} row(s). Found ${count}.`,
    );
  }
}

/**
 * The shape `assertSoftDeleted`/`assertNotSoftDeleted` accept in place of
 * a table name, satisfied by any model class, without `@mahiframework/testing`
 * depending on the model type itself.
 */
export interface SoftDeletableModel {
  readonly table: string;
  readonly softDeleteColumn?: string | undefined;
}

/** `"posts"` or `Post` → the table name and the column it soft-deletes into. */
function resolveSoftDelete(target: string | SoftDeletableModel): {
  table: string;
  column: string;
} {
  if (typeof target === "string") {
    return { table: target, column: "deleted_at" };
  }

  const column = target.softDeleteColumn;

  if (column === undefined) {
    throw new Error(
      `Model for table [${target.table}] does not use soft deletes, so it can never be soft-deleted. ` +
        `Configure \`softDeletes: true\` on the model, or assert with assertDatabaseMissing() instead.`,
    );
  }

  return { table: target.table, column };
}

/**
 * Assert a row exists **and** has been soft-deleted, Laravel's
 * `assertSoftDeleted`.
 *
 *   await assertSoftDeleted(app, Post, { id: post.id });
 *   await assertSoftDeleted(app, "posts", { id: post.id });
 *
 * Distinct from `assertDatabaseMissing()`, which passes whether the row
 * was soft-deleted, hard-deleted, or never written, so it cannot tell a
 * working soft delete from a destructive one. This asserts both halves:
 * the row is still there, and its delete column is set.
 *
 * Pass the **model** rather than a table name where possible. A bare
 * string has to assume the column is `deleted_at`, which silently
 * mis-asserts on a model configured otherwise; a model class knows its own
 * column and throws if it does not soft-delete at all.
 */
export async function assertSoftDeleted(
  app: Application,
  target: string | SoftDeletableModel,
  criteria: DatabaseCriteria = {},
): Promise<void> {
  const { table, column } = resolveSoftDelete(target);
  const matching = await countDatabaseRows(app, table, criteria);

  if (matching === 0) {
    throw new Error(
      `Failed asserting that table [${table}] contains a soft-deleted row matching ` +
        `${JSON.stringify(criteria)}. Found no row at all — a hard delete would also look like this.`,
    );
  }

  const deleted = await countDatabaseRows(app, table, { ...criteria, [column]: null });

  if (deleted === matching) {
    throw new Error(
      `Failed asserting that table [${table}] contains a soft-deleted row matching ` +
        `${JSON.stringify(criteria)}. Found ${matching} matching row(s), but [${column}] is null on all of them.`,
    );
  }
}

/**
 * Assert a row exists and has **not** been soft-deleted, Laravel's
 * `assertNotSoftDeleted`.
 *
 * The counterpart to `assertSoftDeleted()`, and the one that catches an
 * over-eager cascade: a row that should have survived someone else's
 * delete.
 */
export async function assertNotSoftDeleted(
  app: Application,
  target: string | SoftDeletableModel,
  criteria: DatabaseCriteria = {},
): Promise<void> {
  const { table, column } = resolveSoftDelete(target);
  const matching = await countDatabaseRows(app, table, criteria);

  if (matching === 0) {
    throw new Error(
      `Failed asserting that table [${table}] contains a live row matching ` +
        `${JSON.stringify(criteria)}. Found no row at all.`,
    );
  }

  const live = await countDatabaseRows(app, table, { ...criteria, [column]: null });

  if (live === 0) {
    throw new Error(
      `Failed asserting that table [${table}] contains a live row matching ` +
        `${JSON.stringify(criteria)}. Found ${matching} matching row(s), but [${column}] is set on all of them.`,
    );
  }
}
