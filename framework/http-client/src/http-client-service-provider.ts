import { EVENTS_TOKEN, ServiceProvider } from "@mahiframework/core";
import type { EventSink } from "./events.js";
import { HttpClientFactory } from "./http-client-factory.js";
import type { HttpClientConfig } from "./http-client-config.js";
import { Http } from "./http.js";
import { HTTP_CLIENT_TOKEN } from "./tokens.js";

export { HTTP_CLIENT_TOKEN };

/**
 * Binds a config-carrying `HttpClientFactory` and points the static `Http`
 * surface at it, so `Http.get()` picks up the application's base URL,
 * timeout, and default headers.
 *
 * Entirely optional: `@mahiframework/http-client` works standalone with no
 * container, on a module-level default factory. This provider only exists
 * for what genuinely needs configuring, named clients, global middleware,
 * and event dispatch.
 *
 *   // config/http-client.ts
 *   export default {
 *     timeout: 10_000,
 *     clients: { github: { baseUrl: "https://api.github.com" } },
 *   } satisfies HttpClientConfig;
 *
 *   await Http.client("github").get("/user");
 */
export class HttpClientServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(HTTP_CLIENT_TOKEN, (app) => {
      const config = app.config.get<HttpClientConfig>("http-client") ?? {};

      return new HttpClientFactory(config);
    });
  }

  /**
   * Wires the event dispatcher, if one is registered, and swaps the
   * module-level factory the static `Http` uses.
   *
   * Deferred to `boot()` because `@mahiframework/events` may register after this
   * provider. `register()` must not assume ordering. The `has()` guard
   * means a missing dispatcher silently skips events rather than failing,
   * so `@mahiframework/events` stays an optional peer.
   */
  boot(): void {
    const factory = this.app.make<HttpClientFactory>(HTTP_CLIENT_TOKEN);

    if (this.app.has(EVENTS_TOKEN)) {
      factory.setEvents(this.app.make<EventSink>(EVENTS_TOKEN));
    }

    Http.swap(factory);
  }
}
