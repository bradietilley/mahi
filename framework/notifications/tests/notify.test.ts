import { afterEach, describe, expect, it } from "vitest";
import { Application, setCurrentApp, clearCurrentApp } from "@mahiframework/core";
import { ChannelManager } from "../src/channel-manager.js";
import { Notification } from "../src/notification.js";
import { notify } from "../src/notify.js";
import { NOTIFICATIONS_TOKEN } from "../src/tokens.js";
import type { NotificationRoutable } from "../src/notifiable.js";

class Recipient implements NotificationRoutable {
  routeNotificationFor(): unknown {
    return "target";
  }
}

class Ping extends Notification {
  via(): string[] {
    return ["memory"];
  }
}

afterEach(() => {
  clearCurrentApp();
});

describe("notify", () => {
  it("sends the notification through the ChannelManager bound on the current app", async () => {
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

    const recipient = new Recipient();
    await notify(recipient, new Ping());

    expect(delivered).toEqual([recipient]);
  });
});
