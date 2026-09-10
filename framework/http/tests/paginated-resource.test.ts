import { describe, expect, it } from "vitest";
import { Collection } from "@mahi/core";
import type { LengthAwarePaginationResult, CursorPaginationResult } from "@mahi/database";
import { Resource } from "../src/resource.js";
import { paginatedResource, cursorPaginatedResource } from "../src/paginated-resource.js";

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
    return { id: this.model.id, title: this.model.title, done: this.model.done === 1 };
  }
}

describe("paginatedResource", () => {
  it("preserves pagination metadata unchanged and transforms data through the Resource", async () => {
    const fixture: LengthAwarePaginationResult<FakeModel> = {
      data: Collection.make([
        { id: "1", title: "A", done: 0 },
        { id: "2", title: "B", done: 1 },
      ]),
      page: 2,
      perPage: 2,
      total: 5,
      totalPages: 3,
      hasMore: true,
    };

    const result = await paginatedResource(FakeResource, fixture);

    expect(result).toEqual({
      page: 2,
      perPage: 2,
      total: 5,
      totalPages: 3,
      hasMore: true,
      data: [
        { id: "1", title: "A", done: false },
        { id: "2", title: "B", done: true },
      ],
    });
  });

  const fixture = (): LengthAwarePaginationResult<FakeModel> => ({
    data: Collection.make([{ id: "1", title: "A", done: 0 }]),
    page: 1,
    perPage: 1,
    total: 1,
    totalPages: 1,
    hasMore: false,
  });

  it("merges additional() top-level fields", async () => {
    const result = await paginatedResource(FakeResource, fixture(), {
      additional: { requestId: "r1" },
    });
    expect(result.requestId).toBe("r1");
    expect(result.page).toBe(1);
    expect(result.data).toEqual([{ id: "1", title: "A", done: false }]);
  });

  it("nests pagination fields under meta when nestMeta is set", async () => {
    const result = await paginatedResource(FakeResource, fixture(), { nestMeta: true });
    expect(result).toEqual({
      data: [{ id: "1", title: "A", done: false }],
      meta: { page: 1, perPage: 1, total: 1, totalPages: 1, hasMore: false },
    });
    expect(result).not.toHaveProperty("page");
  });
});

describe("cursorPaginatedResource", () => {
  it("preserves nextCursor/prevCursor unchanged and transforms data through the Resource", async () => {
    const fixture: CursorPaginationResult<FakeModel> = {
      data: Collection.make([{ id: "1", title: "A", done: 1 }]),
      nextCursor: "abc",
      prevCursor: null,
    };

    const result = await cursorPaginatedResource(FakeResource, fixture);

    expect(result).toEqual({
      nextCursor: "abc",
      prevCursor: null,
      data: [{ id: "1", title: "A", done: true }],
    });
  });

  it("merges additional() top-level fields", async () => {
    const fixture: CursorPaginationResult<FakeModel> = {
      data: Collection.make([{ id: "1", title: "A", done: 1 }]),
      nextCursor: "abc",
      prevCursor: null,
    };

    const result = await cursorPaginatedResource(FakeResource, fixture, {
      additional: { requestId: "r1" },
    });
    expect(result.requestId).toBe("r1");
    expect(result.nextCursor).toBe("abc");
  });
});
