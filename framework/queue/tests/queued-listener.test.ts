import { Application, ServiceProvider } from "@mahiframework/core";
import { DatabaseServiceProvider } from "@mahiframework/database";
import {
  AbstractEvent,
  EventDispatcher,
  EventsServiceProvider,
  EVENTS_TOKEN,
  type Listener,
} from "@mahiframework/events";
import { describe, expect, it } from "vitest";
import { QueueServiceProvider } from "../src/queue-service-provider.js";

class UserRegistered extends AbstractEvent {
  constructor(public readonly email: string) {
    super();
  }
}

class SendWelcome implements Listener<UserRegistered> {
  static handled: string[] = [];
  handle(event: UserRegistered) {
    SendWelcome.handled.push(event.email);
  }
}

class AppProvider extends ServiceProvider {
  boot(): void {
    const dispatcher = this.app.make<EventDispatcher>(EVENTS_TOKEN);
    dispatcher.listenQueued(UserRegistered, SendWelcome);
  }
}

async function buildApp(): Promise<Application> {
  const app = new Application();
  app.config.set("database", {
    default: "sqlite",
    connections: { sqlite: { filename: ":memory:" } },
  });
  app.config.set("queue", { default: "sync", connections: { sync: {}, database: {} } });
  app.register(DatabaseServiceProvider);
  app.register(EventsServiceProvider);
  app.register(QueueServiceProvider);
  app.register(AppProvider);
  await app.bootstrap();

  return app;
}

describe("listenQueued() + QueueServiceProvider", () => {
  it("runs the original listener through the sync queue", async () => {
    SendWelcome.handled = [];
    const app = await buildApp();
    const dispatcher = app.make<EventDispatcher>(EVENTS_TOKEN);

    await dispatcher.dispatch(new UserRegistered("a@example.com"));

    expect(SendWelcome.handled).toEqual(["a@example.com"]);
  });
});
