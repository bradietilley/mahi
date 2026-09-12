import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Kysely } from "kysely";
import type { Dialect } from "./schema/dialect.js";
import { SchemaBuilder } from "./schema/schema-builder.js";
import { transaction } from "./transaction.js";
import { getActiveTransaction } from "./transaction-context.js";
import { formatTimestamp } from "./timestamps.js";

export interface Migration {
  up(): Promise<void>;
  down(): Promise<void>;
}

export interface MigrationStatus {
  name: string;
  ran: boolean;
  batch: number | null;
}

/**
 * A migration paired with the name it is recorded under in the
 * `migrations` table. That name is also the ordering key, so it carries
 * the leading timestamp/sequence prefix (`"0001_create_jobs_table"`) —
 * exactly the filename-without-extension a discovered migration gets.
 */
export interface RegisteredMigration {
  /** Unique id + ordering key. Conventionally the filename without extension. */
  name: string;
  migration: Migration;
}

/**
 * Where migrations come from. Either:
 *
 * - a **directory path**, scanned at runtime (`readdir` + dynamic
 *   `import()`), which is the convenient default for a project-style app
 *   run from source; or
 * - an **explicit `{ name, migration }`**, statically imported by the
 *   caller.
 *
 * The explicit form exists because the directory form cannot survive
 * bundling: a single-file executable has no `database/migrations`
 * directory to read and no path to `import()`, so discovery finds nothing
 * and `migrate` cheerfully reports "Nothing to migrate" — a silent no-op
 * against an empty database. An app that intends to be compiled keeps a
 * static registry (a module that imports every migration and exports them
 * as an array) and passes that instead. The two forms can be mixed
 * freely; names are deduplicated across them, first occurrence winning.
 */
export type MigrationSource = string | RegisteredMigration;

/** Options accepted by `MigrationRunner.up()`. */
export interface UpOptions {
  /**
   * Report what *would* run and change nothing — Laravel's
   * `migrate --pretend`, the standard pre-deploy check. No migration's
   * `up()` is called, no `migrations` row is written, and the lock is
   * not taken (there is nothing to serialise against).
   *
   * The honest limitation, and why this does not print SQL: a migration
   * here is arbitrary TypeScript, not a declarative list of statements.
   * Laravel can echo the SQL because it intercepts the connection while
   * the migration runs; doing that here would mean *running* the
   * migration's code against a pretend connection, and a migration that
   * branches on a query result (`if (await schema.hasColumn(...))`)
   * would take a different path — or, worse, do real non-DDL work.
   * Reporting the names is the part that is both useful and truthful.
   */
  pretend?: boolean;
}

/** Options accepted by `MigrationRunner.rollback()`. */
export interface RollbackOptions {
  /**
   * How many **batches** to roll back, most recent first — Laravel's
   * `migrate:rollback --step`. Defaults to 1 (the most recent batch
   * only). `Infinity` rolls back everything, which is what
   * `migrate:reset` means.
   *
   * Batches, not individual migrations, matching Laravel: a batch is the
   * unit that was applied together, so it is the unit that can be undone
   * together without leaving a half-applied deploy.
   */
  step?: number;
  /** Report what *would* roll back and change nothing. See `UpOptions.pretend`. */
  pretend?: boolean;
}

const MIGRATIONS_TABLE = "migrations";

/**
 * The single-row table used as a mutual-exclusion lock around a
 * migration run. Its `id` is a fixed constant, so `INSERT` succeeds for
 * exactly one contender and every other one collides with the primary
 * key — a portable compare-and-set that needs no dialect-specific
 * advisory-lock API.
 */
const LOCK_TABLE = "migrations_lock";
const LOCK_ID = 1;

function isRegistered(source: MigrationSource): source is RegisteredMigration {
  return typeof source !== "string";
}

/**
 * Filenames a migration directory scan will `import()`.
 *
 * Migrations are conventionally named `{timestamp-or-sequence}_{描述}.ts`
 * — a leading digit run, an underscore, then a name. Requiring that
 * shape (rather than importing *every* `.ts`/`.js` in the directory)
 * matters because the directory is an application's own source folder:
 * a `helpers.ts` of shared blueprint code, an `index.ts` re-export, or
 * an editor's `.swp`-adjacent leftovers all get imported and, if the
 * module has a default export at all, silently "run" as a migration
 * under its own filename.
 *
 * `.d.ts` is excluded separately by the caller — it matches this pattern
 * only when the migration it describes does, and it's a type-only file
 * either way.
 */
const MIGRATION_FILE = /^\d+[_-].+\.(ts|js|mts|mjs|cts|cjs)$/;

