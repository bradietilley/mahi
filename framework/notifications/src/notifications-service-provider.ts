import { ServiceProvider } from "@mahiframework/core";
import { DatabaseManager, DATABASE_TOKEN, type RegisteredMigration } from "@mahiframework/database";
import createNotificationsTable from "./migrations/0001_create_notifications_table.js";
import { EventDispatcher, EVENTS_TOKEN } from "@mahiframework/events";
import { MailManager, MAIL_TOKEN } from "@mahiframework/mail";
import { ChannelManager } from "./channel-manager.js";
import { MailChannel } from "./channels/mail-channel.js";
import { DatabaseChannel } from "./channels/database-channel.js";
import { BroadcastChannel } from "./channels/broadcast-channel.js";
import { NOTIFICATIONS_TOKEN } from "./tokens.js";

export { NOTIFICATIONS_TOKEN };

/**
 * Registers the `ChannelManager` singleton and pre-registers each built-in
 * channel whose backing package is actually bound — the same "extend() is
 * optional" pattern queue/cache drivers use. A channel is only wired if its
 * dependency token is present in the container:
 *
 *   - `database` — always (the `notifications` table is this package's own
 *     hard dependency on `@mahiframework/database`).
 *   - `mail` — only if `MAIL_TOKEN` is bound (`MailServiceProvider`
 *     registered). Mail is a hard dependency of `MailChannel` specifically,
 *     not of the package as a whole.
 *   - `broadcast` — only if `EVENTS_TOKEN` is bound. Broadcasting itself is
 *     optional: `BroadcastChannel` only needs the `EventDispatcher`, and
 *     `@mahiframework/broadcasting`'s `afterDispatch()` hook (if installed)
 *     forwards the dispatched `NotificationBroadcast` to clients.
 *
 * A `via()` naming a channel that wasn't registered (because its package is
 * absent) throws the standard `DriverNotRegisteredError` — the same
 * feedback any unregistered driver gives.
 *
 * **Provider ordering:** list this provider after `DatabaseServiceProvider`
 * and — if their channels are used — after `MailServiceProvider`,
 * `EventsServiceProvider`, and `BroadcastServiceProvider`, since the
 * channel factories resolve those tokens at `register()` time. Same hard-
 * ordering pattern documented for `QueueServiceProvider` needing
 * `DatabaseServiceProvider` first.
 */
export class NotificationsServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(NOTIFICATIONS_TOKEN, (app) => {
      const manager = new ChannelManager(app);

      manager.extend(
        "database",
        () => new DatabaseChannel(app.make<DatabaseManager>(DATABASE_TOKEN)),
      );

      if (app.has(MAIL_TOKEN)) {
        manager.extend("mail", () => new MailChannel(app.make<MailManager>(MAIL_TOKEN)));
      }

      if (app.has(EVENTS_TOKEN)) {
        manager.extend(
          "broadcast",
          () => new BroadcastChannel(app.make<EventDispatcher>(EVENTS_TOKEN)),
        );
      }

      return manager;
    });
  }

  /**
   * Static rather than a `migrations()` directory path — see
   * `QueueServiceProvider.migrationSources()`.
   */
  migrationSources(): RegisteredMigration[] {
    return [{ name: "0001_create_notifications_table", migration: createNotificationsTable }];
  }
}
