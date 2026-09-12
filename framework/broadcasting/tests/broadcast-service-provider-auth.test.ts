import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Application, type ServiceProvider } from "@mahiframework/core";
import { EventsServiceProvider } from "@mahiframework/events";
import { HttpServiceProvider, HttpKernel, HTTP_KERNEL_TOKEN } from "@mahiframework/http";
import { afterEach, describe, expect, it } from "vitest";
import { BroadcastManager } from "../src/broadcast-manager.js";
import {
  BroadcastServiceProvider,
  resolveBroadcastDriverOptions,
  BROADCAST_TOKEN,
  CHANNEL_REGISTRY_TOKEN,
} from "../src/broadcast-service-provider.js";
import { ChannelRegistry } from "../src/channel-registry.js";
import { ContainerBroadcastAuthorizer } from "../src/container-authorizer.js";
import { TestSocket } from "./websocket-test-helpers.js";

/** A provider that declares a couple of channel-authorization callbacks. */
class AppChannelsProvider {
  channels(broadcast: ChannelRegistry): void {
    broadcast.channel("orders.{orderId}", (user, orderId) => {
      return (user as { id?: string } | null)?.id === orderId;
    });
  }
}

async function bootApp(): Promise<Application> {
  const app = new Application();
  app.config.set("broadcasting", { default: "local", connections: { local: {} } });

  app.register(EventsServiceProvider);
  app.register(HttpServiceProvider);
  app.register(BroadcastServiceProvider);
  // A stand-in "auth" manager: guards resolve a fixed user by the header the
  // test sends, so the auth endpoint has something to authenticate against
  // without pulling in @mahiframework/auth.
  class FakeAuthProvider {
    register(): void {
      app.instance("auth", {
        guard: () => ({
          user: (request: { header(name: string): string | undefined }) => {
            const id = request.header("x-user");

            return Promise.resolve(id ? { id } : null);
          },
        }),
      });
    }
  }
  app.register(FakeAuthProvider as unknown as new (app: Application) => ServiceProvider);
  app.register(AppChannelsProvider as unknown as new (app: Application) => ServiceProvider);
  await app.bootstrap();

  return app;
}

