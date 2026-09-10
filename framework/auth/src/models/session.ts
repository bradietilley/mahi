import { Cast, Model } from "@mahi/database";
import type { DateTime } from "@mahi/datetime";

/**
 * The framework-owned `sessions` table backing `DatabaseSessionStore`.
 *
 * The timestamp columns are `DateTime`, cast on both sides — the table
 * declares them `table.timestamp()`, so a `DateTime` is what they
 * actually hold. Expiry then reads as `row.expires_at.isPast()` instead
 * of parsing text back into a `Date` on every session read, and the
 * store writes a `DateTime` straight through (the cast converts to UTC).
 *
 * `id` is a client-generated random string the store supplies on every
 * write, so no key strategy is needed. `timestamps: false` — the table
 * has no `updated_at`; `created_at` and `last_active_at` are
 * hand-stamped by the store.
 */
export interface SessionAttributes {
  id: string;
  user_id: string;
  expires_at: DateTime;
  created_at: DateTime;
  last_active_at: DateTime;
}

export class Session extends Model<SessionAttributes>()({
  table: "sessions",
  primaryKey: "id",
  timestamps: false,
  casts: {
    expires_at: Cast.datetime(),
    created_at: Cast.datetime(),
    last_active_at: Cast.datetime(),
  },
}) {}
