import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { DatabaseDriver } from "../../src/drivers/driver.js";
import { ENGINES, engineAvailable, withDatabase, dropDatabase } from "../support/drivers.js";
import { SchemaBuilder } from "../../src/schema/schema-builder.js";
import { QueryBuilder } from "../../src/query-builder.js";
import type { Blueprint } from "../../src/schema/blueprint.js";
import {
  ForeignKeyConstraintViolationException,
  NotNullConstraintViolationException,
  UniqueConstraintViolationException,
} from "../../src/exceptions.js";

/**
 * These tests exercise the MySQL and Postgres drivers against the real
 * engines from the repo-root `docker-compose.yml`. They connect once per
 * suite; if the database isn't reachable (CI without docker), the whole
 * suite is skipped rather than failing — the SQLite suites already cover
 * the dialect-agnostic behaviour.
 *
 * Connection details, availability probing and the per-file scratch
 * database all come from `../support/drivers.ts`, which the cross-dialect
 * suite shares. The scratch database matters here specifically: this file
 * calls `dropAllTables()` repeatedly, and vitest runs test files in
 * parallel, so sharing one database with the cross-dialect suite meant
 * dropping tables out from under it.
 */

const engines = ENGINES.filter((e) => e.external);

for (const engine of engines) {
  describe(`${engine.name} driver`, async () => {
    const available = await engineAvailable(engine);
    const maybe = available ? describe : describe.skip;

    maybe(`${engine.name} (live)`, () => {
      let driver: DatabaseDriver;
      let schema: SchemaBuilder;
      let database: string | undefined;

      beforeAll(async () => {
        database = await withDatabase(engine, "mysql_postgres");
        driver = engine.make(database);
        await driver.connect?.();
        schema = new SchemaBuilder(driver.kysely, driver.dialect);
        await schema.dropAllTables();
      });

      afterAll(async () => {
        if (!driver) {
          return;
        }

        await schema.dropAllTables();
        await driver.disconnect?.();
        await dropDatabase(engine, database);
      });

      it("creates a table with an auto-increment PK and CRUD works", async () => {
        await schema.create("widgets", (t: Blueprint) => {
          t.id();
          t.string("name");
          t.integer("qty").default(0);
          t.boolean("active").default(true);
          t.timestamps();
        });

        expect(await schema.hasTable("widgets")).toBe(true);
        expect(await schema.hasColumn("widgets", "name")).toBe(true);

        const table = () => new QueryBuilder(() => driver.kysely, "widgets");

        await table().insert({ name: "Sprocket", qty: 3 } as any);

        const rows = await table().where("name", "Sprocket").get();
        expect(rows).toHaveLength(1);
        expect(String(rows[0]!.name)).toBe("Sprocket");

        await table()
          .where("name", "Sprocket")
          .update({ qty: 10 } as any);
        const updated = await table().where("name", "Sprocket").first();
        expect(Number(updated!.qty)).toBe(10);

        expect(await table().count()).toBe(1);
      });

      it("enforces a unique index and raises UniqueConstraintViolationException", async () => {
        await schema.create("accounts", (t: Blueprint) => {
          t.id();
          t.string("email").unique();
        });

        const table = () => new QueryBuilder(() => driver.kysely, "accounts");
        await table().insert({ email: "a@example.com" } as any);

        await expect(table().insert({ email: "a@example.com" } as any)).rejects.toBeInstanceOf(
          UniqueConstraintViolationException,
        );
      });

      it("raises NotNullConstraintViolationException for a null in a NOT NULL column", async () => {
        await schema.create("profiles", (t: Blueprint) => {
          t.id();
          t.string("handle");
        });

        const table = () => new QueryBuilder(() => driver.kysely, "profiles");
        await expect(table().insert({ handle: null } as any)).rejects.toBeInstanceOf(
          NotNullConstraintViolationException,
        );
      });

      it("enforces foreign keys and raises ForeignKeyConstraintViolationException", async () => {
        await schema.create("authors", (t: Blueprint) => {
          t.id();
          t.string("name");
        });
        await schema.create("books", (t: Blueprint) => {
          t.id();
          t.unsignedBigInteger("author_id");
          t.foreign("author_id").references("id").on("authors").cascadeOnDelete();
        });

        const books = () => new QueryBuilder(() => driver.kysely, "books");
        await expect(books().insert({ author_id: 99999 } as any)).rejects.toBeInstanceOf(
          ForeignKeyConstraintViolationException,
        );
      });

      it("adds and drops columns via ALTER TABLE in place", async () => {
        await schema.create("posts", (t: Blueprint) => {
          t.id();
          t.string("title");
          t.string("legacy").nullable();
        });

        await schema.table("posts", (t: Blueprint) => {
          t.text("body").nullable();
          t.dropColumn("legacy");
        });

        expect(await schema.hasColumn("posts", "body")).toBe(true);
        expect(await schema.hasColumn("posts", "legacy")).toBe(false);
      });

      it("dropAllTables clears the schema", async () => {
        await schema.create("temp_a", (t: Blueprint) => t.id());
        await schema.create("temp_b", (t: Blueprint) => t.id());
        await schema.dropAllTables();
        expect(await schema.hasTable("temp_a")).toBe(false);
        expect(await schema.hasTable("temp_b")).toBe(false);
      });

      it("round-trips a value through sql template execution", async () => {
        const result = await sql<{ one: number }>`SELECT 1 as one`.execute(driver.kysely);
        expect(Number(result.rows[0]!.one)).toBe(1);
      });

      it("dropAllTables drops FK-linked tables in any order (M10: session variable)", async () => {
        // The parent is created first, so it is dropped first — which
        // only works while FK enforcement is genuinely suspended for
        // the whole sequence, not just the connection the SET landed
        // on.
        await schema.create("m10_parent", (t: Blueprint) => t.id());
        await schema.create("m10_child", (t: Blueprint) => {
          t.id();
          t.unsignedBigInteger("parent_id");
          t.foreign("parent_id").references("id").on("m10_parent");
        });

        await schema.dropAllTables();
        expect(await schema.hasTable("m10_parent")).toBe(false);
        expect(await schema.hasTable("m10_child")).toBe(false);
      });

      it("dropForeign() removes the constraint (MySQL needs DROP FOREIGN KEY)", async () => {
        await schema.create("fk_parent", (t: Blueprint) => t.id());
        await schema.create("fk_child", (t: Blueprint) => {
          t.id();
          t.unsignedBigInteger("parent_id");
          t.foreign("parent_id").references("id").on("fk_parent");
        });

        const child = () => new QueryBuilder(() => driver.kysely, "fk_child");
        await expect(child().insert({ parent_id: 99999 } as any)).rejects.toBeInstanceOf(
          ForeignKeyConstraintViolationException,
        );

        await schema.table("fk_child", (t: Blueprint) => {
          t.dropForeign(["parent_id"]);
        });

        // With the constraint gone the orphan row is accepted.
        await child().insert({ parent_id: 99999 } as any);
        expect(await child().count()).toBe(1);
      });

      it("enum columns reject a value outside the declared set", async () => {
        await schema.create("enum_rows", (t: Blueprint) => {
          t.id();
          t.enum("status", ["draft", "live"]);
        });

        const rows = () => new QueryBuilder(() => driver.kysely, "enum_rows");
        await rows().insert({ status: "draft" } as any);
        expect(await rows().count()).toBe(1);

        // MySQL enforces this with its native enum type; Postgres needs
        // the CHECK constraint the grammar adds beside the varchar.
        await expect(rows().insert({ status: "banana" } as any)).rejects.toThrow();
      });
    });
  });
}
