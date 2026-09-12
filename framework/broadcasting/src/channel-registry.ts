import { isPresenceChannel, isProtectedChannel, normalizeChannelName } from "./channel-name.js";

/**
 * What a channel-authorization callback may return.
 *
 *   - `false` / `null` / `undefined` → deny the subscription.
 *   - `true` → allow (private channels).
 *   - an object → allow, and (for presence channels) publish this object
 *     as the subscriber's member info to everyone else on the channel.
 *
 * A private-channel callback typically returns a boolean; a presence
 * callback returns the member payload (`{ id, name }`) it wants broadcast
 * in `here`/`joining`/`leaving` frames.
 */
export type ChannelAuthorizationResult = boolean | object | null | undefined;

/**
 * A channel-authorization callback, registered against a channel pattern.
 * `user` is whatever the app's auth guard resolved for the connecting
 * socket (`null` for a guest — a guest is denied every protected channel).
 * Trailing args are the values captured from `{param}` placeholders in the
 * pattern, in declaration order.
 */
export type ChannelAuthorizationCallback<TUser = unknown> = (
  user: TUser | null,
  ...parameters: string[]
) => ChannelAuthorizationResult | Promise<ChannelAuthorizationResult>;

interface CompiledChannel {
  /** The regex the (prefix-stripped) channel name is matched against. */
  readonly matcher: RegExp;
  readonly callback: ChannelAuthorizationCallback;
}

/** The outcome of authorizing a subscribe request against the registry. */
export interface ChannelAuthorization {
  /** Whether the subscription is permitted. */
  readonly authorized: boolean;
  /**
   * For an authorized presence channel, the member info to publish to the
   * rest of the channel. `undefined` for private/public channels.
   */
  readonly presenceData?: object;
}

/**
 * Turns a Laravel-style channel pattern (`orders.{orderId}`) into a regex
 * capturing each `{param}`. Anchored so `orders.{id}` doesn't match
 * `orders.5.items`. A pattern with no placeholders matches literally.
 */
function compilePattern(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((segment) =>
      segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, "([^.]+)"),
    )
    .join("[^.]+");

  return new RegExp(`^${source}$`);
}

/**
 * The registry of channel-authorization callbacks — the runtime half of
 * `Broadcast::channel('orders.{orderId}', fn)`. Applications populate it in
 * a provider's `channels()` hook; the broadcast driver consults it on every
 * `subscribe` to a `private-`/`presence-` channel.
 *
 * Deliberately NOT a `Manager<T>`: there are no swappable drivers here,
 * just a pattern→callback table, exactly like `@mahiframework/authorization`'s
 * `GateRegistry`.
 */
export class ChannelRegistry {
  private channels: CompiledChannel[] = [];

  /**
   * Register an authorization callback for a channel pattern. Patterns use
   * `{param}` placeholders (matched against the channel name with its
   * `private-`/`presence-` prefix stripped) whose captured values are
   * passed to `callback` after the user.
   *
   *   Broadcast.channel("orders.{orderId}", (user, orderId) =>
   *     user?.id === Order.find(orderId)?.userId);
   *
   *   Broadcast.channel("presence-chat.{room}", (user, room) =>
   *     user ? { id: user.id, name: user.name } : false);
   */
  channel<TUser = unknown>(pattern: string, callback: ChannelAuthorizationCallback<TUser>): this {
    this.channels.push({
      matcher: compilePattern(normalizeChannelName(pattern)),
      callback: callback as ChannelAuthorizationCallback,
    });

    return this;
  }

  /** Whether any callback is registered (used to short-circuit in tests). */
  get size(): number {
    return this.channels.length;
  }

  /**
   * Authorize a `subscribe` for `channel` on behalf of `user`.
   *
   * Public channels (no `private-`/`presence-` prefix) are always
   * authorized without consulting a callback. Protected channels are
   * denied unless a registered pattern matches AND its callback returns a
   * truthy value; a channel with no matching callback fails **closed**
   * (the safe default — an unregistered `private-` channel is a
   * misconfiguration, not an open door).
   */
  async authorize(channel: string, user: unknown): Promise<ChannelAuthorization> {
    if (!isProtectedChannel(channel)) {
      return { authorized: true };
    }

    const name = normalizeChannelName(channel);

    for (const { matcher, callback } of this.channels) {
      const match = matcher.exec(name);

      if (!match) {
        continue;
      }

      const result = await callback(user, ...match.slice(1));

      if (!result) {
        return { authorized: false };
      }

      if (isPresenceChannel(channel) && typeof result === "object") {
        return { authorized: true, presenceData: result };
      }

      return { authorized: true };
    }

    // No callback claimed this protected channel — fail closed.
    return { authorized: false };
  }
}
