import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Application, DriverNotRegisteredError, clearCurrentApp } from "@mahiframework/core";
import { Hasher } from "@mahiframework/encryption";
import { Request } from "@mahiframework/http";
import {
  AuthManager,
  UnknownUserProviderError,
  UserProviderNotRegisteredError,
} from "../src/auth-manager.js";
import { MissingAuthContextError, runWithAuth, currentAuthState } from "../src/auth-context.js";
import type { Guard } from "../src/guard.js";
import type { Credentials, UserProvider } from "../src/user-provider.js";

interface TestUser {
  id: string;
  email: string;
  password: string;
}

const alice: TestUser = { id: "alice", email: "alice@example.com", password: "hashed" };

class StubUserProvider implements UserProvider<TestUser> {
  constructor(private readonly hasher: Hasher) {}

  async retrieveById(id: string): Promise<TestUser | null> {
    return id === alice.id ? alice : null;
  }

  async retrieveByCredentials(credentials: Credentials): Promise<TestUser | null> {
    return credentials["email"] === alice.email ? alice : null;
  }

  async validateCredentials(user: TestUser, credentials: Credentials): Promise<boolean> {
    return this.hasher.check(credentials["password"] ?? "", user.password);
  }
}

function emptyRequest(): Request {
  return Request.create("/");
}

describe("AuthManager", () => {
  let app: Application;
  let hasher: Hasher;
  let manager: AuthManager;

  beforeEach(async () => {
    app = new Application();
    hasher = new Hasher();
    alice.password = await hasher.make("correct-horse");

    manager = new AuthManager(
      app,
      {
        default: "token",
        guards: { token: { provider: "users" }, other: { provider: "users" } },
        providers: { users: { driver: "database" }, broken: { driver: "nonexistent" } },
      },
      hasher,
    );

    manager.extendUserProvider("database", () => new StubUserProvider(hasher));
    manager.extend("token", () => stubGuard(alice));
    manager.extend("other", () => stubGuard(null));
  });

  afterEach(() => clearCurrentApp());

  function stubGuard(result: TestUser | null): Guard<TestUser> {
    return { user: async () => result };
  }

  describe("guard resolution", () => {
    it("resolves the default guard when no name is given", async () => {
      await expect(manager.guard().user(emptyRequest())).resolves.toEqual(alice);
    });

    it("caches a resolved guard", () => {
      expect(manager.guard("token")).toBe(manager.guard("token"));
    });

    it("throws for an unregistered guard", () => {
      expect(() => manager.guard("nope")).toThrow(DriverNotRegisteredError);
    });
  });

  describe("user provider resolution", () => {
    it("resolves and caches by config key", () => {
      expect(manager.userProvider("users")).toBe(manager.userProvider("users"));
    });

    it("falls back to the default guard's configured provider", () => {
      expect(manager.userProvider()).toBeInstanceOf(StubUserProvider);
    });

    it("throws for a provider that isn't configured", () => {
      expect(() => manager.userProvider("missing")).toThrow(UnknownUserProviderError);
    });

    it("throws for a configured provider whose driver isn't registered", () => {
      expect(() => manager.userProvider("broken")).toThrow(UserProviderNotRegisteredError);
    });
  });

  describe("resolve()", () => {
    it("writes the resolved user and guard name into the ambient scope", async () => {
      await runWithAuth({ user: null, guard: null }, async () => {
        await manager.resolve(emptyRequest(), "token");

        expect(manager.user()).toEqual(alice);
        expect(manager.check()).toBe(true);
        expect(manager.currentGuard()).toBe("token");
        expect(manager.id()).toBe("alice");
      });
    });

    it("leaves the scope anonymous when the guard finds nobody", async () => {
      await runWithAuth({ user: null, guard: null }, async () => {
        await expect(manager.resolve(emptyRequest(), "other")).resolves.toBeNull();

        expect(manager.userOrNull()).toBeNull();
        expect(manager.check()).toBe(false);
        expect(manager.currentGuard()).toBeNull();
      });
    });

    it("mutates the existing scope rather than nesting a new one", async () => {
      // One request must have exactly one identity for its whole
      // lifetime — the caller's own reference to the state has to see the
      // resolved user.
      await runWithAuth({ user: null, guard: null }, async () => {
        const state = currentAuthState()!;
        await manager.resolve(emptyRequest(), "token");
        expect(state.user).toEqual(alice);
      });
    });

    it("throws outside any auth scope", async () => {
      await expect(manager.resolve(emptyRequest(), "token")).rejects.toThrow(
        MissingAuthContextError,
      );
    });
  });

  describe("attempt()", () => {
    it("returns the user for correct credentials", async () => {
      await expect(
        manager.attempt({ email: alice.email, password: "correct-horse" }),
      ).resolves.toEqual(alice);
    });

    it("returns null for a wrong password", async () => {
      await expect(manager.attempt({ email: alice.email, password: "wrong" })).resolves.toBeNull();
    });

    it("returns null for an unknown identifier", async () => {
      await expect(
        manager.attempt({ email: "nobody@example.com", password: "correct-horse" }),
      ).resolves.toBeNull();
    });

    it("hashes a throwaway value when no user is found", async () => {
      // Timing-attack mitigation: a nonexistent account must cost the
      // same wall-clock time as a wrong password, or response timing
      // reveals which emails have accounts. Nothing visibly depends on
      // this call, which is exactly why it needs a test — a future
      // refactor would otherwise delete it as dead code.
      const spy = vi.spyOn(hasher, "make");

      await manager.attempt({ email: "nobody@example.com", password: "some-password" });

      expect(spy).toHaveBeenCalledWith("some-password");
    });

    it("does not log the user in", async () => {
      // attempt() verifies credentials; issuing a token or session is the
      // caller's decision.
      await runWithAuth({ user: null, guard: null }, async () => {
        await manager.attempt({ email: alice.email, password: "correct-horse" });
        expect(manager.check()).toBe(false);
      });
    });
  });

  describe("runAs()", () => {
    it("establishes a scope for non-HTTP callers", async () => {
      const seen = await manager.runAs(alice, () => manager.user<TestUser>());
      expect(seen).toEqual(alice);
    });

    it("does not leak the scope after it resolves", async () => {
      await manager.runAs(alice, () => undefined);
      expect(() => manager.user()).toThrow(MissingAuthContextError);
    });
  });
});
