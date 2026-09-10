import type { EventDispatcher } from "@mahi/events";
import type { NotificationChannel } from "../notification-channel.js";
import type { Notification } from "../notification.js";
import type { NotificationRoutable } from "../notifiable.js";
import { NotificationBroadcast } from "../notification-broadcast.js";

/**
 * A thin wrapper over the existing `EventDispatcher`: it dispatches a
 * `NotificationBroadcast` event carrying the notification's `toBroadcast()`
 * payload, and lets `@mahi/broadcasting`'s `afterDispatch()` hook
 * pick it up (because `NotificationBroadcast` structurally implements
 * `ShouldBroadcast`). No new broadcasting plumbing lives here — if
 * broadcasting isn't installed, the event dispatches harmlessly with no
 * listeners.
 *
 * `EventDispatcher` is an explicit constructor dependency (resolved once by
 * the channel factory), mirroring `MailChannel`/`DatabaseChannel`.
 */
export class BroadcastChannel implements NotificationChannel {
  constructor(private events: EventDispatcher) {}

  async send(notifiable: NotificationRoutable, notification: Notification): Promise<void> {
    if (!notification.toBroadcast) {
      return;
    }

    await this.events.dispatch(
      new NotificationBroadcast(notifiable, notification, notification.toBroadcast(notifiable)),
    );
  }
}
