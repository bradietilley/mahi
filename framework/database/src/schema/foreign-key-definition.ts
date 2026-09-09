import type { ReferentialAction } from "./types.js";
import { asColumnList } from "./types.js";

/**
 * Fluent foreign-key command, mirroring
 * `Illuminate\Database\Schema\ForeignKeyDefinition`.
 */
export class ForeignKeyDefinition {
  referencedTable?: string;
  referencedColumns: string[] = ["id"];
  onDeleteAction?: ReferentialAction;
  onUpdateAction?: ReferentialAction;
  constraintName?: string;

  constructor(
    public readonly columns: string[],
    name?: string,
  ) {
    this.constraintName = name;
  }

  references(columns: string | string[]): this {
    this.referencedColumns = asColumnList(columns);

    return this;
  }

  on(table: string): this {
    this.referencedTable = table;

    return this;
  }

  name(name: string): this {
    this.constraintName = name;

    return this;
  }

  onDelete(action: ReferentialAction): this {
    this.onDeleteAction = action;

    return this;
  }

  onUpdate(action: ReferentialAction): this {
    this.onUpdateAction = action;

    return this;
  }

  cascadeOnDelete(): this {
    return this.onDelete("cascade");
  }

  restrictOnDelete(): this {
    return this.onDelete("restrict");
  }

  nullOnDelete(): this {
    return this.onDelete("set null");
  }

  noActionOnDelete(): this {
    return this.onDelete("no action");
  }

  cascadeOnUpdate(): this {
    return this.onUpdate("cascade");
  }

  restrictOnUpdate(): this {
    return this.onUpdate("restrict");
  }

  nullOnUpdate(): this {
    return this.onUpdate("set null");
  }

  noActionOnUpdate(): this {
    return this.onUpdate("no action");
  }
}
