import { sql } from "kysely";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { DatabaseManager } from "../../src/database-manager.js";
import { DATABASE_TOKEN } from "../../src/database-service-provider.js";
import type { DatabaseDriver } from "../../src/drivers/driver.js";
import { MysqlDriver, type MysqlConnectionConfig } from "../../src/drivers/mysql-driver.js";
import {
  PostgresDriver,
  type PostgresConnectionConfig,
} from "../../src/drivers/postgres-driver.js";
import { SqliteDriver } from "../../src/drivers/sqlite-driver.js";
import { SchemaBuilder } from "../../src/schema/schema-builder.js";
import type { Blueprint } from "../../src/schema/blueprint.js";
import type { Dialect } from "../../src/schema/dialect.js";

/**
 * The MySQL/Postgres instances the integration suites run against,
 * `docker-compose.yml` at the repo root, and the same services CI
 * starts. Overridable by env for a differently-provisioned box.
 */
const MYSQL: MysqlConnectionConfig = {
  host: process.env.MAHI_TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MAHI_TEST_MYSQL_PORT ?? 3306),
  database: process.env.MAHI_TEST_MYSQL_DATABASE ?? "mahi_test",
  username: process.env.MAHI_TEST_MYSQL_USER ?? "root",
  password: process.env.MAHI_TEST_MYSQL_PASSWORD ?? "mysql",
};

const POSTGRES: PostgresConnectionConfig = {
  host: process.env.MAHI_TEST_PGHOST ?? "127.0.0.1",
  port: Number(process.env.MAHI_TEST_PGPORT ?? 5432),
  database: process.env.MAHI_TEST_PGDATABASE ?? "mahi_test",
  username: process.env.MAHI_TEST_PGUSER ?? "postgres",
  password: process.env.MAHI_TEST_PGPASSWORD ?? "postgres",
};

/** One engine in the test matrix. */
export interface TestEngine {
  readonly name: Dialect;
  /** Whether the engine needs a server this machine may not be running. */
  readonly external: boolean;
  /**
   * Connect to this engine. `database`, when given, overrides the
   * default one. See `withDatabase()`.
   */
  make(database?: string): DatabaseDriver;
}

export const ENGINES: readonly TestEngine[] = [
  { name: "sqlite", external: false, make: () => new SqliteDriver({ filename: ":memory:" }) },
  {
    name: "mysql",
    external: true,
    make: (database) => new MysqlDriver({ ...MYSQL, ...(database ? { database } : {}) }),
  },
  {
    name: "postgres",
    external: true,
    make: (database) => new PostgresDriver({ ...POSTGRES, ...(database ? { database } : {}) }),
  },
];

/**
 * Creates a scratch database named for the calling test file, so two
 * integration suites can run in parallel without colliding.
 *
 * They otherwise share one `mahi_test`, and each calls
 * `dropAllTables()` in its own `beforeAll`/`afterAll`. Vitest runs test
 * *files* in parallel, so one suite's teardown would drop the tables
 * another was mid-way through using, an intermittent
 * `relation "widgets" does not exist` in roughly one full-suite run in
 * ten, and worse on a busier machine.
 *
 * A database per file rather than serialising the files: the isolation
 * is real (not a convention future tests must remember), and the suite
 * keeps its parallelism.
 *
 * SQLite needs none of this. Every harness gets its own `:memory:`
 * database already.
 */
export async function withDatabase(engine: TestEngine, label: string): Promise<string | undefined> {
  if (!engine.external) {
    return undefined;
  }

  const name = scratchDatabaseName(label);
  // Connect to the default database purely to issue the CREATE.
  const admin = engine.make();
  try {
    await admin.connect?.();
    // Postgres has no `CREATE DATABASE IF NOT EXISTS` (it is a syntax
    // error, 42601), so only MySQL gets the guard and Postgres relies
    // on catching "already exists" below.
    const ifNotExists = engine.name === "mysql" ? "if not exists " : "";
    await sql
      .raw(`create database ${ifNotExists}${quoteIdentifier(engine, name)}`)
      .execute(admin.kysely);
  } catch (error) {
    // 42P04 / "already exists". A previous crashed run left it behind,
    // which is fine: the suite drops all tables on start anyway.
    const message = (error as Error).message;

    if (!/already exists|42P04/i.test(message)) {
      throw error;
    }
  } finally {
    await admin.disconnect?.().catch(() => {});
  }

  return name;
}

