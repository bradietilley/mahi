import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

/**
 * `password_reset_tokens` backing `PasswordBroker`.
 *
 * `email` is the primary key: a user has at most one outstanding reset,
 * so re-requesting overwrites rather than accumulating rows, and
 * verifying a reset is one indexed PK lookup. `token` stores an argon2
 * hash, never the plaintext — a leaked table dump yields no usable reset
 * links.
 *
 * No foreign key to `users`: that table is app-owned and the framework
 * can't assume its name (same rationale as the sessions/tokens tables).
 */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("password_reset_tokens", (table: Blueprint) => {
      table.string("email").primary();
      table.string("token");
      table.timestamp("created_at");
    });
  },

  async down(): Promise<void> {
    await Schema.drop("password_reset_tokens");
  },
};

export default migration;
