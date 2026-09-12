import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import WebSocket from "ws";
import type { WebSocketSupport } from "@mahiframework/http";
import type { LocalBroadcastDriver } from "../src/drivers/local-broadcast-driver.js";

export interface TestServer {
  hono: Hono;
  server: ServerType;
  port: number;
  close: () => Promise<void>;
}

/**
 * Boot a real Node HTTP server with the driver's websocket endpoint
 * mounted and injected. A real server (rather than Hono's in-process
 * `app.request()`) is unavoidable here: the websocket handshake happens at
 * the Node `upgrade` event, below the `fetch` interface Hono's test
 * request helper exercises — an in-process test would never touch the
 * code path this driver exists to implement.
 */
export async function startTestServer(
  driver: LocalBroadcastDriver,
  hono = new Hono(),
  support?: WebSocketSupport,
): Promise<TestServer> {
  driver.registerRoutes(hono, support);

  const server = serve({ fetch: hono.fetch, port: 0 });
  driver.injectWebSocket(server);

  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    hono,
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * A websocket client that buffers every frame it receives, so a test can
 * await "the next message" without racing the server.
 */
export class TestSocket {
  private received: string[] = [];
  private waiters: Array<(frame: string) => void> = [];

  private constructor(private socket: WebSocket) {
    socket.on("message", (data: WebSocket.RawData) => {
      const frame = data.toString();
      const waiter = this.waiters.shift();

      if (waiter) {
        waiter(frame);
      } else {
        this.received.push(frame);
      }
    });
  }

  /**
   * Note the ordering: the `TestSocket` (and with it the `message`
   * listener) is constructed BEFORE awaiting `open`, not after. An
   * endpoint that sends a frame from its own `onOpen` — a scrollback
   * replay, a greeting — delivers it the moment the handshake completes,
   * which is the same tick the `open` event fires. Attaching the listener
   * after that await drops the frame, and drops it *intermittently*: it
   * only loses the race under load, so it passes alone and fails in a
   * full run.
   */
  static async connect(
    port: number,
    path = "/broadcasting/socket",
    options: { headers?: Record<string, string> } = {},
  ): Promise<TestSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: options.headers });
    const testSocket = new TestSocket(socket);
    await once(socket, "open");

    return testSocket;
  }

  /**
   * Attempt a connection that may be refused at the upgrade (e.g. a
   * forbidden Origin). Resolves `true` if the handshake completed, `false`
   * if the server rejected the upgrade.
   */
  static async tryConnect(
    port: number,
    path = "/broadcasting/socket",
    options: { headers?: Record<string, string> } = {},
  ): Promise<boolean> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: options.headers });
    try {
      await once(socket, "open");
      socket.close();

      return true;
    } catch {
      return false;
    }
  }

  send(payload: unknown): void {
    this.socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  /** Subscribe and wait for the server's acknowledgement frame. */
  async subscribe(channel: string): Promise<void> {
    this.send({ type: "subscribe", channel });
    await this.nextMessage();
  }

  /** Unsubscribe and wait for the server's acknowledgement frame. */
  async unsubscribe(channel: string): Promise<void> {
    this.send({ type: "unsubscribe", channel });
    await this.nextMessage();
  }

  nextMessage(timeoutMs = 1000): Promise<Record<string, unknown>> {
    return this.nextFrame(timeoutMs).then((frame) => JSON.parse(frame) as Record<string, unknown>);
  }

  /**
   * The next frame as raw text, unparsed — for an endpoint that is not
   * the broadcast socket and owes it no JSON.
   */
  nextRawFrame(timeoutMs = 1000): Promise<string> {
    return this.nextFrame(timeoutMs);
  }

  /** Assert nothing arrives within the window — for "must NOT receive" cases. */
  async expectNoMessage(windowMs = 100): Promise<void> {
    const frame = await this.nextFrame(windowMs).catch(() => null);

    if (frame !== null) {
      throw new Error(`Expected no message, received: ${frame}`);
    }
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }

    this.socket.close();
    await once(this.socket, "close");
  }

  private nextFrame(timeoutMs: number): Promise<string> {
    const buffered = this.received.shift();

    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for a websocket message.`));
      }, timeoutMs);

      const waiter = (frame: string) => {
        clearTimeout(timer);
        resolve(frame);
      };

      this.waiters.push(waiter);
    });
  }
}

/** Poll until `predicate` holds, so tests don't sleep on arbitrary timers. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition.");
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
