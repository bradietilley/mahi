import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN, SCHEMA_TOKEN } from "../src/database-service-provider.js";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { MigrationRunner, type Migration, type RegisteredMigration } from "../src/migrator.js";
import { Schema } from "../src/schema/schema-facade.js";

const MIGRATION_A = `
import { Schema } from "@mahiframework/database";

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

const MIGRATION_B = `
import { Schema } from "@mahiframework/database";

export default {
  async up() {
    await Schema.create("gadgets", (table) => {
      table.string("id").primary();
    });
  },
  async down() {
    await Schema.drop("gadgets");
  },
};
`;

const MIGRATION_C = `
import { Schema } from "@mahiframework/database";

export default {
  async up() {
    await Schema.create("doodads", (table) => {
      table.string("id").primary();
    });
  },
  async down() {
    await Schema.drop("doodads");
  },
};
`;

/**
 * The `{ name, migration }` form of one of the source strings above,
 * without going through the filesystem, lets a test apply migrations as
 * separate batches (one `up()` call each) to exercise `--step`.
 */
function fromSource(source: string): Migration {
  const table = /Schema\.create\("(\w+)"/.exec(source)![1]!;

  return {
    async up() {
      await Schema.create(table, (t) => {
        t.string("id").primary();
      });
    },
    async down() {
      await Schema.drop(table);
    },
  };
}

describe("MigrationRunner", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "migrator-test-"));
    await writeFile(path.join(dir, "0001_create_widgets.js"), MIGRATION_A);
    await writeFile(path.join(dir, "0002_create_gadgets.js"), MIGRATION_B);
  });

  afterEach(async () => {
    clearCurrentApp();
    await rm(dir, { recursive: true, force: true });
  });

  function freshRunner() {
    const driver = new SqliteDriver({ filename: ":memory:" });
    const application = new Application();
    const manager = new DatabaseManager(application, {
      default: "sqlite",
      connections: { sqlite: {} },
    });
    manager.extend("sqlite", () => driver);
    application.instance(DATABASE_TOKEN, manager);
    application.bind(SCHEMA_TOKEN, () => manager.schema());
    setCurrentApp(application);

    return { driver, runner: new MigrationRunner(driver.kysely) };
  }

  it("runs every pending migration in order and records them in the migrations table", async () => {
    const { driver, runner } = freshRunner();

    const ran = await runner.up([dir]);

    expect(ran).toEqual(["0001_create_widgets", "0002_create_gadgets"]);

    const tables = await driver.kysely.introspection.getTables();
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toEqual(expect.arrayContaining(["widgets", "gadgets", "migrations"]));
  });

  it("running up() again is a no-op when everything has already run", async () => {
    const { runner } = freshRunner();

    await runner.up([dir]);
    const secondRun = await runner.up([dir]);

    expect(secondRun).toEqual([]);
  });

  it("status() reports ran vs pending migrations with their batch", async () => {
    const { runner } = freshRunner();

    const beforeStatus = await runner.status([dir]);
    expect(beforeStatus).toEqual([
      { name: "0001_create_widgets", ran: false, batch: null },
      { name: "0002_create_gadgets", ran: false, batch: null },
    ]);

    await runner.up([dir]);
    const afterStatus = await runner.status([dir]);

    expect(afterStatus).toEqual([
      { name: "0001_create_widgets", ran: true, batch: 1 },
      { name: "0002_create_gadgets", ran: true, batch: 1 },
    ]);
  });

  it("rollback() reverts the most recent batch, in reverse order", async () => {
    const { driver, runner } = freshRunner();

    await runner.up([dir]);
    const rolledBack = await runner.rollback([dir]);

    // reverse alphabetical/name order within the batch
    expect(rolledBack).toEqual(["0002_create_gadgets", "0001_create_widgets"]);

    const tables = await driver.kysely.introspection.getTables();
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).not.toContain("widgets");
    expect(tableNames).not.toContain("gadgets");
  });

  it("rollback() with nothing to roll back is a no-op", async () => {
    const { runner } = freshRunner();
    expect(await runner.rollback([dir])).toEqual([]);
  });

  it("ignores .d.ts declaration files sitting alongside compiled .js migrations", async () => {
    // Mirrors a published package's `migrations()` directory pointing at
    // its own compiled `dist/` output, which has a `.d.ts` next to every
    // `.js` file, `.d.ts` also ends in ".ts" so a naive suffix filter
    // would try to `import()` it as if it were the migration itself.
    await writeFile(
      path.join(dir, "0001_create_widgets.d.ts"),
      "export default {} as unknown;", // not a real migration, must be skipped
    );

    const { runner } = freshRunner();
    const ran = await runner.up([dir]);

    expect(ran).toEqual(["0001_create_widgets", "0002_create_gadgets"]);
  });

  it("discovers migrations across multiple directories, sorted by name", async () => {
    const otherDir = await mkdtemp(path.join(tmpdir(), "migrator-test-other-"));
    await writeFile(
      path.join(otherDir, "0000_first.js"),
      `import { Schema } from "@mahiframework/database";
