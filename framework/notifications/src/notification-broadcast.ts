import { AbstractEvent } from "@mahiframework/events";
import type { Notification } from "./notification.js";
import type { NotificationRoutable } from "./notifiable.js";

/**
 * The `Event` `BroadcastChannel` dispatches for a broadcastable
 * notification. It structurally implements `@mahiframework/broadcasting`'s
 * `ShouldBroadcast` marker (a `broadcastChannel()` method plus the optional
 * `broadcastEventName()`/`broadcastPayload()`), so when broadcasting is
 * installed its `afterDispatch()` hook forwards this to websocket clients
 * with no extra plumbing.
 *
 * It **does not import** `ShouldBroadcast`. That interface is checked
 * structurally by broadcasting, so implementing its shape is enough. This
 * keeps `@mahiframework/broadcasting` an *optional* dependency of
 * notifications: an app with no broadcasting installed can still dispatch
 * this event (it's simply a no-op event with no listeners), and the
 * notifications package needn't depend on broadcasting to define it.
 *
 * The subscribe channel is the notifiable's `routeNotificationFor("broadcast")`
 * when set, else falls back to the notification's class name.
 */
export class NotificationBroadcast extends AbstractEvent {
  constructor(
    public readonly notifiable: NotificationRoutable,
    public readonly notification: Notification,
    public readonly data: object,
  ) {
    super();
  }

  /** The channel clients subscribe to, the notifiable's broadcast route. */
  broadcastChannel(): string {
    const route = this.notifiable.routeNotificationFor("broadcast");

    return typeof route === "string" ? route : this.notification.constructor.name;
  }

  /** The wire-level event name, the notification's class name. */
  broadcastEventName(): string {
    return this.notification.constructor.name;
  }

  /** The JSON payload delivered to clients, the `toBroadcast()` data plus id/type. */
  broadcastPayload(): unknown {
    return {
      id: this.notification.id,
      type: this.notification.constructor.name,
      ...this.data,
    };
  }
}
