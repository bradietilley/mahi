import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Application, clearCurrentApp, setCurrentApp } from "@mahi/core";
import { DatabaseManager, SqliteDriver, DATABASE_TOKEN, SCHEMA_TOKEN } from "@mahi/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tui } from "@mahi/tui";
import { makeMigrationDir, removeMigrationDir } from "../helpers/migration-fixtures.js";
import { MigrateFreshCommand } from "../../src/commands/migrate-fresh.js";
import { MigrateResetCommand } from "../../src/commands/migrate-reset.js";
import { DbWipeCommand } from "../../src/commands/db-wipe.js";
import { MigrateCommand } from "../../src/commands/migrate.js";
import { MigrateRollbackCommand } from "../../src/commands/migrate-rollback.js";

const MIGRATION_A = `
import { Schema } from "@mahi/database";

export default {
  async up() {
    await Schema.create("widgets", (table) => {
      table.string("id").primary();
    });
  },
  async down() {
    await Schema.drop("widgets");
  },
};
`;

/**
 * `migrate:fresh` drops every table in the database. Running it against
 * production is unrecoverable, so it must not be possible by accident —
 * and in particular must not be possible from an unattended process
 * that has no terminal to be asked on.
 */
describe("destructive commands are guarded in production", () => {
  let dir: string;
  let stdinIsTTY: PropertyDescriptor | undefined;

  beforeEach(async () => {
    dir = await makeMigrationDir("production-guard-test");
    await writeFile(path.join(dir, "0001_create_widgets.js"), MIGRATION_A);
    stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  });

  afterEach(async () => {
    clearCurrentApp();
    vi.restoreAllMocks();
    // Process-global, so it must be cleared or it leaks into every test
    // file that runs after this one in the same worker.
    Tui.clearInteractive();
    process.exitCode = undefined;

    if (stdinIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
    }

    await removeMigrationDir(dir);
  });

  function buildApp(env: string): { app: Application; driver: SqliteDriver } {
    const app = new Application();
    app.useEnvironment(env);
    app.config.set("database", { migrationsPath: dir });

    const driver = new SqliteDriver({ filename: ":memory:" });
    const manager = new DatabaseManager(app, { default: "sqlite", connections: { sqlite: {} } });
    manager.extend("sqlite", () => driver);
    app.instance(DATABASE_TOKEN, manager);
    app.bind(SCHEMA_TOKEN, () => manager.schema());
    setCurrentApp(app);

    return { app, driver };
  }

  /**
   * Pretend there is (or is not) a terminal attached.
   *
   * `Tui.interactive()` rather than poking `process.stdin.isTTY`: the guard
   * asks `isInteractive()`, which checks stdin AND stdout. Under vitest
   * stdout is piped, so forcing only stdin would leave the guard correctly
   * seeing a non-interactive process and the "prompts on a terminal" cases
   * could never be reached.
   */
  function setTTY(value: boolean) {
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
    Tui.interactive(value);
  }

  async function tableNames(driver: SqliteDriver): Promise<string[]> {
    return (await driver.kysely.introspection.getTables()).map((t) => t.name);
  }

  /**
   * Migrate, then write a row.
   *
   * Checking that `widgets` *exists* after `migrate:fresh` proves
   * nothing — fresh drops every table and immediately re-creates them,
   * so the table is there either way. The row is what distinguishes
   * "the guard stopped it" from "it ran and wiped production".
   */
  async function seedRow(app: Application, driver: SqliteDriver): Promise<void> {
    await new MigrateCommand(app).handle({ force: true });
    await driver.kysely
      .insertInto("widgets" as never)
      .values({ id: "keep-me" } as never)
      .execute();
  }

  async function widgetIds(driver: SqliteDriver): Promise<string[]> {
    const rows = await driver.kysely
      .selectFrom("widgets" as never)
      .selectAll()
      .execute();

    return rows.map((r) => (r as { id: string }).id);
  }

  it("migrate:fresh refuses to run unattended in production", async () => {
    const { app, driver } = buildApp("production");
    setTTY(false);
    const confirm = vi.spyOn(Tui, "confirm");

    await seedRow(app, driver);
    await new MigrateFreshCommand(app).handle({});

    // Never even asked — there is no terminal to ask on — and the data
    // is still there.
    expect(confirm).not.toHaveBeenCalled();
    expect(await widgetIds(driver)).toEqual(["keep-me"]);
  });

  it("migrate:reset refuses to run unattended in production", async () => {
    const { app, driver } = buildApp("production");
    setTTY(false);
    const confirm = vi.spyOn(Tui, "confirm");

    await seedRow(app, driver);
    await new MigrateResetCommand(app).handle({});

    expect(confirm).not.toHaveBeenCalled();
    expect(await widgetIds(driver)).toEqual(["keep-me"]);
  });

  it("migrate:reset --pretend needs no confirmation, since it changes nothing", async () => {
    const { app, driver } = buildApp("production");
    setTTY(false);
    const confirm = vi.spyOn(Tui, "confirm");

    await seedRow(app, driver);
    await new MigrateResetCommand(app).handle({ pretend: true });

    expect(confirm).not.toHaveBeenCalled();
    expect(await widgetIds(driver)).toEqual(["keep-me"]);
  });

  it("db:wipe refuses to run unattended in production", async () => {
    // The most destructive command here — it drops the migrations ledger
    // too, so there is not even a record of what the schema was.
    const { app, driver } = buildApp("production");
    setTTY(false);
    const confirm = vi.spyOn(Tui, "confirm");

    await seedRow(app, driver);
    await new DbWipeCommand(app).handle({});

    expect(confirm).not.toHaveBeenCalled();
    expect(await widgetIds(driver)).toEqual(["keep-me"]);
  });

  it("db:wipe proceeds unattended in production with --force", async () => {
    const { app, driver } = buildApp("production");
    setTTY(false);

    await seedRow(app, driver);
    await new DbWipeCommand(app).handle({ force: true });

    expect(await tableNames(driver)).toEqual([]);
  });

  it("migrate:fresh proceeds unattended in production with --force", async () => {
    const { app, driver } = buildApp("production");
    setTTY(false);

    await seedRow(app, driver);
    await new MigrateFreshCommand(app).handle({ force: true });

    // Explicitly asked for: the table was dropped and rebuilt empty.
    expect(await tableNames(driver)).toContain("widgets");
    expect(await widgetIds(driver)).toEqual([]);
  });

  it("migrate:fresh prompts on a terminal, and a 'no' stops it", async () => {
    const { app, driver } = buildApp("production");
    setTTY(true);
    const confirm = vi.spyOn(Tui, "confirm").mockResolvedValue(false);

    await seedRow(app, driver);
    await new MigrateFreshCommand(app).handle({});

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await widgetIds(driver)).toEqual(["keep-me"]);
  });

  it("migrate:fresh proceeds when the operator confirms", async () => {
    const { app, driver } = buildApp("production");
    setTTY(true);
    vi.spyOn(Tui, "confirm").mockResolvedValue(true);

    await seedRow(app, driver);
    await new MigrateFreshCommand(app).handle({});

    expect(await widgetIds(driver)).toEqual([]);
  });

  it("does not prompt outside production — a local migrate:fresh stays one keystroke", async () => {
    const { app, driver } = buildApp("local");
    setTTY(true);
    const confirm = vi.spyOn(Tui, "confirm");

    await seedRow(app, driver);
    await new MigrateFreshCommand(app).handle({});

    expect(confirm).not.toHaveBeenCalled();
    expect(await widgetIds(driver)).toEqual([]);
  });

  it("guards migrate and migrate:rollback too", async () => {
    const { app, driver } = buildApp("production");
    setTTY(false);

    await new MigrateCommand(app).handle({});
    expect(await tableNames(driver)).not.toContain("widgets");

    await new MigrateCommand(app).handle({ force: true });
    expect(await tableNames(driver)).toContain("widgets");

    await new MigrateRollbackCommand(app).handle({});
    expect(await tableNames(driver)).toContain("widgets");
  });

  it("--pretend needs no confirmation: it cannot change anything", async () => {
    const { app, driver } = buildApp("production");
    setTTY(false);
    const confirm = vi.spyOn(Tui, "confirm");

    await new MigrateCommand(app).handle({ pretend: true });

    expect(confirm).not.toHaveBeenCalled();
    expect(await tableNames(driver)).not.toContain("widgets");
  });

  it("sets a non-zero exit code when refused for want of a terminal", async () => {
    // The pipeline-visibility property. Exiting 0 here would let a deploy
    // continue against an unmigrated schema and call it a success.
    const { app } = buildApp("production");
    setTTY(false);

    await new MigrateCommand(app).handle({});

    expect(process.exitCode).toBe(1);
  });

  it("leaves the exit code alone when a human declines", async () => {
    // Someone was asked and said no. A decision, not a fault.
    const { app, driver } = buildApp("production");
    setTTY(true);
    vi.spyOn(Tui, "confirm").mockResolvedValue(false);

    await seedRow(app, driver);
    await new MigrateFreshCommand(app).handle({});

    expect(process.exitCode).toBeUndefined();
    expect(await widgetIds(driver)).toEqual(["keep-me"]);
  });

  it("treats a piped stdout as unattended, even with stdin on a terminal", async () => {
    // `./artisan migrate:fresh | tee deploy.log`. The old guard read only
    // `process.stdin.isTTY` and would have taken the prompt branch, where
    // a non-TTY prompt resolves to its default rather than blocking.
    const { app, driver } = buildApp("production");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Tui.clearInteractive();
    const confirm = vi.spyOn(Tui, "confirm");

    await seedRow(app, driver);
    await new MigrateFreshCommand(app).handle({});

    expect(confirm).not.toHaveBeenCalled();
    expect(await widgetIds(driver)).toEqual(["keep-me"]);
  });
});
