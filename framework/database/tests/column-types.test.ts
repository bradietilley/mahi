import { describe, expect, it } from "vitest";
import { ColumnDefinition } from "../src/schema/column-definition.js";
import { compileColumnType } from "../src/schema/grammars/column-types.js";
import type { Dialect } from "../src/schema/dialect.js";

function column(laravelType: string, mutate?: (d: ColumnDefinition) => void): ColumnDefinition {
  const def = new ColumnDefinition("col", laravelType);
  mutate?.(def);

  return def;
}

// Read the raw SQL out of the sql.raw expression node.
function raw(def: ColumnDefinition, dialect: Dialect): string {
  const node: any = (compileColumnType(def, dialect) as any).toOperationNode();

  // RawNode stores its literal in `sqlFragments`.
  return (node.sqlFragments ?? []).join("");
}

describe("compileColumnType", () => {
  it("maps sqlite affinities", () => {
    expect(raw(column("string"), "sqlite")).toBe("text");
    expect(raw(column("integer"), "sqlite")).toBe("integer");
    expect(raw(column("boolean"), "sqlite")).toBe("integer");
    expect(raw(column("binary"), "sqlite")).toBe("blob");
    expect(raw(column("decimal"), "sqlite")).toBe("numeric");
  });

  it("maps mysql types with length/precision", () => {
    expect(
      raw(
        column("string", (d) => (d.length = 100)),
        "mysql",
      ),
    ).toBe("varchar(100)");
    expect(raw(column("string"), "mysql")).toBe("varchar(255)");
    expect(raw(column("boolean"), "mysql")).toBe("tinyint(1)");
    expect(
      raw(
        column("bigInteger", (d) => d.unsigned()),
        "mysql",
      ),
    ).toBe("bigint unsigned");
    expect(
      raw(
        column("decimal", (d) => {
          d.total = 12;
          d.places = 4;
        }),
        "mysql",
      ),
    ).toBe("decimal(12, 4)");
    expect(
      raw(
        column("enum", (d) => (d.allowed = ["a", "b"])),
        "mysql",
      ),
    ).toBe("enum('a', 'b')");
  });

  it("maps postgres types including serial for auto-increment", () => {
    expect(raw(column("id"), "postgres")).toBe("bigserial");
    expect(raw(column("increments"), "postgres")).toBe("serial");
    expect(
      raw(
        column("string", (d) => (d.length = 64)),
        "postgres",
      ),
    ).toBe("varchar(64)");
    expect(raw(column("boolean"), "postgres")).toBe("boolean");
    expect(raw(column("binary"), "postgres")).toBe("bytea");
    expect(raw(column("json"), "postgres")).toBe("json");
    expect(raw(column("jsonb"), "postgres")).toBe("jsonb");
    expect(raw(column("uuid"), "postgres")).toBe("uuid");
  });

  it("throws on an unknown type per dialect", () => {
    expect(() => raw(column("nonsense"), "mysql")).toThrow(/Unknown Blueprint column type/);
    expect(() => raw(column("nonsense"), "postgres")).toThrow(/Unknown Blueprint column type/);
    expect(() => raw(column("nonsense"), "sqlite")).toThrow(/Unknown Blueprint column type/);
  });
});