export default { async up() { await Schema.create("early", (table) => { table.string("id").primary(); }); }, async down() { await Schema.drop("early"); } };`,
    );

    const { runner } = freshRunner();
    const ran = await runner.up([otherDir, dir]);

    expect(ran).toEqual(["0000_first", "0001_create_widgets", "0002_create_gadgets"]);

    await rm(otherDir, { recursive: true, force: true });
  });

  it("fresh() drops every table (including migrations) and re-runs every migration", async () => {
    const { driver, runner } = freshRunner();

    await runner.up([dir]);
    const ran = await runner.fresh([dir]);

    expect(ran).toEqual(["0001_create_widgets", "0002_create_gadgets"]);

    const tables = await driver.kysely.introspection.getTables();
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toEqual(expect.arrayContaining(["widgets", "gadgets", "migrations"]));

    const status = await runner.status([dir]);
    expect(status).toEqual([
      { name: "0001_create_widgets", ran: true, batch: 1 },
      { name: "0002_create_gadgets", ran: true, batch: 1 },
    ]);
  });

  it("fresh() works even when there was nothing migrated yet", async () => {
    const { runner } = freshRunner();

    const ran = await runner.fresh([dir]);

    expect(ran).toEqual(["0001_create_widgets", "0002_create_gadgets"]);
  });

  it("fresh() does not call down() on prior migrations (drops tables directly instead)", async () => {
    const brokenDownDir = await mkdtemp(path.join(tmpdir(), "migrator-test-broken-"));
    await writeFile(
      path.join(brokenDownDir, "0001_create_things.js"),
      `import { Schema } from "@mahiframework/database";
export default {
        async up() {
          await Schema.create("things", (table) => { table.string("id").primary(); });
        },
        async down() {
          throw new Error("down() should never be called by fresh()");
        },
      };`,
    );

    const { runner } = freshRunner();
    await runner.up([brokenDownDir]);
    const ran = await runner.fresh([brokenDownDir]);

    expect(ran).toEqual(["0001_create_things"]);

    await rm(brokenDownDir, { recursive: true, force: true });
  });

  /**
   * The bundling case. A single-file executable has no migrations
   * directory to `readdir` and no path to `import()`, and `discover()`
   * treats an unreadable directory as "nothing found", so without an
   * explicit form, a compiled app reports "Nothing to migrate" and then
   * runs against an empty database. These assert the explicit form works
   * everywhere the directory form does, and interoperates with it.
   */
  describe("explicit migration sources (no filesystem)", () => {
    function widgetsMigration(): RegisteredMigration {
      return {
        name: "0001_create_widgets",
        migration: {
          async up() {
            await Schema.create("widgets", (table) => {
              table.string("id").primary();
            });
          },
          async down() {
            await Schema.drop("widgets");
          },
        },
      };
    }

    function gadgetsMigration(): RegisteredMigration {
      return {
        name: "0002_create_gadgets",
        migration: {
          async up() {
            await Schema.create("gadgets", (table) => {
              table.string("id").primary();
            });
          },
          async down() {
            await Schema.drop("gadgets");
          },
        },
      };
    }

    it("up() runs statically-supplied migrations with no directory at all", async () => {
      const { driver, runner } = freshRunner();

      const ran = await runner.up([widgetsMigration(), gadgetsMigration()]);

      expect(ran).toEqual(["0001_create_widgets", "0002_create_gadgets"]);

      const tableNames = (await driver.kysely.introspection.getTables()).map((t) => t.name);
      expect(tableNames).toEqual(expect.arrayContaining(["widgets", "gadgets"]));
    });

    it("orders by name, not by the order they were supplied in", async () => {
      const { runner } = freshRunner();

      const ran = await runner.up([gadgetsMigration(), widgetsMigration()]);

      expect(ran).toEqual(["0001_create_widgets", "0002_create_gadgets"]);
    });

    it("mixes explicit entries with scanned directories", async () => {
      const otherDir = await mkdtemp(path.join(tmpdir(), "migrator-test-mixed-"));
      await writeFile(
        path.join(otherDir, "0000_first.js"),
        `import { Schema } from "@mahiframework/database";
