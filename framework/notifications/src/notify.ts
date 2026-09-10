import { app } from "@mahi/core";
import type { ChannelManager } from "./channel-manager.js";
import type { Notification } from "./notification.js";
import type { NotificationRoutable } from "./notifiable.js";
import { NOTIFICATIONS_TOKEN } from "./tokens.js";

/**
 * Send `notification` to `notifiable` through the `ChannelManager`
 * singleton — the free-function analogue of Laravel's
 * `$user->notify($notification)`. TS has no traits, so rather than mixing a
 * `notify()` method into every notifiable model, this is a plain function:
 *
 *   await notify(user, new InvoicePaid(invoice));
 *
 * Prefer constructor-injecting `ChannelManager` (via `NOTIFICATIONS_TOKEN`)
 * where practical — reach for this only where threading the manager through
 * is genuinely inconvenient, same guidance as `app()` itself. Sending to
 * many recipients is just a loop (or `Promise.all`) over `notify()`.
 */
export function notify(
  notifiable: NotificationRoutable,
  notification: Notification,
): Promise<void> {
  return app().make<ChannelManager>(NOTIFICATIONS_TOKEN).send(notifiable, notification);
}
