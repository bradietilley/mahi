import type { Mailable } from "@mahiframework/mail";
import type { NotificationRoutable } from "./notifiable.js";

/**
 * Base class for a notification, a single message that may fan out across
 * several channels (mail + database + broadcast) from one definition.
 * Subclass it, declare which channels it goes out on via `via()`, and
 * implement one `toXxx()` builder per channel:
 *
 *   class InvoicePaid extends Notification {
 *     constructor(private invoice: Invoice) { super(); }
 *     via(): string[] { return ["mail", "database"]; }
 *     toMail(): Mailable { return new InvoicePaidMail(this.invoice); }
 *     toDatabase(): object { return { invoiceId: this.invoice.id }; }
 *   }
 *
 * The per-channel `toMail`/`toDatabase`/`toBroadcast` methods are **optional
 * methods**, not magic `method_exists()` reflection: TS expresses "may or
 * may not implement this" as an optional method on the class, and each
 * channel checks `if (!notification.toX) return;` before calling it. A
 * plugin channel adds its own optional `toXxx()` convention the same way.
 * There is no central registry of channel method names.
 *
 * Unlike Laravel's `Notification`, `via()` receives the notifiable so a
 * notification can vary its channels per recipient (e.g. only email users
 * who opted in), but there is no `routeNotificationFor{Studly}` reflection
 * anywhere. Routing is the notifiable's explicit `routeNotificationFor()`.
 */
export abstract class Notification {
  /**
   * A stable value stored in the `notifications.type` column by
   * `DatabaseChannel`. Set this on any notification whose class name might
   * be mangled by a minifier or clash with another module's notification,
   * `constructor.name` (the fallback) is neither stable across builds nor
   * unique across modules:
   *
   *   class InvoicePaid extends Notification {
   *     static type = "billing.InvoicePaid";
   *   }
   *
   * Changing it after rows exist changes how future rows are keyed; existing
   * rows keep their old `type`.
   */
  static type?: string;

  /** The stable discriminant stored in `notifications.type`, the class's `static type`, or its name. */
  databaseType(): string {
    return (this.constructor as typeof Notification).type ?? this.constructor.name;
  }

  /**
   * Stable identifier for this notification instance. Used as the primary
   * key by `DatabaseChannel` (and to correlate the same logical
   * notification across channels). Defaults to a fresh UUID at persist
   * time when left unset, set it explicitly only if you need a
   * caller-chosen id.
   */
  id?: string;

  /** Optional locale hint a channel may honor when rendering. */
  locale?: string;

  /**
   * Whether this notification is delivered only after the enclosing
   * `DB.transaction()` commits, Laravel's `Notification::afterCommit()`.
   * Return `true` on a notification that reads rows written by the
   * transaction it is sent from, so delivery is held until the data is
   * durable and dropped if the transaction rolls back. Outside a
   * transaction it sends immediately; `undefined` (the default) means "no
   * opinion, send immediately".
   *
   *   class InvoicePaid extends Notification {
   *     override afterCommit() { return true; }
   *   }
   */
  afterCommit(): boolean | undefined {
    return undefined;
  }

  /**
   * The channel names this notification is delivered on for `notifiable`,
   * e.g. `["mail", "database"]`. Each name is resolved through
   * `ChannelManager` (`mail`/`database`/`broadcast` built in, more via
   * `ChannelManager.extend()`).
   */
  abstract via(notifiable: NotificationRoutable): string[];

  /**
   * Build the message delivered over the `mail` channel. Return a
   * `Mailable`, `MailChannel` hands it straight to `MailManager.send()`.
   * Omit this method entirely if the notification never uses `"mail"`.
   */
  toMail?(notifiable: NotificationRoutable): Mailable;

  /**
   * The JSON-serializable payload stored in the `notifications` table's
   * `data` column by `DatabaseChannel`. Typed as `object` (not
   * `Record<string, unknown>`) so a subclass can return a narrow, named
   * payload interface directly, a TS interface type has no index signature
   * and so isn't assignable to `Record<string, unknown>`, whereas `object`
   * accepts any non-primitive. Omit if never using `"database"`.
   */
  toDatabase?(notifiable: NotificationRoutable): object;

  /**
   * The payload broadcast over the `broadcast` channel by
   * `BroadcastChannel` (wrapped in a `NotificationBroadcast` event that
   * `@mahiframework/broadcasting` forwards to websocket clients). Typed as
   * `object` for the same reason as `toDatabase()`. Omit if never using
   * `"broadcast"`.
   */
  toBroadcast?(notifiable: NotificationRoutable): object;
}
