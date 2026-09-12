import { Application } from "@mahiframework/core";
import { describe, expect, it } from "vitest";
import { HttpKernel } from "../src/http-kernel.js";
import { HEALTH_TOKEN } from "../src/health-check-route.js";
import { CacheManager, ArrayCacheStore, CACHE_TOKEN } from "@mahiframework/cache";
import { MaintenanceMode, MAINTENANCE_MODE_TOKEN } from "../src/maintenance/maintenance-mode.js";

/**
 * A stand-in for `@mahiframework/health`'s `HealthRegistry`, bound at the same
 * token. `@mahiframework/http` deliberately has no dependency on that package —
 * it resolves the registry by string and serializes whatever it returns —
 * so these tests describe exactly the contract the route relies on.
 */
type Outcome = true | string | null;

function bindRegistry(app: Application, results: Record<string, Record<string, Outcome>>): void {
  const healthy = Object.values(results).every((group) =>
    Object.values(group).every((outcome) => typeof outcome !== "string"),
  );
  app.singleton(HEALTH_TOKEN, () => ({
    run: async () => ({ healthy, results, durationMs: 1 }),
  }));
}

function kernelFor(app: Application): HttpKernel {
  (app as any).providers ??= [];
  const kernel = new HttpKernel(app);
  kernel.collectFromProviders();

  return kernel;
}

const PASSING = { core: { cache: true as const, database: true as const } };
const FAILING = { core: { cache: true as const, database: "connect ECONNREFUSED 10.0.1.4:5432" } };

describe("readiness route registration", () => {
  it("is not registered when http.healthCheck is absent", async () => {
    const app = new Application();
    bindRegistry(app, PASSING);

    expect((await kernelFor(app).raw().request("/health")).status).toBe(404);
  });

  it("is not registered when no health registry is bound", async () => {
    // `@mahiframework/health` isn't installed: the config is set but nothing has
    // bound the token, so the route must not exist rather than 500.
    const app = new Application();
    app.config.set("http", { healthCheck: {} });

    expect((await kernelFor(app).raw().request("/health")).status).toBe(404);
  });

  it("is registered at /health when both are present", async () => {
    const app = new Application();
    app.config.set("http", { healthCheck: {} });
    bindRegistry(app, PASSING);

    expect((await kernelFor(app).raw().request("/health")).status).toBe(200);
  });

  it("honours a custom path", async () => {
    const app = new Application();
    app.config.set("http", { healthCheck: { path: "/readyz" } });
    bindRegistry(app, PASSING);

    const kernel = kernelFor(app);
    expect((await kernel.raw().request("/readyz")).status).toBe(200);
    expect((await kernel.raw().request("/health")).status).toBe(404);
  });

  it('is named "health" so URL.route("health") resolves it', () => {
    const app = new Application();
    app.config.set("http", { healthCheck: {} });
    bindRegistry(app, PASSING);

    expect(kernelFor(app).routeRegistry().get("health")?.path).toBe("/health");
  });

  it("leaves the liveness route unnamed, so an app may use that name", async () => {
    // `/up` has always been unnamed, and `RouteRegistry` throws on a
    // duplicate name — claiming one here would stop an app that already
    // names a route "liveness" from booting at all.
    class AppProvider {
      routes(router: any) {
        router.get("/x", () => Response.json({})).name("liveness");
      }
    }

    const app = new Application();
    app.config.set("http", { liveness: {} });
    (app as any).providers = [new AppProvider()];

    const kernel = new HttpKernel(app);
    expect(() => kernel.collectFromProviders()).not.toThrow();
    expect((await kernel.raw().request("/up")).status).toBe(200);
  });

  it("coexists with the liveness route", async () => {
    const app = new Application();
    app.config.set("http", { liveness: {}, healthCheck: {} });
    bindRegistry(app, PASSING);

    const kernel = kernelFor(app);
    expect((await kernel.raw().request("/up")).status).toBe(200);
    expect((await kernel.raw().request("/health")).status).toBe(200);
  });
});

describe("readiness route status and payload", () => {
  it("returns 200 and the terse payload when everything passes", async () => {
    const app = new Application();
    app.config.set("http", { healthCheck: {} });
    bindRegistry(app, { core: { cache: true, database: true, filesystem: null } });

    const res = await kernelFor(app).raw().request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      core: { cache: true, database: true, filesystem: null },
    });
  });

  it("returns 503 by default when any check fails", async () => {
    const app = new Application();
    app.config.set("http", { healthCheck: {} });
    bindRegistry(app, FAILING);

    // 503, not 500: a load balancer drains a 503 and pages on a 500.
    expect((await kernelFor(app).raw().request("/health")).status).toBe(503);
  });

  it("honours a configured failureStatus", async () => {
    const app = new Application();
    app.config.set("http", { healthCheck: { failureStatus: 500 } });
    bindRegistry(app, FAILING);

    expect((await kernelFor(app).raw().request("/health")).status).toBe(500);
  });

  it("treats a skipped check as passing", async () => {
    const app = new Application();
    app.config.set("http", { healthCheck: {} });
    bindRegistry(app, { core: { cache: null, database: null, filesystem: null } });

    expect((await kernelFor(app).raw().request("/health")).status).toBe(200);
  });

  it("returns 200 with an empty object when nothing is registered", async () => {
    const app = new Application();
    app.config.set("http", { healthCheck: {} });
    bindRegistry(app, {});

    const res = await kernelFor(app).raw().request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});

