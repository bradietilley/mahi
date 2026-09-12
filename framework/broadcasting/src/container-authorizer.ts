import { AUTH_TOKEN, type Application } from "@mahiframework/core";
import { requestFromContext } from "@mahiframework/http";
import type { Context } from "hono";
import type { BroadcastAuthorizer, SubscribeAuthorization } from "./broadcast-authorizer.js";
import type { ChannelRegistry } from "./channel-registry.js";
import { isPresenceChannel } from "./channel-name.js";

/**
 * Minimal shape of `@mahiframework/auth`'s `AuthManager` this authorizer needs —
 * resolved by the `"auth"` token so `@mahiframework/broadcasting` takes NO
 * compile-time dependency on `@mahiframework/auth`, the same soft-dependency shape
 * `@mahiframework/authorization`'s Gate uses. `guard(name?).user(request)` returns
 * the authenticated user (or `null`).
 */
interface AuthManagerLike {
  guard(name?: string): { user(request: unknown): Promise<unknown | null> };
}

/**
 * Minimal `Signer` shape (from `@mahiframework/encryption`), resolved by the
 * `"signer"` token for the same reason. `for(purpose)` domain-separates
 * the broadcast grant from session cookies / signed URLs.
 */
export interface SignerLike {
  for(purpose: string): SignerLike;
  sign(payload: string): string;
  verify(signed: string): string | null;
}

/** The purpose a broadcast subscription grant is signed under. */
export const BROADCAST_SIGNER_PURPOSE = "broadcast";

/**
 * The default `BroadcastAuthorizer`, wiring the websocket driver to the
 * app's real auth stack:
 *
 *   - `resolveUser()` authenticates the upgrade request against a named
 *     guard (`session` by default, so a same-origin browser's cookie just
 *     works), falling back through the other configured guards.
 *   - `authorize()` runs the `Broadcast.channel(...)` callbacks in the
 *     `ChannelRegistry`.
 *   - `verifyGrant()` accepts a short-lived HMAC grant minted by
 *     `POST /broadcasting/auth` for cross-origin SPAs whose cookie the
 *     browser won't send on the upgrade.
 *
 * The signer is optional: with none configured, grants are never accepted
 * and only the cookie/guard path authorizes.
 */
export class ContainerBroadcastAuthorizer implements BroadcastAuthorizer {
  private readonly resolveSigner: () => SignerLike | undefined;
  private purposeSigner?: SignerLike | null;

  /**
   * `signer` may be the signer itself or a thunk that resolves it on first
   * use. The provider passes a thunk: resolving the container's signer
   * eagerly would construct the encrypter — and fail on a missing
   * `APP_KEY` — during boot, before `key:generate` has had a chance to run.
   */
  constructor(
    private readonly app: Application,
    private readonly registry: ChannelRegistry,
    private readonly guards: string[],
    signer?: SignerLike | (() => SignerLike | undefined),
  ) {
    this.resolveSigner = typeof signer === "function" ? signer : () => signer;
  }

  /** The signer scoped to the broadcast purpose, resolved once on first use. */
  private get signer(): SignerLike | undefined {
    if (this.purposeSigner === undefined) {
      this.purposeSigner = this.resolveSigner()?.for(BROADCAST_SIGNER_PURPOSE) ?? null;
    }

    return this.purposeSigner ?? undefined;
  }

  async resolveUser(context: Context): Promise<unknown | null> {
    if (!this.app.has(AUTH_TOKEN)) {
      return null;
    }

    const auth = this.app.make<AuthManagerLike>(AUTH_TOKEN);
    const request = await requestFromContext(context);

    for (const guard of this.guards) {
      const user = await auth.guard(guard).user(request);

      if (user !== null && user !== undefined) {
        return user;
      }
    }

    return null;
  }

  authorize(channel: string, user: unknown): Promise<SubscribeAuthorization> {
    return this.registry.authorize(channel, user);
  }

  /**
   * Verify a grant of the form `<channel>|<expiryMs>[|<base64 presence>]`,
   * signed under the broadcast purpose. The channel is bound INTO the
   * signed payload, so a grant minted for one channel can't be replayed on
   * another. Expired or mismatched grants return `null`, falling the
   * driver back to the normal callback path.
   */
  verifyGrant(channel: string, grant: string): SubscribeAuthorization | null {
    if (!this.signer) {
      return null;
    }

    const payload = this.signer.verify(grant);

    if (payload === null) {
      return null;
    }

    const [signedChannel, expiryRaw, presenceRaw] = payload.split("|");

    if (signedChannel !== channel) {
      return null;
    }

    const expiry = Number(expiryRaw);

    if (!Number.isFinite(expiry) || expiry < Date.now()) {
      return null;
    }

    if (isPresenceChannel(channel) && presenceRaw) {
      try {
        const member = JSON.parse(Buffer.from(presenceRaw, "base64url").toString("utf8")) as object;

        return { authorized: true, presenceData: member };
      } catch {
        return { authorized: true };
      }
    }

    return { authorized: true };
  }

  /**
   * Mint a signed grant for `channel`, valid for `ttlMs`. Used by the
   * `POST /broadcasting/auth` endpoint after it has authorized the request
   * through the normal guard + channel callbacks. Returns `null` when no
   * signer is configured.
   */
  mintGrant(channel: string, ttlMs: number, presenceData?: object): string | null {
    if (!this.signer) {
      return null;
    }

    const expiry = Date.now() + ttlMs;
    const parts = [channel, String(expiry)];

    if (presenceData !== undefined) {
      parts.push(Buffer.from(JSON.stringify(presenceData), "utf8").toString("base64url"));
    }

    return this.signer.sign(parts.join("|"));
  }
}
