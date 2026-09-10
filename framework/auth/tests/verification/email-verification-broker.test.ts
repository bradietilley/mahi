import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cast, Model, Schema } from "@mahi/database";
import { Signer } from "@mahi/encryption";
import { hasValidSignature, Request } from "@mahi/http";
import { createTestDatabase, type TestDatabase } from "../__fixtures__/test-database.js";
import { EmailVerificationBroker } from "../../src/verification/email-verification-broker.js";
import type { Credentials, UserProvider } from "../../src/user-provider.js";

interface UserAttributes {
  id: string;
  email: string;
  email_verified_at: string | null;
}

class User extends Model<UserAttributes>()({
  table: "broker_users",
  primaryKey: "id",
  timestamps: false,
  casts: { email_verified_at: Cast.string() },
}) {}

/** Reads straight through the model, so tests exercise real rows. */
class ModelUserProvider implements UserProvider<Record<string, unknown>> {
  async retrieveById(id: string): Promise<Record<string, unknown> | null> {
    const user = await User.find(id);

    return user === undefined ? null : (user as unknown as Record<string, unknown>);
  }

  async retrieveByCredentials(credentials: Credentials): Promise<Record<string, unknown> | null> {
    const email = credentials["email"];
    const user = await User.query().where("email", "=", email!).first();

    return user === undefined ? null : (user as unknown as Record<string, unknown>);
  }

  async validateCredentials(): Promise<boolean> {
    return true;
  }
}

const signer = new Signer(Buffer.alloc(32, 7));

/** Turn a signed URL into a Request as the router would see it. */
function requestFor(url: string): Request {
  const [path, query = ""] = url.split("?");

  return Request.create(
    path!,
    "GET",
    {},
    { query: Object.fromEntries(new URLSearchParams(query)) },
  );
}

/** Pull a query param out of a generated URL. */
function param(url: string, key: string): string {
  return new URL(url, "https://app.test").searchParams.get(key) ?? "";
}

