import { describe, expect, it } from "vitest";
import { Application } from "@mahiframework/core";
import { HealthRegistry } from "../src/health-registry.js";
import type { HealthCheck } from "../src/health-check.js";

function registry(config = {}): HealthRegistry {
  return new HealthRegistry(new Application(), config);
}

/** A passing check that records nothing. */
function passing(name: string, group?: string): HealthCheck {
  return { name, group, run: () => {} };
}

describe("HealthRegistry.register()", () => {
  it("preserves registration order", () => {
    const health = registry().register(passing("a"), passing("b"), passing("c"));
    expect(health.all().map((check) => check.name)).toEqual(["a", "b", "c"]);
  });

  it("replaces an earlier check with the same group and name", () => {
    const first: HealthCheck = { name: "db", group: "core", run: () => "first" };
    const second: HealthCheck = { name: "db", group: "core", run: () => "second" };
    const health = registry().register(first, second);

    expect(health.all()).toHaveLength(1);
    expect(health.all()[0]).toBe(second);
  });

  it("keeps the replaced check's original position", async () => {
    const health = registry().register(
      { name: "db", group: "core", run: () => "original" },
      passing("cache", "core"),
      { name: "db", group: "core", run: () => "replacement" },
    );

    expect(health.all().map((c) => c.name)).toEqual(["db", "cache"]);
    expect((await health.run()).results.core?.db).toBe("replacement");
  });

  it("treats the same name in different groups as two checks", () => {
    const health = registry().register(passing("database", "core"), passing("database", "app"));
    expect(health.all()).toHaveLength(2);
  });

  it("lets an app check override a core one by declaring the same group and name", async () => {
    const health = registry()
      .register({ name: "database", group: "core", run: () => "core says down" })
      .register({ name: "database", group: "core", run: () => {} });

    expect((await health.run()).results).toEqual({ core: { database: true } });
  });
});

describe("HealthRegistry.run() outcomes", () => {
  it("maps a void return to true", async () => {
    const report = await registry()
      .register({ name: "a", run: () => {} })
      .run();
    expect(report.results.app?.a).toBe(true);
  });

  it("maps an explicit true return to true", async () => {
    const report = await registry()
      .register({ name: "a", run: () => true as const })
      .run();
    expect(report.results.app?.a).toBe(true);
  });

  it("maps a returned string to that string", async () => {
    const report = await registry()
      .register({ name: "a", run: () => "disk 94% full" })
      .run();
    expect(report.results.app?.a).toBe("disk 94% full");
  });

  it("maps a returned null to null (skipped)", async () => {
    const report = await registry()
      .register({ name: "a", run: () => null })
      .run();
    expect(report.results.app?.a).toBeNull();
  });

  it("maps a thrown Error to its message", async () => {
    const report = await registry()
      .register({
        name: "a",
        run: () => {
          throw new Error("connect ECONNREFUSED 10.0.1.4:5432");
        },
      })
      .run();

    expect(report.results.app?.a).toBe("connect ECONNREFUSED 10.0.1.4:5432");
  });

  it("maps a thrown string to that string", async () => {
    const report = await registry()
      .register({
        name: "a",
        run: () => {
          throw "plain string failure";
        },
      })
      .run();

    expect(report.results.app?.a).toBe("plain string failure");
  });

  it("maps a thrown non-Error object to a String()'d message rather than crashing", async () => {
    const report = await registry()
      .register({
        name: "a",
        run: () => {
          throw { code: "ENOTFOUND" };
        },
      })
      .run();

    expect(report.results.app?.a).toBe("[object Object]");
    expect(report.healthy).toBe(false);
  });

  it("maps a rejected promise to its message", async () => {
    const report = await registry()
      .register({ name: "a", run: () => Promise.reject(new Error("async boom")) })
      .run();

    expect(report.results.app?.a).toBe("async boom");
  });

  it("catches a synchronous throw that happens before any promise is returned", async () => {
    const report = await registry()
      .register({
        name: "a",
        run: (): Promise<void> => {
          throw new Error("threw before returning");
        },
      })
      .run();

    expect(report.results.app?.a).toBe("threw before returning");
  });
});

describe("HealthRegistry.run() isolation", () => {
  it("lets every other check report when one throws", async () => {
    const report = await registry()
      .register(
        passing("before"),
        {
          name: "broken",
          run: () => {
            throw new Error("boom");
          },
        },
        passing("after"),
      )
      .run();

    expect(report.results.app).toEqual({ before: true, broken: "boom", after: true });
  });

  it("never rejects, whatever the checks do", async () => {
    await expect(
      registry()
        .register(
          {
            name: "a",
            run: () => {
              throw new Error("a");
            },
          },
          {
            name: "b",
            run: () => {
              throw null;
            },
          },
        )
        .run(),
    ).resolves.toBeDefined();
  });
});

describe("HealthRegistry.run() healthy", () => {
  it("is false when any outcome is a string", async () => {
    const report = await registry()
      .register(passing("a"), { name: "b", run: () => "nope" })
      .run();
    expect(report.healthy).toBe(false);
  });

  it("is true when every outcome is true or null", async () => {
    const report = await registry()
      .register(passing("a"), { name: "b", run: () => null })
      .run();

    expect(report.healthy).toBe(true);
    expect(report.results.app).toEqual({ a: true, b: null });
  });

  it("is not failed by a skipped check alone", async () => {
    const report = await registry()
      .register({ name: "a", run: () => null })
      .run();
    expect(report.healthy).toBe(true);
  });
});

describe("HealthRegistry.run() grouping", () => {
  it("nests outcomes under their group", async () => {
    const report = await registry()
      .register(passing("cache", "core"), passing("database", "core"), {
        name: "stripe",
        run: () => "Failed to connect",
      })
      .run();

    expect(report.results).toEqual({
      core: { cache: true, database: true },
      app: { stripe: "Failed to connect" },
    });
  });

  it('defaults the group to "app"', async () => {
    const report = await registry().register(passing("stripe")).run();
    expect(report.results).toEqual({ app: { stripe: true } });
  });
});

describe("HealthRegistry.run() edge cases", () => {
  it("reports an empty registry as healthy with no results", async () => {
    const report = await registry().run();
    expect(report.healthy).toBe(true);
    expect(report.results).toEqual({});
  });

  it("includes a wall-clock duration", async () => {
    const report = await registry().register(passing("a")).run();
    expect(report.durationMs).toBeTypeOf("number");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes the application into run()", async () => {
    const app = new Application();
    let received: unknown;
    await new HealthRegistry(app)
      .register({
        name: "a",
        run: (received_) => {
          received = received_;
        },
      })
      .run();

    expect(received).toBe(app);
  });

  it("runs sequentially by default", async () => {
    const events: string[] = [];
    const slow = (name: string): HealthCheck => ({
      name,
      run: async () => {
        events.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`${name}:end`);
      },
    });

    await registry().register(slow("a"), slow("b")).run();

    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("overlaps checks when concurrency is raised", async () => {
    const events: string[] = [];
    const slow = (name: string): HealthCheck => ({
      name,
      run: async () => {
        events.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`${name}:end`);
      },
    });

    await registry({ concurrency: 2 }).register(slow("a"), slow("b")).run();

    expect(events).toEqual(["a:start", "b:start", "a:end", "b:end"]);
  });
});
