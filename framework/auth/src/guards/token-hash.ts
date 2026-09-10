import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Personal access tokens are hashed with SHA-256, NOT with the argon2
 * `Hasher` used for passwords. This is deliberate and is not an oversight
 * or a performance shortcut taken at the cost of security:
 *
 * argon2 is intentionally slow (~50-100ms) to make brute-forcing
 * HUMAN-CHOSEN passwords infeasible — passwords occupy a tiny, heavily
 * biased corner of the keyspace, so the only defense is making each guess
 * expensive. A personal access token is 32 bytes of `randomBytes`: there
 * is no low-entropy space to brute-force, so the slowness buys nothing
 * while costing an argon2 verification on EVERY authenticated API
 * request. Sanctum makes the same call for the same reason.
 *
 * Fixed, not configurable: the only alternative setting is strictly
 * slower for zero security gain, and changing the algorithm would
 * invalidate every already-issued token (the stored digest format
 * changes), so a config knob would be a trap rather than a feature.
 */
export function hashToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Constant-time comparison of a presented secret against a stored digest.
 *
 * `timingSafeEqual` rather than `===` is the security-critical detail
 * here — the same class of bug `Signer.verify()` guards against, and just
 * as easy to "simplify" back into a vulnerability during review.
 */
export function verifyTokenHash(secret: string, storedDigest: string): boolean {
  let stored: Buffer;
  try {
    stored = Buffer.from(storedDigest, "hex");
  } catch {
    return false;
  }

  const presented = Buffer.from(hashToken(secret), "hex");

  if (presented.length !== stored.length) {
    return false;
  }

  return timingSafeEqual(presented, stored);
}

/**
 * Split a `"<id>|<secret>"` token into its parts.
 *
 * The id prefix is NOT cosmetic. The stored column is a digest, so it
 * can't be looked up by equality; without an id, verifying a token would
 * mean loading every token row and comparing each — O(n) work per
 * request, trivially DoS-able. The id turns it into one indexed
 * primary-key lookup plus exactly one digest comparison.
 */
export function splitToken(plaintext: string): [id: string, secret: string] | null {
  const separator = plaintext.indexOf("|");

  if (separator <= 0) {
    return null;
  }

  const id = plaintext.slice(0, separator);
  const secret = plaintext.slice(separator + 1);

  if (id === "" || secret === "") {
    return null;
  }

  return [id, secret];
}
