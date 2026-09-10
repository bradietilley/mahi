import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Application, setAfterCommitResolver, clearAfterCommitResolver } from "@mahi/core";
import { AbstractEvent, EventsServiceProvider, EventDispatcher, EVENTS_TOKEN } from "@mahi/events";
import { HttpServiceProvider, HttpKernel, HTTP_KERNEL_TOKEN } from "@mahi/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BroadcastManager } from "../src/broadcast-manager.js";
import { BroadcastServiceProvider, BROADCAST_TOKEN } from "../src/broadcast-service-provider.js";
import type { BroadcastDriver, BroadcastMessage } from "../src/broadcast-driver.js";
import {
  shouldBroadcast,
  broadcastMessageFor,
  shouldBroadcastAfterCommit,
} from "../src/should-broadcast.js";
import type { ShouldBroadcast, ShouldBroadcastAfterCommit } from "../src/should-broadcast.js";
import { TestSocket } from "./websocket-test-helpers.js";

class TodoCreated extends AbstractEvent implements ShouldBroadcast {
  constructor(public readonly todo: { id: string; title: string }) {
    super();
  }

  broadcastChannel(): string {
    return "todos";
  }
}

class RenamedEvent extends AbstractEvent implements ShouldBroadcast {
  broadcastChannel(): string {
    return "todos";
  }

  broadcastEventName(): string {
    return "todo.renamed";
  }

  broadcastPayload(): unknown {
    return { only: "this" };
  }
}

class PrivateEvent extends AbstractEvent {
  constructor(public readonly secret = "shh") {
    super();
  }
}

class DeferredBroadcastEvent extends AbstractEvent implements ShouldBroadcast {
  static broadcastAfterCommit = true;
  broadcastChannel(): string {
    return "todos";
  }
}

describe("shouldBroadcast()", () => {
  it("recognises an event implementing the marker interface", () => {
    expect(shouldBroadcast(new TodoCreated({ id: "1", title: "t" }))).toBe(true);
  });

  it("rejects an ordinary event, a plain object, and nullish values", () => {
    expect(shouldBroadcast(new PrivateEvent())).toBe(false);
    expect(shouldBroadcast({ broadcastChannel: "todos" })).toBe(false);
    expect(shouldBroadcast(null)).toBe(false);
    expect(shouldBroadcast(undefined)).toBe(false);
  });
});

describe("shouldBroadcastAfterCommit()", () => {
  class StaticMarker extends AbstractEvent implements ShouldBroadcast {
    static broadcastAfterCommit = true;
    broadcastChannel(): string {
      return "todos";
    }
  }

  class InstanceMarker
    extends AbstractEvent
    implements ShouldBroadcast, ShouldBroadcastAfterCommit
  {
    broadcastAfterCommit = true;
    broadcastChannel(): string {
      return "todos";
    }
  }

  it("recognises the static broadcastAfterCommit marker", () => {
    expect(shouldBroadcastAfterCommit(new StaticMarker())).toBe(true);
  });

  it("recognises the instance-property marker", () => {
    expect(shouldBroadcastAfterCommit(new InstanceMarker())).toBe(true);
  });

  it("is false for an event with no marker", () => {
    expect(shouldBroadcastAfterCommit(new TodoCreated({ id: "1", title: "t" }))).toBe(false);
  });
});

describe("broadcastMessageFor()", () => {
  it("defaults the event name to the class name and the payload to the event itself", () => {
    const event = new TodoCreated({ id: "1", title: "Ship it" });

    expect(broadcastMessageFor(event)).toEqual({
      channel: "todos",
      event: "TodoCreated",
      payload: event,
    });
  });

  it("prefers explicit broadcastEventName()/broadcastPayload() overrides", () => {
    expect(broadcastMessageFor(new RenamedEvent())).toEqual({
      channel: "todos",
      event: "todo.renamed",
      payload: { only: "this" },
    });
  });
});

/** Captures messages instead of pushing them over a socket. */
class RecordingDriver implements BroadcastDriver {
  readonly messages: BroadcastMessage[] = [];
  shouldFail = false;