describe("resolve-at-request-time", () => {
  it("runs checks registered after the route was mounted", async () => {
    // The route closure must resolve HEALTH_TOKEN per request.
    // `HttpServiceProvider.boot()` may
    // run before `HealthServiceProvider.boot()` has collected the app's
    // `checks()` hooks, so a closure that captured the check list at
    // registration would silently only ever run the built-ins.
    const app = new Application();
    app.config.set("http", { healthCheck: {} });

    const results: Record<string, Record<string, Outcome>> = { core: { cache: true } };
    app.singleton(HEALTH_TOKEN, () => ({
      run: async () => ({
        healthy: Object.values(results).every((group) =>
          Object.values(group).every((outcome) => typeof outcome !== "string"),
        ),
        results,
        durationMs: 1,
      }),
    }));

    const kernel = kernelFor(app);

    // A late provider contributes its check AFTER the route was mounted.
    results.app = { stripe: "Failed to connect" };

    const res = await kernel.raw().request("/health");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      core: { cache: true },
      app: { stripe: "Failed to connect" },
    });
  });

  it("reflects a registry that changes between two requests", async () => {
    const app = new Application();
    app.config.set("http", { healthCheck: {} });

    let healthy = true;
    app.singleton(HEALTH_TOKEN, () => ({
      run: async () => ({
        healthy,
        results: { core: { database: healthy ? (true as const) : "down" } },
        durationMs: 1,
      }),
    }));

    const kernel = kernelFor(app);

    expect((await kernel.raw().request("/health")).status).toBe(200);
    healthy = false;
    expect((await kernel.raw().request("/health")).status).toBe(503);
  });
});

describe("redaction", () => {
  function productionApp(config: Record<string, unknown> = {}): Application {
    const app = new Application().useEnvironment("production");
    app.config.set("http", { healthCheck: config });
    bindRegistry(app, FAILING);

    return app;
  }

  it("replaces failure messages in production", async () => {
    const res = await kernelFor(productionApp()).raw().request("/health");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ core: { cache: true, database: "Check failed" } });
  });

  it("leaves messages intact outside production", async () => {
    const app = new Application().useEnvironment("local");
    app.config.set("http", { healthCheck: {} });
    bindRegistry(app, FAILING);

    expect(await (await kernelFor(app).raw().request("/health")).json()).toEqual({
      core: { cache: true, database: "connect ECONNREFUSED 10.0.1.4:5432" },
    });
  });

  it("un-redacts for a request carrying the correct X-Health-Secret", async () => {
    const app = productionApp({ secret: "s3cret" });

    const res = await kernelFor(app)
      .raw()
      .request("/health", { headers: { "X-Health-Secret": "s3cret" } });

    expect(await res.json()).toEqual({
      core: { cache: true, database: "connect ECONNREFUSED 10.0.1.4:5432" },
    });
  });

  it("stays redacted for a wrong X-Health-Secret", async () => {
    const app = productionApp({ secret: "s3cret" });

    const res = await kernelFor(app)
      .raw()
      .request("/health", { headers: { "X-Health-Secret": "wrong" } });

    expect(await res.json()).toEqual({ core: { cache: true, database: "Check failed" } });
  });

  it("stays redacted when a secret is configured but none is sent", async () => {
    const app = productionApp({ secret: "s3cret" });

    const res = await kernelFor(app).raw().request("/health");

    expect(await res.json()).toEqual({ core: { cache: true, database: "Check failed" } });
  });

  it("ignores a sent secret when none is configured", async () => {
    const res = await kernelFor(productionApp())
      .raw()
      .request("/health", { headers: { "X-Health-Secret": "anything" } });

    expect(await res.json()).toEqual({ core: { cache: true, database: "Check failed" } });
  });

  it("preserves true, null, and the result shape", async () => {
    const app = new Application().useEnvironment("production");
    app.config.set("http", { healthCheck: {} });
    bindRegistry(app, {
      core: { cache: true, database: "ECONNREFUSED", filesystem: null },
      app: { stripe: "403 from stripe.com" },
    });

    // Which checks exist and which failed stays visible; only the
    // message goes.
    expect(await (await kernelFor(app).raw().request("/health")).json()).toEqual({
      core: { cache: true, database: "Check failed", filesystem: null },
      app: { stripe: "Check failed" },
    });
  });

  it("does not change the status code", async () => {
    expect((await kernelFor(productionApp()).raw().request("/health")).status).toBe(503);
  });
});

describe("maintenance mode", () => {
  function downApp(config: Record<string, unknown>): Application {
    const app = new Application();
    app.config.set("http", config);
    const cache = new CacheManager(app, { default: "array", stores: { array: {} } });
    cache.extend("array", () => new ArrayCacheStore());
    app.instance(CACHE_TOKEN, cache);
    app.singleton(MAINTENANCE_MODE_TOKEN, (resolved) => new MaintenanceMode(resolved));
    bindRegistry(app, PASSING);

    return app;
  }

  it("returns 503 from /health while down — it is NOT exempt", async () => {
    const app = downApp({ liveness: {}, healthCheck: {} });
    const kernel = kernelFor(app);
    await app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN).activate({});

    // A readiness probe answering "ready" while the operator has taken
    // the app down would put traffic straight back on it.
    const res = await kernel.raw().request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ message: "Service Unavailable" });
  });

  it("still returns 200 from /up in the same state — it IS exempt", async () => {
    const app = downApp({ liveness: {}, healthCheck: {} });
    const kernel = kernelFor(app);
    await app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN).activate({});

    // An orchestrator must be able to tell a down-for-maintenance app
    // from a dead one, or it will restart every pod.
    const res = await kernel.raw().request("/up");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("serves /health normally once the app is back up", async () => {
    const app = downApp({ healthCheck: {} });
    const kernel = kernelFor(app);
    const mode = app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN);

    await mode.activate({});
    expect((await kernel.raw().request("/health")).status).toBe(503);

    await mode.deactivate();
    const res = await kernel.raw().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PASSING);
  });
});