/** Drops a scratch database created by `withDatabase()`. */
export async function dropDatabase(engine: TestEngine, name: string | undefined): Promise<void> {
  if (!engine.external || !name) {
    return;
  }

  const admin = engine.make();
  try {
    await admin.connect?.();
    await sql.raw(`drop database if exists ${quoteIdentifier(engine, name)}`).execute(admin.kysely);
  } catch {
    // A leftover scratch database is harmless, `withDatabase()` reuses
    // it next run, and failing teardown would mask the real result.
  } finally {
    await admin.disconnect?.().catch(() => {});
  }
}

/**
 * `mahi_test_<label>`, sanitised to the identifier characters both
 * engines accept and truncated to MySQL's 64-character limit.
 */
function scratchDatabaseName(label: string): string {
  const slug = label.replace(/[^a-z0-9]+/gi, "_").toLowerCase();

  return `mahi_test_${slug}`.slice(0, 64);
}

function quoteIdentifier(engine: TestEngine, name: string): string {
  return engine.name === "mysql" ? `\`${name}\`` : `"${name}"`;
}

/**
 * Whether `engine` can actually be reached right now.
 *
 * SQLite always can. For the two server engines this opens a real
 * connection and throws it away, so a developer without docker running
 * gets the suite skipped rather than a wall of connection errors.
 *
 * **Except under `CI_STRICT_MODE=true`**, where the services are
 * provisioned and an unreachable database means the harness is
 * misconfigured, silently skipping there would turn the entire
 * cross-dialect suite into a no-op that still reports green, which is
 * exactly the failure this plan exists to prevent. So that job rethrows.
 *
 * Deliberately NOT keyed off `CI`: GitHub Actions sets `CI=true` on every
 * runner, so the service-free job would fail on the very suites it is
 * meant to skip. The opt-in has to be something only the job that starts
 * the services sets.
 */
export async function engineAvailable(engine: TestEngine): Promise<boolean> {
  if (!engine.external) {
    return true;
  }

  let driver: DatabaseDriver | undefined;
  try {
    driver = engine.make();
    await driver.connect?.();

    return true;
  } catch (error) {
    if (process.env.CI_STRICT_MODE === "true") {
      throw new Error(
        `${engine.name} is unreachable and CI_STRICT_MODE=true, so the integration suite ` +
          `cannot be skipped. Original error: ${(error as Error).message}`,
      );
    }

    return false;
  } finally {
    await driver?.disconnect?.().catch(() => {});
  }
}

/**
 * A live connection to one engine, with an `Application` bound so
 * static `Model` calls resolve to it, plus schema helpers.
 *
 * `setUp()`/`tearDown()` are deliberately per-suite rather than
 * per-test: connecting to MySQL/Postgres is far too slow to repeat for
 * every `it()`, so tables are created once and `truncate()` clears
 * their rows between tests instead.
 */
export class EngineHarness {
  readonly schema: SchemaBuilder;
  private readonly tables: string[] = [];

  private constructor(
    readonly engine: TestEngine,
    readonly driver: DatabaseDriver,
    readonly app: Application,
    private readonly database: string | undefined,
  ) {
    this.schema = new SchemaBuilder(driver.kysely, driver.dialect);
  }

  /**
   * `label` names the scratch database this harness gets, and must be
   * unique per test *file*, pass something derived from the filename.
   * See `withDatabase()` for why.
   */
  static async start(engine: TestEngine, label: string): Promise<EngineHarness> {
    const database = await withDatabase(engine, label);
    const driver = engine.make(database);
    await driver.connect?.();

    const app = new Application();
    const manager = new DatabaseManager(app, { default: engine.name, connections: {} });
    manager.extend(engine.name, () => driver);
    app.instance(DATABASE_TOKEN, manager);
    setCurrentApp(app);

    const harness = new EngineHarness(engine, driver, app, database);
    // Whatever a previous, crashed run left behind.
    await harness.schema.dropAllTables();

    return harness;
  }

  /** Creates a table and registers it for `truncate()`/`stop()` cleanup. */
  async create(table: string, build: (t: Blueprint) => void): Promise<void> {
    await this.schema.create(table, build);
    this.tables.push(table);
  }

  /**
   * Empties every table this harness created, leaving the schema in
   * place, the between-tests reset.
   *
   * Uses `DELETE` rather than `TRUNCATE` because `TRUNCATE` is DDL on
   * MySQL (it would implicitly commit an open transaction) and needs
   * `CASCADE` on Postgres to get past foreign keys. Deleting in reverse
   * creation order means children go before the parents they reference,
   * so the FKs are satisfied without disabling them.
   */
  async truncate(): Promise<void> {
    for (const table of [...this.tables].reverse()) {
      await this.driver.kysely.deleteFrom(table).execute();
    }
  }

  async stop(): Promise<void> {
    await this.schema.dropAllTables();
    await this.driver.disconnect?.();
    await dropDatabase(this.engine, this.database);
    clearCurrentApp();
  }
}
