import { describe, expect, it } from "vitest";
import { Resource, normalizeResourceValue } from "../src/resource.js";

interface FakeModel {
  id: string;
  title: string;
  done: number;
}

interface FakeJson {
  id: string;
  title: string;
  done: boolean;
}

class FakeResource extends Resource<FakeModel, FakeJson> {
  toJson(): FakeJson {
    return {
      id: this.model.id,
      title: this.model.title,
      done: this.model.done === 1,
    };
  }
}

describe("Resource", () => {
  it("toJson() transforms the model into the declared shape", () => {
    const resource = new FakeResource({ id: "1", title: "Test", done: 1 });
    expect(resource.toJson()).toEqual({ id: "1", title: "Test", done: true });
  });

  it("collection() maps an array of models through toJson()", async () => {
    const rows: FakeModel[] = [
      { id: "1", title: "A", done: 0 },
      { id: "2", title: "B", done: 1 },
    ];

    const shapes = await FakeResource.collection(rows);

    expect(shapes).toEqual([
      { id: "1", title: "A", done: false },
      { id: "2", title: "B", done: true },
    ]);
  });

  it("collection() on an empty array returns an empty array", async () => {
    expect(await FakeResource.collection([])).toEqual([]);
  });
});

interface RelRow {
  id: string;
  author?: { id: string; name: string };
  tags?: { id: string }[];
  bio?: string | null;
  secret?: string;
}

class RelResource extends Resource<RelRow, Record<string, unknown>> {
  toJson(): Record<string, unknown> {
    return {
      id: this.model.id,
      author: this.whenLoaded("author", (u) => ({ id: u.id, name: u.name })),
      tags: this.whenLoaded("tags", (t) => t.map((x) => x.id)),
      bio: this.whenNotNull(this.model.bio),
      lazy: this.when(this.model.secret !== undefined, () => "computed"),
      ...this.mergeWhen(this.model.secret !== undefined, { secret: this.model.secret }),
    };
  }
}

/** JSON round-trip drops undefined-valued keys, mirroring c.json(...). */
function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("Resource conditional fields", () => {
  it("whenLoaded() omits a relation that was never loaded (undefined -> absent on the wire)", () => {
    const json = new RelResource({ id: "1" }).toJson();
    expect(json.author).toBeUndefined();
    expect(wire(json)).not.toHaveProperty("author");
  });

  it("whenLoaded() maps a loaded relation through the mapper", () => {
    const json = new RelResource({ id: "1", author: { id: "9", name: "Ada" } }).toJson();
    expect(json.author).toEqual({ id: "9", name: "Ada" });
  });

  it("whenLoaded() keeps a loaded-but-empty hasMany array", () => {
    const json = new RelResource({ id: "1", tags: [] }).toJson();
    expect(json.tags).toEqual([]);
    expect(wire(json)).toHaveProperty("tags", []);
  });

  it("whenLoaded() without a mapper returns the raw relation value", () => {
    class Raw extends Resource<RelRow, Record<string, unknown>> {
      toJson() {
        return { author: this.whenLoaded("author") };
      }
    }
    expect(new Raw({ id: "1", author: { id: "9", name: "Ada" } }).toJson().author).toEqual({
      id: "9",
      name: "Ada",
    });
  });

  it("whenNotNull() drops null and undefined but keeps other falsy values", () => {
    expect(wire(new RelResource({ id: "1", bio: null }).toJson())).not.toHaveProperty("bio");
    expect(wire(new RelResource({ id: "1" }).toJson())).not.toHaveProperty("bio");
    expect(new RelResource({ id: "1", bio: "hi" }).toJson().bio).toBe("hi");
  });

  it("when() evaluates the lazy value only when the condition holds", () => {
    expect(new RelResource({ id: "1" }).toJson().lazy).toBeUndefined();
    expect(new RelResource({ id: "1", secret: "x" }).toJson().lazy).toBe("computed");
  });

  it("mergeWhen() contributes fields only when the condition holds", () => {
    expect(wire(new RelResource({ id: "1" }).toJson())).not.toHaveProperty("secret");
    expect(new RelResource({ id: "1", secret: "shh" }).toJson().secret).toBe("shh");
  });
});

