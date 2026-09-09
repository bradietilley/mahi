import { createPool, type Pool } from "mysql2";
import { Kysely, MysqlDialect, sql } from "kysely";
import type { Dialect } from "../schema/dialect.js";
import type { DatabaseDriver } from "./driver.js";
import { errorTranslatingDialect } from "./error-translating-dialect.js";

export interface MysqlConnectionConfig {
  host?: string;
  port?: number;
  database: string;
  username?: string;
  password?: string;
  /** Unix socket path — used in preference to host/port when set. */
  socketPath?: string;
  charset?: string;
  /** Max pooled connections. Defaults to mysql2's own default (10). */
  connectionLimit?: number;
  /**
   * Extra mysql2 pool options passed through verbatim (SSL, timezone,
   * flags, ...). Anything set here overrides the mapped fields above.
   */
  options?: Record<string, unknown>;
}

/**
 * MySQL (and MariaDB) connection backed by a `mysql2` pool and Kysely's
 * `MysqlDialect`. Unlike SQLite this is genuinely async: the pool warms up
 * lazily and must be drained on shutdown, so this driver implements
 * `Connectable` (`connect`/`disconnect`) — `connect()` issues a trivial
 * round-trip to surface a bad host/credentials at boot rather than on the
 * first query, and `disconnect()` ends the pool.
 *
 * ## Value handling
 *
 * Three pool options below exist to make values round-trip identically
 * to SQLite rather than to mysql2's defaults, and are deliberately not
 * left to the caller:
 *
 * - `dateStrings: true` — mysql2 otherwise parses `DATE`/`DATETIME`/
 *   `TIMESTAMP` into a JS `Date` **using the process's local timezone**,
 *   so a row stored as `07:31:37` UTC comes back shifted by the server's
 *   `TZ` (8 hours under `TZ=Asia/Shanghai`) and re-saving it writes the
 *   shifted value back. Keeping them as strings makes the column a plain
 *   `"YYYY-MM-DD HH:MM:SS"`, which is what the SQLite driver already
 *   yields and what `DateTimeCast` reads.
 * - `timezone: "Z"` — the zone mysql2 interprets outbound `Date` values
 *   in. The framework writes pre-formatted UTC strings (see
 *   `formatTimestamp()`), but an application passing a raw `Date`
 *   through `DB.table(...).insert()` would otherwise have it converted
 *   in local time.
 * - `supportBigNumbers`/`bigNumberStrings` — without these, a `BIGINT`
 *   beyond 2^53 is silently rounded on the way out
 *   (`9007199254740993` → `9007199254740992`). `bigNumberStrings:
 *   false` keeps ordinary ids as numbers and only widens to a string
 *   when the value genuinely does not fit, so the common case is
 *   unchanged.
 *
 * All of them can still be overridden through `options`, which is merged
 * last.
 */
export class MysqlDriver<DB = any> implements DatabaseDriver<DB> {
  readonly dialect: Dialect = "mysql";
  readonly kysely: Kysely<DB>;
  private readonly pool: Pool;

  constructor(config: MysqlConnectionConfig) {
    this.pool = createPool({
      host: config.host ?? "127.0.0.1",
      port: config.port ?? 3306,
      database: config.database,
      user: config.username ?? "root",
      password: config.password ?? "",
      ...(config.socketPath ? { socketPath: config.socketPath } : {}),
      ...(config.charset ? { charset: config.charset } : {}),
      ...(config.connectionLimit ? { connectionLimit: config.connectionLimit } : {}),
      // See the class docstring — these three keep dates and big
      // integers round-tripping the way the rest of the framework
      // expects, rather than mysql2's local-timezone/lossy defaults.
      dateStrings: true,
      timezone: "Z",
      supportBigNumbers: true,
      bigNumberStrings: false,
      ...(config.options ?? {}),
    });

    this.kysely = new Kysely<DB>({
      dialect: errorTranslatingDialect(new MysqlDialect({ pool: this.pool }), "mysql"),
    });
  }

  async connect(): Promise<void> {
    // Force a real connection now so misconfiguration fails at boot.
    await sql`SELECT 1`.execute(this.kysely);
  }

  async disconnect(): Promise<void> {
    await this.kysely.destroy();
  }
}
