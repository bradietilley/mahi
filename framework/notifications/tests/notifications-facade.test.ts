import { afterEach, describe, expect, it } from "vitest";
import { Application, setCurrentApp, clearCurrentApp } from "@mahi/core";
import { ChannelManager } from "../src/channel-manager.js";
import { Notification } from "../src/notification.js";
import { Notifications } from "../src/notifications-facade.js";
import { AnonymousNotifiable } from "../src/anonymous-notifiable.js";
import { NOTIFICATIONS_TOKEN } from "../src/tokens.js";
import type { NotificationRoutable } from "../src/notifiable.js";

class Recipient implements NotificationRoutable {
  constructor(public label: string) {}
  routeNotificationFor(): unknown {
    return this.label;
  }
}

class Ping extends Notification {
  via(): string[] {
    return ["memory"];
  }
}

function bootApp(): NotificationRoutable[] {
  const app = new Application();
  const delivered: NotificationRoutable[] = [];

  app.singleton(NOTIFICATIONS_TOKEN, (a) => {
    const manager = new ChannelManager(a);
    manager.extend("memory", () => ({
      async send(notifiable) {
        delivered.push(notifiable);
      },
    }));

    return manager;
  });
  setCurrentApp(app);

  return delivered;
}

afterEach(() => {
  clearCurrentApp();
});

describe("Notifications facade", () => {
  it("send() delivers to a single notifiable", async () => {
    const delivered = bootApp();
    const user = new Recipient("alice");

    await Notifications.send(user, new Ping());

    expect(delivered).toEqual([user]);
  });

  it("send() delivers to an array of notifiables, in order", async () => {
    const delivered = bootApp();
    const alice = new Recipient("alice");
    const bob = new Recipient("bob");

    await Notifications.send([alice, bob], new Ping());

    expect(delivered).toEqual([alice, bob]);
  });

  it("send() with an empty array delivers to no one", async () => {
    const delivered = bootApp();

    await Notifications.send([], new Ping());

    expect(delivered).toEqual([]);
  });

  it("route() returns an AnonymousNotifiable carrying the route", () => {
    bootApp();

    const notifiable = Notifications.route("mail", "ops@example.com");

    expect(notifiable).toBeInstanceOf(AnonymousNotifiable);
    expect(notifiable.routeNotificationFor("mail")).toBe("ops@example.com");
  });

  it("route() target can be delivered via send()", async () => {
    const delivered = bootApp();
    const target = Notifications.route("memory", "ops@example.com");

    await Notifications.send(target, new Ping());

    expect(delivered).toEqual([target]);
  });
});