describe("BroadcastServiceProvider channel authorization", () => {
  let server: ServerType | undefined;
  const sockets: TestSocket[] = [];

  async function listen(app: Application): Promise<number> {
    const kernel = app.make<HttpKernel>(HTTP_KERNEL_TOKEN);
    const broadcaster = app.make<BroadcastManager>(BROADCAST_TOKEN);
    server = serve({ fetch: kernel.raw().fetch, port: 0 });
    broadcaster.injectWebSocket(server);
    await once(server, "listening");

    return (server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));

    if (server) {
      const closing = server;
      server = undefined;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  });

  it("collects channels() declarations from every provider into the registry", async () => {
    const app = await bootApp();
    const registry = app.make<ChannelRegistry>(CHANNEL_REGISTRY_TOKEN);
    expect(registry.size).toBe(1);

    expect(await registry.authorize("private-orders.5", { id: "5" })).toMatchObject({
      authorized: true,
    });
    expect(await registry.authorize("private-orders.5", { id: "9" })).toMatchObject({
      authorized: false,
    });
  });

  it("POST /broadcasting/auth authorizes and returns a grant for an allowed user", async () => {
    const app = await bootApp();
    const port = await listen(app);

    const response = await fetch(`http://127.0.0.1:${port}/broadcasting/auth`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "5" },
      body: JSON.stringify({ channel: "private-orders.5" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { auth: string | null };
    // No signer bound in this app, so the grant is null but the request is
    // authorized (200, not 403) — the endpoint ran the channel callback.
    expect(body).toHaveProperty("auth");
  });

  it("POST /broadcasting/auth rejects a user who fails the channel callback", async () => {
    const app = await bootApp();
    const port = await listen(app);

    const response = await fetch(`http://127.0.0.1:${port}/broadcasting/auth`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "9" },
      body: JSON.stringify({ channel: "private-orders.5" }),
    });

    expect(response.status).toBe(403);
  });

  it("POST /broadcasting/auth returns 422 without a channel", async () => {
    const app = await bootApp();
    const port = await listen(app);

    const response = await fetch(`http://127.0.0.1:${port}/broadcasting/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(422);
  });
});

/**
 * A fresh app has no `APP_KEY` — that is the state `key:generate` exists
 * to leave. `@mahiframework/encryption` binds `"signer"` as a singleton whose
 * FACTORY calls `parseAppKey()` and throws when the key is unset, so the
 * token is bound but not buildable until the key exists.
 *
 * This provider resolves the signer for the `/broadcasting/auth` grant.
 * Doing so eagerly, at boot, turned that throw into a failure of
 * `app.bootstrap()` itself — so the app could not start, so
 * `key:generate` could never run, so the key was never created. A fresh
 * `npm create mahi` was unbootable.
 *
 * The signer is therefore resolved through a thunk, on first grant
 * operation. `app.has()` cannot catch this: the token IS bound. Only
 * not resolving it can.
 *
 * The signer here is bound to throw rather than pulling in
 * `@mahiframework/encryption` (which `@mahiframework/broadcasting` does not depend on) —
 * the throw is the whole of the behaviour that matters.
 */
describe("BroadcastServiceProvider boot without an APP_KEY", () => {
  /** Boots with a `"signer"` bound exactly as a keyless app's is: bound, unbuildable. */
  async function bootAppWithUnbuildableSigner(): Promise<{ app: Application; builds: number }> {
    const counter = { builds: 0 };
    const app = new Application();
    app.config.set("broadcasting", { default: "local", connections: { local: {} } });

    app.register(EventsServiceProvider);
    app.register(HttpServiceProvider);
    class KeylessEncryptionProvider {
      register(): void {
        app.singleton("signer", () => {
          counter.builds += 1;
          throw new Error(
            "APP_KEY is not set. Run `./artisan key:generate` and add the printed value to your .env file.",
          );
        });
      }
    }
    app.register(KeylessEncryptionProvider as unknown as new (app: Application) => ServiceProvider);
    app.register(BroadcastServiceProvider);

    await app.bootstrap();

    return { app, builds: counter.builds };
  }

  it("boots when the signer is bound but cannot be built", async () => {
    const { app, builds } = await bootAppWithUnbuildableSigner();

    // The token is bound — `app.has()` is true, which is exactly why a
    // `has()` guard was not enough on its own.
    expect(app.has("signer")).toBe(true);
    // ...but boot never built it, so the throw never fired.
    expect(builds).toBe(0);
    expect(app.isResolved("signer")).toBe(false);
  });

  it("leaves the app usable, so key:generate gets its chance to run", async () => {
    const { app } = await bootAppWithUnbuildableSigner();

    // Boot completed, so the console kernel could now dispatch
    // `key:generate` — the whole point of deferring the signer.
    expect(app.make<HttpKernel>(HTTP_KERNEL_TOKEN)).toBeInstanceOf(HttpKernel);
    expect(app.make<BroadcastManager>(BROADCAST_TOKEN)).toBeInstanceOf(BroadcastManager);
  });

  it("defers the failure to the first grant, rather than swallowing it", async () => {
    const { app } = await bootAppWithUnbuildableSigner();

    // `resolveBroadcastDriverOptions` is the boot-time path: building it
    // must not resolve the signer either.
    const { authorizer } = resolveBroadcastDriverOptions(app);
    expect(app.isResolved("signer")).toBe(false);

    // Deferred, not discarded: a grant request on a still-keyless app is
    // a real error and must surface as one. Failing here (one request)
    // rather than at boot (the entire app) is the whole distinction.
    expect(() =>
      (authorizer as ContainerBroadcastAuthorizer).mintGrant("private-orders.1", 60_000),
    ).toThrow(/APP_KEY is not set/);
  });
});
