import { serve, type ServerType } from "@hono/node-server";
import { BROADCAST_TOKEN, type Application } from "@mahiframework/core";
import { HTTP_KERNEL_TOKEN } from "./http-service-provider.js";
import type { HttpKernel } from "./http-kernel.js";

// `@mahiframework/broadcasting`'s `BroadcastManager` token, resolved by
// string so this package does not import broadcasting (that package
// already depends on http, so importing it back would be a cycle). The
// token literal comes from `@mahiframework/core`'s `well-known-tokens`, the
// shared source of truth both packages agree on.

/**
 * How long `close()` waits for in-flight requests and keep-alive sockets
 * to finish before forcing the remaining ones shut. Ten seconds is the
 * usual orchestrator grace period (Kubernetes' default
 * `terminationGracePeriodSeconds` is 30, Docker's `stop` timeout 10), so
 * the drain finishes inside the window rather than being SIGKILLed
 * halfway through it.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export interface ListenHttpOptions {
  port: number;
  /** Omit to bind Node's default (all interfaces). */
  hostname?: string;
}

export interface ListeningServer {
  server: ServerType;
  port: number;
  hostname: string;
  /**
   * Stop accepting connections and shut down gracefully: close open
   * websockets, wait up to `drainTimeoutMs` (default
   * `DEFAULT_DRAIN_TIMEOUT_MS`) for in-flight requests to finish, then
   * destroy whatever is left. Resolves once the server has closed;
   * idempotent, so a signal handler and an explicit call can both run.
   */
  close(options?: CloseOptions): Promise<void>;
}

export interface CloseOptions {
  /**
   * Milliseconds to wait for open connections to finish before
   * destroying them. `0` closes everything immediately. Defaults to
   * `DEFAULT_DRAIN_TIMEOUT_MS`.
   */
  drainTimeoutMs?: number;
}

interface WebSocketInjectable {
  injectWebSocket(server: ServerType): void;
}

function isWebSocketInjectable(value: unknown): value is WebSocketInjectable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as WebSocketInjectable).injectWebSocket === "function"
  );
}

function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "EADDRINUSE"
  );
}

/**
 * `closeAllConnections`/`closeIdleConnections` exist on `http.Server`
 * (Node >= 18.2) but not on `Http2Server`, and `ServerType` is the union
 * of the three, so they are reached through a capability check rather
 * than a cast.
 */
interface ConnectionClosable {
  closeAllConnections?(): void;
  closeIdleConnections?(): void;
}

/**
 * Shut a listening server down without hanging.
 *
 * `server.close()` alone does two thirds of the job: it stops accepting
 * new connections and resolves once the open ones end. The missing third
 * is that HTTP keep-alive connections and upgraded websockets do NOT end
 * on their own, so a server with a single idle browser tab attached never
 * finishes closing. Which is exactly the "SIGTERM and the process hangs
 * until it is SIGKILLed" symptom.
 *
 * So, in order:
 *   1. websockets are closed (they never end otherwise);
 *   2. `closeIdleConnections()` drops keep-alive sockets sitting between
 *      requests, which is most of them, immediately;
 *   3. in-flight requests get `drainTimeoutMs` to finish;
 *   4. anything still open is destroyed with `closeAllConnections()`.
 *
 * A request that outlives the drain window is cut off, deliberately.
 * The alternative is not "the request completes", it is "the orchestrator
 * SIGKILLs the process", which cuts it off anyway and skips every
 * remaining shutdown hook.
 */
function closeServer(
  server: ServerType,
  closeWebSockets: () => void,
  drainTimeoutMs: number,
): Promise<void> {
  closeWebSockets();

  const closable = server as ConnectionClosable;
  closable.closeIdleConnections?.();

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    server.close((error) => {
      if (timer) {
        clearTimeout(timer);
      }

      // "Server is not running", something already closed it. Shutdown
      // is idempotent by contract, so that is a success, not an error.
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);

        return;
      }

      resolve();
    });

    if (drainTimeoutMs <= 0) {
      closable.closeAllConnections?.();

      return;
    }

    timer = setTimeout(() => {
      closable.closeAllConnections?.();
    }, drainTimeoutMs);
    // The drain timer must not itself keep the process alive. It exists
    // to shorten shutdown, not extend it.
    timer.unref?.();
  });
}

/**
 * Bind `@hono/node-server`'s `serve()` to the app's `HttpKernel` and,
 * when a broadcast manager is registered, hand it the Node server so
 * websocket drivers can attach to the `upgrade` event.
 *
 * The upgrade handler only exists once `serve()` has returned, inject
 * immediately, before the listen callback. A no-op for drivers that
 * don't run their own socket server.
 */
export function listenHttpServer(
  app: Application,
  options: ListenHttpOptions,
): Promise<ListeningServer> {
  const kernel = app.make<HttpKernel>(HTTP_KERNEL_TOKEN);

  return new Promise((resolve, reject) => {
    // One shared close promise, so a signal handler and an explicit
    // `close()` (or two signals in a row from an impatient operator) run
    // the teardown once and both wait for the same result.
    let closing: Promise<void> | undefined;

    const server = serve(
      options.hostname !== undefined
        ? { fetch: kernel.raw().fetch, port: options.port, hostname: options.hostname }
        : { fetch: kernel.raw().fetch, port: options.port },
      (info) => {
        // Swap the bind-time rejecter for a permanent listener rather
        // than just removing it. `reject` is useless once the promise has
        // settled, but leaving the server with NO `error` listener is
        // worse than useless: Node treats an unhandled `error` event as a
        // throw, so a post-bind socket error (a client resetting mid-
        // upgrade, EMFILE under load) takes the whole process down.
        server.off("error", reject);
        server.on("error", (error) => {
          app.logger.error("http: server error after bind.", { error });
        });

        resolve({
          server,
          port: info.port,
          hostname: options.hostname ?? info.address,
          close: (closeOptions) => {
            closing ??= closeServer(
              server,
              () => kernel.closeWebSockets(),
              closeOptions?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
            );

            return closing;
          },
        });
      },
    );

    server.once("error", reject);

    // The kernel's own helper first: it is the one every websocket route
    // in the app shares, including the broadcast driver's when that driver
    // takes it from here (see `HttpKernel.websocketSupport()`). A no-op if
    // no route ever asked for a socket.
    kernel.injectWebSocket(server);

    // Then any driver that runs a socket server of its OWN. Which is not
    // the shipped local driver any more, but remains the contract for a
    // third-party one.
    if (app.has(BROADCAST_TOKEN)) {
      const broadcaster = app.make<unknown>(BROADCAST_TOKEN);

      if (isWebSocketInjectable(broadcaster)) {
        broadcaster.injectWebSocket(server);
      }
    }
  });
}

/**
 * Bind, retrying the next port on `EADDRINUSE`. `attempts` is the total
 * number of ports to try (Laravel `--tries`: offsets `0 .. attempts-1`).
 */
export async function bindWithRetries(
  app: Application,
  options: ListenHttpOptions & { attempts: number },
): Promise<ListeningServer> {
  const attempts = Math.max(1, options.attempts);
  let lastError: unknown;

  for (let offset = 0; offset < attempts; offset++) {
    try {
      return await listenHttpServer(app, {
        hostname: options.hostname,
        port: options.port + offset,
      });
    } catch (error) {
      lastError = error;

      if (!isAddrInUse(error) || offset === attempts - 1) {
        throw error;
      }
    }
  }

  throw lastError;
}
