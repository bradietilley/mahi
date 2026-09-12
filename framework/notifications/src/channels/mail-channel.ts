import type { MailManager } from "@mahiframework/mail";
import type { NotificationChannel } from "../notification-channel.js";
import type { Notification } from "../notification.js";
import type { NotificationRoutable } from "../notifiable.js";

/**
 * Delivers a notification's `toMail()` `Mailable` through the injected
 * `MailManager`. `MailManager` is an **explicit constructor dependency**,
 * not resolved from the container inside `send()` — the channel factory in
 * `NotificationsServiceProvider` does the `app.make(MAIL_TOKEN)` once, at
 * registration, so this class stays a plain testable object.
 *
 * A notification that doesn't implement `toMail` is skipped (a notifiable
 * may list `"mail"` in `via()` only conditionally). The mailable owns its
 * own recipients (its `envelope()`/`to()`), so the notifiable's
 * `routeNotificationFor("mail")` is advisory — a `toMail()` that wants the
 * routed address reads it and calls `.to(...)` itself.
 */
export class MailChannel implements NotificationChannel {
  constructor(private mail: MailManager) {}

  async send(notifiable: NotificationRoutable, notification: Notification): Promise<void> {
    if (!notification.toMail) {
      return;
    }

    await this.mail.send(notification.toMail(notifiable));
  }
}
