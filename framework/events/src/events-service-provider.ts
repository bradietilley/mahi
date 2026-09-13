import { ServiceProvider, EVENTS_TOKEN } from "@mahiframework/core";
import { EventDispatcher } from "./event-dispatcher.js";

// Canonical definition in `@mahiframework/core`'s `well-known-tokens`
// (resolved cross-package by broadcasting and model events); re-exported
// so this package's public API is unchanged.
export { EVENTS_TOKEN };

/**
 * Registers the EventDispatcher singleton and, during boot, collects every
 * provider's `listeners()` hook (all providers are already instantiated by
 * this point, regardless of boot order) and wires them into the
 * dispatcher, event-class pairs and event-name wildcard patterns alike,
 * in the order the hooks return them.
 *
 * Because provider boot() runs sequentially in registration order, list
 * EventsServiceProvider before any provider whose own boot() calls
 * `dispatcher.dispatch(...)` and expects listeners to already be wired.
 */
export class EventsServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(EVENTS_TOKEN, (app) => new EventDispatcher(app));
  }

  boot(): void {
    const dispatcher = this.app.make<EventDispatcher>(EVENTS_TOKEN);

    for (const provider of this.app.getProviders()) {
      const pairs = provider.listeners?.();

      if (!pairs) {
        continue;
      }

      for (const [eventClassOrPattern, listener] of pairs) {
        // Cast: `ListenerRegistration` is a union of two tuple shapes, and
        // destructuring widens each position to the union of both. Which
        // matches no single `listen()` overload even though every
        // *inhabited* pairing does. The dispatcher re-discriminates at
        // runtime on `typeof pattern === "string"`.
        (dispatcher.listen as (a: unknown, b: unknown) => void)(eventClassOrPattern, listener);
      }
    }
  }
}
