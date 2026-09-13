import type { Kysely } from "kysely";
import type { Connectable } from "@mahiframework/core";
import type { Dialect } from "../schema/dialect.js";

/**
 * A DatabaseDriver wraps a Kysely instance for one connection. `connect`/
 * `disconnect` are optional (the `Connectable` contract from
 * @mahiframework/core), implement them only if the underlying driver needs
 * genuine async warm-up/teardown. SqliteDriver does not need them since
 * better-sqlite3 connects synchronously at construction time; the MySQL
 * and Postgres drivers do (their pools warm up / drain asynchronously).
 *
 * `dialect` tells the schema layer which `SchemaGrammar` to compile
 * Blueprints with, SQLite, MySQL and Postgres spell DDL differently.
 */
export interface DatabaseDriver<DB = any> extends Partial<Connectable> {
  readonly kysely: Kysely<DB>;
  readonly dialect: Dialect;
}
