import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Model } from "@mahiframework/database";
import { Hasher } from "@mahiframework/encryption";
import { createTestDatabase, type TestDatabase } from "../__fixtures__/test-database.js";
import { DatabaseUserProvider } from "../../src/providers/database-user-provider.js";

interface UserAttributes {
  id: string;
  email: string;
  password: string;
  deleted_at: string | null;
}

type UserTable = UserAttributes;

class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  timestamps: false,
  softDeletes: true,
}) {}

describe("DatabaseUserProvider", () => {
  let database: TestDatabase;
  let hasher: Hasher;
  let provider: DatabaseUserProvider<UserTable>;
  let passwordHash: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    hasher = new Hasher();
    provider = new DatabaseUserProvider<UserTable>({ model: User }, hasher);

    passwordHash = await hasher.make("correct-horse");
    await User.create({
      id: "alice",
      email: "alice@example.com",
      password: passwordHash,
      deleted_at: null,
    });
  });

  afterEach(() => database.cleanup());

  it("retrieveById() returns the row, or null when absent", async () => {
    await expect(provider.retrieveById("alice")).resolves.toMatchObject({
      email: "alice@example.com",
    });
    await expect(provider.retrieveById("nobody")).resolves.toBeNull();
  });

  it("retrieveByCredentials() looks up by the identifier column", async () => {
    await expect(
      provider.retrieveByCredentials({ email: "alice@example.com", password: "irrelevant" }),
    ).resolves.toMatchObject({ id: "alice" });

    await expect(
      provider.retrieveByCredentials({ email: "nobody@example.com", password: "irrelevant" }),
    ).resolves.toBeNull();
  });

  it("retrieveByCredentials() returns null when the identifier is missing or empty", async () => {
    await expect(provider.retrieveByCredentials({ password: "x" })).resolves.toBeNull();
    await expect(provider.retrieveByCredentials({ email: "", password: "x" })).resolves.toBeNull();
  });

  it("retrieveByCredentials() never consults the password", async () => {
    // Lookup and verification are deliberately separate steps. See
    // UserProvider's docstring. If this method started checking the
    // password, attempt()'s constant-time behaviour would break.
    await expect(
      provider.retrieveByCredentials({ email: "alice@example.com", password: "totally-wrong" }),
    ).resolves.toMatchObject({ id: "alice" });
  });

  it("validateCredentials() checks the password against the stored hash", async () => {
    const user = (await provider.retrieveById("alice"))!;

    await expect(provider.validateCredentials(user, { password: "correct-horse" })).resolves.toBe(
      true,
    );
    await expect(provider.validateCredentials(user, { password: "wrong" })).resolves.toBe(false);
    await expect(provider.validateCredentials(user, {})).resolves.toBe(false);
  });

  it("validateCredentials() returns false when the password column isn't a string", async () => {
    const user = { id: "x", email: "x", password: null } as unknown as UserTable;
    await expect(provider.validateCredentials(user, { password: "anything" })).resolves.toBe(false);
  });

  it("does not retrieve soft-deleted users", async () => {
    // The payoff of going through Model.query() rather than
    // queryWithoutScopes(): global scopes apply, so a deleted user stops
    // authenticating with no extra code in this provider.
    await User.delete("alice");

    await expect(provider.retrieveById("alice")).resolves.toBeNull();
    await expect(
      provider.retrieveByCredentials({ email: "alice@example.com", password: "correct-horse" }),
    ).resolves.toBeNull();
  });

  it("honours custom identifier and password columns", async () => {
    const custom = new DatabaseUserProvider<UserTable>(
      { model: User, identifierColumn: "id", passwordColumn: "password" },
      hasher,
    );

    await expect(
      custom.retrieveByCredentials({ id: "alice", password: "irrelevant" }),
    ).resolves.toMatchObject({ email: "alice@example.com" });
  });
});
