/**
 * HMAC-based sign/verify for short-lived tokens or payloads (e.g. "this
 * webhook body really came from us," "this password-reset link hasn't
 * been tampered with"), distinct from `Encrypter` since the payload
 * itself doesn't need to stay secret, just verifiably unmodified.
 *
 * Supports key rotation, same shape as `Encrypter`: `sign()` always uses
 * the current key, `verify()` tries the current key then each of
 * `previousKeys` in order, so tokens signed before a rotation still
 * verify successfully afterward, as long as the old key is retained in
 * `previousKeys`.
 *
 * Distinct consumers must not share one signer instance, use
 * `Signer.for(purpose)` (see below) so a signature minted for one purpose
 * can never be replayed as another.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey } from "./app-key.js";

/**
 * HMAC-SHA256 has a 32-byte output; a key shorter than that (and
 * especially an empty one) is a silent downgrade of the whole scheme, so
 * it's rejected outright rather than accepted as "technically valid HMAC".
 */
const MIN_KEY_BYTES = 32;

function hmac(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Constant-time comparison of two base64url signature strings. */
function signaturesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  // timingSafeEqual requires equal-length buffers, and is the one
  // genuinely security-critical detail here: naive `a === b` string
  // comparison is vulnerable to timing attacks. Do not "simplify" this
  // back to `===`.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function assertKeyLength(key: Buffer): void {
  if (key.length < MIN_KEY_BYTES) {
    throw new Error(
      `Signing key must be at least ${MIN_KEY_BYTES} bytes (got ${key.length}). ` +
        "Derive it from APP_KEY via deriveKey() rather than passing a raw string.",
    );
  }
}

export class Signer {
  private previousKeys: Buffer[];

  constructor(
    private key: Buffer,
    previousKeys: Buffer[] = [],
  ) {
    assertKeyLength(key);

    for (const previousKey of previousKeys) {
      assertKeyLength(previousKey);
    }

    this.previousKeys = previousKeys;
  }

  /**
   * A `Signer` whose keys are HKDF-derived for one specific `purpose`,
   * domain separation between consumers that would otherwise share the
   * root signing key.
   *
   * Without this, the *same* HMAC key signs session cookies (a bare
   * session id) and signed URLs (`/path?query`). Any feature that signs
   * user-influenced strings could then be used as an oracle to mint a
   * signature that a different consumer accepts, e.g. producing a valid
   * session cookie for a known session id. The purposes are disjoint
   * key spaces, so a signature from `for("url")` simply doesn't verify
   * under `for("session")`.
   *
   * Previous keys are derived under the same purpose, so key rotation
   * continues to work per-purpose.
   */
  for(purpose: string): Signer {
    return new Signer(
      deriveKey(this.key, `signing:${purpose}`),
      this.previousKeys.map((previousKey) => deriveKey(previousKey, `signing:${purpose}`)),
    );
  }

  sign(payload: string): string {
    return `${payload}.${hmac(this.key, payload)}`;
  }

  /**
   * Returns the original payload if the signature is valid against `key`
   * or any of `previousKeys`, `null` otherwise.
   */
  verify(signedPayload: string): string | null {
    const lastDot = signedPayload.lastIndexOf(".");

    if (lastDot === -1) {
      return null;
    }

    const payload = signedPayload.slice(0, lastDot);
    const signature = signedPayload.slice(lastDot + 1);

    for (const candidateKey of [this.key, ...this.previousKeys]) {
      if (signaturesMatch(signature, hmac(candidateKey, payload))) {
        return payload;
      }
    }

    return null;
  }
}