/** The extension of a migration filename (empty string if none matches). */
const MIGRATION_EXT = /\.(ts|js|mts|mjs|cts|cjs)$/;

/**
 * Source (TypeScript) extensions. A file with one of these can only run
 * on a Node that strips types on the fly (>=22.6 by default, or with
 * `--experimental-strip-types`); on any other it throws
 * `ERR_UNKNOWN_FILE_EXTENSION`.
 */
const TS_EXT = /\.(ts|mts|cts)$/;

/**
 * Whether the process was launched from a COMPILED entrypoint — `node
 * dist/bin/console.js` rather than `tsx bin/console.ts`. Used only to
 * decide whether a discovered `.ts` migration is worth warning about: a
 * compiled deploy that still resolves its migrations directory to a
 * source tree is the exact shape that silently migrates nothing (or
 * throws `ERR_UNKNOWN_FILE_EXTENSION`) in production.
 *
 * Heuristic, deliberately: `process.argv[1]` is the script Node was told
 * to run, and under `tsx` it is a `.ts` path while a real deploy runs a
 * `.js` one. False negatives (no warning) are harmless; there is no false
 * positive that matters, since a `.ts` migration next to compiled `.js`
 * is a mistake regardless.
 */
function launchedFromCompiledEntrypoint(): boolean {
  const entry = process.argv[1];

  return typeof entry === "string" && /\.(js|mjs|cjs)$/.test(entry);
}

/**
 * Collapse `{base}.ts` / `{base}.js` pairs in one directory down to the
 * compiled `.js`, keeping every other file untouched and the original
 * order stable.
 *
 * A compiled app's migrations directory (`dist/database/migrations`) holds
 * only `.js`, and a source one (`database/migrations` under `tsx`) holds
 * only `.ts` — so the two normally don't collide. They do the moment a
 * directory is a source tree that has ALSO been compiled in place, or a
 * `dist/` that a build left a stray `.ts` in: importing both would run the
 * same migration twice under two names. Preferring the `.js` keeps the
 * runnable one on any Node, type-stripping or not.
 */
function preferCompiled(files: string[]): string[] {
  const hasCompiledSibling = new Set<string>();

  for (const file of files) {
    if (/\.(js|mjs|cjs)$/.test(file)) {
      hasCompiledSibling.add(file.replace(MIGRATION_EXT, ""));
    }
  }

  return files.filter((file) => {
    if (!TS_EXT.test(file)) {
      return true;
    }

    return !hasCompiledSibling.has(file.replace(MIGRATION_EXT, ""));
  });
}

/**
 * Byte-wise name comparison — the migration ordering.
 *
 * NOT `localeCompare()`, which is locale-dependent by definition:
 * under ICU it ignores/reorders punctuation, so `2024_01_01_a` and
 * `2024-01-01-a` collate as equal and `_` vs `-` separators sort
 * differently on different machines. Migration order has to be the same
 * on a developer's laptop, in CI and on the production host, and the
 * only comparison that guarantees that is the raw code-unit one.
 */
function byNameKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Runs migrations supplied either as directories to scan (dynamic
 * `import()`, expecting a default export implementing `Migration`) or as
 * explicit, statically-imported `{ name, migration }` entries — see
 * `MigrationSource`. Tracks which have run in a `migrations` table (name,
 * batch, migrated_at) — same shape as Laravel's migrations table.
 */
export class MigrationRunner {
  constructor(
    private connection: Kysely<any>,
    private dialect: Dialect = "sqlite",
  ) {}

  /**
   * The connection this runner's own bookkeeping (`migrations`,
   * `migrations_lock`) executes on — the active transaction on it when
   * one is open, exactly as `SchemaBuilder` and `QueryBuilder` resolve
   * theirs.
   *
   * This matters for `runOne()`: a migration's `migrations` row is
   * written inside that migration's transaction, so reaching for the
   * root connection here would (a) leave the row outside the atomic
   * unit it exists to pair with, and (b) on SQLite block outright —
   * the transaction holds the single write lock, and the root
   * connection's insert would sit there until `busy_timeout` expired.
   */
  private get db(): Kysely<any> {
    return getActiveTransaction(this.connection) ?? this.connection;
  }

  private builder(): SchemaBuilder {
    return new SchemaBuilder(this.connection, this.dialect);
  }

  private async ensureMigrationsTable(): Promise<void> {
    const schema = this.builder();

    if (await schema.hasTable(MIGRATIONS_TABLE)) {
      return;
    }

    await schema.create(MIGRATIONS_TABLE, (table) => {
      table.id();
      table.string("name").unique();
      table.integer("batch");
      table.timestamp("migrated_at");
    });
  }