/** Minimal stand-in for a Model instance's appended-value surface. */
class FakeAppendable {
  private appended = new Map<string, unknown>();
  constructor(public id: string) {}
  setAppended(name: string, value: unknown): this {
    this.appended.set(name, value);

    return this;
  }
  hasAppended(name: string): boolean {
    return this.appended.has(name);
  }
  getAppended(name: string): unknown {
    return this.appended.get(name);
  }
}

class AppendResource extends Resource<FakeAppendable, Record<string, unknown>> {
  async toJson(): Promise<Record<string, unknown>> {
    await Promise.resolve();

    return {
      id: this.model.id,
      likesCount: this.whenAppended("likesCount"),
      label: this.whenAppended("label", (v) => `#${v as string}`),
    };
  }
}

describe("Resource appended attributes + async toJson", () => {
  it("whenAppended() omits a value that was never appended", async () => {
    const json = await new AppendResource(new FakeAppendable("1")).toJson();
    expect(json.likesCount).toBeUndefined();
    expect(wire(json)).not.toHaveProperty("likesCount");
  });

  it("whenAppended() includes an appended value, mapped when a mapper is given", async () => {
    const model = new FakeAppendable("1").setAppended("likesCount", 3).setAppended("label", "hot");
    const json = await new AppendResource(model).toJson();
    expect(json.likesCount).toBe(3);
    expect(json.label).toBe("#hot");
  });

  it("whenAppended() keeps a deliberately-null appended value", async () => {
    const model = new FakeAppendable("1").setAppended("likesCount", null);
    const json = await new AppendResource(model).toJson();
    expect(json.likesCount).toBeNull();
  });

  it("collection() resolves async toJson() in parallel", async () => {
    const shapes = await AppendResource.collection([
      new FakeAppendable("1").setAppended("likesCount", 1),
      new FakeAppendable("2").setAppended("likesCount", 2),
    ]);
    expect(shapes).toEqual([
      { id: "1", likesCount: 1 },
      { id: "2", likesCount: 2 },
    ]);
  });
});

// A minimal duck-typed stand-in for a `@mahiframework/database` Model: it
// carries `toJsonResource()` (returning its default resource, or undefined)
// and `toJSON()` (its own attribute serialization) — the two surfaces
// `normalizeResourceValue` detects structurally.

class FakeUserResource extends Resource<FakeUserModel, { id: string; name: string }> {
  toJson() {
    return { id: this.model.id, name: this.model.name };
  }
}

class FakeUserModel {
  constructor(
    public id: string,
    public name: string,
    private withResource = true,
  ) {}
  toJsonResource(): FakeUserResource | undefined {
    return this.withResource ? new FakeUserResource(this) : undefined;
  }
  toJSON() {
    return { id: this.id, name: this.name, raw: true };
  }
}

/** A collection stand-in — anything with `toArray()` is treated as one. */
class FakeCollection<T> {
  constructor(private items: T[]) {}
  toArray(): T[] {
    return this.items;
  }
  map<R>(fn: (item: T) => R): FakeCollection<R> {
    return new FakeCollection(this.items.map(fn));
  }
}

