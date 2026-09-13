import type { Notification } from "./notification.js";
import type { NotificationRoutable } from "./notifiable.js";

/**
 * The one interface every notification channel implements, the
 * notifications analogue of `MailTransport`/`CacheStore`/`QueueDriver`.
 * Resolved by name through `ChannelManager` (`mail`/`database`/`broadcast`
 * built in, more via `ChannelManager.extend()`).
 *
 * A channel reads its own optional `toXxx()` builder off the notification
 * (e.g. `MailChannel` reads `notification.toMail`), skipping delivery when
 * the notification doesn't implement it.
 */
export interface NotificationChannel {
  send(notifiable: NotificationRoutable, notification: Notification): Promise<void>;
}
