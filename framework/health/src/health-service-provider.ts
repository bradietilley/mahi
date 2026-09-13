import { ServiceProvider } from "@mahiframework/core";
import { HealthRegistry } from "./health-registry.js";
import type { HealthConfig } from "./health-config.js";
import { cacheCheck, databaseCheck, filesystemCheck } from "./checks/index.js";
import { HealthCommand } from "./commands/health.js";

/**
 * Resolved only from inside `@mahiframework/health` (its own command, and the
 * route registered by `@mahiframework/http`'s kernel when this token is bound), so
 * it stays local rather than joining `well-known-tokens.ts`. That file's
 * own stated bar.
 */
export const HEALTH_TOKEN = "health";

/**
 * Binds the `HealthRegistry` and, during boot, collects every provider's
 * `checks()` hook, the same shape as `ScheduleServiceProvider`: bind in
 * `register()`, collect hooks in `boot()`, contribute commands.
 *
 * The three built-ins are registered *inside the factory*, before any
 * provider hook can run, so an app check declaring `group: "core"` with a
 * built-in's name replaces it under the registry's replace-on-duplicate
 * rule.
 *
 * **Ordering in `config/app.ts`:** after `CacheServiceProvider`,
 * `DatabaseServiceProvider`, and `StorageServiceProvider`. Not because
 * this provider resolves them, the checks resolve their tokens lazily, at
 * probe time, but so `app.has(TOKEN)` is answered against a fully
 * registered container. (In practice every `register()` runs before any
 * `boot()`, so this is belt and braces.)
 */
export class HealthServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(HEALTH_TOKEN, (app) => {
      const config = app.config.get<HealthConfig>("health") ?? {};

      return new HealthRegistry(app, config).register(cacheCheck, databaseCheck, filesystemCheck);
    });
  }

  boot(): void {
    const registry = this.app.make<HealthRegistry>(HEALTH_TOKEN);

    // Every provider is constructed before any `boot()` runs, so this
    // walk sees providers listed both before and after this one.
    for (const provider of this.app.getProviders()) {
      const checks = provider.checks?.();

      if (checks?.length) {
        registry.register(...checks);
      }
    }
  }

  commands() {
    return [HealthCommand];
  }
}
