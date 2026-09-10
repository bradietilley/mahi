import { Facade } from "@mahi/facades";
import { CHANNEL_REGISTRY_TOKEN } from "./broadcast-service-provider.js";
import type { ChannelRegistry, ChannelAuthorizationCallback } from "./channel-registry.js";

/**
 * Thin facade over the `ChannelRegistry` singleton — the
 * `Broadcast::channel(...)` entry point for declaring who may subscribe to
 * a `private-`/`presence-` channel. Register callbacks from a provider's
 * `channels()` hook:
 *
 *   Broadcast.channel("orders.{orderId}", async (user, orderId) => {
 *     const order = await Order.find(orderId);
 *     return order?.userId === user?.id;
 *   });
 *
 *   Broadcast.channel("presence-chat.{room}", (user) =>
 *     user ? { id: user.id, name: user.name } : false);
 */
export class Broadcast extends Facade<ChannelRegistry>(() => CHANNEL_REGISTRY_TOKEN) {
  /** Register an authorization callback for a channel pattern. */
  static channel<TUser = unknown>(
    pattern: string,
    callback: ChannelAuthorizationCallback<TUser>,
  ): ChannelRegistry {
    return this.instance().channel<TUser>(pattern, callback);
  }
}
