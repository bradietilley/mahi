import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Dialect } from "../schema/dialect.js";
import type { DatabaseDriver } from "./driver.js";
import { errorTranslatingDialect } from "./error-translating-dialect.js";

export interface SqliteConnectionConfig {
  /** Path to the sqlite file, or ":memory:" for an in-memory database. */
  filename: string;

  /**
   * How long a blocked writer waits for the lock, in milliseconds.
   *
   * Defaults to 5000. **Sqlite's own default is 0**, which means a second
   * process attempting to write while another holds the lock fails
   * immediately with `SQLITE_BUSY` rather than waiting — and since WAL still
   * permits only one writer at a time, that is not an exotic condition, it is
   * what two concurrent writes look like.
   *
   * The failure is also silent in the shape that matters: the losing process
   * gets an exception it may well be swallowing, so the symptom is missing
   * data rather than an error. Set to 0 to restore sqlite's behaviour.
   */
  busyTimeout?: number;
}

/**
 * better-sqlite3 is a fully synchronous driver (no async API at all), so
 * construction here is synchronous and there is no `connect()` —
 * the handle is open the moment the constructor returns, so there is
 * nothing to warm up and nothing for `DatabaseServiceProvider.boot()` to
 * await.
 *
 * `disconnect()` is a different matter and IS implemented: an open sqlite
 * handle is an OS file descriptor plus a WAL file, and leaving it dangling
 * on shutdown means the WAL is not checkpointed back into the database
 * file and (on Windows) the file stays locked. Called by
 * `DatabaseServiceProvider.shutdown()`.
 */
export class SqliteDriver<DB = any> implements DatabaseDriver<DB> {
  readonly dialect: Dialect = "sqlite";
  readonly kysely: Kysely<DB>;
  private readonly db: BetterSqlite3.Database;

  constructor(config: SqliteConnectionConfig) {
    this.db = new BetterSqlite3(config.filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // WAL lets readers and a writer coexist, but still only ONE writer — so
    // without a busy timeout a second concurrent write fails instantly.
    this.db.pragma(`busy_timeout = ${config.busyTimeout ?? 5000}`);

    this.kysely = new Kysely<DB>({
      dialect: errorTranslatingDialect(new SqliteDialect({ database: this.db }), "sqlite"),
    });
  }

  /**
   * Close the underlying better-sqlite3 handle (via Kysely's `destroy()`,
   * which the SqliteDialect wires to `database.close()`), checkpointing
   * and releasing the WAL. Every query after this throws
   * "The database connection is closed" — which is the point: a
   * terminated application should be discarded, not reused.
   *
   * Idempotent, because shutdown is best-effort and a second
   * `terminate()` (or a test's `cleanup()` after an explicit close) must
   * not turn into an error. Kysely's own `destroy()` is not: it throws
   * `TypeError: db.prepare is not a function` on the second call.
   */
  async disconnect(): Promise<void> {
    if (!this.db.open) {
      return;
    }

    await this.kysely.destroy();
  }
}
