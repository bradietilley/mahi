import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Request } from "@mahiframework/http";
import { createTestDatabase, type TestDatabase } from "../__fixtures__/test-database.js";
import { PersonalAccessToken } from "../../src/models/personal-access-token.js";
import type { Credentials, UserProvider } from "../../src/user-provider.js";
import { TokenGuard } from "../../src/guards/token-guard.js";

interface TestUser {
  id: string;
  email: string;
}

const alice: TestUser = { id: "alice", email: "alice@example.com" };

class StubUserProvider implements UserProvider<TestUser> {
  async retrieveById(id: string): Promise<TestUser | null> {
    return id === alice.id ? alice : null;
  }
  async retrieveByCredentials(_credentials: Credentials): Promise<TestUser | null> {
    return null;
  }
  async validateCredentials(): Promise<boolean> {
    return false;
  }
}

function requestWith(authorization?: string): Request {
  return Request.create(
    "/",
    "GET",
    {},
    {
      headers: authorization ? { Authorization: authorization } : {},
    },
  );
}

describe("TokenGuard", () => {
  let database: TestDatabase;
  let guard: TokenGuard<TestUser>;

  beforeEach(async () => {
    database = await createTestDatabase();
    guard = new TokenGuard(new StubUserProvider(), { expiresInMinutes: null });
  });

  afterEach(() => database.cleanup());

  it("authenticates a request carrying a token it issued", async () => {
    const { token } = await guard.createToken(alice.id, "cli");

    await expect(guard.user(requestWith(`Bearer ${token}`))).resolves.toEqual(alice);
  });

  it("never stores the plaintext secret", async () => {
    const { token, record } = await guard.createToken(alice.id, "cli");
    const secret = token.split("|")[1]!;

    // The whole point of hashing at rest: a database dump yields nothing
    // usable.
    expect(record.token).not.toBe(secret);
    expect(record.token).not.toContain(secret);

    const stored = await PersonalAccessToken.findOrFail(record.id);
    expect(stored.token).not.toBe(secret);
  });

  it("rejects a tampered secret with a valid id", async () => {
    const { token } = await guard.createToken(alice.id, "cli");
    const [id, secret] = token.split("|") as [string, string];
    const tampered = `${id}|${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;

    await expect(guard.user(requestWith(`Bearer ${tampered}`))).resolves.toBeNull();
  });

  it("rejects a valid secret presented with the wrong id", async () => {
    const first = await guard.createToken(alice.id, "one");
    const second = await guard.createToken(alice.id, "two");

    const secretOfFirst = first.token.split("|")[1]!;
    const idOfSecond = second.token.split("|")[0]!;

    await expect(
      guard.user(requestWith(`Bearer ${idOfSecond}|${secretOfFirst}`)),
    ).resolves.toBeNull();
  });

  it("rejects an unknown id", async () => {
    await expect(guard.user(requestWith("Bearer missing|whatever"))).resolves.toBeNull();
  });

  it("rejects a revoked token", async () => {
    const { token, record } = await guard.createToken(alice.id, "cli");
    await guard.revokeToken(record.id);

    await expect(guard.user(requestWith(`Bearer ${token}`))).resolves.toBeNull();
  });

  it("revokeAllTokens() invalidates every token for that user only", async () => {
    const mine = await guard.createToken(alice.id, "mine");
    const theirs = await guard.createToken("someone-else", "theirs");

    await guard.revokeAllTokens(alice.id);

    await expect(guard.user(requestWith(`Bearer ${mine.token}`))).resolves.toBeNull();
    await expect(PersonalAccessToken.find(theirs.record.id)).resolves.toBeDefined();
  });

  it("rejects an expired token", async () => {
    const expiring = new TokenGuard<TestUser>(new StubUserProvider(), { expiresInMinutes: -1 });
    const { token } = await expiring.createToken(alice.id, "already-stale");

    await expect(expiring.user(requestWith(`Bearer ${token}`))).resolves.toBeNull();
  });

  it("issues non-expiring tokens when expiresInMinutes is null", async () => {
    const { record } = await guard.createToken(alice.id, "cli");
    expect(record.expires_at).toBeNull();
  });

  it("updates last_used_at on a successful authentication", async () => {
    const { token, record } = await guard.createToken(alice.id, "cli");
    expect(record.last_used_at).toBeNull();

    await guard.user(requestWith(`Bearer ${token}`));

    const after = await PersonalAccessToken.findOrFail(record.id);
    expect(after.last_used_at).not.toBeNull();
  });

  it("does not touch last_used_at when verification fails", async () => {
    // A failed guess must not write — otherwise the column becomes a log
    // of attack attempts rather than of genuine use.
    const { token, record } = await guard.createToken(alice.id, "cli");
    const [id] = token.split("|") as [string, string];

    await guard.user(requestWith(`Bearer ${id}|wrong-secret`));

    const after = await PersonalAccessToken.findOrFail(record.id);
    expect(after.last_used_at).toBeNull();
  });

  it.each([
    ["a missing header", undefined],
    ["a header without the Bearer scheme", "abc|xyz"],
    ["a Bearer header with no token", "Bearer "],
    ["a token with no separator", "Bearer no-separator"],
    ["an empty header", ""],
  ])("returns null rather than throwing for %s", async (_label, header) => {
    await expect(guard.user(requestWith(header))).resolves.toBeNull();
  });

  it("accepts the Bearer scheme case-insensitively", async () => {
    const { token } = await guard.createToken(alice.id, "cli");
    await expect(guard.user(requestWith(`bearer ${token}`))).resolves.toEqual(alice);
  });

  it("currentTokenId() extracts the id of the presenting token", async () => {
    const { token, record } = await guard.createToken(alice.id, "cli");

    expect(guard.currentTokenId(requestWith(`Bearer ${token}`))).toBe(record.id);
    expect(guard.currentTokenId(requestWith())).toBeNull();
  });
});
