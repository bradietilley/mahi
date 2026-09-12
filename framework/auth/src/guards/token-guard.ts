import { randomBytes, randomUUID } from "node:crypto";
import { DateTime } from "@mahiframework/datetime";
import type { Request } from "@mahiframework/http";
import type { Guard } from "../guard.js";
import type { UserProvider } from "../user-provider.js";
import {
  PersonalAccessToken,
  type PersonalAccessTokenAttributes,
} from "../models/personal-access-token.js";
import { hashToken, splitToken, verifyTokenHash } from "./token-hash.js";

export interface TokenGuardConfig {
  /** Which user provider to resolve users from. */
  provider?: string;
  /**
   * Token lifetime in minutes, or `null` for tokens that never expire
   * (the default, matching Sanctum). `expires_at` exists on the table
   * either way, so switching later is purely a config change.
   */
  expiresInMinutes?: number | null;
}

export interface NewAccessToken {
  /** The plaintext `"<id>|<secret>"` — shown to the user ONCE, never stored. */
  token: string;
  record: PersonalAccessTokenAttributes;
}

/**
 * Opaque, database-backed bearer tokens, modeled on Sanctum's API-token
 * half. Tokens are revocable server-side, which is the decisive advantage
 * over JWT for a single-database application (a JWT can't be revoked
 * without a revocation list, which reintroduces the very database lookup
 * JWTs exist to avoid).
 *
 * Stateless, per the `Guard` contract — every method takes what it needs
 * as arguments and nothing is memoized on the instance.
 */
export class TokenGuard<TUser = unknown> implements Guard<TUser> {
  constructor(
    private readonly users: UserProvider<TUser>,
    private readonly config: TokenGuardConfig = {},
  ) {}

  async user(request: Request): Promise<TUser | null> {
    const plaintext = request.bearerToken() ?? null;

    if (plaintext === null) {
      return null;
    }

    const parts = splitToken(plaintext);

    if (parts === null) {
      return null;
    }

    const [id, secret] = parts;

    const record = await PersonalAccessToken.find(id);

    if (record === undefined) {
      return null;
    }

    // Verify the secret BEFORE checking expiry so a valid-but-expired
    // token and a bogus one take the same path; and reject before
    // touching last_used_at so a failed guess never writes.
    if (!verifyTokenHash(secret, record.token)) {
      return null;
    }

    if (this.isExpired(record)) {
      return null;
    }

    await PersonalAccessToken.update(id, { last_used_at: DateTime.now() });

    return this.users.retrieveById(record.user_id);
  }

  /**
   * Issue a new token. The plaintext is returned once and never
   * recoverable afterwards — only its digest is stored.
   */
  async createToken(userId: string, name: string): Promise<NewAccessToken> {
    const secret = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const now = DateTime.now();

    const record = await PersonalAccessToken.create({
      id,
      user_id: userId,
      name,
      token: hashToken(secret),
      last_used_at: null,
      expires_at: this.expiresAt(now),
      created_at: now,
    });

    return { token: `${id}|${secret}`, record };
  }

  /** Revoke a single token by id — e.g. the one used by the current request. */
  async revokeToken(id: string): Promise<void> {
    await PersonalAccessToken.delete(id);
  }

  /** Revoke every token belonging to a user ("log out everywhere"). */
  async revokeAllTokens(userId: string): Promise<void> {
    await PersonalAccessToken.query().where("user_id", userId).delete();
  }

  /**
   * Delete expired tokens; returns how many were removed. Driven by
   * `auth:gc`, the same way sessions and reset tokens are.
   *
   * Expiry is already enforced on read, so a stale row is never
   * *honoured* — but nothing deleted them either, so the table grew
   * forever in any app that configured `expiresInMinutes`. Rows with a
   * null `expires_at` never expire (the Sanctum default) and are left
   * alone.
   */
  async gc(): Promise<number> {
    return PersonalAccessToken.query()
      .whereNotNull("expires_at")
      .where("expires_at", "<=", DateTime.now())
      .delete();
  }

  /** The token id carried by this request, if any — for `logout`. */
  currentTokenId(request: Request): string | null {
    const plaintext = request.bearerToken() ?? null;

    if (plaintext === null) {
      return null;
    }

    return splitToken(plaintext)?.[0] ?? null;
  }

  private expiresAt(now: DateTime): DateTime | null {
    const minutes = this.config.expiresInMinutes;

    if (minutes === null || minutes === undefined) {
      return null;
    }

    return now.addMinutes(minutes);
  }

  private isExpired(record: PersonalAccessTokenAttributes): boolean {
    if (record.expires_at === null) {
      return false;
    }

    return record.expires_at.isPast();
  }
}
