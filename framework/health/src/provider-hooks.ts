import type { HealthCheck } from "./health-check.js";

declare module "@mahiframework/core" {
  interface ProviderHooks {
    /**
     * Contribute readiness checks. Collected during
     * `HealthServiceProvider.boot()`, which walks every provider — so a
     * provider listed *after* `HealthServiceProvider` in
     * `config/app.ts` still has its checks collected.
     *
     *     checks(): HealthCheck[] {
     *       return [{ name: "stripe", run: () => stripe.ping() }];
     *     }
     *
     * Checks default to the `"app"` group; declare `group: "core"` with a
     * built-in's name to replace it.
     */
    checks?(): HealthCheck[];
  }
}
