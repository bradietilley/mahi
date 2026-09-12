import { describe, expect, it } from "vitest";
import { Application, ServiceProvider } from "@mahiframework/core";
import { HttpServiceProvider, HTTP_KERNEL_TOKEN } from "@mahiframework/http";
import type { HttpKernel } from "@mahiframework/http";
import { HealthServiceProvider, HEALTH_TOKEN } from "../src/health-service-provider.js";
import { HealthRegistry } from "../src/health-registry.js";
import type { HealthCheck } from "../src/health-check.js";
import "../src/provider-hooks.js";

/**
 * `HealthServiceProvider` has **no hard ordering constraint** against
 * `HttpServiceProvider`, in either direction. These tests pin that,
 * because the plausible-sounding assumption ("Health must come first, or
 * the route won't mount") is wrong, and an app author who believes it
 * will write a comment in `config/app.ts` that later constrains a
 * reordering for no reason.
 *
 * It holds because of the boot sequence: EVERY provider's `register()`
 * runs before ANY provider's `boot()`. So by the time `HttpKernel` tests
 * `app.has(HEALTH_TOKEN)`, the registry is bound regardless of list
 * order — and `HealthServiceProvider.boot()` walks every provider, so it
 * collects `checks()` from providers on both sides of it.
 */

/** A provider listed after both framework providers in every case below. */
class LateProvider extends ServiceProvider {
  checks(): HealthCheck[] {
    return [{ name: "stripe", run: () => "Failed to connect" }];
  }
}

const EXPECTED = {
  status: 503,
  body: {
    // No cache/database/storage bound in this app, so all three skip.
    core: { cache: null, database: null, filesystem: null },
    // The late provider's check ran and failed.
    app: { stripe: "Failed to connect" },
  },
};

async function probe(
  providers: Array<new (app: Application) => ServiceProvider>,
): Promise<{ status: number; body: unknown }> {
  const app = new Application();
  app.config.set("http", { healthCheck: {} });

  for (const provider of providers) {
    app.register(provider);
  }

  await app.bootstrap();

  const res = await app.make<HttpKernel>(HTTP_KERNEL_TOKEN).raw().request("/health");

  return { status: res.status, body: await res.json() };
}

describe("HealthServiceProvider ordering against HttpServiceProvider", () => {
  it("mounts /health and runs every check with Health listed FIRST", async () => {
    expect(await probe([HealthServiceProvider, HttpServiceProvider, LateProvider])).toEqual(
      EXPECTED,
    );
  });

  it("mounts /health and runs every check with Http listed FIRST", async () => {
    expect(await probe([HttpServiceProvider, HealthServiceProvider, LateProvider])).toEqual(
      EXPECTED,
    );
  });

  it("collects a checks() hook from a provider listed between the two", async () => {
    expect(await probe([HttpServiceProvider, LateProvider, HealthServiceProvider])).toEqual(
      EXPECTED,
    );
  });
});

describe("route mounting", () => {
  it("does not mount /health when HealthServiceProvider is absent", async () => {
    const app = new Application();
    app.config.set("http", { healthCheck: {} });
    app.register(HttpServiceProvider);
    await app.bootstrap();

    // `@mahiframework/http` resolves the registry by token and simply skips the
    // route when nothing has bound it — no import, no hard dependency.
    const res = await app.make<HttpKernel>(HTTP_KERNEL_TOKEN).raw().request("/health");
    expect(res.status).toBe(404);
  });

  it("does not mount /health when http.healthCheck is unconfigured", async () => {
    const app = new Application();
    app.register(HealthServiceProvider);
    app.register(HttpServiceProvider);
    await app.bootstrap();

    const res = await app.make<HttpKernel>(HTTP_KERNEL_TOKEN).raw().request("/health");
    expect(res.status).toBe(404);
    // The registry is still bound and usable — `./artisan health` works
    // in an app that never exposes the endpoint.
    expect(app.make<HealthRegistry>(HEALTH_TOKEN)).toBeInstanceOf(HealthRegistry);
  });

  it("serves /health in an app with no HTTP package by way of the CLI instead", async () => {
    // The CLI frontend must work with @mahiframework/core alone — no HttpKernel,
    // no routes, no config namespace.
    const app = new Application();
    app.register(HealthServiceProvider);
    await app.bootstrap();

    const report = await app.make<HealthRegistry>(HEALTH_TOKEN).run();

    expect(report.healthy).toBe(true);
    expect(report.results).toEqual({ core: { cache: null, database: null, filesystem: null } });
  });
});
