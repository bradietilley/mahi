import { describe, expect, it } from "vitest";
import { ArrayCacheStore } from "@mahi/cache";
import { CacheSequenceResolver } from "../../src/sequence-resolvers/cache-sequence-resolver.js";

describe("CacheSequenceResolver", () => {
  it("first caller in a microsecond gets 0; subsequent callers increment", async () => {
    const store = new ArrayCacheStore();
    const resolver = new CacheSequenceResolver(store, "sf:");

    expect(await resolver.sequence(100)).toBe(0);
    expect(await resolver.sequence(100)).toBe(1);
    expect(await resolver.sequence(100)).toBe(2);

    expect(await resolver.sequence(101)).toBe(0);
  });

  it("prefixes cache keys", async () => {
    const store = new ArrayCacheStore();
    const resolver = new CacheSequenceResolver(store, "ns:");

    await resolver.sequence(42);
    expect(await store.get("ns:42")).toBe(0);
  });
});
