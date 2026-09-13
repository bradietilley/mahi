import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Application } from "@mahiframework/core";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { HttpKernel } from "../src/http-kernel.js";
import { HTTP_KERNEL_TOKEN } from "../src/http-service-provider.js";
import { listenHttpServer, type ListeningServer } from "../src/listen.js";
import { HttpResponse } from "../src/response.js";
import type { Router } from "../src/router.js";

/**
 * These exist for one reason: an application that wants a websocket route
 * of its own alongside a framework one (a PTY bridge next to the
 * broadcast socket, say) needs a way to get one. Building a second
 * `createNodeWebSocket()` looks like the obvious answer, compiles, and
 * then **crashes the process on the first connection**. See
 * `WebSocketSupport`. The kernel owns a single helper instead, and the
 * case worth guarding is "two routes, one helper, both work".
 */

function kernelWith(register: (kernel: HttpKernel) => void): Application {
  class PingProvider {
    routes(router: Router) {
      router.get("/ping", () => HttpResponse.json({ ok: true }));
    }
  }

  const app = new Application();
  (app as unknown as { providers: unknown[] }).providers = [new PingProvider()];
  const kernel = new HttpKernel(app);
  kernel.collectFromProviders();
  register(kernel);
  app.instance(HTTP_KERNEL_TOKEN, kernel);

  return app;
}

/** Connect, collect every frame for a beat, and report what arrived. */
async function exchange(
  port: number,
  path: string,
  send?: (socket: WebSocket) => void,
): Promise<string[]> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const frames: string[] = [];
  socket.binaryType = "arraybuffer";
  socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
    // `binaryType` is arraybuffer, so a binary frame arrives as an
    // ArrayBuffer (byteLength) rather than a Buffer (length).
    const bytes = data instanceof ArrayBuffer ? data.byteLength : (data as Buffer).length;
    frames.push(isBinary ? `binary:${bytes}` : data.toString());
  });

  await once(socket, "open");
  send?.(socket);
  await new Promise((resolve) => setTimeout(resolve, 100));

  socket.close();
  await once(socket, "close");

  return frames;
}

describe("HttpKernel websocket support", () => {
  let listening: ListeningServer | undefined;

  afterEach(async () => {
    await listening?.close();
    listening = undefined;
  });

  async function serve(app: Application): Promise<number> {
    listening = await listenHttpServer(app, { hostname: "127.0.0.1", port: 0 });

    return listening.port;
  }

  it("hands out the same helper every time, so a second one is never built", () => {
    const app = kernelWith(() => {});
    const kernel = app.make<HttpKernel>(HTTP_KERNEL_TOKEN);

    expect(kernel.websocketSupport()).toBe(kernel.websocketSupport());
  });

  it("serves two websocket routes registered on the one helper", async () => {
    const app = kernelWith((kernel) => {
      const { upgradeWebSocket } = kernel.websocketSupport();
      const hono = kernel.raw();

      hono.get(
        "/first",
        upgradeWebSocket(() => ({ onOpen: (_e, ws) => ws.send("first") })),
      );
      hono.get(
        "/second",
        upgradeWebSocket(() => ({ onOpen: (_e, ws) => ws.send("second") })),
      );
    });

    const port = await serve(app);

    // Both, and in either order, the failure this guards against took the
    // whole process down on whichever connected first.
    expect(await exchange(port, "/first")).toEqual(["first"]);
    expect(await exchange(port, "/second")).toEqual(["second"]);
  });

  it("carries binary frames in both directions", async () => {
    const app = kernelWith((kernel) => {
      const { upgradeWebSocket } = kernel.websocketSupport();
      kernel.raw().get(
        "/echo",
        upgradeWebSocket(() => ({
          onMessage: (event, ws) => {
            const data = event.data;
            ws.send(typeof data === "string" ? `text:${data}` : new Uint8Array([1, 2, 3, 4]));
          },
        })),
      );
    });

    const port = await serve(app);

    // A text frame comes back as text; a binary frame comes back as binary
    // and keeps its length. That distinction is the whole framing contract
    // for anything streaming bytes (a PTY, a file) over a socket.
    expect(await exchange(port, "/echo", (s) => s.send("hi"))).toEqual(["text:hi"]);
    expect(await exchange(port, "/echo", (s) => s.send(Buffer.from([9, 9])))).toEqual(["binary:4"]);
  });

  it("leaves plain HTTP routes answering alongside the socket", async () => {
    const app = kernelWith((kernel) => {
      const { upgradeWebSocket } = kernel.websocketSupport();
      kernel.raw().get(
        "/socket",
        upgradeWebSocket(() => ({})),
      );
    });

    const port = await serve(app);

    const response = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  /**
   * The security half. `BroadcastServiceProvider.boot()` mounts its upgrade
   * onto the raw Hono instance before `HttpServiceProvider.boot()` runs.
   * Hono applies `use("*")` only to routes registered AFTER it, so if the
   * global pipes were installed that way the socket would be matched with
   * no global middleware on it whatsoever: no context scope, no maintenance
   * check, and no auth. Nothing about the route table would show it.
   */
  it("runs global middleware on a route mounted before the pipes were collected", async () => {
    const refusals: string[] = [];

    class GuardProvider {
      middleware() {
        return [
          (request: { path(): string }) => {
            refusals.push(request.path());

            return new Response("refused", { status: 401 });
          },
        ];
      }
    }

    const app = new Application();
    (app as unknown as { providers: unknown[] }).providers = [new GuardProvider()];

    const kernel = new HttpKernel(app);

    // Mounted onto raw() BEFORE collectFromProviders(), exactly as a
    // websocket-owning provider's boot() does.
    const { upgradeWebSocket } = kernel.websocketSupport();
    kernel.raw().get(
      "/early",
      upgradeWebSocket(() => ({ onOpen: (_e, ws) => ws.send("early") })),
    );

    kernel.collectFromProviders();
    app.instance(HTTP_KERNEL_TOKEN, kernel);

    const port = await serve(app);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/early`);
    const outcome = await new Promise<string>((resolve) => {
      socket.on("open", () => resolve("OPENED — GUARD BYPASSED"));
      socket.on("error", (error: Error) => resolve(`refused: ${error.message}`));
    });

    expect(outcome).toContain("401");
    expect(refusals).toContain("/early");
  });

  it("binds a server normally when no route ever asked for a socket", async () => {
    // The upgrade listener must not be attached speculatively: an app with
    // no websockets should not construct a WebSocketServer at all.
    const app = kernelWith(() => {});
    const port = await serve(app);

    expect((listening?.server.address() as AddressInfo).port).toBe(port);
    expect((await fetch(`http://127.0.0.1:${port}/ping`)).status).toBe(200);
  });
});
