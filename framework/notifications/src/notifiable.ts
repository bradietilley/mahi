/**
 * The contract a model implements to receive notifications — the TS
 * equivalent of Laravel's `Notifiable` trait, minus the magic.
 *
 * Laravel's `Notifiable` drives per-channel routing via
 * `routeNotificationFor{Studly}($channel)` — a **string-reflection**
 * method-name lookup (`routeNotificationForMail`, `routeNotificationForSlack`,
 * …). This framework rejects that pattern: a
 * notifiable instead implements ONE explicit `routeNotificationFor(channel)`
 * method with a plain `switch`, so "where does channel X deliver to?" is
 * ordinary, greppable, type-checked code — no string-to-method-name magic.
 *
 *   class User extends Model implements NotificationRoutable {
 *     routeNotificationFor(channel: string): unknown {
 *       switch (channel) {
 *         case "mail":     return this.email;
 *         case "database": return this.id;
 *         default:         return null;
 *       }
 *     }
 *   }
 */
export interface NotificationRoutable {
  /**
   * The delivery target for a given channel — an email address for
   * `"mail"`, the model's primary key for `"database"`, etc. Returning
   * `null`/`undefined` means "this notifiable has no route for that
   * channel"; a channel is free to skip delivery in that case.
   */
  routeNotificationFor(channel: string): unknown;
}
