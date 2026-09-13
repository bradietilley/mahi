import { sql, type Kysely } from "kysely";
import type { Blueprint } from "../blueprint.js";
import type { ColumnDefinition } from "../column-definition.js";
import type { ForeignKeyDefinition } from "../foreign-key-definition.js";
import type { Dialect } from "../dialect.js";
import { createIndexName } from "../index-name.js";
import type { IndexCommand } from "../types.js";
import { quoteBacktick, quoteDoubleQuoted } from "../quote-identifier.js";
import { compileColumnType } from "./column-types.js";

/**
 * Shared compiler for engines that support real, in-place `ALTER TABLE`
 * (MySQL and PostgreSQL), i.e. everything SQLite has to fake with a table
 * rebuild. The two dialects differ only in a handful of spellings
 * (auto-increment, `MODIFY`/`ALTER COLUMN`, drop-index syntax), captured by
 * the `NativeAlterOptions` hooks; the create/alter/index/foreign-key
 * plumbing is identical and lives here.
 */
export interface NativeAlterOptions {
  dialect: Dialect;

  /** Apply the auto-increment modifier to a Kysely column builder. */
  autoIncrement(col: any): any;

  /**
   * Drop an index by name. MySQL needs the owning table (`ALTER TABLE t
   * DROP INDEX i`); Postgres drops indexes globally (`DROP INDEX i`).
   */
  dropIndex(db: Kysely<any>, table: string, name: string): Promise<void>;

  /** Change an existing column's type/modifiers in place. */
  changeColumn(db: Kysely<any>, table: string, def: ColumnDefinition): Promise<void>;

  /** Drop a (named or implicit) primary key constraint. */
  dropPrimary(db: Kysely<any>, table: string, name?: string): Promise<void>;

  /** Drop a named foreign key constraint. */
  dropForeign(db: Kysely<any>, table: string, name: string): Promise<void>;

  /** Whether this engine supports `fullText` indexes (MySQL yes, PG no). */
  supportsFullText: boolean;
}

function normalizeDefault(value: unknown, dialect: Dialect): unknown {
  // MySQL stores booleans as tinyint(1); Postgres has a real boolean type
  // and rejects an integer default on it, so only coerce for MySQL.
  if (typeof value === "boolean" && dialect === "mysql") {
    return value ? 1 : 0;
  }

  return value;
}

/**
 * Restricts an `enum` column to its declared values with a `CHECK`.
 *
 * MySQL has a native `enum(...)` type that enforces this itself, and
 * SQLite is typeless. Postgres has neither: `postgresType()` compiles
 * an enum to a plain `varchar` (a native PG enum would mean owning a
 * `CREATE TYPE` and its migration lifecycle), which on its own accepts
 * *any* string, so a column declared `enum("status", ["draft",
 * "live"])` silently allowed `"banana"`. The CHECK restores the
 * constraint the declaration promises.
 */
function applyEnumCheck(col: any, def: ColumnDefinition, opts: NativeAlterOptions): any {
  if (opts.dialect !== "postgres" || def.laravelType !== "enum") {
    return col;
  }

  const allowed = def.allowed ?? [];

  if (allowed.length === 0) {
    return col;
  }

  const values = allowed.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");

  return col.check(sql.raw(`${quoteDoubleQuoted(def.name)} in (${values})`));
}

function applyColumnModifiers(
  col: any,
  def: ColumnDefinition,
  opts: NativeAlterOptions,
  options?: { skipPrimary?: boolean },
): any {
  const skipPrimary = options?.skipPrimary ?? false;

  if (!skipPrimary) {
    if (def.autoIncrementFlag) {
      col = opts.autoIncrement(col.primaryKey());
    } else if (def.primaryFlag) {
      col = col.primaryKey();
    }
  } else if (def.autoIncrementFlag) {
    col = opts.autoIncrement(col);
  }

  if (!def.nullableFlag) {
    col = col.notNull();
  }

  if (def.useCurrentFlag) {
    col = col.defaultTo(sql`CURRENT_TIMESTAMP`);
  } else if (def.hasDefault) {
    col = col.defaultTo(normalizeDefault(def.defaultValue, opts.dialect));
  }

  if (def.storedAsExpr) {
    col = col.generatedAlwaysAs(sql.raw(def.storedAsExpr)).stored();
  } else if (def.virtualAsExpr) {
    col = col.generatedAlwaysAs(sql.raw(def.virtualAsExpr));
  }

  return applyEnumCheck(col, def, opts);
}

