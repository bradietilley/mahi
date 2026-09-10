import { beforeEach, describe, expect, it } from "vitest";
import { Application } from "@mahi/core";
import { HttpError } from "@mahi/http";
import { GateRegistry } from "../src/gate.js";
import { Policy } from "../src/policy.js";
import { AuthorizationResponse } from "../src/response.js";

interface User {
  id: string;
}
interface BookmarkRow {
  id: string;
  user_id: string;
}

const alice: User = { id: "alice" };
const bob: User = { id: "bob" };
const bobsBookmark: BookmarkRow = { id: "b1", user_id: "bob" };

class Bookmark {}

class BookmarkPolicy extends Policy<User, BookmarkRow> {
  // Someone else's private bookmark reads as 404, not 403, so the
  // endpoint can't be used to probe which ids exist (README's "401 vs
  // 403, and 404" rule).
  view(user: User | null, bookmark: BookmarkRow): AuthorizationResponse {
    if (user !== null && bookmark.user_id === user.id) {
      return AuthorizationResponse.allow();
    }

    return AuthorizationResponse.denyAsNotFound();
  }

  // A plain deny with a custom message → 403 with that message.
  update(user: User | null, bookmark: BookmarkRow): AuthorizationResponse {
    if (user !== null && bookmark.user_id === user.id) {
      return AuthorizationResponse.allow();
    }

    return AuthorizationResponse.deny("You do not own this bookmark.");
  }
}

function makeGate(): GateRegistry {
  const gate = new GateRegistry(new Application());
  gate.policy(Bookmark, BookmarkPolicy);

  return gate;
}

describe("AuthorizationResponse", () => {
  it("allow()/deny()/denyAsNotFound() expose the expected shape", () => {
    expect(AuthorizationResponse.allow().allowed).toBe(true);

    const denied = AuthorizationResponse.deny("nope", 401);
    expect(denied.allowed).toBe(false);
    expect(denied.denied()).toBe(true);
    expect(denied.message).toBe("nope");
    expect(denied.status).toBe(401);

    const nf = AuthorizationResponse.denyAsNotFound();
    expect(nf.status).toBe(404);
  });
});

describe("GateRegistry with AuthorizationResponse", () => {
  let gate: GateRegistry;

  beforeEach(() => {
    gate = makeGate();
  });

  it("allows/denies collapse a response to a boolean for allows()/denies()", async () => {
    await expect(gate.forUser(bob).allows("view", Bookmark, bobsBookmark)).resolves.toBe(true);
    await expect(gate.forUser(alice).allows("view", Bookmark, bobsBookmark)).resolves.toBe(false);
    await expect(gate.forUser(alice).denies("view", Bookmark, bobsBookmark)).resolves.toBe(true);
  });

  it("authorize() throws a 404 for denyAsNotFound()", async () => {
    await expect(
      gate.forUser(alice).authorize("view", Bookmark, bobsBookmark),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("authorize() throws a 403 with the custom message for a plain deny", async () => {
    await expect(
      gate.forUser(alice).authorize("update", Bookmark, bobsBookmark),
    ).rejects.toMatchObject({ status: 403, message: "You do not own this bookmark." });
  });

  it("authorize() does not throw when allowed", async () => {
    await expect(
      gate.forUser(bob).authorize("view", Bookmark, bobsBookmark),
    ).resolves.toBeUndefined();
  });

  it("inspect() returns the raw response for a denied check", async () => {
    const response = await gate.inspect(alice, "view", [Bookmark, bobsBookmark]);
    expect(response.allowed).toBe(false);
    expect(response.status).toBe(404);
  });

  it("throws an HttpError instance (so the kernel renders it)", async () => {
    await expect(
      gate.forUser(alice).authorize("view", Bookmark, bobsBookmark),
    ).rejects.toBeInstanceOf(HttpError);
  });
});
