import { describe, expect, it } from "vitest";
import {
  data_fill,
  data_forget,
  data_get,
  data_has,
  data_set,
  dataFill,
  dataForget,
  dataGet,
  dataHas,
  dataSet,
  type DataObject,
} from "../src/data.js";

describe("dataGet", () => {
  const target: {
    user: { name: string; address: { city: string }; missing?: string };
    tags: string[];
    users: { name: string; roles: string[] }[];
  } = {
    user: { name: "Ada", address: { city: "London" } },
    tags: ["a", "b"],
    users: [
      { name: "Ada", roles: ["admin", "owner"] },
      { name: "Grace", roles: ["user"] },
    ],
  };

  it("reads a dotted path", () => {
    expect(dataGet(target, "user.name")).toBe("Ada");
    expect(dataGet(target, "user.address.city")).toBe("London");
    expect(dataGet(target, "tags.1")).toBe("b");
  });

  it("accepts an array of segments as a single path", () => {
    expect(dataGet(target, ["user", "name"])).toBe("Ada");
  });

  it("returns the fallback when a segment is missing", () => {
    expect(dataGet(target, "user.missing", "fallback")).toBe("fallback");
  });

  it("returns target itself for a null/empty key", () => {
    expect(dataGet(target, null)).toBe(target);
    expect(dataGet(target, "")).toBe(target);
  });

  it("returns an existing null/undefined leaf rather than the fallback", () => {
    expect(dataGet({ a: null }, "a", "fallback")).toBeNull();
  });

  it("expands * over arrays", () => {
    expect(dataGet(target, "users.*.name")).toEqual(["Ada", "Grace"]);
  });

  it("collapses nested * segments one level", () => {
    expect(dataGet(target, "users.*.roles.*")).toEqual(["admin", "owner", "user"]);
  });
});

describe("dataSet / dataFill", () => {
  it("writes a nested path, creating missing objects", () => {
    const target: DataObject = {};
    dataSet(target, "user.name", "Ada");
    expect(target).toEqual({ user: { name: "Ada" } });
  });

  it("creates arrays when the next segment is an index", () => {
    const target: DataObject = {};
    dataSet(target, "users.0.name", "Ada");
    expect(target).toEqual({ users: [{ name: "Ada" }] });
  });

  it("overwrites an existing leaf by default", () => {
    const target = { a: { b: 1 } };
    dataSet(target, "a.b", 2);
    expect(target.a.b).toBe(2);
  });

  it("dataFill does not overwrite an existing leaf", () => {
    const target: { a: { b: number; c?: number } } = { a: { b: 1 } };
    dataFill(target, "a.b", 2);
    dataFill(target, "a.c", 3);
    expect(target).toEqual({ a: { b: 1, c: 3 } });
  });

  it("writes through * onto every item", () => {
    const target: { users: { name: string; active?: boolean }[] } = {
      users: [{ name: "Ada" }, { name: "Grace" }],
    };
    dataSet(target, "users.*.active", true);
    expect(target.users).toEqual([
      { name: "Ada", active: true },
      { name: "Grace", active: true },
    ]);
  });
});

describe("dataHas / dataForget", () => {
  it("dataHas reports nested key presence, including null leaves", () => {
    expect(dataHas({ a: { b: 1 } }, "a.b")).toBe(true);
    expect(dataHas({ a: { b: null } }, "a.b")).toBe(true);
    const empty: { a: { b?: number } } = { a: {} };
    expect(dataHas(empty, "a.b")).toBe(false);
    expect(dataHas({ a: 1, c: 2 }, ["a", "c"])).toBe(true);
    const partial: { a: number; c?: number } = { a: 1 };
    expect(dataHas(partial, ["a", "c"])).toBe(false);
  });

  it("dataForget removes a nested key", () => {
    const target = { a: { b: 1, c: 2 } };
    dataForget(target, "a.b");
    expect(target).toEqual({ a: { c: 2 } });
  });

  it("dataForget removes several dotted paths", () => {
    const target = { a: 1, b: 2, c: { d: 3 } };
    dataForget(target, ["a", "c.d"]);
    expect(target).toEqual({ b: 2, c: {} });
  });

  it("dataForget splices array indices", () => {
    const target = { tags: ["a", "b", "c"] };
    dataForget(target, "tags.1");
    expect(target.tags).toEqual(["a", "c"]);
  });
});

describe("snake_case aliases (Laravel-matching canonical names)", () => {
  it("data_get/data_set/data_fill/data_has/data_forget alias the camelCase versions", () => {
    expect(data_get).toBe(dataGet);
    expect(data_set).toBe(dataSet);
    expect(data_fill).toBe(dataFill);
    expect(data_has).toBe(dataHas);
    expect(data_forget).toBe(dataForget);
  });

  it("data_get reads a dotted path", () => {
    expect(data_get({ user: { name: "Ada" } }, "user.name")).toBe("Ada");
  });

  it("data_set writes a dotted path", () => {
    const target = { user: { name: "Ada" } };
    data_set(target, "user.name", "Grace");
    expect(target.user.name).toBe("Grace");
  });
});
