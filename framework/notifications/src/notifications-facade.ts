import { Facade } from "@mahiframework/facades";
import type { ChannelManager } from "./channel-manager.js";
import type { Notification } from "./notification.js";
import type { NotificationRoutable } from "./notifiable.js";
import { AnonymousNotifiable } from "./anonymous-notifiable.js";
import { NOTIFICATIONS_TOKEN } from "./tokens.js";

/**
 * Thin facade over the `ChannelManager` singleton bound at
 * `NOTIFICATIONS_TOKEN`, for call sites that would otherwise read
 * `app().make<ChannelManager>(NOTIFICATIONS_TOKEN).send(...)` — the
 * notifications analogue of `Mail`/`Bus`/`Events`.
 *
 *   await Notifications.send(user, new InvoicePaid(invoice));
 *   await Notifications.send([alice, bob], new InvoicePaid(invoice));
 *   await Notifications.route("mail", "ops@example.com").send(new ServerDown());
 *
 * Named `Notifications` (plural), not `Notification`, because the package
 * already exports the `Notification` base class — same plural-facade /
 * singular-base-class split as `Events`/`Event`, `Bus`/`Job`,
 * `Mail`/`Mailable`.
 *
 * `notify(notifiable, notification)` is the single-recipient free-function
 * equivalent of `Notifications.send(one, notification)`; prefer
 * constructor-injecting `ChannelManager` (via `NOTIFICATIONS_TOKEN`) where
 * threading it through is practical, same guidance as `app()` itself.
 */
export class Notifications extends Facade<ChannelManager>(() => NOTIFICATIONS_TOKEN) {
  /**
   * Deliver `notification` to one notifiable or an array of them, over
   * each recipient's `via()` channels. Recipients are processed
   * sequentially — pass an array rather than looping at the call site so a
   * single `await` covers the whole fan-out. Errors propagate (a caller
   * wanting best-effort delivery wraps its own dispatch or queues
   * per-recipient).
   */
  static async send(
    notifiables: NotificationRoutable | NotificationRoutable[],
    notification: Notification,
  ): Promise<void> {
    const manager = this.instance();

    for (const notifiable of Array.isArray(notifiables) ? notifiables : [notifiables]) {
      await manager.send(notifiable, notification);
    }
  }

  /**
   * Begin an on-demand notification to a route you hold directly (an email
   * address, a broadcast channel, …) rather than a persisted notifiable —
   * Laravel's `Notification::route(...)->notify(...)`. Returns an
   * `AnonymousNotifiable` whose own `.route()` chains further channels and
   * whose delivery is done via `Notifications.send(...)`:
   *
   *   await Notifications.send(
   *     Notifications.route("mail", "ops@example.com"),
   *     new ServerDown(),
   *   );
   *
   * The `database` channel is rejected here (an anonymous target has no
   * persisted `notifiable_type`/`notifiable_id`) — see
   * `AnonymousNotifiable`.
   */
  static route(channel: string, target: unknown): AnonymousNotifiable {
    return new AnonymousNotifiable().route(channel, target);
  }
}
