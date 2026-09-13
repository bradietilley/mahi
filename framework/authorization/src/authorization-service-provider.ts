import { ServiceProvider } from "@mahiframework/core";
import { GateRegistry } from "./gate.js";
import { GATE_TOKEN } from "./tokens.js";

export { GATE_TOKEN };

/**
 * Binds the `GateRegistry` singleton and populates it during boot from
 * every provider's `gates()` hook, directly modeled on
 * `EventsServiceProvider.boot()`'s `listeners()` collection.
 *
 * ORDERING: list after `AuthServiceProvider` (the gate resolves the
 * current user through `AUTH_TOKEN`), before `HttpServiceProvider` so
 * `GATE_TOKEN` is bound before routes referencing `can()` are collected,
 * and before any app provider whose `gates()` hook registers policies.
 *
 * Note there is NO `config/authorization.ts`, unlike every other package
 * in this framework, a gate has nothing configurable (no drivers, no
 * connections, no defaults). Its absence is intentional, not an omission.
 */
export class AuthorizationServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(GATE_TOKEN, (app) => new GateRegistry(app));
  }

  boot(): void {
    const gate = this.app.make<GateRegistry>(GATE_TOKEN);

    for (const provider of this.app.getProviders()) {
      provider.gates?.(gate);
    }
  }
}
