import { Application } from "@mahi/core";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../src/cache-manager.js";
import { ArrayCacheStore } from "../src/stores/array-cache-store.js";

function buildManager(): CacheManager {
  const app = new Application();
  const manager = new CacheManager(app, { default: "array", stores: { array: {} } });
  manager.extend("array", () => new ArrayCacheStore());

  return manager;
}

describe("CacheManager", () => {
  it("store() resolves the default store when called without a name", () => {
    const manager = buildManager();
    expect(manager.store()).toBeInstanceOf(ArrayCacheStore);
  });

  it("store() resolves and caches the same instance across calls", () => {
    const manager = buildManager();
    expect(manager.store()).toBe(manager.store());
  });

  it("remember() calls the resolver only once across two calls with the same key", async () => {
    const manager = buildManager();
    let calls = 0;

    const resolve = async () => {
      calls += 1;

      return "computed value";
    };

    const first = await manager.remember("key", resolve, 60);
    const second = await manager.remember("key", resolve, 60);

    expect(first).toBe("computed value");
    expect(second).toBe("computed value");
    expect(calls).toBe(1);
  });

  it("remember() calls the resolver again for a different key", async () => {
    const manager = buildManager();
    let calls = 0;
    const resolve = async () => {
      calls += 1;

      return calls;
    };

    const a = await manager.remember("a", resolve, 60);
    const b = await manager.remember("b", resolve, 60);

    expect(a).toBe(1);
    expect(b).toBe(2);
  });
});