  async broadcast(message: BroadcastMessage): Promise<void> {
    if (this.shouldFail) {
      throw new Error("driver exploded");
    }

    this.messages.push(message);
  }
}

async function bootApp(driverOverride?: BroadcastDriver): Promise<Application> {
  const app = new Application();
  app.config.set("broadcasting", { default: "local", connections: { local: {} } });

  app.register(EventsServiceProvider);
  app.register(HttpServiceProvider);
  app.register(BroadcastServiceProvider);
  await app.bootstrap();

  if (driverOverride) {
    const manager = app.make<BroadcastManager>(BROADCAST_TOKEN);
    manager.extend("recording", () => driverOverride);
    // Re-point the default connection at the recording driver.
    vi.spyOn(manager, "getDefaultDriver").mockReturnValue("recording");
  }

  return app;
}

describe("BroadcastServiceProvider wiring", () => {
  let server: ServerType | undefined;
  const sockets: TestSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));

    if (server) {
      const closing = server;
      server = undefined;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }

    vi.restoreAllMocks();
    clearAfterCommitResolver();
  });

  it("holds a ShouldBroadcastAfterCommit event's broadcast until commit", async () => {
    const deferred: Array<() => void | Promise<void>> = [];
    setAfterCommitResolver({ run: async (cb) => void deferred.push(cb), active: () => true });

    const driver = new RecordingDriver();
    const app = await bootApp(driver);

    await app.make<EventDispatcher>(EVENTS_TOKEN).dispatch(new DeferredBroadcastEvent());

    // Not broadcast yet — held for the commit.
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.messages).toEqual([]);

    for (const cb of deferred) {
      await cb();
    }

    await vi.waitFor(() => expect(driver.messages).toHaveLength(1));
  });

  it("broadcasts a marked event immediately when no transaction is open", async () => {
    const driver = new RecordingDriver();
    const app = await bootApp(driver);

    await app.make<EventDispatcher>(EVENTS_TOKEN).dispatch(new DeferredBroadcastEvent());
    await vi.waitFor(() => expect(driver.messages).toHaveLength(1));
  });

  it("forwards a dispatched ShouldBroadcast event to a subscribed client, end to end", async () => {
    const app = await bootApp();
    const kernel = app.make<HttpKernel>(HTTP_KERNEL_TOKEN);
    const broadcaster = app.make<BroadcastManager>(BROADCAST_TOKEN);

    server = serve({ fetch: kernel.raw().fetch, port: 0 });
    broadcaster.injectWebSocket(server);
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const client = await TestSocket.connect(port);
    sockets.push(client);
    await client.subscribe("todos");

    await app
      .make<EventDispatcher>(EVENTS_TOKEN)
      .dispatch(new TodoCreated({ id: "1", title: "Ship it" }));

    expect(await client.nextMessage()).toEqual({
      channel: "todos",
      event: "TodoCreated",
      payload: { todo: { id: "1", title: "Ship it" } },
    });
  });

  it("does not broadcast — and does not throw — for an event without the marker interface", async () => {
    const driver = new RecordingDriver();
    const app = await bootApp(driver);

    await expect(
      app.make<EventDispatcher>(EVENTS_TOKEN).dispatch(new PrivateEvent()),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(driver.messages).toEqual([]));
  });

  it("logs, rather than propagates, a failing broadcast so it cannot break the dispatching code", async () => {
    const driver = new RecordingDriver();
    driver.shouldFail = true;
    const app = await bootApp(driver);
    const logged = vi.spyOn(app.logger, "error").mockImplementation(() => {});

    // dispatch() itself must still resolve cleanly: a websocket push is a
    // side channel, not part of the application's own success criteria.
    await expect(
      app.make<EventDispatcher>(EVENTS_TOKEN).dispatch(new TodoCreated({ id: "1", title: "t" })),
    ).resolves.toBeUndefined();

    await vi.waitFor(() =>
      expect(logged).toHaveBeenCalledWith(
        "Failed to broadcast event",
        expect.objectContaining({
          event: "TodoCreated",
          channel: "todos",
          error: "driver exploded",
        }),
      ),
    );
  });
});
