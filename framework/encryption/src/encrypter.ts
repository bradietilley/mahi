/**
 * Symmetric encrypt/decrypt of arbitrary string data using an app-wide key,
 * for "store this securely, get the exact original value back later" use
 * cases (e.g. encrypting sensitive columns before storage).
 *
 * Uses AES-256-GCM (built into `node:crypto`, no new dependency) —
 * authenticated encryption, so tampering with the ciphertext is detected
 * on decrypt (throws) rather than silently producing garbage or, worse,
 * plausible-looking incorrect plaintext.
 *
 * Wire format is `base64url(version[1] || iv[12] || authTag[16] || ct)`,
 * minimum 29 bytes. The auth tag length is pinned on both cipher and
 * decipher (see `decrypt()` — this is security-critical),
 * and callers can optionally bind a ciphertext to a context via `aad`.
 *
 * Supports key rotation, Laravel-style: `encrypt()` always uses the
 * *current* key (`key`), never a previous one, but `decrypt()` tries the
 * current key first, then each of `previousKeys` in order, so data
 * encrypted under an old `APP_KEY` stays decryptable after rotating to a
 * new one (as long as the old key is retained in `APP_PREVIOUS_KEYS`).
 * There's no automatic re-encryption under the new key on successful
 * decrypt with a previous key — same as Laravel — callers that want that
 * re-encrypt explicitly (decrypt, then encrypt again) as part of a
 * deliberate migration.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12; // GCM standard IV size
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

/**
 * Wire format version, the first byte of every payload. Exists so the
 * algorithm can be migrated later without guessing at what old stored
 * ciphertexts are: a future v2 reader dispatches on this byte instead of
 * trying to parse v1 bytes as v2. Adding it *after* a release would be
 * impossible without breaking every value already in a database, which is
 * why it's here from the start.
 *
 * The version byte is also fed to GCM as additional authenticated data
 * (see `aadFor`), so it can't be flipped to trigger a downgrade to a
 * weaker future format without failing authentication.
 */
const VERSION = 1;
const VERSION_BYTES = 1;

/** Smallest possible valid payload: version + iv + tag, with empty ciphertext. */
const MIN_PAYLOAD_BYTES = VERSION_BYTES + IV_BYTES + AUTH_TAG_BYTES;

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must be exactly ${KEY_BYTES} bytes (AES-256). See APP_KEY generation.`,
    );
  }
}

/**
 * The AAD actually passed to GCM: the version byte, then the caller's
 * context string (if any). Binding the version defeats downgrade;
 * binding the caller's `aad` is what stops a ciphertext being lifted from
 * one context and replayed in another (e.g. moving an encrypted value
 * from `users.ssn` into `users.notes`), since decryption with a different
 * context fails authentication.
 */
function aadFor(aad: string | undefined): Buffer {
  const version = Buffer.from([VERSION]);

  return aad === undefined ? version : Buffer.concat([version, Buffer.from(aad, "utf-8")]);
}

/**
 * Every failure mode — wrong key, wrong/missing aad, unknown version,
 * truncated payload, corruption, deliberate tampering — collapses into
 * this one message. That's deliberate: telling an attacker probing an
 * endpoint *which* of those they achieved turns the error into an oracle.
 */
function decryptionFailed(): Error {
  return new Error(
    "Unable to decrypt payload — invalid key, corrupted data, or tampering detected.",
  );
}

export class Encrypter {
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
   * `aad` optionally binds the ciphertext to a context — decryption only
   * succeeds when given the identical string. Use it to pin a value to
   * where it lives (`"users.ssn"`, `` `invoice:${id}` ``) so a ciphertext
   * copied to another column/row stops decrypting. It is authenticated,
   * not encrypted, and is *not* stored in the payload: whatever `aad`
   * `encrypt()` was given must be passed to `decrypt()` again by the
   * caller.
   */
  encrypt(value: string, aad?: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(aadFor(aad));
    const ciphertext = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // pack version + iv + authTag + ciphertext into one base64url string
    return Buffer.concat([Buffer.from([VERSION]), iv, authTag, ciphertext]).toString("base64url");
  }

  /**
   * Tries `key` first, then each of `previousKeys` in order — the first
   * key that decrypts (and passes GCM's authentication check) wins.
   * Throws only if every key fails.
   *
   * `aad` must match whatever was passed to `encrypt()`; a mismatch fails
   * authentication and throws exactly like a wrong key does.
   */
  decrypt(payload: string, aad?: string): string {
    const raw = Buffer.from(payload, "base64url");

    // Length is checked before slicing because `subarray` silently
    // returns short/empty buffers rather than throwing. Without this, a
    // truncated payload reaches `setAuthTag` with a stub tag.
    if (raw.length < MIN_PAYLOAD_BYTES) {
      throw decryptionFailed();
    }

    if (raw[0] !== VERSION) {
      throw decryptionFailed();
    }

    const iv = raw.subarray(VERSION_BYTES, VERSION_BYTES + IV_BYTES);
    const authTag = raw.subarray(VERSION_BYTES + IV_BYTES, MIN_PAYLOAD_BYTES);
    const ciphertext = raw.subarray(MIN_PAYLOAD_BYTES);
    const additionalData = aadFor(aad);

    for (const candidateKey of [this.key, ...this.previousKeys]) {
      try {
        // `authTagLength` is required: without it Node
        // accepts 4/8/12-byte tags here, letting an attacker with a
        // decrypt oracle forge a payload at 2^-32 per attempt instead of
        // 2^-128 (and recover the GHASH key from a few successes via
        // Ferguson's short-tag attack). Do not remove it.
        const decipher = createDecipheriv("aes-256-gcm", candidateKey, iv, {
          authTagLength: AUTH_TAG_BYTES,
        });
        decipher.setAAD(additionalData);
        decipher.setAuthTag(authTag);

        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
      } catch {
        continue;
      }
    }

    throw decryptionFailed();
  }
}
