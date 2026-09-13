import type { Transaction } from "kysely";
import { Facade } from "@mahiframework/facades";
import { DATABASE_TOKEN } from "@mahiframework/core";
import type { DatabaseManager } from "./database-manager.js";
import type { DatabaseDriver } from "./drivers/driver.js";
import type { QueryBuilder } from "./query-builder.js";
import type { SchemaBuilder } from "./schema/schema-builder.js";

/**
 * Thin facade over the `DatabaseManager` singleton bound at
 * `DATABASE_TOKEN`, for call sites that would otherwise read
 * `app().make<DatabaseManager>(DATABASE_TOKEN).transaction(...)`.
 *
 *   await DB.table("users").count();
 *   await DB.table("users").where("first_name", "John").get();
 *   await DB.transaction(async (trx) => { ... });
 *   const kysely = DB.connection().kysely;   // raw Kysely
 *   DB.connection("analytics");              // a secondary connection
 *
 * Named `DB` (not `Database`) to match Laravel's `DB` facade. This wraps
 * the connection MANAGER, for model reads/writes prefer the Active-Record
 * `Model` API; reach here for model-free table queries (`table()`), raw
 * Kysely access, secondary connections, or an explicit `transaction()`
 * boundary around static `Model` calls.
 *
 * Prefer constructor-injecting `DatabaseManager` (via `DATABASE_TOKEN`)
 * where that's practical (e.g. inside a `ServiceProvider`/`Command` that
 * already receives `app`), use this only where threading
 * `app`/`DatabaseManager` through is genuinely inconvenient, same guidance
 * as `app()` itself.
 */
export class DB extends Facade<DatabaseManager>(() => DATABASE_TOKEN) {
  /** The named connection (default if omitted). Laravel's `DB::connection()`. */
  static connection(name?: string): DatabaseDriver {
    return this.instance().connection(name);
  }

  /** Schema builder for the named connection (default if omitted). */
  static schema(name?: string): SchemaBuilder {
    return this.instance().schema(name);
  }

  /**
   * A model-free `QueryBuilder` bound to `name`, Laravel's `DB::table()`.
   *
   *   await DB.table("users").count();
   *   await DB.table<UserTable>("users").where("first_name", "John").get();
   *
   * Unnamed connection: joins an enclosing `DB.transaction()`. Named:
   * resolves that connection directly, ignoring the transaction context.
   * No hydration, no casts, no events, no relations, no global scopes.
   * See `DatabaseManager.table()`.
   */
  static table<TRow extends Record<string, any> = Record<string, any>>(
    name: string,
    connection?: string,
  ): QueryBuilder<TRow> {
    return this.instance().table<TRow>(name, connection);
  }

  /**
   * A `QueryBuilder` with no table bound yet, Laravel's `DB::query()`.
   * Call `.table(name)` before any terminal. Prefer `DB.table(name)`;
   * see `DatabaseManager.query()` for why this one can't stay typed.
   */
  static query<TRow extends Record<string, any> = Record<string, any>>(
    connection?: string,
  ): QueryBuilder<TRow> {
    return this.instance().query<TRow>(connection);
  }

  /**
   * Run `callback` in a transaction on the named (default) connection,
   * static `Model` calls made inside automatically participate. See
   * `DatabaseManager.transaction()`.
   */
  static transaction<T>(
    callback: (trx: Transaction<any>) => Promise<T>,
    connectionName?: string,
  ): Promise<T> {
    return this.instance().transaction(callback, connectionName);
  }
}