function namedUnique(table: string, columns: string[], name?: string | true): string {
  return typeof name === "string" ? name : createIndexName(table, "unique", columns);
}

function namedIndex(table: string, columns: string[], name?: string | true): string {
  return typeof name === "string" ? name : createIndexName(table, "index", columns);
}

function namedFullText(table: string, columns: string[], name?: string): string {
  return name ?? createIndexName(table, "fulltext", columns);
}

function namedPrimary(table: string, columns: string[], name?: string): string {
  return name ?? createIndexName(table, "primary", columns);
}

function namedForeign(table: string, columns: string[], name?: string): string {
  return name ?? createIndexName(table, "foreign", columns);
}

function collectForeignKeys(blueprint: Blueprint): ForeignKeyDefinition[] {
  const fks = [...blueprint.foreignKeys];

  for (const col of blueprint.columns) {
    if (col.foreignKey) {
      fks.push(col.foreignKey);
    }
  }

  return fks;
}

function assertSupportedIndexes(indexes: IndexCommand[], opts: NativeAlterOptions): void {
  for (const idx of indexes) {
    if (idx.kind === "fullText" && !opts.supportsFullText) {
      throw new Error(`fullText indexes are not supported on ${opts.dialect}.`);
    }

    if (idx.kind === "spatialIndex") {
      throw new Error(`spatialIndex is not supported on ${opts.dialect}.`);
    }
  }
}

interface PlainIndex {
  name: string;
  columns: string[];
  unique: boolean;
  fullText?: boolean;
}

function collectIndexes(blueprint: Blueprint, columns: ColumnDefinition[]): PlainIndex[] {
  const table = blueprint.table;
  const out: PlainIndex[] = [];

  for (const col of columns) {
    if (col.uniqueIndex) {
      out.push({
        name: namedUnique(table, [col.name], col.uniqueIndex),
        columns: [col.name],
        unique: true,
      });
    }

    if (col.nonUniqueIndex) {
      out.push({
        name: namedIndex(table, [col.name], col.nonUniqueIndex),
        columns: [col.name],
        unique: false,
      });
    }
  }

  for (const idx of blueprint.indexes) {
    if (idx.kind === "unique") {
      out.push({
        name: namedUnique(table, idx.columns, idx.name),
        columns: idx.columns,
        unique: true,
      });
    } else if (idx.kind === "index") {
      out.push({
        name: namedIndex(table, idx.columns, idx.name),
        columns: idx.columns,
        unique: false,
      });
    } else if (idx.kind === "fullText") {
      out.push({
        name: namedFullText(table, idx.columns, idx.name),
        columns: idx.columns,
        unique: false,
        fullText: true,
      });
    }
  }

  return out;
}

async function createIndex(db: Kysely<any>, table: string, idx: PlainIndex): Promise<void> {
  if (idx.fullText) {
    // Kysely has no cross-dialect fullText builder; emit raw (MySQL only).
    const cols = idx.columns.map((c) => quoteBacktick(c)).join(", ");
    await sql
      .raw(`CREATE FULLTEXT INDEX ${quoteBacktick(idx.name)} ON ${quoteBacktick(table)} (${cols})`)
      .execute(db);

    return;
  }

  let create: any = db.schema.createIndex(idx.name).on(table).columns(idx.columns);

  if (idx.unique) {
    create = create.unique();
  }

  await create.execute();
}

