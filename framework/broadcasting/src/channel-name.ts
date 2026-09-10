/**
 * Channel-name conventions, mirroring Laravel/Pusher so existing client
 * libraries (Echo, pusher-js) port unchanged.
 *
 * A channel name's PREFIX decides whether it is authorized:
 *
 *   - `private-*`  — authorized. A client may only subscribe if the
 *     channel-authorization callback registered for it returns truthy for
 *     the connecting user.
 *   - `presence-*` — authorized AND membership-aware. The callback returns
 *     the member payload published to everyone else on the channel
 *     (`here`/`joining`/`leaving`); returning a falsy value denies the
 *     subscription.
 *   - anything else — public. Any connected client may subscribe. This is
 *     the only tier that existed before channel authorization, and the one
 *     the driver still serves without any auth callback at all.
 *
 * The prefix is part of the wire channel name (`private-orders.5`) but NOT
 * part of the pattern an application registers (`orders.{orderId}`) — the
 * registry matches against the name with its prefix stripped, exactly like
 * `Broadcast::channel('orders.{orderId}', …)` matching both
 * `private-orders.5` and `presence-orders.5`.
 */

/** The `private-` prefix marking an authorized, non-membership channel. */
export const PRIVATE_PREFIX = "private-";

/** The `presence-` prefix marking an authorized, membership-aware channel. */
export const PRESENCE_PREFIX = "presence-";

export function isPrivateChannel(channel: string): boolean {
  return channel.startsWith(PRIVATE_PREFIX);
}

export function isPresenceChannel(channel: string): boolean {
  return channel.startsWith(PRESENCE_PREFIX);
}

/**
 * Whether a channel requires authorization at all — i.e. it carries a
 * `private-`/`presence-` prefix. Public channels return `false` and are
 * served without any callback.
 */
export function isProtectedChannel(channel: string): boolean {
  return isPrivateChannel(channel) || isPresenceChannel(channel);
}

/**
 * The channel name with its `private-`/`presence-` prefix removed — the
 * form a channel-authorization pattern is registered and matched against.
 * A public channel is returned unchanged.
 */
export function normalizeChannelName(channel: string): string {
  if (isPrivateChannel(channel)) {
    return channel.slice(PRIVATE_PREFIX.length);
  }

  if (isPresenceChannel(channel)) {
    return channel.slice(PRESENCE_PREFIX.length);
  }

  return channel;
}
