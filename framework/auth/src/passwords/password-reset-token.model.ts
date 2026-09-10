import { Cast, Model } from "@mahi/database";
import type { DateTime } from "@mahi/datetime";

/**
 * The framework-owned `password_reset_tokens` table backing
 * `PasswordBroker`. `email` is the primary key (one live reset per email),
 * so re-requesting overwrites the previous row and the reset lookup is a
 * single indexed PK read. `timestamps: false` — write-once, delete-on-use,
 * with `created_at` hand-stamped by the broker.
 *
 * `created_at` is a cast `DateTime`, matching the `table.timestamp()`
 * column, so the broker's expiry and throttle windows are expressed as
 * datetime arithmetic rather than millisecond maths on parsed text.
 */
export interface PasswordResetTokenAttributes {
  /** The account's login identifier — also the primary key. */
  email: string;
  /** argon2 hash of the reset token — never the plaintext. */
  token: string;
  created_at: DateTime;
}

export class PasswordResetToken extends Model<PasswordResetTokenAttributes>()({
  table: "password_reset_tokens",
  primaryKey: "email",
  timestamps: false,
  casts: {
    created_at: Cast.datetime(),
  },
}) {}