export function makeNativeAlterGrammar(opts: NativeAlterOptions) {
  async function compileCreate(db: Kysely<any>, blueprint: Blueprint): Promise<void> {
    assertSupportedIndexes(blueprint.indexes, opts);
    const table = blueprint.table;

    if (blueprint.columns.some((c) => c.changing)) {
      throw new Error(
        `Column.change() is only valid inside Schema.table(), not Schema.create(), for "${table}".`,
      );
    }

    let builder: any = db.schema.createTable(table);

    const compositePrimary = blueprint.indexes.filter((i) => i.kind === "primary");
    const skipColumnPrimary = compositePrimary.length > 0;

    for (const col of blueprint.columns) {
      builder = builder.addColumn(col.name, compileColumnType(col, opts.dialect), (c: any) =>
        applyColumnModifiers(c, col, opts, { skipPrimary: skipColumnPrimary }),
      );
    }

    for (const pk of compositePrimary) {
      builder = builder.addPrimaryKeyConstraint(
        namedPrimary(table, pk.columns, pk.name),
        pk.columns,
      );
    }

    for (const fk of collectForeignKeys(blueprint)) {
      if (!fk.referencedTable) {
        throw new Error(`Foreign key on ${table}(${fk.columns.join(", ")}) is missing .on(table).`);
      }

      builder = builder.addForeignKeyConstraint(
        namedForeign(table, fk.columns, fk.constraintName),
        fk.columns,
        fk.referencedTable,
        fk.referencedColumns,
        (cb: any) => {
          if (fk.onDeleteAction) {
            cb = cb.onDelete(fk.onDeleteAction);
          }

          if (fk.onUpdateAction) {
            cb = cb.onUpdate(fk.onUpdateAction);
          }

          return cb;
        },
      );
    }

    await builder.execute();

    for (const idx of collectIndexes(blueprint, blueprint.columns)) {
      await createIndex(db, table, idx);
    }
  }

  async function compileAlter(db: Kysely<any>, blueprint: Blueprint): Promise<void> {
    assertSupportedIndexes(blueprint.indexes, opts);
    const table = blueprint.table;

    const added = blueprint.columns.filter((c) => !c.changing);
    const changed = blueprint.columns.filter((c) => c.changing);

    for (const col of added) {
      await db.schema
        .alterTable(table)
        .addColumn(col.name, compileColumnType(col, opts.dialect), (c: any) =>
          applyColumnModifiers(c, col, opts),
        )
        .execute();
    }

    for (const def of changed) {
      await opts.changeColumn(db, table, def);
    }

    for (const { from, to } of blueprint.renameColumns) {
      await db.schema.alterTable(table).renameColumn(from, to).execute();
    }

    // Indexes come off BEFORE the columns they cover. A `down()` written
    // as the mirror of its `up()` drops both in one call, and an index
    // outliving its column is either an error (SQLite refuses to rebuild
    // the table) or a dangling object. The reverse ordering cannot be
    // needed: nothing here creates an index on a column being dropped in
    // the same call, since `collectIndexes()` runs against the added ones.
    for (const name of blueprint.droppedIndexes) {
      await opts.dropIndex(db, table, name);
    }

    for (const col of blueprint.droppedColumns) {
      await db.schema.alterTable(table).dropColumn(col).execute();
    }

    // Primary key added via alter (composite).
    for (const idx of blueprint.indexes) {
      if (idx.kind === "primary") {
        await db.schema
          .alterTable(table)
          .addPrimaryKeyConstraint(namedPrimary(table, idx.columns, idx.name), idx.columns as any)
          .execute();
      }
    }

    for (const idx of collectIndexes(blueprint, added)) {
      await createIndex(db, table, idx);
    }

    for (const fk of collectForeignKeys(blueprint)) {
      if (!fk.referencedTable) {
        throw new Error(
          `Foreign key on "${table}" (${fk.columns.join(", ")}) has no referenced table — call .references(...).on(...).`,
        );
      }

      await db.schema
        .alterTable(table)
        .addForeignKeyConstraint(
          namedForeign(table, fk.columns, fk.constraintName),
          fk.columns as any,
          fk.referencedTable,
          fk.referencedColumns,
          (cb: any) => {
            if (fk.onDeleteAction) {
              cb = cb.onDelete(fk.onDeleteAction);
            }

            if (fk.onUpdateAction) {
              cb = cb.onUpdate(fk.onUpdateAction);
            }

            return cb;
          },
        )
        .execute();
    }

    for (const name of blueprint.dropForeigns) {
      await opts.dropForeign(db, table, name);
    }

    for (const dp of blueprint.dropPrimaries) {
      await opts.dropPrimary(db, table, dp.name);
    }

    if (blueprint.renameTo) {
      await db.schema.alterTable(table).renameTo(blueprint.renameTo).execute();
    }
  }

  return { compileCreate, compileAlter };
}
