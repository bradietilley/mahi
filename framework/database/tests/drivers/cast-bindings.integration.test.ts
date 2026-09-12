import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "@mahiframework/datetime";
import { ENGINES, EngineHarness, engineAvailable } from "../support/drivers.js";
import { Model } from "../../src/model.js";
import { Cast } from "../../src/casts.js";
import type { Blueprint } from "../../src/schema/blueprint.js";

/**
 * Casts applied to query BINDINGS, on every engine.
 *
 * The builder used to pass values straight through to `QueryBuilder`, so a
 * `boolean`-cast column bound `true` rather than `1` and a JSON column
 * bound a live JS object. `EloquentBuilder.castBinding()` now closes that,
 * and this file is the multi-engine proof — the SQLite-only suites cannot
 * see this bug class, because SQLite coerces at the driver boundary and
 * finds the row whether or not the cast ran.
 *
 * The shape of most tests is the same on purpose: write a row through the
 * model (so the write path casts), then find it through a *binding* (so the
 * read path must cast identically). A mismatch means zero rows, which is
 * the production symptom — a silently empty result, not an error.
 *
 * **There are two layers here, and the tests distinguish them.** Deleting
 * `castBinding()`'s body fails 14 of these, but the boolean and `DateTime`
 * `where()` cases keep passing, because `QueryBuilder.normalize()` →
 * `normalizeBinding()` independently converts `DateTime`/`Date`/`bigint`
 * and models-with-keys per dialect. So temporal bindings have a second,
 * dialect-aware safety net and JSON/array/decimal/enum do not — those are
 * carried by the cast layer alone, which is why they are the ones that
 * break. Worth knowing before "simplifying" either layer: neither is
 * redundant, and their coverage only partly overlaps.
 *
 * Kept separate from `cross-dialect.integration.test.ts` because that file
 * is about SQL this framework spells per dialect, whereas this one is about
 * values crossing into bindings. Its own scratch database, per
 * `withDatabase()`.
 */
