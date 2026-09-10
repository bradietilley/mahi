import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cast, Model, Schema } from "@mahi/database";
import { createTestDatabase, type TestDatabase } from "../__fixtures__/test-database.js";
import {
  hasVerifiedEmail,
  markEmailAsVerified,
} from "../../src/verification/email-verification.js";

interface UserAttributes {
  id: string;
  email: string;
  email_verified_at: string | null;
}

class User extends Model<UserAttributes>()({
  table: "verifiable_users",
  primaryKey: "id",
  timestamps: false,
  casts: { email_verified_at: Cast.string() },
}) {}

describe("email verification helpers", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
    await Schema.create("verifiable_users", (table) => {
      table.string("id").primary();
      table.string("email");
      table.timestamp("email_verified_at").nullable();
    });
    await User.create({ id: "alice", email: "alice@example.com", email_verified_at: null });
  });

  afterEach(() => database.cleanup());

  describe("hasVerifiedEmail", () => {
    it("is false when email_verified_at is null or undefined", () => {
      expect(hasVerifiedEmail({ email_verified_at: null })).toBe(false);
      expect(hasVerifiedEmail({})).toBe(false);
    });

    it("is true when email_verified_at is set", () => {
      expect(hasVerifiedEmail({ email_verified_at: "2026-01-01T00:00:00.000Z" })).toBe(true);
    });

    it("honours a custom column name", () => {
      expect(hasVerifiedEmail({ verified: "2026-01-01T00:00:00.000Z" }, "verified")).toBe(true);
      expect(hasVerifiedEmail({ email_verified_at: null }, "verified")).toBe(false);
    });
  });

  describe("markEmailAsVerified", () => {
    it("stamps the timestamp and returns it", async () => {
      const stamped = await markEmailAsVerified(User, "alice");

      const row = await User.find("alice");
      expect(row!.email_verified_at).toBe(stamped);
      expect(hasVerifiedEmail(row!)).toBe(true);
    });
  });
});
