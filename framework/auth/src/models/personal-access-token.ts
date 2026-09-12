import { Cast, Model } from "@mahiframework/database";
import type { DateTime } from "@mahiframework/datetime";

/**
 * The framework-owned `personal_access_tokens` table backing `TokenGuard`.
 * Owned by the package (not the app) because it's an internal detail of a
 * built-in guard — same rationale as `@mahiframework/queue` owning `jobs`.
 *
 * The timestamp columns are `DateTime`, cast on both sides: the table
 * declares them `table.timestamp()`, and reading one back as a real
 * `DateTime` is what lets expiry be expressed as `record.expires_at
 * .isPast()` rather than a `new Date(...).getTime() <= Date.now()`
 * round-trip through text. Writes take a `DateTime` directly — the cast
 * converts to UTC and spells it the way the engine accepts.
 *
 * `id` is a client-generated random string, and `timestamps: false` — the
 * table has no `updated_at`; `last_used_at` covers "last changed".
 */
export interface PersonalAccessTokenAttributes {
  id: string;
  user_id: string;
  name: string;
  /** SHA-256 digest of the secret half — never the plaintext. */
  token: string;
  last_used_at: DateTime | null;
  expires_at: DateTime | null;
  created_at: DateTime;
}

export class PersonalAccessToken extends Model<PersonalAccessTokenAttributes>()({
  table: "personal_access_tokens",
  primaryKey: "id",
  timestamps: false,
  casts: {
    last_used_at: Cast.datetime(),
    expires_at: Cast.datetime(),
    created_at: Cast.datetime(),
  },
}) {}
