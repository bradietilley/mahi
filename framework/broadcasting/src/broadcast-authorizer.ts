import type { Context } from "hono";

/** The outcome of authorizing a socket's `subscribe` request. */
export interface SubscribeAuthorization {
  /** Whether the subscription is permitted. */
  readonly authorized: boolean;
  /**
   * For an authorized presence channel, the member info to publish to the
   * rest of the channel (`here`/`joining`/`leaving`).
   */
  readonly presenceData?: object;
}

/**
 * The auth seam the websocket driver talks to, so the driver itself takes
 * NO compile-time dependency on `@mahiframework/auth` or `@mahiframework/encryption`. The
 * `BroadcastServiceProvider` supplies the concrete implementation (backed
 * by the `AuthManager` at `AUTH_TOKEN`, the `ChannelRegistry`, and the
 * `Signer`); the driver's own tests can supply a trivial fake.
 *
 * Same soft-dependency shape `@mahiframework/authorization`'s Gate uses to read the
 * current user via the `"auth"` token without importing `@mahiframework/auth`.
 */
export interface BroadcastAuthorizer {
  /**
   * Resolve the user a websocket connection is authenticated as, from the
   * upgrade request. Called once per connection at upgrade time. Returns
   * `null` for an unauthenticated (guest) connection — a guest is still
   * allowed to connect and subscribe to public channels, just denied every
   * `private-`/`presence-` channel.
   */
  resolveUser(context: Context): Promise<unknown | null> | (unknown | null);

  /**
   * Authorize a `subscribe` to `channel` for `user`. Public channels
   * (no `private-`/`presence-` prefix) resolve to `{ authorized: true }`
   * without consulting any callback; protected channels are authorized by
   * the app's `Broadcast.channel(...)` callbacks and fail closed when none
   * matches.
   */
  authorize(channel: string, user: unknown): Promise<SubscribeAuthorization>;

  /**
   * Verify a signed subscription grant minted by `POST /broadcasting/auth`
   * for a cross-origin SPA that cannot ride the session cookie on the
   * upgrade. Returns the channel (and presence member info) the grant
   * authorizes, or `null` if the grant is missing, malformed, expired, or
   * not for this channel. Optional: a driver with no signer configured
   * simply never accepts grants.
   */
  verifyGrant?(channel: string, grant: string): SubscribeAuthorization | null;
}