  private async ensureLockTable(): Promise<void> {
    const schema = this.builder();

    if (await schema.hasTable(LOCK_TABLE)) {
      return;
    }

    await schema.create(LOCK_TABLE, (table) => {
      table.integer("id").primary();
      table.string("acquired_by");
      table.timestamp("acquired_at");
    });
  }

  /**
   * Runs `work` while holding the migration lock, releasing it (even on
   * failure) before returning.
   *
   * Two `migrate` processes racing — a deploy that starts two app
   * instances at once, a CI job overlapping a manual run — otherwise
   * both read the same "pending" list and the same `max(batch)`, then
   * both run every migration. The second one's DDL fails halfway
   * ("table already exists"), leaving the schema in a state neither
   * process's `migrations` rows describe.
   *
   * The lock is a single-row `INSERT` on a fixed primary key: portable
   * across all three dialects, visible to a human (`select * from
   * migrations_lock` says who holds it and since when), and — unlike a
   * connection-scoped advisory lock — survivable in the sense that a
   * crashed run leaves a row somebody can inspect and delete rather than
   * a lock that vanished with the connection while the schema stayed
   * half-migrated.
   *
   * The trade-off is the other side of that: a hard crash leaves the row
   * behind and the next run refuses to start, with an error saying
   * exactly which row to delete. That's the safer failure — a stale lock
   * costs a manual `DELETE`, a wrongly-released one costs a corrupted
   * schema.
   */
  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await this.ensureLockTable();

    const owner = `pid:${process.pid}`;
    try {
      await this.db
        .insertInto(LOCK_TABLE)
        .values({ id: LOCK_ID, acquired_by: owner, acquired_at: formatTimestamp(this.dialect) })
        .execute();
    } catch {
      const held: any = await this.db
        .selectFrom(LOCK_TABLE)
        .selectAll()
        .where("id", "=", LOCK_ID)
        .executeTakeFirst();
      throw new Error(
        `Another migration run holds the lock (acquired by ${held?.acquired_by ?? "unknown"} at ` +
          `${held?.acquired_at ?? "unknown time"}). Wait for it to finish, or — if that process ` +
          `died mid-run — inspect the schema and clear it with: delete from "${LOCK_TABLE}".`,
      );
    }