export default { async up() { await Schema.create("early", (table) => { table.string("id").primary(); }); }, async down() { await Schema.drop("early"); } };`,
      );

      const { runner } = freshRunner();
      const ran = await runner.up([otherDir, widgetsMigration()]);

      expect(ran).toEqual(["0000_first", "0001_create_widgets"]);

      await rm(otherDir, { recursive: true, force: true });
    });

    /**
     * An app part-way through moving to a static registry may well pass
     * both the registry and the directory it mirrors. Running each
     * migration twice would blow up on the `migrations.name` unique
     * index, and, worse, run `up()` twice first.
     */
    it("deduplicates a migration supplied both explicitly and via a directory", async () => {
      const { runner } = freshRunner();

      const ran = await runner.up([widgetsMigration(), gadgetsMigration(), dir]);

      expect(ran).toEqual(["0001_create_widgets", "0002_create_gadgets"]);
    });

    it("status() reports explicit migrations like any other", async () => {
      const { runner } = freshRunner();
      await runner.up([widgetsMigration()]);

      expect(await runner.status([widgetsMigration(), gadgetsMigration()])).toEqual([
        { name: "0001_create_widgets", ran: true, batch: 1 },
        { name: "0002_create_gadgets", ran: false, batch: null },
      ]);
    });

    it("rollback() rolls explicit migrations back", async () => {
      const { driver, runner } = freshRunner();
      await runner.up([widgetsMigration(), gadgetsMigration()]);

      const rolledBack = await runner.rollback([widgetsMigration(), gadgetsMigration()]);

      expect(rolledBack).toEqual(["0002_create_gadgets", "0001_create_widgets"]);

      const tableNames = (await driver.kysely.introspection.getTables()).map((t) => t.name);
      expect(tableNames).not.toContain("widgets");
      expect(tableNames).not.toContain("gadgets");
    });

    /**
     * The names are the compatibility surface: a migration moved from a
     * directory to a static registry keeps the filename it already wrote
     * into the `migrations` table, so it is recognised as already run
     * rather than executed a second time against a live database.
     */
    it("treats a directory-run migration as already run once it moves to the registry", async () => {
      const { runner } = freshRunner();
      await runner.up([dir]);

      const ran = await runner.up([widgetsMigration(), gadgetsMigration()]);

      expect(ran).toEqual([]);
    });
  });

  describe("per-migration transactions", () => {
    /**
     * A migration that throws part-way must leave neither its partial
     * DDL nor a `migrations` row behind: recorded-but-not-applied makes
     * the next run skip work that never happened, and the reverse
     * re-runs DDL against a schema that already has it.
     */
    it("rolls back a migration's DDL when it throws part-way", async () => {
      const { driver, runner } = freshRunner();

      const failing: RegisteredMigration = {
        name: "0001_partial",
        migration: {
          async up() {
            await Schema.create("first", (table) => {
              table.string("id").primary();
            });
            throw new Error("halfway");
          },
          async down() {},
        },
      };

      await expect(runner.up([failing])).rejects.toThrow("halfway");

      const tableNames = (await driver.kysely.introspection.getTables()).map((t) => t.name);
      expect(tableNames).not.toContain("first");
    });

    it("does not record a migration that failed", async () => {
      const { runner } = freshRunner();

      const failing: RegisteredMigration = {
        name: "0001_partial",
        migration: {
          async up() {
            await Schema.create("first", (table) => {
              table.string("id").primary();
            });
            throw new Error("halfway");
          },
          async down() {},
        },
      };

      await expect(runner.up([failing])).rejects.toThrow("halfway");

      expect(await runner.status([failing])).toEqual([
        { name: "0001_partial", ran: false, batch: null },
      ]);
    });

    it("earlier migrations in the same run stay committed when a later one fails", async () => {
      const { driver, runner } = freshRunner();

      const failing: RegisteredMigration = {
        name: "0003_boom",
        migration: {
          async up() {
            throw new Error("boom");
          },
          async down() {},
        },
      };

      await expect(runner.up([dir, failing])).rejects.toThrow("boom");

      // Each migration is its own transaction, so the two that succeeded
      // before the failure are durable, matching Laravel.
      const tableNames = (await driver.kysely.introspection.getTables()).map((t) => t.name);
      expect(tableNames).toEqual(expect.arrayContaining(["widgets", "gadgets"]));

      const status = await runner.status([dir, failing]);
      expect(status).toEqual([
        { name: "0001_create_widgets", ran: true, batch: 1 },
        { name: "0002_create_gadgets", ran: true, batch: 1 },
        { name: "0003_boom", ran: false, batch: null },
      ]);
    });
  });

  describe("the migration lock", () => {
    it("refuses to start while another run holds the lock", async () => {
      const { driver, runner } = freshRunner();

      // Simulate a run already in progress (or a crashed one that left
      // its row behind).
      await runner.up([]);
      await driver.kysely
        .insertInto("migrations_lock")
        .values({ id: 1, acquired_by: "pid:99999", acquired_at: "2024-01-01T00:00:00.000Z" })
        .execute();

      await expect(runner.up([dir])).rejects.toThrow(/Another migration run holds the lock/);
    });

    it("releases the lock after a successful run", async () => {
      const { driver, runner } = freshRunner();
      await runner.up([dir]);

      const held = await driver.kysely.selectFrom("migrations_lock").selectAll().execute();
      expect(held).toHaveLength(0);
    });

    it("releases the lock even when a migration throws", async () => {
      const { driver, runner } = freshRunner();

      const failing: RegisteredMigration = {
        name: "0001_boom",
        migration: {
          async up() {
            throw new Error("boom");
          },
          async down() {},
        },
      };

      await expect(runner.up([failing])).rejects.toThrow("boom");

      const held = await driver.kysely.selectFrom("migrations_lock").selectAll().execute();
      expect(held).toHaveLength(0);

      // ...and the next run can proceed.
      expect(await runner.up([dir])).toEqual(["0001_create_widgets", "0002_create_gadgets"]);
    });
  });

  describe("directory discovery", () => {
    it("ignores files that don't look like migrations", async () => {
      // A shared-helpers module living alongside the migrations would
      // otherwise be imported and run as one, under its own filename.
      await writeFile(
        path.join(dir, "helpers.js"),
        `export default { async up() { throw new Error("helpers.js must not run"); }, async down() {} };`,
      );
      await writeFile(
        path.join(dir, "index.js"),
        `export default { async up() { throw new Error("index.js must not run"); }, async down() {} };`,
      );

      const { runner } = freshRunner();
      expect(await runner.up([dir])).toEqual(["0001_create_widgets", "0002_create_gadgets"]);
    });

    it("prefers a compiled .js over a .ts sibling of the same migration", async () => {
      // A source tree compiled in place holds both `0003_thing.ts` and
      // `0003_thing.js`. Importing both would run the migration twice
      // under two names; the `.js` is the one that loads on any Node.
      await writeFile(
        path.join(dir, "0003_thing.js"),
        `import { Schema } from "@mahiframework/database";
