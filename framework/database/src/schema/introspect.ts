import { sql, type Kysely } from "kysely";
import { quoteDoubleQuoted } from "./quote-identifier.js";

export interface IntrospectedColumn {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  pk: number;
  autoIncrement: boolean;
}

export interface IntrospectedIndex {
  name: string;
  unique: boolean;
  origin: string;
  columns: string[];
  sql: string | null;
}

export interface IntrospectedForeignKey {
  id: number;
  table: string;
  from: string;
  to: string;
  onUpdate: string;
  onDelete: string;
}

export interface TableSnapshot {
  name: string;
  columns: IntrospectedColumn[];
  indexes: IntrospectedIndex[];
  foreignKeys: IntrospectedForeignKey[];
}

export async function introspectTable(db: Kysely<any>, table: string): Promise<TableSnapshot> {
  const ident = quoteDoubleQuoted(table);

  const info = await sql<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>`PRAGMA table_info(${sql.raw(ident)})`.execute(db);

  const tables = await db.introspection.getTables();
  const meta = tables.find((t) => t.name === table);
  const autoCols = new Set(
    (meta?.columns ?? []).filter((c) => c.isAutoIncrementing).map((c) => c.name),
  );

  const columns: IntrospectedColumn[] = info.rows.map((row) => ({
    name: row.name,
    type: row.type || "TEXT",
    notNull: row.notnull === 1,
    defaultValue: row.dflt_value,
    pk: row.pk,
    autoIncrement: autoCols.has(row.name),
  }));

  const indexList = await sql<{
    name: string;
    unique: number;
    origin: string;
  }>`PRAGMA index_list(${sql.raw(ident)})`.execute(db);

  const indexSqlRows = await sql<{ name: string; sql: string | null }>`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = ${table}
  `.execute(db);
  const sqlByName = new Map(indexSqlRows.rows.map((r) => [r.name, r.sql]));

  const indexes: IntrospectedIndex[] = [];

  for (const idx of indexList.rows) {
    const idxIdent = quoteDoubleQuoted(idx.name);
    const cols = await sql<{ name: string }>`PRAGMA index_info(${sql.raw(idxIdent)})`.execute(db);
    indexes.push({
      name: idx.name,
      unique: idx.unique === 1,
      origin: idx.origin,
      columns: cols.rows.map((c) => c.name),
      sql: sqlByName.get(idx.name) ?? null,
    });
  }

  const fkRows = await sql<{
    id: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
  }>`PRAGMA foreign_key_list(${sql.raw(ident)})`.execute(db);

  return {
    name: table,
    columns,
    indexes,
    foreignKeys: fkRows.rows.map((fk) => ({
      id: fk.id,
      table: fk.table,
      from: fk.from,
      to: fk.to,
      onUpdate: fk.on_update,
      onDelete: fk.on_delete,
    })),
  };
}
