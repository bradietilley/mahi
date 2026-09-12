import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Application,
  DriverNotRegisteredError,
  setAfterCommitResolver,
  clearAfterCommitResolver,
} from "@mahiframework/core";
import { ChannelManager } from "../src/channel-manager.js";
import { Notification } from "../src/notification.js";
import type { NotificationChannel } from "../src/notification-channel.js";
import type { NotificationRoutable } from "../src/notifiable.js";

class Recipient implements NotificationRoutable {
  routeNotificationFor(): unknown {
    return "target";
  }
}

class MultiChannel extends Notification {
  via(): string[] {
    return ["a", "b"];
  }
}

function fakeChannel(): NotificationChannel & { calls: number } {
  return {
    calls: 0,
    async send() {
      this.calls++;
    },
  };
}

describe("ChannelManager", () => {
  it("defaults to the mail driver", () => {
    const manager = new ChannelManager(new Application());
    expect(manager.getDefaultDriver()).toBe("mail");
  });

  it("send() fans a notification out across every channel in via()", async () => {
    const manager = new ChannelManager(new Application());
    const a = fakeChannel();
    const b = fakeChannel();
    manager.extend("a", () => a);
    manager.extend("b", () => b);

    await manager.send(new Recipient(), new MultiChannel());

    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
  });

  it("send() passes the notifiable and notification through to each channel", async () => {
    const manager = new ChannelManager(new Application());
    const recipient = new Recipient();
    const notification = new MultiChannel();
    const spy = vi.fn(async () => {});
    manager.extend("a", () => ({ send: spy }));
    manager.extend("b", () => ({ send: spy }));

    await manager.send(recipient, notification);

    expect(spy).toHaveBeenCalledWith(recipient, notification);
  });

  it("send() delivers channels sequentially in via() order", async () => {
    const manager = new ChannelManager(new Application());
    const order: string[] = [];
    manager.extend("a", () => ({
      async send() {
        order.push("a");
      },
    }));
    manager.extend("b", () => ({
      async send() {
        order.push("b");
      },
    }));

    await manager.send(new Recipient(), new MultiChannel());

    expect(order).toEqual(["a", "b"]);
  });

  it("throws DriverNotRegisteredError when via() names an unregistered channel", async () => {
    const manager = new ChannelManager(new Application());
    await expect(manager.send(new Recipient(), new MultiChannel())).rejects.toBeInstanceOf(
      DriverNotRegisteredError,
    );
  });

  describe("after-commit delivery", () => {
    afterEach(() => clearAfterCommitResolver());

    class AfterCommitNotification extends Notification {
      override afterCommit() {
        return true;
      }
      via(): string[] {
        return ["a"];
      }
    }

    it("holds the fan-out until the transaction commits", async () => {
      const deferred: Array<() => void | Promise<void>> = [];
      setAfterCommitResolver({ run: async (cb) => void deferred.push(cb), active: () => true });

      const manager = new ChannelManager(new Application());
      const a = fakeChannel();
      manager.extend("a", () => a);

      await manager.send(new Recipient(), new AfterCommitNotification());
      expect(a.calls).toBe(0);

      for (const cb of deferred) {
        await cb();
      }

      expect(a.calls).toBe(1);
    });

    it("delivers immediately when no transaction is open", async () => {
      const manager = new ChannelManager(new Application());
      const a = fakeChannel();
      manager.extend("a", () => a);

      await manager.send(new Recipient(), new AfterCommitNotification());
      expect(a.calls).toBe(1);
    });
  });
});
