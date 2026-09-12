import { once } from "node:events";
import { Application } from "@mahiframework/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { HttpResponse } from "../src/response.js";
import { HttpKernel } from "../src/http-kernel.js";
import { HTTP_KERNEL_TOKEN } from "../src/http-service-provider.js";
import { bindWithRetries, listenHttpServer, type ListeningServer } from "../src/listen.js";
import { trustProxies } from "../src/trusted-proxies.js";
import type { HttpPipe } from "../src/middleware/pipeline-middleware.js";
import type { Router } from "../src/router.js";

function appWithPing(register?: (kernel: HttpKernel) => void): Application {
  class PingProvider {
    routes(router: Router) {
      router.get("/ping", () => HttpResponse.json({ ok: true }));
    }
  }

  const app = new Application();
  (app as any).providers = [new PingProvider()];
  const kernel = new HttpKernel(app);
  kernel.collectFromProviders();
  register?.(kernel);
  app.instance(HTTP_KERNEL_TOKEN, kernel);

  return app;
}

describe("listenHttpServer", () => {
  let listening: ListeningServer | undefined;

  afterEach(async () => {
    await listening?.close();
    listening = undefined;
  });

  it("binds a real server and serves registered routes", async () => {
    const app = appWithPing();
    listening = await listenHttpServer(app, { hostname: "127.0.0.1", port: 0 });

    const response = await fetch(`http://127.0.0.1:${listening.port}/ping`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("injects the Node server into a bound broadcast manager", async () => {
    const app = appWithPing();
    const injectWebSocket = vi.fn();
    app.instance("broadcast", { injectWebSocket });

    listening = await listenHttpServer(app, { hostname: "127.0.0.1", port: 0 });

    expect(injectWebSocket).toHaveBeenCalledWith(listening.server);
  });

  it("rejects with EADDRINUSE when the port is already taken", async () => {
    const app = appWithPing();
    listening = await listenHttpServer(app, { hostname: "127.0.0.1", port: 0 });

    await expect(
      listenHttpServer(app, { hostname: "127.0.0.1", port: listening.port }),
    ).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });
});

/**
 * The peer address only exists over a real socket — `hono.request()`
 * dispatches in-process and has none — so these have to bind a server.
 */
describe("client IP over a real socket", () => {
  let listening: ListeningServer | undefined;

  afterEach(async () => {
    await listening?.close({ drainTimeoutMs: 0 });
    listening = undefined;
  });

  function appReportingIp(pipes: HttpPipe[] = []): Application {
    class IpProvider {
      middleware() {
        return pipes;
      }
      routes(router: Router) {
        router.get("/ip", (request) =>
          HttpResponse.json({
            ip: request.ip() ?? null,
            secure: request.secure(),
            root: request.root(),
          }),
        );
      }
    }

    const app = new Application();
    (app as any).providers = [new IpProvider()];
    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();
    app.instance(HTTP_KERNEL_TOKEN, kernel);

    return app;
  }

  it("reports the socket peer, and ignores a forged X-Forwarded-For", async () => {
    listening = await listenHttpServer(appReportingIp(), { hostname: "127.0.0.1", port: 0 });

    const res = await fetch(`http://127.0.0.1:${listening.port}/ip`, {
      headers: { "x-forwarded-for": "9.9.9.9" },
    });

    // Not "9.9.9.9", and — critically — not null. Returning undefined
    // for a direct connection is what made every un-proxied client share
    // one `throttle:unknown:/path` bucket.
    expect((await res.json()) as { ip: string }).toMatchObject({ ip: "127.0.0.1" });
  });

  it("honours X-Forwarded-For once the peer is trusted, and applies X-Forwarded-Proto", async () => {
    const app = appReportingIp([trustProxies(["127.0.0.1", "::1", "::ffff:127.0.0.1"])]);
    listening = await listenHttpServer(app, { hostname: "127.0.0.1", port: 0 });

    const res = await fetch(`http://127.0.0.1:${listening.port}/ip`, {
      headers: {
        "x-forwarded-for": "203.0.113.7",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "api.example.com",
      },
    });

    expect(await res.json()).toEqual({
      ip: "203.0.113.7",
      // Behind a TLS terminator this is what makes generated links come
      // out https:// instead of http://.
      secure: true,
      root: "https://api.example.com",
    });
  });
});

describe("bindWithRetries", () => {
  const servers: ListeningServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it("walks to the next port on EADDRINUSE when attempts > 1", async () => {
    const app = appWithPing();
    const occupier = await listenHttpServer(app, { hostname: "127.0.0.1", port: 0 });
    servers.push(occupier);

    const listening = await bindWithRetries(app, {
      hostname: "127.0.0.1",
      port: occupier.port,
      attempts: 2,
    });
    servers.push(listening);

    expect(listening.port).toBe(occupier.port + 1);
  });

  it("does not walk ports when attempts is 1", async () => {
    const app = appWithPing();
    const occupier = await listenHttpServer(app, { hostname: "127.0.0.1", port: 0 });
    servers.push(occupier);

    await expect(
      bindWithRetries(app, { hostname: "127.0.0.1", port: occupier.port, attempts: 1 }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});

/**
 * `server.close()` alone stops accepting new connections and then waits
 * for the open ones to end — and an upgraded websocket never ends on its
 * own, so a server with a single connected client never finishes closing.
 * That is the "SIGTERM and the process hangs until it is SIGKILLed"
 * symptom, and these are the cases that reproduce it.
 */
describe("ListeningServer.close()", () => {
  const servers: ListeningServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close({ drainTimeoutMs: 0 })));
  });

  it("resolves promptly with an open websocket, closing it", async () => {
    const app = appWithPing((kernel) => {
      const { upgradeWebSocket } = kernel.websocketSupport();
      kernel.raw().get(
        "/socket",
        upgradeWebSocket(() => ({})),
      );
    });

    const listening = await listenHttpServer(app, { hostname: "127.0.0.1", port: 0 });
    servers.push(listening);

    const socket = new WebSocket(`ws://127.0.0.1:${listening.port}/socket`);
    await once(socket, "open");

    const closed = once(socket, "close");
    // A generous drain window that must NOT be waited out: the websocket
    // is closed outright, so this returns immediately rather than in 10s.
    await listening.close({ drainTimeoutMs: 10_000 });

    const [code] = (await closed) as [number];
    // 1001 "going away" — the server is shutting down, so the client
    // should reconnect rather than conclude the conversation is over.
    expect(code).toBe(1001);
  });

  it("stops accepting new connections", async () => {
    const app = appWithPing();
    const listening = await listenHttpServer(app, { hostname: "127.0.0.1", port: 0 });
    servers.push(listening);

    expect((await fetch(`http://127.0.0.1:${listening.port}/ping`)).status).toBe(200);

    await listening.close({ drainTimeoutMs: 0 });

    await expect(fetch(`http://127.0.0.1:${listening.port}/ping`)).rejects.toThrow();
  });

  it("is idempotent, and concurrent calls share one close", async () => {
    const app = appWithPing();
    const listening = await listenHttpServer(app, { hostname: "127.0.0.1", port: 0 });
    servers.push(listening);

    await expect(
      Promise.all([listening.close({ drainTimeoutMs: 0 }), listening.close({ drainTimeoutMs: 0 })]),
    ).resolves.toBeDefined();

    // A third, after both settled — a signal handler firing on a server
    // an entrypoint already closed.
    await expect(listening.close({ drainTimeoutMs: 0 })).resolves.toBeUndefined();
  });

  it("is a no-op path for an app that never asked for websockets", async () => {
    const app = appWithPing();
    const listening = await listenHttpServer(app, { hostname: "127.0.0.1", port: 0 });
    servers.push(listening);

    // `websocketSupport()` is lazy, so no WebSocketServer was ever built
    // and there is nothing for closeWebSockets() to close.
    await expect(listening.close()).resolves.toBeUndefined();
  });

  /**
   * Removing the bind-time `reject` listener without replacing it left
   * the server with NO `error` listener, and Node treats an unhandled
   * `error` event as a throw — so a post-bind socket error took the whole
   * process down.
   */
  it("keeps an error listener on the server after binding", async () => {
    const app = appWithPing();
    const error = vi.spyOn(app.logger, "error").mockImplementation(() => {});
    const listening = await listenHttpServer(app, { hostname: "127.0.0.1", port: 0 });
    servers.push(listening);

    expect(listening.server.listenerCount("error")).toBeGreaterThan(0);

    listening.server.emit("error", new Error("late socket failure"));

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("server error"),
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
});
