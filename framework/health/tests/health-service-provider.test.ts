import { describe, expect, it } from "vitest";
import { Application, ServiceProvider } from "@mahiframework/core";
import { HealthServiceProvider, HEALTH_TOKEN } from "../src/health-service-provider.js";
import { HealthRegistry } from "../src/health-registry.js";
import { HealthCommand } from "../src/commands/health.js";
import type { HealthCheck } from "../src/health-check.js";
import "../src/provider-hooks.js";

async function bootApp(
  ...providers: Array<new (app: Application) => ServiceProvider>
): Promise<Application> {
  const app = new Application();

  for (const provider of providers) {
    app.register(provider);
  }

  await app.bootstrap();

  return app;
}

function registryOf(app: Application): HealthRegistry {
  return app.make<HealthRegistry>(HEALTH_TOKEN);
}

describe("HealthServiceProvider", () => {
  it("binds a HealthRegistry singleton at HEALTH_TOKEN", async () => {
    const app = await bootApp(HealthServiceProvider);

    expect(registryOf(app)).toBeInstanceOf(HealthRegistry);
    expect(registryOf(app)).toBe(registryOf(app));
  });

  it("pre-registers the three built-in checks", async () => {
    const app = await bootApp(HealthServiceProvider);

    expect(
      registryOf(app)
        .all()
        .map((check) => `${check.group}.${check.name}`),
    ).toEqual(["core.cache", "core.database", "core.filesystem"]);
  });

  it("reports all three as skipped in an app with none of the packages", async () => {
    const app = await bootApp(HealthServiceProvider);
    const report = await registryOf(app).run();

    expect(report.results).toEqual({
      core: { cache: null, database: null, filesystem: null },
    });
    // Skipped is not failed.
    expect(report.healthy).toBe(true);
  });

  it("contributes the health command", async () => {
    const app = await bootApp(HealthServiceProvider);
    const provider = new HealthServiceProvider(app);

    expect(provider.commands()).toEqual([HealthCommand]);
  });

  it("reads timeoutSeconds and concurrency from the health config namespace", async () => {
    const app = new Application();
    app.config.set("health", { timeoutSeconds: 1, concurrency: 4 });
    app.register(HealthServiceProvider);
    await app.bootstrap();

    // Observable through behaviour: a hung check yields the configured
    // deadline in its message.
    registryOf(app).register({ name: "hung", run: () => new Promise<void>(() => {}) });
    const report = await registryOf(app).run();

    expect(report.results.app?.hung).toBe("Timed out after 1s");
  });

  it("tolerates a missing health config namespace", async () => {
    const app = await bootApp(HealthServiceProvider);
    await expect(registryOf(app).run()).resolves.toBeDefined();
  });
});

describe("checks() hook collection", () => {
  class StripeProvider extends ServiceProvider {
    checks(): HealthCheck[] {
      return [{ name: "stripe", run: () => {} }];
    }
  }

  class DaemonProvider extends ServiceProvider {
    checks(): HealthCheck[] {
      return [{ name: "daemon", run: () => "not running" }];
    }
  }

  it("collects checks from a provider registered before HealthServiceProvider", async () => {
    const app = await bootApp(StripeProvider, HealthServiceProvider);

    expect((await registryOf(app).run()).results.app).toEqual({ stripe: true });
  });

  it("collects checks from a provider registered AFTER HealthServiceProvider", async () => {
    // Every provider is constructed before any `boot()` runs, so
    // `boot()`'s walk over `getProviders()` sees later providers too.
    // Without that property an app's own checks would silently vanish.
    const app = await bootApp(HealthServiceProvider, StripeProvider);

    expect((await registryOf(app).run()).results.app).toEqual({ stripe: true });
  });

  it("collects from several providers at once", async () => {
    const app = await bootApp(HealthServiceProvider, StripeProvider, DaemonProvider);
    const report = await registryOf(app).run();

    expect(report.results.app).toEqual({ stripe: true, daemon: "not running" });
    expect(report.healthy).toBe(false);
  });

  it('defaults a collected check to the "app" group', async () => {
    const app = await bootApp(HealthServiceProvider, StripeProvider);
    const stripe = registryOf(app)
      .all()
      .find((check) => check.name === "stripe");

    expect(stripe?.group).toBeUndefined();
    expect((await registryOf(app).run()).results.app?.stripe).toBe(true);
  });

  it("ignores a provider with no checks() hook", async () => {
    class Plain extends ServiceProvider {}
    const app = await bootApp(HealthServiceProvider, Plain);

    expect(registryOf(app).all()).toHaveLength(3);
  });

  it("ignores a checks() hook returning an empty array", async () => {
    class Empty extends ServiceProvider {
      checks(): HealthCheck[] {
        return [];
      }
    }
    const app = await bootApp(HealthServiceProvider, Empty);

    expect(registryOf(app).all()).toHaveLength(3);
  });

  it("lets an app check replace a built-in by declaring the same group and name", async () => {
    class CustomDatabaseProvider extends ServiceProvider {
      checks(): HealthCheck[] {
        return [{ name: "database", group: "core", run: () => "custom probe says down" }];
      }
    }

    const app = await bootApp(HealthServiceProvider, CustomDatabaseProvider);
    const report = await registryOf(app).run();

    expect(registryOf(app).all()).toHaveLength(3);
    expect(report.results.core?.database).toBe("custom probe says down");
    expect(report.healthy).toBe(false);
  });

  it("preserves the built-ins' position when one is replaced", async () => {
    class CustomCacheProvider extends ServiceProvider {
      checks(): HealthCheck[] {
        return [{ name: "cache", group: "core", run: () => {} }];
      }
    }

    const app = await bootApp(HealthServiceProvider, CustomCacheProvider);

    expect(
      registryOf(app)
        .all()
        .map((check) => check.name),
    ).toEqual(["cache", "database", "filesystem"]);
  });
});
