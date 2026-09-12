import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import { DatabaseManager } from "../src/database-manager.js";
import { DATABASE_TOKEN, SCHEMA_TOKEN } from "../src/database-service-provider.js";
import { SqliteDriver } from "../src/drivers/sqlite-driver.js";
import { SchemaBuilder } from "../src/schema/schema-builder.js";
import { Schema } from "../src/schema/schema-facade.js";
import type { Blueprint } from "../src/schema/blueprint.js";

function freshBuilder() {
  const driver = new SqliteDriver({ filename: ":memory:" });

  return { driver, db: driver.kysely, schema: new SchemaBuilder(driver.kysely) };
}

function bootSchemaApp() {
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

  return { driver, application };
}

describe("SchemaBuilder", () => {
  it("creates, reports, and drops tables", async () => {
    const { schema } = freshBuilder();

    expect(await schema.hasTable("users")).toBe(false);

    await schema.create("users", (table: Blueprint) => {
      table.id();
      table.string("email");
    });

    expect(await schema.hasTable("users")).toBe(true);
    expect(await schema.hasColumn("users", "email")).toBe(true);
    expect(await schema.hasColumn("users", "missing")).toBe(false);
    expect(await schema.hasColumn("nope", "email")).toBe(false);

    await schema.drop("users");
    expect(await schema.hasTable("users")).toBe(false);
  });

  it("dropIfExists is a no-op when the table is missing", async () => {
    const { schema } = freshBuilder();
    await schema.dropIfExists("ghost");
    expect(await schema.hasTable("ghost")).toBe(false);
  });

  it("renames a table", async () => {
    const { schema } = freshBuilder();
    await schema.create("people", (table: Blueprint) => {
      table.id();
    });
    await schema.rename("people", "humans");
    expect(await schema.hasTable("people")).toBe(false);
    expect(await schema.hasTable("humans")).toBe(true);
  });

  it("dropAllTables removes user tables", async () => {
    const { schema } = freshBuilder();
    await schema.create("a", (table: Blueprint) => {
      table.id();
    });
    await schema.create("b", (table: Blueprint) => {
      table.id();
    });
    await schema.dropAllTables();
    expect(await schema.hasTable("a")).toBe(false);
    expect(await schema.hasTable("b")).toBe(false);
  });
});

describe("Schema facade", () => {
  beforeEach(() => {
    clearCurrentApp();
  });

  afterEach(() => {
    clearCurrentApp();
  });

  it("throws when no Application has bootstrapped yet, same as app()", () => {
    expect(() => Schema.create("users", () => {})).toThrow(
      /No Application instance is currently registered/,
    );
  });

  it("runs the Laravel-identical Schema/Blueprint examples end-to-end", async () => {
    const { driver } = bootSchemaApp();

    await Schema.create("users", (table: Blueprint) => {
      table.id();
      table.string("name");
      table.string("email").unique();
      table.string("password");
      table.timestamps();
      table.softDeletes();
    });

    expect(await Schema.hasTable("users")).toBe(true);
    expect(await Schema.hasColumn("users", "password")).toBe(true);
    expect(await Schema.hasColumn("users", "deleted_at")).toBe(true);

    await driver.kysely
      .insertInto("users" as any)
      .values({ name: "Ada", email: "ada@example.com", password: "secret" })
      .execute();

    await Schema.table("users", (table: Blueprint) => {
      table.string("name", 255).nullable().change();
      table.dropColumn("password");
      table.dropSoftDeletes();
      table.index(["email"]);
    });

    expect(await Schema.hasColumn("users", "password")).toBe(false);
    expect(await Schema.hasColumn("users", "deleted_at")).toBe(false);
    expect(await Schema.hasColumn("users", "name")).toBe(true);

    const tables = await driver.kysely.introspection.getTables();
    const users = tables.find((t) => t.name === "users");
    const nameCol = users?.columns.find((c) => c.name === "name");
    expect(nameCol?.isNullable).toBe(true);

    const row = await driver.kysely
      .selectFrom("users" as any)
      .selectAll()
      .executeTakeFirst();
    expect(row).toMatchObject({ name: "Ada", email: "ada@example.com" });

    await Schema.drop("users");
    expect(await Schema.hasTable("users")).toBe(false);

    await Schema.dropIfExists("users");
  });
});
