import { describe, expect, it } from "vitest";
import { Application } from "@mahi/core";
import { EventDispatcher } from "@mahi/events";
import { BroadcastChannel } from "../src/channels/broadcast-channel.js";
import { NotificationBroadcast } from "../src/notification-broadcast.js";
import { Notification } from "../src/notification.js";
import type { NotificationRoutable } from "../src/notifiable.js";

class User implements NotificationRoutable {
  constructor(public id: string) {}
  routeNotificationFor(channel: string): unknown {
    return channel === "broadcast" ? `users.${this.id}` : null;
  }
}

class Unroutable implements NotificationRoutable {
  routeNotificationFor(): unknown {
    return null;
  }
}

class PostLiked extends Notification {
  constructor(private postId: string) {
    super();
  }
  via(): string[] {
    return ["broadcast"];
  }
  toBroadcast(): Record<string, unknown> {
    return { postId: this.postId };
  }
}

class SilentNotification extends Notification {
  via(): string[] {
    return ["broadcast"];
  }
}

describe("BroadcastChannel", () => {
  it("dispatches a NotificationBroadcast carrying the toBroadcast() payload", async () => {
    const dispatcher = new EventDispatcher(new Application());
    const captured: NotificationBroadcast[] = [];
    dispatcher.afterDispatch((event) => {
      if (event instanceof NotificationBroadcast) {
        captured.push(event);
      }
    });

    const channel = new BroadcastChannel(dispatcher);
    await channel.send(new User("7"), new PostLiked("post-1"));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.data).toEqual({ postId: "post-1" });
  });

  it("is a no-op when the notification does not implement toBroadcast", async () => {
    const dispatcher = new EventDispatcher(new Application());
    const captured: NotificationBroadcast[] = [];
    dispatcher.afterDispatch((event) => {
      if (event instanceof NotificationBroadcast) {
        captured.push(event);
      }
    });

    await new BroadcastChannel(dispatcher).send(new User("7"), new SilentNotification());

    expect(captured).toHaveLength(0);
  });
});

describe("NotificationBroadcast", () => {
  it("broadcastChannel() uses the notifiable's broadcast route", () => {
    const event = new NotificationBroadcast(new User("7"), new PostLiked("post-1"), {});
    expect(event.broadcastChannel()).toBe("users.7");
  });

  it("broadcastChannel() falls back to the notification class name without a route", () => {
    const event = new NotificationBroadcast(new Unroutable(), new PostLiked("post-1"), {});
    expect(event.broadcastChannel()).toBe("PostLiked");
  });

  it("broadcastEventName() is the notification class name", () => {
    const event = new NotificationBroadcast(new User("7"), new PostLiked("post-1"), {});
    expect(event.broadcastEventName()).toBe("PostLiked");
  });

  it("broadcastPayload() merges id/type with the data", () => {
    const notification = new PostLiked("post-1");
    notification.id = "n-1";
    const event = new NotificationBroadcast(new User("7"), notification, { postId: "post-1" });

    expect(event.broadcastPayload()).toEqual({ id: "n-1", type: "PostLiked", postId: "post-1" });
  });
});