    try {
      return await work();
    } finally {
      await this.db.deleteFrom(LOCK_TABLE).where("id", "=", LOCK_ID).execute();
    }
  }

  /**
   * Whether this dialect can roll back DDL, deciding whether each
   * migration gets its own transaction.
   *
   * SQLite and Postgres have transactional DDL: a migration that throws
   * half-way undoes its own tables/columns, and the `migrations` row is
   * written in the same transaction, so "ran" and "actually applied"
   * can't disagree.
   *
   * **MySQL does not.** Every `CREATE`/`ALTER TABLE` there causes an
   * implicit commit, so wrapping a migration in a transaction buys
   * nothing and actively misleads (it looks atomic and isn't). Rather
   * than pretend, MySQL runs each migration unwrapped — a failed
   * migration there leaves partial DDL that has to be cleaned up by
   * hand, exactly as it does in Laravel.
   */
  private supportsTransactionalDdl(): boolean {
    return this.dialect !== "mysql";
  }

  /**
   * Runs one migration and records it, atomically where the dialect
   * allows (see `supportsTransactionalDdl()`).
   *
   * The `migrations` row is written **inside** the same transaction as
   * the migration's own DDL. That pairing is the point: recorded-but-
   * not-applied means the next run skips a migration that never took
   * effect, and applied-but-not-recorded means the next run re-runs DDL
   * against a schema that already has it.
   */
  private async runOne(name: string, run: () => Promise<void>): Promise<void> {
    if (!this.supportsTransactionalDdl()) {
      return run();
    }

    await transaction(this.connection, () => run());
  }

  private async discover(sources: MigrationSource[]): Promise<RegisteredMigration[]> {
    const found: RegisteredMigration[] = [];

    for (const source of sources) {
      // Statically-supplied migrations need no filesystem at all — this
      // is the branch a compiled binary takes.
      if (isRegistered(source)) {
        found.push(source);
        continue;
      }

      const dir = source;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue; // directory doesn't exist yet — not an error, just nothing to discover
      }

      // Only files that look like migrations (see `MIGRATION_FILE`) —
      // a helper module or an `index.ts` sitting in the same directory
      // would otherwise be imported and, given any default export, run
      // as a migration under its own filename.
      //
      // `.d.ts` also ends in ".ts" — excluded explicitly. This matters
      // once a *published package's* `migrations()` directory is resolved
      // via its own compiled `dist/` (which has both `.js` and `.d.ts`
      // side by side for every file), not just an app's own `src/`
      // migrations (transpiled on the fly, `.ts` only, no `.d.ts` present).
      const files = preferCompiled(
        entries.filter((f) => !f.endsWith(".d.ts") && MIGRATION_FILE.test(f)).sort(byNameKey),
      );

      // A `.ts` migration surviving `preferCompiled` (no `.js` sibling)
      // under a compiled entrypoint is a deploy that shipped source, or
      // pointed `migrationsPath` at one: it either throws
      // `ERR_UNKNOWN_FILE_EXTENSION` on a Node that doesn't strip types,
      // or worked by accident on one that does and will stop the day the
      // runtime changes. Warn loudly rather than migrate-then-surprise.
      if (launchedFromCompiledEntrypoint()) {
        const tsFiles = files.filter((f) => TS_EXT.test(f));

        if (tsFiles.length > 0) {
          console.warn(
            `[migrator] Found TypeScript migration(s) in ${dir} while running from a ` +
              `compiled entrypoint: ${tsFiles.join(", ")}. These only load on a Node that ` +
              `strips types on the fly; a production deploy should point migrationsPath at the ` +
              `compiled directory (e.g. dist/database/migrations). See docs/deployment.`,
          );
        }
      }

      for (const file of files) {
        const fullPath = path.join(dir, file);
        const mod = await import(pathToFileURL(fullPath).href);
        const migration: Migration = mod.default ?? mod;
        const name = file.replace(/\.(ts|js|mts|mjs|cts|cjs)$/, "");
        found.push({ name, migration });
      }
    }

    // Deduplicate by name, first occurrence winning. A static registry
    // and the directory it mirrors are both legitimate sources and an app
    // mid-migration to the static form may well pass both; running the
    // same migration twice under one name would insert a duplicate row
    // and then fail the `name` unique constraint.
    const byName = new Map<string, RegisteredMigration>();

    for (const entry of found) {
      if (!byName.has(entry.name)) {
        byName.set(entry.name, entry);
      }
    }

    return [...byName.values()].sort((a, b) => byNameKey(a.name, b.name));
  }

  /**
   * Run every pending migration across the given sources — directories to
   * scan, statically-imported entries, or a mix (see `MigrationSource`).
   * Returns the names that ran.
   *
   * `onEach`, if given, wraps the execution of each individual
   * migration (e.g. to print a per-migration RUNNING/DONE status line
   * from the CLI's `migrate` command) — it must call and await `run()`
   * itself; the default (no `onEach`) just awaits `run()` directly.
   *
   * The whole run holds the migration lock (see `withLock()`), and each
   * migration plus its `migrations` row is applied atomically where the
   * dialect supports it (see `runOne()`).
   *
   * With `{ pretend: true }` this returns exactly the same list without
   * running anything — see `UpOptions.pretend`.
   */
  async up(
    sources: MigrationSource[],
    onEach?: (name: string, run: () => Promise<void>) => Promise<void>,
    options: UpOptions = {},
  ): Promise<string[]> {
    await this.ensureMigrationsTable();
    const discovered = await this.discover(sources);

    // Pretend short-circuits before the lock: it mutates nothing, so
    // there is nothing to serialise against, and blocking a dry run
    // behind a real run in progress would be actively unhelpful.
    if (options.pretend) {
      const already = await this.db.selectFrom(MIGRATIONS_TABLE).select("name").execute();
      const alreadyNames = new Set(already.map((r) => r.name as string));

      return discovered.filter((d) => !alreadyNames.has(d.name)).map((d) => d.name);
    }

    return this.withLock(async () => {
      // Re-read *inside* the lock: another run may have completed
      // between `discover()` and acquiring it, and its migrations are
      // no longer pending.
      const already = await this.db.selectFrom(MIGRATIONS_TABLE).select("name").execute();
      const alreadyNames = new Set(already.map((r) => r.name as string));

      const pending = discovered.filter((d) => !alreadyNames.has(d.name));

      if (pending.length === 0) {
        return [];
      }

      const batchRow: any = await this.db
        .selectFrom(MIGRATIONS_TABLE)
        .select(({ fn }: any) => fn.max("batch").as("maxBatch"))
        .executeTakeFirst();
      const batch = ((batchRow?.maxBatch as number | null) ?? 0) + 1;

      const ran: string[] = [];

      for (const { name, migration } of pending) {
        const run = (): Promise<void> =>
          this.runOne(name, async () => {
            await migration.up();
            await this.db
              .insertInto(MIGRATIONS_TABLE)
              .values({ name, batch, migrated_at: formatTimestamp(this.dialect) })
              .execute();
          });
        await (onEach ? onEach(name, run) : run());
        ran.push(name);
      }

      return ran;
    });
  }

  /**
   * Roll back the most recent batch — or the most recent `step` batches
   * (see `RollbackOptions.step`). Returns the names that were rolled
   * back, in the order they were undone.
   *
   * `onEach` behaves like `up()`'s — wraps the execution of each
   * individual migration's `down()`.
   *
   * With `{ pretend: true }` this returns exactly the same list without
   * running anything — see `UpOptions.pretend`.
   */
  async rollback(
    sources: MigrationSource[],
    onEach?: (name: string, run: () => Promise<void>) => Promise<void>,
    options: RollbackOptions = {},
  ): Promise<string[]> {
    await this.ensureMigrationsTable();
    const discovered = await this.discover(sources);

    const plan = async (): Promise<Array<{ name: string }>> => {
      const batches = await this.db
        .selectFrom(MIGRATIONS_TABLE)
        .select("batch")
        .distinct()
        .orderBy("batch", "desc")
        .execute();

      if (batches.length === 0) {
        return [];
      }

      const step = options.step ?? 1;
      const targets = batches.slice(0, Math.max(0, step)).map((b) => b.batch as number);

      if (targets.length === 0) {
        return [];
      }

      const rows = await this.db
        .selectFrom(MIGRATIONS_TABLE)
        .selectAll()
        .where("batch", "in", targets)
        .execute();

      // Newest batch first, and within a batch the reverse of the order
      // it was applied in — a migration's `down()` can depend on
      // anything applied before it still existing.
      return [...rows].sort((a, b) => {
        const byBatch = (b.batch as number) - (a.batch as number);

        return byBatch !== 0 ? byBatch : byNameKey(b.name as string, a.name as string);
      }) as Array<{ name: string }>;
    };

    // See `up()` — a dry run mutates nothing, so it does not take the lock.
    if (options.pretend) {
      return (await plan()).map((row) => row.name);
    }

    return this.withLock(async () => {
      const sorted = await plan();

      if (sorted.length === 0) {
        return [];
      }

      const migrations = new Map(discovered.map((d) => [d.name, d.migration]));
      const rolledBack: string[] = [];

      for (const row of sorted) {
        const name = row.name;
        const migration = migrations.get(name);

        if (!migration) {
          throw new Error(`Cannot roll back migration "${name}": no such migration in any source.`);
        }

        const run = (): Promise<void> =>
          this.runOne(name, async () => {
            await migration.down();
            await this.db.deleteFrom(MIGRATIONS_TABLE).where("name", "=", name).execute();
          });
        await (onEach ? onEach(name, run) : run());
        rolledBack.push(name);
      }

      return rolledBack;
    });
  }

  /**
   * Roll back **every** migration, newest batch first — Laravel's
   * `migrate:reset`. Sugar for `rollback(sources, onEach, { step:
   * Infinity })`, and unlike `fresh()` it goes through each migration's
   * `down()` rather than dropping tables outright.
   */
  async reset(
    sources: MigrationSource[],
    onEach?: (name: string, run: () => Promise<void>) => Promise<void>,
    options: Omit<RollbackOptions, "step"> = {},
  ): Promise<string[]> {
    return this.rollback(sources, onEach, { ...options, step: Infinity });
  }

  /**
   * Drops every table in the database (bypassing each migration's
   * `down()` entirely — a direct schema wipe), then re-runs every
   * migration from scratch. Mirrors Laravel's `migrate:fresh`. Unlike
   * `rollback()`, this works even if a migration's `down()` is missing or
   * broken, since it never calls it.
   */
  async fresh(
    sources: MigrationSource[],
    onEach?: (name: string, run: () => Promise<void>) => Promise<void>,
  ): Promise<string[]> {
    await this.builder().dropAllTables();

    return this.up(sources, onEach);
  }

  /** Status of every discovered migration: whether it has run, and in which batch. */
  async status(sources: MigrationSource[]): Promise<MigrationStatus[]> {
    await this.ensureMigrationsTable();
    const discovered = await this.discover(sources);
    const already = await this.db.selectFrom(MIGRATIONS_TABLE).selectAll().execute();
    const byName = new Map(already.map((r) => [r.name as string, r]));

    return discovered.map((d) => {
      const row = byName.get(d.name);

      return { name: d.name, ran: !!row, batch: row ? (row.batch as number) : null };
    });
  }
}
