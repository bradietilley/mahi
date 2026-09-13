import type { GateRegistry } from "./gate.js";

declare module "@mahiframework/core" {
  interface ProviderHooks {
    /**
     * Register abilities (`gate.define(...)`) and policies
     * (`gate.policy(Model, Policy)`). Collected by
     * `AuthorizationServiceProvider` during its own boot, in provider
     * registration order.
     *
     * A single hook covers both rather than a separate `policies()`
     * returning tuples, matching `schedule?(schedule: Schedule)`'s shape
     * (receive the registry, call methods on it) and avoiding the
     * question of what a provider does when it wants both.
     */
    gates?(gate: GateRegistry): void;
  }
}
