import { describe, expect, it } from "vitest";
import { Application } from "@mahi/core";
import { MailManager, Mailable, ArrayTransport } from "@mahi/mail";
import { MailChannel } from "../src/channels/mail-channel.js";
import { Notification } from "../src/notification.js";
import type { NotificationRoutable } from "../src/notifiable.js";

class User implements NotificationRoutable {
  constructor(public email: string) {}
  routeNotificationFor(channel: string): unknown {
    return channel === "mail" ? this.email : null;
  }
}

class WelcomeMail extends Mailable {
  constructor(private recipient: string) {
    super();
  }
  build(): void {
    this.subject("Welcome").to(this.recipient).html("<p>Hi</p>");
  }
}

class WelcomeNotification extends Notification {
  via(): string[] {
    return ["mail"];
  }
  toMail(notifiable: NotificationRoutable): Mailable {
    return new WelcomeMail(notifiable.routeNotificationFor("mail") as string);
  }
}

class SilentNotification extends Notification {
  via(): string[] {
    return ["mail"];
  }
}

function buildManager(): MailManager {
  const manager = new MailManager(new Application(), {
    default: "array",
    mailers: { array: {} },
    from: { address: "sys@example.com" },
  });
  manager.extend("array", () => new ArrayTransport());

  return manager;
}

describe("MailChannel", () => {
  it("sends the notification's toMail() mailable through the mail manager", async () => {
    const manager = buildManager();
    const channel = new MailChannel(manager);

    await channel.send(new User("ada@example.com"), new WelcomeNotification());

    const transport = manager.mailer() as ArrayTransport;
    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]?.subject).toBe("Welcome");
    expect(transport.messages[0]?.to).toEqual([{ address: "ada@example.com", name: undefined }]);
  });

  it("is a no-op when the notification does not implement toMail", async () => {
    const manager = buildManager();
    const channel = new MailChannel(manager);

    await channel.send(new User("ada@example.com"), new SilentNotification());

    expect((manager.mailer() as ArrayTransport).messages).toHaveLength(0);
  });
});
