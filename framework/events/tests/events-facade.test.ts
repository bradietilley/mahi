import { afterEach, describe, expect, it } from "vitest";
import { Application, ServiceProvider, clearCurrentApp } from "@mahi/core";
import { AbstractEvent } from "../src/event.js";
import type { Listener } from "../src/listener.js";
import type { EventDispatcher, QueuedListenerPayload } from "../src/event-dispatcher.js";
import { EVENTS_TOKEN, EventsServiceProvider } from "../src/events-service-provider.js";
import type { ListenerRegistration } from "../src/provider-hooks.js";
import { Events } from "../src/event-facade.js";

class UserRegistered extends AbstractEvent {
  constructor(public readonly email: string) {
    super();
  }
}

describe("Events facade", () => {
  afterEach(() => {
    clearCurrentApp();
  });

  it("dispatch() runs listeners registered on the current app()'s EventDispatcher", async () => {
    const handled: string[] = [];

    class SendWelcomeEmail implements Listener<UserRegistered> {
      handle(event: UserRegistered) {
        handled.push(`welcome:${event.email}`);
      }
    }

    class TodosLikeProvider extends ServiceProvider {
      listeners() {
        return [[UserRegistered, SendWelcomeEmail] as const];
      }
    }

    const app = new Application();
    app.register(EventsServiceProvider);
    app.register(TodosLikeProvider);
    await app.bootstrap();

    await Events.dispatch(new UserRegistered("a@example.com"));

    expect(handled).toEqual(["welcome:a@example.com"]);
  });

  it("wires patterns and closures returned from a provider's listeners() hook", async () => {
    const handled: string[] = [];

    class PostCreated extends AbstractEvent {
      override get eventName(): string {
        return "model.posts.created";
      }
    }

    class AuditModelWrites implements Listener {
      handle(event: AbstractEvent) {
        handled.push(`audit:${event.eventName}`);
      }
    }

    class TodosLikeProvider extends ServiceProvider {
      listeners(): ReadonlyArray<ListenerRegistration> {
        return [
          ["model.posts.*", AuditModelWrites],
          [
            "model.*",
            (event) => {
              handled.push(`wild:${event.eventName}`);
            },
          ],
          [
            PostCreated,
            (event) => {
              handled.push(`class:${event.eventName}`);
            },
          ],
        ];
      }
    }

    const app = new Application();
    app.register(EventsServiceProvider);
    app.register(TodosLikeProvider);
    await app.bootstrap();

    await Events.dispatch(new PostCreated());

    expect(handled).toEqual([
      "audit:model.posts.created",
      "wild:model.posts.created",
      "class:model.posts.created",
    ]);
  });

  it("throws app()'s own error when no Application has bootstrapped yet", () => {
    expect(() => Events.dispatch(new UserRegistered("a@example.com"))).toThrow(
      /No Application instance is currently registered/,
    );
  });

  describe("listen()", () => {
    async function bootedApp(): Promise<Application> {
      const app = new Application();
      app.register(EventsServiceProvider);
      await app.bootstrap();

      return app;
    }

    it("registers a listener class against an event class", async () => {
      const handled: string[] = [];

      class SendWelcomeEmail implements Listener<UserRegistered> {
        handle(event: UserRegistered) {
          handled.push(`welcome:${event.email}`);
        }
      }

      await bootedApp();
      Events.listen(UserRegistered, SendWelcomeEmail);

      await Events.dispatch(new UserRegistered("a@example.com"));

      expect(handled).toEqual(["welcome:a@example.com"]);
    });

    it("registers a closure against an event class, with the event narrowed", async () => {
      const handled: string[] = [];

      await bootedApp();
      // `event.email` compiling at all is the assertion here: `E` infers
      // from the event class, so this is a typed `UserRegistered`, not
      // `AbstractEvent`.
      Events.listen(UserRegistered, (event) => {
        handled.push(event.email);
      });

      await Events.dispatch(new UserRegistered("b@example.com"));

      expect(handled).toEqual(["b@example.com"]);
    });

    it("registers a wildcard pattern against a listener class", async () => {
      const handled: string[] = [];

      class PostCreated extends AbstractEvent {
        override get eventName(): string {
          return "model.posts.created";
        }
      }

      class AuditModelWrites implements Listener {
        handle(event: AbstractEvent) {
          handled.push(event.eventName);
        }
      }

      await bootedApp();
      Events.listen("model.posts.*", AuditModelWrites);
      Events.listen("model.comments.*", AuditModelWrites);

      await Events.dispatch(new PostCreated());

      expect(handled).toEqual(["model.posts.created"]);
    });

    it("registers a wildcard pattern against a callback", async () => {
      const handled: string[] = [];

      await bootedApp();
      Events.listen("*", (event) => {
        handled.push(event.eventName);
      });

      await Events.dispatch(new UserRegistered("c@example.com"));

      expect(handled).toEqual(["UserRegistered"]);
    });

    it("resolves the current app() on every call, not a cached dispatcher", async () => {
      const first: string[] = [];
      const second: string[] = [];

      await bootedApp();
      Events.listen(UserRegistered, (event) => {
        first.push(event.email);
      });

      // A second Application replaces the current app(); the facade must
      // register against — and dispatch through — the new dispatcher.
      await bootedApp();
      Events.listen(UserRegistered, (event) => {
        second.push(event.email);
      });

      await Events.dispatch(new UserRegistered("d@example.com"));

      expect(first).toEqual([]);
      expect(second).toEqual(["d@example.com"]);
    });
  });

  describe("listenQueued()", () => {
    it("enqueues through the dispatcher's bound handler", async () => {
      const enqueued: QueuedListenerPayload[] = [];

      class SendWelcomeEmail implements Listener<UserRegistered> {
        handle() {}
      }

      const app = new Application();
      app.register(EventsServiceProvider);
      await app.bootstrap();
      app
        .make<EventDispatcher>(EVENTS_TOKEN)
        .useQueuedListenerHandler((payload) => void enqueued.push(payload));

      Events.listenQueued(UserRegistered, SendWelcomeEmail);
      await Events.dispatch(new UserRegistered("e@example.com"));

      expect(enqueued).toEqual([
        { id: "UserRegistered:SendWelcomeEmail", data: { email: "e@example.com" } },
      ]);
    });
  });
});
