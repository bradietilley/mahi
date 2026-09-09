import type { Kysely, Transaction } from "kysely";
import { Manager, type Application } from "@mahi/core";
import type { DatabaseDriver } from "./drivers/driver.js";
import { QueryBuilder } from "./query-builder.js";
import { SchemaBuilder } from "./schema/schema-builder.js";
import { transaction } from "./transaction.js";
import { getActiveTransaction } from "./transaction-context.js";

/**
 * A single connection's config. The only field the framework itself reads
 * is `driver` — which built-in (or plugin-registered) driver builds this
 * connection. Everything else (`filename`, `host`, `database`, ...) is
 * passed straight to that driver's constructor.
 *
 * `driver` may be omitted when the connection's *name* is the driver
 * type — the `connections: { sqlite: { ... } }` shorthand, the same
 * convention `AuthManager.guardDriver()` follows for guards.
 */
export interface ConnectionConfig {
  driver?: string;
  [key: string]: unknown;
}

export interface DatabaseConfig {
  default: string;
  connections: Record<string, ConnectionConfig>;
}

/**
 * Resolves named database connections. The "default" connection is just
 * the one used when `driver()`/`connection()` is called without an
 * explicit name — other named connections can be resolved and used
 * simultaneously (e.g. a secondary analytics sqlite file).
 *
 * Built-in drivers are registered via `extend()` by
 * DatabaseServiceProvider, exactly the same way a plugin would register an
 * additional connection type — no string-to-method dispatch magic.
 */
export class DatabaseManager extends Manager<DatabaseDriver> {
  constructor(
    app: Application,
    private config: DatabaseConfig,
  ) {
    super(app);
  }

  getDefaultDriver(): string {
    return this.config.default;
  }

  /** Domain-flavored alias for `driver()` — reads more naturally for DB code. */
  connection(name?: string): DatabaseDriver {
    return this.driver(name);
  }

  /** Schema builder for the given connection (default if omitted). */
  schema(name?: string): SchemaBuilder {
    const driver = this.driver(name);

    return new SchemaBuilder(driver.kysely, driver.dialect);
  }

  connectionConfig(name: string): ConnectionConfig {
    const config = this.config.connections[name];

    if (!config) {
      throw new Error(`Database connection "${name}" is not configured.`);
    }

    return config;
  }

  /** Every configured connection name. */
  connectionNames(): string[] {
    return Object.keys(this.config.connections);
  }

  /**
   * The driver *type* for a connection — its `driver` field, or the
   * connection name itself when `driver` is omitted (the name-equals-driver
   * shorthand).
   */
  driverType(name: string): string {
    return this.connectionConfig(name).driver ?? name;
  }

  /**
   * A `QueryBuilder` bound to `name` — the model-free entry point into the
   * low-level builder, Laravel's `DB::table()`. No `Model` involved, so no
   * hydration into instances, no casts, no lifecycle events, no relations
   * (`with()`/`whereHas()`), and **no global scopes** — a `SoftDeletes`
   * model's rows come back including the soft-deleted ones. Reach for
   * `Model.query()` whenever a model for the table exists; reach here for
   * tables that have no model (pivots, reporting views, ad-hoc reads).
   *
   *   await DB.table("users").count();
   *   await DB.table("users").where("first_name", "John").get();
   *
   * `TRow` defaults to `Record<string, any>` (every column is `any`);
   * supply it to get the same column/value checking a model builder has:
   *
   *   await DB.table<UserTable>("users").where("first_name", "John").get();
   *
   * See `queryConnection()` for how the connection is resolved, including
   * the deliberate difference between naming one and not.
   */
  table<TRow extends Record<string, any> = Record<string, any>>(
    name: string,
    connection?: string,
  ): QueryBuilder<TRow> {
    return new QueryBuilder<TRow>(this.queryConnection(connection), name);
  }

  /**
   * A `QueryBuilder` with **no table bound yet** — Laravel's `DB::query()`.
   * Call `.table(name)` before any terminal, or that terminal throws
   * ("no table bound"). `DB.table(name)` is the direct form and is what
   * you want unless the table genuinely isn't known at construction.
   *
   * Note `QueryBuilder.table()` returns `QueryBuilder<Record<string, any>>`
   * rather than `this` (switching tables invalidates the row type), so a
   * `TRow` passed here is discarded by the `.table()` call that follows —
   * `DB.table<UserTable>("users")` is the typed path, not
   * `DB.query<UserTable>().table("users")`.
   */
  query<TRow extends Record<string, any> = Record<string, any>>(
    connection?: string,
  ): QueryBuilder<TRow> {
    return new QueryBuilder<TRow>(this.queryConnection(connection), "");
  }

  /**
   * The connection thunk handed to builders from `table()`/`query()`.
   * Lazy on purpose: `QueryBuilder` calls it fresh at every terminal
   * (`get()`/`count()`/`insert()`/...), never at construction, so a
   * builder created before a transaction opens still executes inside it.
   *
   * Named or not, the connection is resolved first and any active
   * transaction looked up **by that connection** (see
   * `transaction-context.ts`), identical to `Model.resolveConnection()`.
   * So `DB.table("users").insert(...)` inside a `DB.transaction()`
   * participates in that transaction and rolls back with it, exactly
   * like a static `Model` call would — and `DB.table("events",
   * "analytics")` inside `DB.transaction(cb, "analytics")` joins the
   * analytics transaction, while a *default*-connection query inside it
   * correctly does not.
   */
  private queryConnection(name?: string): () => Kysely<any> {
    return () => {
      const connection = this.connection(name).kysely;

      return getActiveTransaction(connection) ?? connection;
    };
  }

  /**
   * Convenience wrapper over the standalone `transaction()` helper,
   * resolving the driver (default, or `driverName` if given) for you.
   * Equivalent to `transaction(this.driver(driverName).kysely, callback)`.
   * Static `Model` calls (`Todo.create(...)`, etc.) made inside the
   * callback automatically participate — see `transaction()`'s docstring.
   */
  async transaction<T>(
    callback: (trx: Transaction<any>) => Promise<T>,
    driverName?: string,
  ): Promise<T> {
    return transaction(this.driver(driverName).kysely, callback);
  }
}