export default { async up() { await Schema.create("thing", (t) => { t.string("id").primary(); }); }, async down() { await Schema.drop("thing"); } };`,
      );
      await writeFile(
        path.join(dir, "0003_thing.ts"),
        `export default { async up() { throw new Error("the .ts sibling must not run"); }, async down() {} };`,
      );

      const { runner } = freshRunner();
      const ran = await runner.up([dir]);

      expect(ran).toEqual(["0001_create_widgets", "0002_create_gadgets", "0003_thing"]);
    });

    it("orders byte-wise, not by locale collation", async () => {
      // `localeCompare` ignores punctuation under ICU, so these two
      // names collate as EQUAL and their relative order becomes
      // machine-dependent. Byte order is stable everywhere.
      await writeFile(
        path.join(dir, "0003-dash.js"),
        `import { Schema } from "@mahiframework/database";
export default { async up() { await Schema.create("dash", (t) => { t.string("id").primary(); }); }, async down() { await Schema.drop("dash"); } };`,
      );
      await writeFile(
        path.join(dir, "0003_underscore.js"),
        `import { Schema } from "@mahiframework/database";
export default { async up() { await Schema.create("underscore", (t) => { t.string("id").primary(); }); }, async down() { await Schema.drop("underscore"); } };`,
      );

      const { runner } = freshRunner();
      const ran = await runner.up([dir]);

      // "-" (0x2D) sorts before "_" (0x5F).
      expect(ran).toEqual([
        "0001_create_widgets",
        "0002_create_gadgets",
        "0003-dash",
        "0003_underscore",
      ]);
    });
  });

  describe("--pretend", () => {
    it("up() reports what would run and changes nothing", async () => {
      const { driver, runner } = freshRunner();

      const would = await runner.up([dir], undefined, { pretend: true });
      expect(would).toEqual(["0001_create_widgets", "0002_create_gadgets"]);

      // The whole point: no tables, and nothing recorded.
      const names = (await driver.kysely.introspection.getTables()).map((t) => t.name);
      expect(names).not.toContain("widgets");
      expect(names).not.toContain("gadgets");
      expect(await runner.status([dir])).toEqual([
        { name: "0001_create_widgets", ran: false, batch: null },
        { name: "0002_create_gadgets", ran: false, batch: null },
      ]);

      // And it is not a one-shot: the real run still has work to do.
      expect(await runner.up([dir])).toEqual(["0001_create_widgets", "0002_create_gadgets"]);
    });

    it("up() only reports migrations that are actually pending", async () => {
      const { runner } = freshRunner();

      await runner.up([{ name: "0001_create_widgets", migration: fromSource(MIGRATION_A) }]);

      const would = await runner.up([dir], undefined, { pretend: true });
      expect(would).toEqual(["0002_create_gadgets"]);
    });

    it("rollback() reports what would roll back and changes nothing", async () => {
      const { driver, runner } = freshRunner();
      await runner.up([dir]);

      const would = await runner.rollback([dir], undefined, { pretend: true });
      expect(would).toEqual(["0002_create_gadgets", "0001_create_widgets"]);

      // Still there.
      const names = (await driver.kysely.introspection.getTables()).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["widgets", "gadgets"]));
      expect((await runner.status([dir])).every((s) => s.ran)).toBe(true);
    });

    it("does not call the migration at all", async () => {
      const { runner } = freshRunner();
      let calls = 0;

      const spy: RegisteredMigration = {
        name: "0001_spy",
        migration: {
          async up() {
            calls++;
          },
          async down() {
            calls++;
          },
        },
      };

      await runner.up([spy], undefined, { pretend: true });
      expect(calls).toBe(0);
    });
  });

  describe("rollback --step", () => {
    /** Applies the two migrations as two separate batches. */
    async function twoBatches(runner: MigrationRunner) {
      await runner.up([{ name: "0001_create_widgets", migration: fromSource(MIGRATION_A) }]);
      await runner.up([{ name: "0002_create_gadgets", migration: fromSource(MIGRATION_B) }]);
    }

    it("rolls back only the most recent batch by default", async () => {
      const { driver, runner } = freshRunner();
      await twoBatches(runner);

      const rolledBack = await runner.rollback([dir]);
      expect(rolledBack).toEqual(["0002_create_gadgets"]);

      const names = (await driver.kysely.introspection.getTables()).map((t) => t.name);
      expect(names).toContain("widgets");
      expect(names).not.toContain("gadgets");
    });

    it("rolls back N batches, newest first", async () => {
      const { driver, runner } = freshRunner();
      await twoBatches(runner);

      const rolledBack = await runner.rollback([dir], undefined, { step: 2 });
      expect(rolledBack).toEqual(["0002_create_gadgets", "0001_create_widgets"]);

      const names = (await driver.kysely.introspection.getTables()).map((t) => t.name);
      expect(names).not.toContain("widgets");
      expect(names).not.toContain("gadgets");
    });

    it("a step larger than the number of batches rolls back everything, without erroring", async () => {
      const { runner } = freshRunner();
      await twoBatches(runner);

      expect(await runner.rollback([dir], undefined, { step: 99 })).toEqual([
        "0002_create_gadgets",
        "0001_create_widgets",
      ]);
      expect(await runner.rollback([dir], undefined, { step: 99 })).toEqual([]);
    });

    it("reset() rolls back every batch", async () => {
      const { runner } = freshRunner();
      await twoBatches(runner);

      expect(await runner.reset([dir])).toEqual(["0002_create_gadgets", "0001_create_widgets"]);
      expect((await runner.status([dir])).every((s) => !s.ran)).toBe(true);
    });

    it("orders correctly across batches, newest batch first, reversed within each", async () => {
      const { runner } = freshRunner();

      // Batch 1 gets two migrations, batch 2 gets one.
      await runner.up([
        { name: "0001_create_widgets", migration: fromSource(MIGRATION_A) },
        { name: "0002_create_gadgets", migration: fromSource(MIGRATION_B) },
      ]);
      await runner.up([{ name: "0003_create_doodads", migration: fromSource(MIGRATION_C) }]);

      expect(
        await runner.reset([
          dir,
          { name: "0003_create_doodads", migration: fromSource(MIGRATION_C) },
        ]),
      ).toEqual([
        "0003_create_doodads", // batch 2
        "0002_create_gadgets", // batch 1, reversed
        "0001_create_widgets",
      ]);
    });
  });
});