describe("normalizeResourceValue", () => {
  it("converts a bare Model to its default resource's JSON", () => {
    const out = normalizeResourceValue(new FakeUserModel("9", "Ada"));
    expect(out).toEqual({ id: "9", name: "Ada" });
  });

  it("falls back to model.toJSON() when the model has no default resource", () => {
    const out = normalizeResourceValue(new FakeUserModel("9", "Ada", false));
    expect(out).toEqual({ id: "9", name: "Ada", raw: true });
  });

  it("converts models inside a Collection", () => {
    const out = normalizeResourceValue(
      new FakeCollection([new FakeUserModel("1", "A"), new FakeUserModel("2", "B")]),
    );
    expect(out).toEqual([
      { id: "1", name: "A" },
      { id: "2", name: "B" },
    ]);
  });

  it("converts models inside an array", () => {
    const out = normalizeResourceValue([new FakeUserModel("1", "A"), new FakeUserModel("2", "B")]);
    expect(out).toEqual([
      { id: "1", name: "A" },
      { id: "2", name: "B" },
    ]);
  });

  it("converts models nested in plain object values", () => {
    const out = normalizeResourceValue({
      author: new FakeUserModel("9", "Ada"),
      meta: { editor: new FakeUserModel("8", "Bo") },
    });
    expect(out).toEqual({
      author: { id: "9", name: "Ada" },
      meta: { editor: { id: "8", name: "Bo" } },
    });
  });

  it("preserves undefined-valued keys (so JSON.stringify still omits them)", () => {
    const out = normalizeResourceValue({ author: undefined, id: "1" }) as Record<string, unknown>;
    expect(Object.keys(out)).toContain("author");
    expect(wire(out)).not.toHaveProperty("author");
  });

  it("leaves primitives and Date untouched", () => {
    const d = new Date("2020-01-01T00:00:00.000Z");
    expect(normalizeResourceValue(d)).toBe(d);
    expect(normalizeResourceValue("x")).toBe("x");
    expect(normalizeResourceValue(null)).toBeNull();
  });

  it("stays synchronous for an all-sync shape", () => {
    const out = normalizeResourceValue({ author: new FakeUserModel("9", "Ada") });
    expect(out).not.toBeInstanceOf(Promise);
  });

  it("returns a Promise when a nested resource is async", async () => {
    class AsyncModel {
      constructor(public id: string) {}
      toJsonResource() {
        const id = this.id;

        return {
          async toJson() {
            await Promise.resolve();

            return { id, async: true };
          },
        };
      }
      toJSON() {
        return { id: this.id };
      }
    }
    const out = normalizeResourceValue({ author: new AsyncModel("9") });
    expect(out).toBeInstanceOf(Promise);
    expect(await out).toEqual({ author: { id: "9", async: true } });
  });
});

describe("Resource auto-normalizes toJson() output", () => {
  interface Row {
    id: string;
    author?: FakeUserModel;
    editors?: FakeCollection<FakeUserModel>;
  }

  class RowResource extends Resource<Row, Record<string, unknown>> {
    toJson() {
      return {
        id: this.model.id,
        author: this.whenLoaded("author"),
        editors: this.whenLoaded("editors"),
      };
    }
  }

  it("converts a bare whenLoaded() model to its resource JSON", () => {
    const json = new RowResource({ id: "1", author: new FakeUserModel("9", "Ada") }).toJson();
    expect(json).toEqual({ id: "1", author: { id: "9", name: "Ada" } });
  });

  it("converts a bare whenLoaded() collection to resource JSON per item", () => {
    const json = new RowResource({
      id: "1",
      editors: new FakeCollection([new FakeUserModel("2", "Bo")]),
    }).toJson();
    expect(json).toEqual({ id: "1", editors: [{ id: "2", name: "Bo" }] });
  });

  it("omits an unloaded relation after normalization", () => {
    const json = new RowResource({ id: "1" }).toJson();
    expect(wire(json)).toEqual({ id: "1" });
  });

  it("is idempotent — an explicitly-mapped nested resource is not double-processed", async () => {
    class Outer extends Resource<{ id: string; author: FakeUserModel }, Record<string, unknown>> {
      toJson() {
        return { id: this.model.id, author: new FakeUserResource(this.model.author).toJson() };
      }
    }
    const json = await new Outer({ id: "1", author: new FakeUserModel("9", "Ada") }).toJson();
    expect(json).toEqual({ id: "1", author: { id: "9", name: "Ada" } });
  });
});
