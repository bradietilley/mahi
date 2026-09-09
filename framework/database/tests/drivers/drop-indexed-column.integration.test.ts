import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ENGINES, EngineHarness, engineAvailable } from "../support/drivers.js";
import type { Blueprint } from "../../src/schema/blueprint.js";

/**
 * Dropping a column together with an index that covers it, in one
 * `Schema.table()` call — the shape every mirror-image `down()` takes.
 *
 * Cross-engine because the failure mode differs and only one engine is
 * loud about it: SQLite validates surviving indexes while rebuilding the
 * table and refuses ("error in index ... after drop column"), MySQL and
 * Postgres drop the index implicitly with the column. So the same bug is
 * a hard error on one engine and silent on the others, which is exactly
 * the kind of thing a SQLite-only suite certifies as working.
 */
for (const engine of ENGINES) {
  const available = await engineAvailable(engine);
  const suite = available ? describe : describe.skip;

  suite(`dropping an indexed column (${engine.name})`, () => {
    let h: EngineHarness;

    beforeAll(async () => {
      h = await EngineHarness.start(engine, "drop-indexed-column");
    });

    afterEach(async () => {
      await h.schema.drop("jobs");
    });

    afterAll(async () => {
      await h?.stop();
    });

    it("drops a composite index and one of its columns together", async () => {
      await h.create("jobs", (t: Blueprint) => {
        t.increments("id");
        t.string("queue");
        t.integer("available_at");
      });

      await h.schema.table("jobs", (t: Blueprint) => {
        t.index(["queue", "available_at"]);
      });

      await h.schema.table("jobs", (t: Blueprint) => {
        t.dropIndex(["queue", "available_at"]);
        t.dropColumn("queue");
      });

      expect(await h.schema.hasColumn("jobs", "queue")).toBe(false);
      expect(await h.schema.hasColumn("jobs", "available_at")).toBe(true);
    });

    it("does not depend on the order the two were called in", async () => {
      await h.create("jobs", (t: Blueprint) => {
        t.increments("id");
        t.string("slug");
      });

      await h.schema.table("jobs", (t: Blueprint) => {
        t.index(["slug"]);
      });

      await h.schema.table("jobs", (t: Blueprint) => {
        t.dropColumn("slug");
        t.dropIndex(["slug"]);
      });

      expect(await h.schema.hasColumn("jobs", "slug")).toBe(false);
    });
  });
}
