import { Model } from "@mahiframework/database";
import type { BuilderFor } from "@mahiframework/database";

/** The attributes of the polymorphic `notifications` table backing `DatabaseChannel`. */
export interface DatabaseNotificationAttributes {
  id: string;
  type: string;
  notifiable_type: string;
  notifiable_id: string;
  /** JSON-encoded `Notification.toDatabase()` payload. */
  data: string;
  /** `null` while unread; the read timestamp once marked read. */
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Read-model over the generic `notifications` table `DatabaseChannel`
 * writes into. `id` is a client-supplied string (a UUID from the channel);
 * `timestamps` stays on so `markAsRead()`/`markAsUnread()` stamp
 * `updated_at`.
 */
export class DatabaseNotification extends Model<DatabaseNotificationAttributes>()({
  table: "notifications",
  primaryKey: "id",
}) {
  /** The decoded `data` payload (parsed from the JSON `data` column). */
  payload<T = Record<string, unknown>>(): T {
    return JSON.parse(this.getRawAttribute("data") as string) as T;
  }

  /** Whether this notification has been read (`read_at` is set). */
  read(): boolean {
    return this.getRawAttribute("read_at") !== null;
  }

  /** Whether this notification is still unread (`read_at` is null). */
  unread(): boolean {
    return !this.read();
  }

  /**
   * Stamp `read_at` (and `updated_at`) now and persist — a no-op if it was
   * already read. The instance counterpart to the bulk `markAllAsRead()`.
   */
  async markAsRead(): Promise<void> {
    if (this.read()) {
      return;
    }

    await this.updateInstance({ read_at: new Date().toISOString() });
  }

  /** Clear `read_at` and persist — a no-op if it was already unread. */
  async markAsUnread(): Promise<void> {
    if (this.unread()) {
      return;
    }

    await this.updateInstance({ read_at: null });
  }

  /**
   * A query scoped to one recipient's notifications, newest first —
   * `(notifiable_type, notifiable_id)` is the composite-indexed pair the
   * table exists to serve. Pass the discriminant + id the way
   * `DatabaseChannel` wrote them.
   */
  static for(
    notifiableType: string,
    notifiableId: string,
  ): BuilderFor<DatabaseNotificationAttributes, DatabaseNotification> {
    return this.query()
      .where("notifiable_type", notifiableType)
      .where("notifiable_id", notifiableId)
      .orderBy("created_at", "desc");
  }

  /** That recipient's unread notifications, newest first. */
  static unreadFor(
    notifiableType: string,
    notifiableId: string,
  ): BuilderFor<DatabaseNotificationAttributes, DatabaseNotification> {
    return this.for(notifiableType, notifiableId).whereNull("read_at");
  }

  /**
   * Mark all of a recipient's unread notifications read in one statement.
   * The bulk counterpart to the instance `markAsRead()`.
   */
  static async markAllAsRead(notifiableType: string, notifiableId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.query()
      .where("notifiable_type", notifiableType)
      .where("notifiable_id", notifiableId)
      .whereNull("read_at")
      .update({ read_at: now, updated_at: now });
  }
}
