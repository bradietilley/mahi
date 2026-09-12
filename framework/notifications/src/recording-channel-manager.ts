import { afterCommit } from "@mahiframework/core";
import { ChannelManager } from "./channel-manager.js";
import type { Notification } from "./notification.js";
import type { NotificationRoutable } from "./notifiable.js";

/** A `Notification` subclass constructor, for asserting by class. */
export type NotificationClass<N extends Notification = Notification> = abstract new (
  ...args: never[]
) => N;

/** A single recorded `(notifiable, notification)` delivery. */
interface RecordedNotification {
  notifiable: NotificationRoutable;
  notification: Notification;
}

/**
 * The notifications equivalent of Laravel's `Notification::fake()`.
 *
 * A drop-in `ChannelManager` subclass that **records** every `send()` call
 * and then **suppresses** the real fan-out — no channel is resolved, no
 * mail leaves, no `notifications` row is written. It keeps the
 * `(notifiable, notification)` pair so `assertSentTo(user, InvoicePaid)`
 * can match the target notifiable and the notification class together.
 *
 * Swap it in for the real manager for a test run (see `@mahiframework/testing`'s
 * `createTestApplication({ fakeNotifications: true })`), then assert:
 *
 *   notifications.assertSentTo(user, InvoicePaid);
 *   notifications.assertSentTo(user, InvoicePaid, (n) => n.invoiceId === invoice.id);
 *   notifications.assertNotSentTo(other, InvoicePaid);
 *   notifications.assertNothingSent();
 *
 * Assertions throw a plain `Error` on failure rather than using a vitest
 * matcher, keeping this package free of any test-runner dependency.
 */
export class RecordingChannelManager extends ChannelManager {
  private recorded: RecordedNotification[] = [];

  /**
   * Record the delivery and return without resolving any channel. A
   * notification whose `afterCommit()` is `true` has its recording
   * deferred until the enclosing transaction commits (and dropped on
   * rollback), the same way the real manager defers delivery — so a test
   * can prove a rolled-back transaction sent nothing.
   */
  override async send(notifiable: NotificationRoutable, notification: Notification): Promise<void> {
    if (notification.afterCommit() === true) {
      await afterCommit(() => void this.recorded.push({ notifiable, notification }));

      return;
    }

    this.recorded.push({ notifiable, notification });
  }

  /**
   * Every notification of `notificationClass` recorded for `notifiable`
   * (identity comparison), in send order. Optionally filtered by a
   * predicate on the notification instance.
   */
  sentTo<N extends Notification>(
    notifiable: NotificationRoutable,
    notificationClass: NotificationClass<N>,
    filter?: (notification: N) => boolean,
  ): N[] {
    let matches = this.recorded
      .filter((r) => r.notifiable === notifiable && r.notification instanceof notificationClass)
      .map((r) => r.notification as N);

    if (filter) {
      matches = matches.filter(filter);
    }

    return matches;
  }

  /** Whether `notifiable` was sent a `notificationClass` (optionally matching `filter`). */
  hasSentTo<N extends Notification>(
    notifiable: NotificationRoutable,
    notificationClass: NotificationClass<N>,
    filter?: (notification: N) => boolean,
  ): boolean {
    return this.sentTo(notifiable, notificationClass, filter).length > 0;
  }

  /**
   * Assert `notifiable` was sent a notification of `notificationClass` at
   * least once. With a `filter`, at least one matching notification must
   * exist. Throws on failure.
   */
  assertSentTo<N extends Notification>(
    notifiable: NotificationRoutable,
    notificationClass: NotificationClass<N>,
    filter?: (notification: N) => boolean,
  ): void {
    if (!this.hasSentTo(notifiable, notificationClass, filter)) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected notification [${notificationClass.name}] to have been sent to the given notifiable${detail}, ` +
          `but it was not. Sent notifications: ${this.describeSent()}.`,
      );
    }
  }

  /**
   * Assert `notifiable` was never sent a notification of
   * `notificationClass`. With a `filter`, assert no *matching* one exists.
   * Throws on failure.
   */
  assertNotSentTo<N extends Notification>(
    notifiable: NotificationRoutable,
    notificationClass: NotificationClass<N>,
    filter?: (notification: N) => boolean,
  ): void {
    if (this.hasSentTo(notifiable, notificationClass, filter)) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected notification [${notificationClass.name}] not to have been sent to the given notifiable${detail}, ` +
          `but it was.`,
      );
    }
  }

  /**
   * Assert `notifiable` was sent `notificationClass` exactly `times` times
   * (optionally counting only matching notifications). Throws on failure.
   */
  assertSentToTimes<N extends Notification>(
    notifiable: NotificationRoutable,
    notificationClass: NotificationClass<N>,
    times: number,
    filter?: (notification: N) => boolean,
  ): void {
    const actual = this.sentTo(notifiable, notificationClass, filter).length;

    if (actual !== times) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected notification [${notificationClass.name}] to have been sent ${times} time(s)${detail}, ` +
          `but it was sent ${actual} time(s).`,
      );
    }
  }

  /** Assert nothing at all was sent. Throws on failure. */
  assertNothingSent(): void {
    if (this.recorded.length > 0) {
      throw new Error(
        `Expected no notifications to have been sent, but found: ${this.describeSent()}.`,
      );
    }
  }

  /** Discard all recorded notifications — handy from a `beforeEach()` for per-test isolation. */
  reset(): void {
    this.recorded = [];
  }

  private describeSent(): string {
    if (this.recorded.length === 0) {
      return "(none)";
    }

    return this.recorded.map((r) => r.notification.constructor.name).join(", ");
  }
}
