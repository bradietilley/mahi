import { ForeignKeyDefinition } from "./foreign-key-definition.js";
import { inferTableFromForeignId } from "./types.js";

/**
 * Fluent per-column modifiers, mirroring
 * `Illuminate\Database\Schema\ColumnDefinition`.
 *
 * The concrete DDL type is NOT computed here — it depends on the target
 * dialect and on modifiers set after construction (`length`, `unsigned`,
 * `decimal` precision, `enum` values). The grammar resolves it at compile
 * time via `compileColumnType(def, dialect)`.
 */
export class ColumnDefinition {
  nullableFlag = false;
  primaryFlag = false;
  autoIncrementFlag = false;
  unsignedFlag = false;
  changing = false;
  useCurrentFlag = false;
  defaultValue: unknown;
  hasDefault = false;
  uniqueIndex: string | true | undefined;
  nonUniqueIndex: string | true | undefined;
  commentText?: string;
  afterColumn?: string;
  firstFlag = false;
  autoIncrementFrom?: number;
  storedAsExpr?: string;
  virtualAsExpr?: string;
  length?: number;
  total?: number;
  places?: number;
  /**
   * Fractional-seconds digits for a `time`/`dateTime`/`timestamp`
   * column, as passed to `timestamp(col, precision)`.
   *
   * `undefined` means the caller didn't ask, and each grammar applies
   * its own default (0 on MySQL/Postgres, matching Laravel; SQLite
   * stores text and ignores it). Set it to keep sub-second data — a
   * `timestamp(col)` column truncates to whole seconds on both server
   * engines, so a millisecond value written to it comes back rounded.
   */
  precision?: number;
  allowed?: string[];
  foreignKey?: ForeignKeyDefinition;

  constructor(
    public readonly name: string,
    public readonly laravelType: string,
  ) {}

  nullable(value = true): this {
    this.nullableFlag = value;

    return this;
  }

  default(value: unknown): this {
    this.defaultValue = value;
    this.hasDefault = true;

    return this;
  }

  unique(indexName?: string): this {
    this.uniqueIndex = indexName ?? true;

    return this;
  }

  primary(): this {
    this.primaryFlag = true;

    return this;
  }

  index(indexName?: string): this {
    this.nonUniqueIndex = indexName ?? true;

    return this;
  }

  unsigned(): this {
    this.unsignedFlag = true;

    return this;
  }

  autoIncrement(): this {
    this.autoIncrementFlag = true;
    this.primaryFlag = true;

    return this;
  }

  useCurrent(): this {
    this.useCurrentFlag = true;

    return this;
  }

  comment(text: string): this {
    this.commentText = text;

    return this;
  }

  change(): this {
    this.changing = true;

    return this;
  }

  after(column: string): this {
    this.afterColumn = column;

    return this;
  }

  first(): this {
    this.firstFlag = true;

    return this;
  }

  from(startingValue: number): this {
    this.autoIncrementFrom = startingValue;

    return this;
  }

  storedAs(expression: string): this {
    this.storedAsExpr = expression;

    return this;
  }

  virtualAs(expression: string): this {
    this.virtualAsExpr = expression;

    return this;
  }

  /**
   * Assume this column references `{table}.{column}` (default table inferred
   * from `foo_id` → `foos`). Returns the foreign-key fluent for
   * `onDelete` / `onUpdate` chaining.
   */
  constrained(table?: string, column = "id"): ForeignKeyDefinition {
    return this.references(column).on(table ?? inferTableFromForeignId(this.name));
  }

  references(column: string | string[]): ForeignKeyDefinition {
    this.foreignKey ??= new ForeignKeyDefinition([this.name]);

    return this.foreignKey.references(column);
  }
}
