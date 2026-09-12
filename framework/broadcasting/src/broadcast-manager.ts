import { Manager, type Application } from "@mahiframework/core";
import type { ServerType } from "@hono/node-server";
import type { BroadcastDriver, BroadcastMessage } from "./broadcast-driver.js";

export interface BroadcastConfig {
  default: string;
  connections: Record<string, unknown>;
}

/**
 * Drivers that own a websocket endpoint on the app's own HTTP server need
 * a hook into the running Node server, which only exists after
 * `@hono/node-server`'s `serve()` has returned. Implementing this is what
 * makes a driver eligible for `BroadcastManager.injectWebSocket()`.
 *
 * Optional on purpose: a Redis/Pusher-style driver has nothing to inject
 * (the socket connection lives elsewhere entirely), and an app swapping
 * to one of those should not have to change its entrypoint.
 */
export interface WebSocketInjectable {
  injectWebSocket(server: ServerType): void;
}

function isWebSocketInjectable(driver: unknown): driver is WebSocketInjectable {
  return typeof (driver as WebSocketInjectable).injectWebSocket === "function";
}

/**
 * Resolves named broadcast connections, synchronously, exactly like
 * `CacheManager`/`QueueManager`. Built-in drivers are registered via
 * `extend()` by `BroadcastServiceProvider` — the same mechanism a plugin
 * uses to add e.g. a `"redis"` driver later, which is the documented
 * answer to `LocalBroadcastDriver`'s single-process limitation.
 */
export class BroadcastManager extends Manager<BroadcastDriver> {
  constructor(
    app: Application,
    private config: BroadcastConfig,
  ) {
    super(app);
  }

  getDefaultDriver(): string {
    return this.config.default;
  }

  /** Domain-flavored alias for `driver()`, mirroring `CacheManager.store()`. */
  connection(name?: string): BroadcastDriver {
    return this.driver(name);
  }

  connectionConfig(name: string): unknown {
    return this.config.connections[name];
  }

  /** Push a message out over the named (or default) connection. */
  broadcast(message: BroadcastMessage, connectionName?: string): Promise<void> {
    return this.connection(connectionName).broadcast(message);
  }

  /**
   * Hand the running Node server to the default (or named) driver, if it
   * needs one — see `WebSocketInjectable`. Called from the app's
   * entrypoint right after `serve()`:
   *
   *   const server = serve({ fetch: kernel.raw().fetch, port });
   *   app.make<BroadcastManager>(BROADCAST_TOKEN).injectWebSocket(server);
   *
   * A no-op for drivers with no websocket server of their own, so this
   * line is safe to leave in place regardless of which driver an app
   * is configured to use.
   */
  injectWebSocket(server: ServerType, connectionName?: string): void {
    const driver = this.connection(connectionName);

    if (isWebSocketInjectable(driver)) {
      driver.injectWebSocket(server);
    }
  }
}
