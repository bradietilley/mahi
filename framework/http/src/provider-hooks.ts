import type { Router } from "./router.js";
import type { HttpPipe } from "./middleware/pipeline-middleware.js";

declare module "@mahi/core" {
  interface ProviderHooks {
    /**
     * Register routes onto the given Router. Collected by HttpKernel from
     * every provider during its own boot.
     */
    routes?(router: Router): void;

    /**
     * Contribute global HTTP pipes, run ahead of route dispatch for every
     * request via `@mahi/pipeline`'s `Pipeline` (see
     * `middleware/pipeline-middleware.ts`). Collected by HttpKernel in
     * provider registration order — a provider earlier in `config/app.ts`'s
     * `providers[]` runs its pipes before a later provider's.
     */
    middleware?(): HttpPipe[];
  }
}
