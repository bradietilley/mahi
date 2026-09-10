import type { NotificationRoutable } from "./notifiable.js";

/**
 * An on-demand notifiable with no backing model — for notifying an address
 * you hold directly rather than a persisted recipient (Laravel's
 * `Notification::route(...)->notify(...)`):
 *
 *   await notify(
 *     new AnonymousNotifiable().route("mail", "ops@example.com"),
 *     new ServerDown(),
 *   );
 *
 * The `database` channel is rejected: it needs a persisted
 * `notifiable_type`/`notifiable_id` to write, which an anonymous target by
 * definition has none of — routing it there is always a mistake, so it
 * throws early rather than writing a row keyed to nothing.
 */
export class AnonymousNotifiable implements NotificationRoutable {
  private routes = new Map<string, unknown>();

  route(channel: string, target: unknown): this {
    if (channel === "database") {
      throw new Error("The database channel does not support anonymous notifiables.");
    }

    this.routes.set(channel, target);

    return this;
  }

  routeNotificationFor(channel: string): unknown {
    return this.routes.get(channel);
  }
}