describe("EmailVerificationBroker", () => {
  let database: TestDatabase;
  let broker: EmailVerificationBroker;

  beforeEach(async () => {
    database = await createTestDatabase();
    await Schema.create("broker_users", (table) => {
      table.string("id").primary();
      table.string("email");
      table.timestamp("email_verified_at").nullable();
    });
    await User.create({ id: "alice", email: "alice@example.com", email_verified_at: null });

    broker = new EmailVerificationBroker(new ModelUserProvider(), User);
  });

  afterEach(() => database.cleanup());

  describe("sendVerificationLink", () => {
    it("mints a link for an unverified user", async () => {
      const result = await broker.sendVerificationLink("alice", { signer });

      expect(result.status).toBe("sent");
      expect(result).toHaveProperty("url");
    });

    it("produces a URL that passes the real signature check", async () => {
      const result = await broker.sendVerificationLink("alice", { signer });
      const url = (result as { url: string }).url;

      expect(hasValidSignature(requestFor(url), { signer })).toBe(true);
    });

    it("produces a URL that fails the check once tampered with", async () => {
      const result = await broker.sendVerificationLink("alice", { signer });
      const url = (result as { url: string }).url.replace("id=alice", "id=mallory");

      expect(hasValidSignature(requestFor(url), { signer })).toBe(false);
    });

    it("refuses to mint a link for an already-verified user", async () => {
      await User.update("alice", { email_verified_at: "2026-01-01T00:00:00.000Z" });

      expect(await broker.sendVerificationLink("alice", { signer })).toEqual({
        status: "already-verified",
      });
    });

    it("reports an unknown user", async () => {
      expect(await broker.sendVerificationLink("nobody", { signer })).toEqual({
        status: "invalid-user",
      });
    });

    it("expires the link after the configured window", async () => {
      const scoped = new EmailVerificationBroker(new ModelUserProvider(), User, {
        expiresInMinutes: 5,
      });
      const now = Math.floor(Date.now() / 1000);
      const result = await scoped.sendVerificationLink("alice", { signer, now });
      const url = (result as { url: string }).url;

      expect(hasValidSignature(requestFor(url), { signer, now: now + 299 })).toBe(true);
      expect(hasValidSignature(requestFor(url), { signer, now: now + 301 })).toBe(false);
    });
  });

  describe("verify", () => {
    it("marks the address verified", async () => {
      const result = await broker.sendVerificationLink("alice", { signer });
      const hash = param((result as { url: string }).url, "hash");

      expect(await broker.verify("alice", hash)).toEqual({ status: "verified" });

      const user = await User.find("alice");
      expect(user?.email_verified_at).not.toBeNull();
    });

    it("is idempotent, and does not rewrite the original timestamp", async () => {
      const result = await broker.sendVerificationLink("alice", { signer });
      const hash = param((result as { url: string }).url, "hash");

      await broker.verify("alice", hash);
      const first = (await User.find("alice"))?.email_verified_at;

      expect(await broker.verify("alice", hash)).toEqual({ status: "already-verified" });
      expect((await User.find("alice"))?.email_verified_at).toBe(first);
    });

    it("rejects a hash minted for a different address", async () => {
      const other = new EmailVerificationBroker(new ModelUserProvider(), User);
      const hash = param(
        other.verificationUrl("alice", "someone-else@example.com", { signer }),
        "hash",
      );

      expect(await broker.verify("alice", hash)).toEqual({ status: "invalid-hash" });
      expect((await User.find("alice"))?.email_verified_at).toBeNull();
    });

    it("rejects a link whose address changed after it was issued", async () => {
      // The hole the email hash exists to close: request a link, change the
      // account's address, then click. The signature is still valid — the
      // URL was legitimately signed — so only the hash catches it.
      const result = await broker.sendVerificationLink("alice", { signer });
      const url = (result as { url: string }).url;

      expect(hasValidSignature(requestFor(url), { signer })).toBe(true);

      await User.update("alice", { email: "victim@example.com" });

      expect(await broker.verify("alice", param(url, "hash"))).toEqual({ status: "invalid-hash" });
      expect((await User.find("alice"))?.email_verified_at).toBeNull();
    });

    it("rejects a garbage hash", async () => {
      expect(await broker.verify("alice", "not-a-real-hash")).toEqual({ status: "invalid-hash" });
    });

    it("reports an unknown user", async () => {
      expect(await broker.verify("nobody", "whatever")).toEqual({ status: "invalid-user" });
    });
  });

  describe("configuration", () => {
    it("honours a custom column", async () => {
      await Schema.create("custom_users", (table) => {
        table.string("id").primary();
        table.string("email");
        table.timestamp("confirmed_at").nullable();
      });

      interface CustomAttributes {
        id: string;
        email: string;
        confirmed_at: string | null;
      }

      class CustomUser extends Model<CustomAttributes>()({
        table: "custom_users",
        primaryKey: "id",
        timestamps: false,
        casts: { confirmed_at: Cast.string() },
      }) {}

      await CustomUser.create({ id: "bob", email: "bob@example.com", confirmed_at: null });

      class CustomProvider implements UserProvider<Record<string, unknown>> {
        async retrieveById(id: string): Promise<Record<string, unknown> | null> {
          const user = await CustomUser.find(id);

          return user === undefined ? null : (user as unknown as Record<string, unknown>);
        }
        async retrieveByCredentials(): Promise<Record<string, unknown> | null> {
          return null;
        }
        async validateCredentials(): Promise<boolean> {
          return true;
        }
      }

      const scoped = new EmailVerificationBroker(new CustomProvider(), CustomUser, {
        column: "confirmed_at",
      });

      const result = await scoped.sendVerificationLink("bob", { signer });
      const hash = param((result as { url: string }).url, "hash");

      expect(await scoped.verify("bob", hash)).toEqual({ status: "verified" });
      expect((await CustomUser.find("bob"))?.confirmed_at).not.toBeNull();
    });

    it("honours a custom path", () => {
      const scoped = new EmailVerificationBroker(new ModelUserProvider(), User, {
        path: "/confirm",
      });

      expect(scoped.verificationUrl("alice", "alice@example.com", { signer })).toMatch(
        /^\/confirm\?/,
      );
    });
  });
});
