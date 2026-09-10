import { Manager, afterCommit } from "@mahi/core";
import type { NotificationChannel } from "./notification-channel.js";
import type { Notification } from "./notification.js";
import type { NotificationRoutable } from "./notifiable.js";

/**
 * Resolves named notification channels and fans a single `Notification`
 * out across every channel its `via()` returns — the notifications
 * analogue of `MailManager`/`CacheManager`/`QueueManager`.
 *
 * Built-in channels (`mail`/`database`/`broadcast`) are registered via
 * `extend()` by `NotificationsServiceProvider`, exactly the way a plugin
 * would register an additional channel — there is no `via()`-names-an-
 * arbitrary-class dynamic-driver magic (Laravel's
 * `ChannelManager::createDriver()` falls back to `class_exists($driver)`;
 * this doesn't). A `via()` entry naming an unregistered channel throws the
 * standard `DriverNotRegisteredError` from `Manager.driver()`.
 */
export class ChannelManager extends Manager<NotificationChannel> {
  getDefaultDriver(): string {
    return "mail";
  }

  /**
   * Deliver `notification` to `notifiable` over every channel its `via()`
   * lists, sequentially. Each channel resolves lazily on first use and is
   * cached thereafter. Errors propagate to the caller — a caller that
   * wants best-effort delivery across channels wraps its own dispatch (or
   * queues per-channel).
   *
   * When the notification's `afterCommit()` returns `true` and a
   * `DB.transaction()` is open, the whole fan-out is held until that
   * transaction commits and dropped if it rolls back; outside a
   * transaction it delivers immediately.
   */
  async send(notifiable: NotificationRoutable, notification: Notification): Promise<void> {
    if (notification.afterCommit() === true) {
      await afterCommit(() => this.deliver(notifiable, notification));

      return;
    }

    await this.deliver(notifiable, notification);
  }

  /** Fan `notification` out across its `via()` channels — the actual delivery. */
  private async deliver(
    notifiable: NotificationRoutable,
    notification: Notification,
  ): Promise<void> {
    for (const channelName of notification.via(notifiable)) {
      await this.driver(channelName).send(notifiable, notification);
    }
  }
}
