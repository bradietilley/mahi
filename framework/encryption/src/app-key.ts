/**
 * Parses the raw `APP_KEY` env value into a 32-byte master key buffer, and
 * derives purpose-scoped subkeys from it via HKDF (RFC 5869) rather than
 * handing the same raw key to both `Encrypter` and `Signer` directly.
 *
 * Deriving separate keys per purpose (via distinct `info` context strings)
 * means a compromise of one derived key (e.g. leaked ciphertext key)
 * doesn't also expose the other (e.g. signing key) — real defense-in-depth
 * — without requiring the operator to manage more than one secret
 * (`APP_KEY` remains the single value that needs generating/rotating/
 * backing up).
 */

import { hkdfSync } from "node:crypto";

const MASTER_KEY_BYTES = 32;
const DERIVED_KEY_BYTES = 32;

/** Parses `APP_KEY` (optionally prefixed with `base64:`) into a 32-byte Buffer. */
export function parseAppKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error(
      "APP_KEY is not set. Run `./artisan key:generate` and add the printed value to your .env file.",
    );
  }

  const value = raw.startsWith("base64:") ? raw.slice("base64:".length) : raw;
  const key = Buffer.from(value, "base64");

  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `APP_KEY must decode to exactly ${MASTER_KEY_BYTES} bytes (got ${key.length}). ` +
        "Run `./artisan key:generate` to generate a valid key.",
    );
  }

  return key;
}

/**
 * Derives a purpose-scoped 32-byte subkey from the master `APP_KEY` via
 * HKDF-SHA256. `context` distinguishes independent derived keys from the
 * same master key (e.g. `"encryption"` vs `"signing"`) — no salt is used
 * since the master key itself is already a high-entropy secret.
 */
export function deriveKey(masterKey: Buffer, context: string): Buffer {
  const derived = hkdfSync("sha256", masterKey, Buffer.alloc(0), context, DERIVED_KEY_BYTES);

  return Buffer.from(derived);
}

/**
 * Parses `APP_PREVIOUS_KEYS` — a comma-separated list of previously-active
 * `APP_KEY` values (each optionally `base64:`-prefixed, same format as
 * `APP_KEY` itself) — into an array of 32-byte master key Buffers.
 *
 * Unlike `parseAppKey()`, an unset/empty value is not an error: it just
 * means no previous keys are configured (the common case — most apps
 * never rotate). Individual malformed entries (wrong decoded length) do
 * throw, on the theory that a typo'd previous key should fail loudly at
 * boot rather than silently making some old ciphertexts undecryptable.
 *
 * Used together with `key:generate --force`, which rotates `APP_KEY` but
 * (matching Laravel) does **not** automatically populate
 * `APP_PREVIOUS_KEYS` — moving the outgoing key there is a deliberate
 * manual step, so an operator can choose how many previous keys to retain
 * (or none, if old data is being re-encrypted / discarded anyway) rather
 * than having the list grow unbounded automatically.
 */
export function parsePreviousAppKeys(raw: string | undefined): Buffer[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseAppKey(entry));
}