for (const engine of ENGINES) {
  const available = await engineAvailable(engine);
  const suite = available ? describe : describe.skip;

  suite(`cast bindings (${engine.name})`, () => {
    let h: EngineHarness;

    interface WidgetAttributes {
      id: number;
      name: string;
      published: boolean;
      quantity: number;
      price: string;
      meta: Record<string, unknown>;
      tags: string[];
      status: "draft" | "live";
      published_at: DateTime | null;
    }

    class Widget extends Model<WidgetAttributes>()({
      table: "cast_widgets",
      primaryKey: "id",
      timestamps: false,
      casts: {
        published: Cast.boolean(),
        quantity: Cast.integer(),
        price: Cast.decimal(2),
        meta: Cast.json<Record<string, unknown>>(),
        tags: Cast.array<string>(),
        status: Cast.enum(["draft", "live"] as const),
        published_at: Cast.datetime(),
      },
    }) {}

    beforeAll(async () => {
      h = await EngineHarness.start(engine, "cast-bindings");

      await h.create("cast_widgets", (t: Blueprint) => {
        t.increments("id");
        t.string("name");
        t.boolean("published").default(false);
        t.integer("quantity").default(0);
        t.decimal("price", 8, 2).default(0);
        t.json("meta").nullable();
        t.json("tags").nullable();
        t.string("status").default("draft");
        t.timestamp("published_at").nullable();
      });
    });

    afterEach(async () => {
      await h.truncate();
    });

    afterAll(async () => {
      await h?.stop();
    });

    /** A saved row with sensible defaults, overridable per test. */
    async function makeWidget(overrides: Partial<WidgetAttributes> = {}): Promise<Widget> {
      return Widget.create({
        name: "widget",
        published: true,
        quantity: 5,
        price: "19.99",
        meta: { colour: "red" },
        tags: ["a", "b"],
        status: "live",
        published_at: DateTime.parse("2026-03-04T05:06:07.000Z"),
        ...overrides,
      } as never);
    }

    describe("boolean", () => {
      it("binds a boolean in where()", async () => {
        await makeWidget({ published: true });
        await makeWidget({ name: "other", published: false });

        const found = (await Widget.query().where("published", "=", true).get()).toArray();

        expect(found).toHaveLength(1);
        expect(found[0]?.name).toBe("widget");
      });

      it("binds false, which must not be confused with a missing binding", async () => {
        await makeWidget({ published: true });
        await makeWidget({ name: "other", published: false });

        const found = (await Widget.query().where("published", "=", false).get()).toArray();

        expect(found).toHaveLength(1);
        expect(found[0]?.name).toBe("other");
      });

      it("binds a boolean in whereIn()", async () => {
        await makeWidget({ published: true });

        expect((await Widget.query().whereIn("published", [true]).get()).toArray()).toHaveLength(1);
        expect((await Widget.query().whereIn("published", [false]).get()).toArray()).toHaveLength(
          0,
        );
      });

      it("round-trips a boolean through update()", async () => {
        const widget = await makeWidget({ published: true });

        await Widget.query()
          .where("id", "=", widget.id)
          .update({ published: false } as never);

        expect((await Widget.query().where("published", "=", false).get()).toArray()).toHaveLength(
          1,
        );
        expect((await Widget.find(widget.id))?.published).toBe(false);
      });
    });

    describe("datetime", () => {
      it("binds a DateTime in where()", async () => {
        // The MySQL case: `DateTimeCast` produces an ISO string with a `Z`
        // suffix, which MySQL rejects outright.
        const at = DateTime.parse("2026-03-04T05:06:07.000Z");
        await makeWidget({ published_at: at });

        const found = (await Widget.query().where("published_at", "=", at).get()).toArray();

        expect(found).toHaveLength(1);
      });

      it("binds a DateTime in a range comparison", async () => {
        await makeWidget({ published_at: DateTime.parse("2026-03-04T05:06:07.000Z") });

        const before = DateTime.parse("2026-01-01T00:00:00.000Z");
        const after = DateTime.parse("2026-12-31T23:59:59.000Z");

        expect(
          (await Widget.query().where("published_at", ">", before).get()).toArray(),
        ).toHaveLength(1);
        expect(
          (await Widget.query().where("published_at", "<", before).get()).toArray(),
        ).toHaveLength(0);
        expect(
          (await Widget.query().whereBetween("published_at", before, after).get()).toArray(),
        ).toHaveLength(1);
        expect(
          (await Widget.query().whereNotBetween("published_at", before, after).get()).toArray(),
        ).toHaveLength(0);
      });

      it("round-trips a DateTime through update()", async () => {
        const widget = await makeWidget();
        const moved = DateTime.parse("2027-07-08T09:10:11.000Z");

        await Widget.query()
          .where("id", "=", widget.id)
          .update({ published_at: moved } as never);

        const reloaded = await Widget.find(widget.id);
        expect(reloaded?.published_at?.setTimezone("UTC").toISOString()).toBe(
          moved.setTimezone("UTC").toISOString(),
        );
      });

      it("binds null without casting it", async () => {
        await makeWidget({ published_at: null });
        await makeWidget({ name: "dated" });

        const found = (await Widget.query().whereNull("published_at").get()).toArray();

        expect(found).toHaveLength(1);
        expect(found[0]?.name).toBe("widget");
      });
    });

    describe("json and array", () => {
      it("serialises an object and an array into the binding", async () => {
        // The cast's whole job: the value must reach the driver as text,
        // not as a JS object. Asserted on the compiled SQL because whether
        // the query then MATCHES is an engine-specific question — see the
        // next test.
        expect(Widget.query().where("meta", "=", { colour: "red" }).getBindings()).toEqual([
          '{"colour":"red"}',
        ]);
        expect(Widget.query().where("tags", "=", ["a", "b"]).getBindings()).toEqual(['["a","b"]']);
      });

      it("cannot compare a whole json column with = portably", async () => {
        // Documented rather than worked around, because the binding is
        // correct on all three engines and the divergence is in SQL
        // semantics: SQLite stores JSON as text so `=` against the
        // serialised string matches; MySQL requires `CAST(? AS JSON)` and
        // quietly returns zero rows without it; Postgres's `json` type has
        // no equality operator at all and raises 42883.
        //
        // Query a JSON column by extracting a path, not by comparing the
        // whole document.
        await makeWidget({ meta: { colour: "red" } });

        const run = async () =>
          (await Widget.query().where("meta", "=", { colour: "red" }).get()).toArray();

        if (engine.name === "sqlite") {
          expect(await run()).toHaveLength(1);
        } else if (engine.name === "mysql") {
          expect(await run()).toHaveLength(0);
        } else {
          await expect(run()).rejects.toThrow(/operator does not exist/i);
        }
      });

      it("round-trips json through update()", async () => {
        const widget = await makeWidget();

        await Widget.query()
          .where("id", "=", widget.id)
          .update({ meta: { colour: "blue", size: 3 } } as never);

        expect((await Widget.find(widget.id))?.meta).toEqual({ colour: "blue", size: 3 });
      });
    });

    describe("numeric and enum", () => {
      it("binds a decimal, which the cast renders to fixed precision", async () => {
        await makeWidget({ price: "19.99" });

        expect((await Widget.query().where("price", "=", "19.99").get()).toArray()).toHaveLength(1);
      });

      it("binds an integer given as a string", async () => {
        await makeWidget({ quantity: 5 });

        expect(
          (
            await Widget.query()
              .where("quantity", "=", "5" as never)
              .get()
          ).toArray(),
        ).toHaveLength(1);
      });

      it("binds enum members in whereIn()", async () => {
        await makeWidget({ status: "live" });
        await makeWidget({ name: "draft one", status: "draft" });

        expect((await Widget.query().whereIn("status", ["live"]).get()).toArray()).toHaveLength(1);
        expect(
          (await Widget.query().whereIn("status", ["draft", "live"]).get()).toArray(),
        ).toHaveLength(2);
      });
    });

    describe("write paths", () => {
      it("casts through insert()", async () => {
        await Widget.query().insert({
          name: "inserted",
          published: true,
          quantity: 2,
          price: "1.50",
          meta: { a: 1 },
          tags: ["x"],
          status: "draft",
          published_at: DateTime.parse("2026-05-06T07:08:09.000Z"),
        } as never);

        const found = (await Widget.query().where("published", "=", true).get()).toArray();

        expect(found).toHaveLength(1);
        expect(found[0]?.meta).toEqual({ a: 1 });
        expect(found[0]?.tags).toEqual(["x"]);
      });

      it("casts through upsert()", async () => {
        const widget = await makeWidget({ published: false });

        await Widget.query().upsert(
          [
            {
              id: widget.id,
              name: "widget",
              published: true,
              quantity: 9,
              price: "2.50",
              meta: { a: 2 },
              tags: ["y"],
              status: "live",
              published_at: DateTime.parse("2026-05-06T07:08:09.000Z"),
            },
          ] as never,
          "id",
          ["published", "quantity"],
        );

        const reloaded = await Widget.find(widget.id);
        expect(reloaded?.published).toBe(true);
        expect(reloaded?.quantity).toBe(9);
      });

      it("casts through updateOrInsert()", async () => {
        await Widget.query().updateOrInsert(
          { name: "widget" } as never,
          {
            name: "widget",
            published: true,
            quantity: 1,
            price: "3.50",
            meta: {},
            tags: [],
            status: "draft",
            published_at: DateTime.parse("2026-05-06T07:08:09.000Z"),
          } as never,
        );

        expect((await Widget.query().where("published", "=", true).get()).toArray()).toHaveLength(
          1,
        );
      });
    });

    describe("the two binding layers", () => {
      it("normalises a DateTime even for an uncast column", async () => {
        // `QueryBuilder.normalize()` handles DateTime independently of the
        // model's casts, which is why the temporal `where()` cases survive
        // a broken `castBinding()`. Pinned so the distinction is not lost:
        // `name` declares no cast at all, yet a DateTime bound against it
        // still reaches the driver as an engine-appropriate string.
        const at = DateTime.parse("2026-03-04T05:06:07.000Z");
        const bindings = Widget.query()
          .where("name" as never, "=", at as never)
          .getBindings();

        expect(bindings).toHaveLength(1);
        expect(typeof bindings[0]).toBe("string");

        // MySQL rejects the ISO `Z` suffix, so the dialect must have
        // rewritten it rather than passing DateTimeCast's output through.
        if (engine.name === "mysql") {
          expect(bindings[0]).not.toMatch(/Z$/);
        }
      });

      it("leaves a cast column to the cast layer", async () => {
        // The other half: nothing in `normalizeBinding()` knows about JSON,
        // so this binding is the cast's work alone.
        expect(Widget.query().where("meta", "=", { a: 1 }).getBindings()).toEqual(['{"a":1}']);
      });
    });

    describe("the read and write paths agree", () => {
      it("finds every row it wrote, by every cast column", async () => {
        // The regression this file exists for. Each of these binds a cast
        // value against a value the write path stored, so any asymmetry
        // between the two shows up as zero rows on at least one engine.
        const at = DateTime.parse("2026-03-04T05:06:07.000Z");
        await makeWidget({ published_at: at });

        // JSON columns are excluded deliberately: `=` against a whole
        // document is not portable (see above), so a round-trip through
        // them would be testing SQL semantics rather than the bindings.
        const byColumn: Array<[string, unknown]> = [
          ["published", true],
          ["quantity", 5],
          ["price", "19.99"],
          ["status", "live"],
          ["published_at", at],
        ];

        for (const [column, value] of byColumn) {
          const found = (
            await Widget.query()
              .where(column as never, "=", value as never)
              .get()
          ).toArray();

          expect(found, `where(${column}) found no row`).toHaveLength(1);
        }
      });
    });
  });
}
