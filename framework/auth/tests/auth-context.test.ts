import { describe, expect, it } from "vitest";
import {
  MissingAuthContextError,
  UnauthenticatedError,
  check,
  currentAuthState,
  currentGuard,
  runWithAuth,
  user,
  userOrNull,
} from "../src/auth-context.js";

const alice = { id: "alice", email: "alice@example.com" };
const bob = { id: "bob", email: "bob@example.com" };

describe("auth context", () => {
  describe("outside any scope", () => {
    it("user() throws MissingAuthContextError", () => {
      expect(() => user()).toThrow(MissingAuthContextError);
    });

    it("userOrNull() also throws rather than returning null", () => {
      // The most important assertion in this module. Softening this to
      // `return null` would make a route that forgot authenticate() behave
      // as a silently-anonymous request, which is how authorization checks
      // get bypassed. If this test is ever "fixed" by relaxing the
      // behaviour, read the module docblock first.
      expect(() => userOrNull()).toThrow(MissingAuthContextError);
    });

    it("check() throws too", () => {
      expect(() => check()).toThrow(MissingAuthContextError);
    });

    it("currentAuthState() returns undefined rather than throwing", () => {
      expect(currentAuthState()).toBeUndefined();
    });
  });

  describe("inside a scope with no user", () => {
    it("userOrNull() returns null and user() throws UnauthenticatedError", () => {
      runWithAuth({ user: null, guard: null }, () => {
        expect(userOrNull()).toBeNull();
        expect(() => user()).toThrow(UnauthenticatedError);
        expect(check()).toBe(false);
      });
    });
  });

  describe("inside a scope with a user", () => {
    it("exposes the user and guard", () => {
      runWithAuth({ user: alice, guard: "token" }, () => {
        expect(user()).toBe(alice);
        expect(userOrNull()).toBe(alice);
        expect(check()).toBe(true);
        expect(currentGuard()).toBe("token");
      });
    });
  });

  it("state mutated inside a scope is visible to later reads", () => {
    // authenticate() populates the state object opened by the global pipe
    // rather than nesting a scope, so in-place mutation must be visible.
    runWithAuth({ user: null, guard: null }, () => {
      expect(check()).toBe(false);

      const state = currentAuthState()!;
      state.user = alice;
      state.guard = "token";

      expect(user()).toBe(alice);
      expect(currentGuard()).toBe("token");
    });
  });

  it("does not leak between concurrent scopes", async () => {
    // The bug AsyncLocalStorage exists to prevent, and the reason a
    // singleton guard holding "the current user" would be a security bug
    // in this framework: one long-lived Application serves every request.
    // Interleaved await points are what make a naive implementation fail.
    const seen: Array<string | null> = [];

    const request = async (identity: { id: string }, delayMs: number): Promise<void> => {
      await runWithAuth({ user: null, guard: null }, async () => {
        currentAuthState()!.user = identity;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        // After yielding — and after the *other* request has run and
        // mutated its own scope — we must still see our own user.
        seen.push(user<{ id: string }>().id);
      });
    };

    await Promise.all([request(alice, 20), request(bob, 5), request(alice, 10)]);

    expect(seen.sort()).toEqual(["alice", "alice", "bob"]);
  });

  it("propagates across await boundaries within one scope", async () => {
    await runWithAuth({ user: alice, guard: "token" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(user()).toBe(alice);

      // ...including through a nested async call several frames deep.
      const nested = async (): Promise<unknown> => {
        await new Promise((resolve) => setImmediate(resolve));

        return user();
      };
      await expect(nested()).resolves.toBe(alice);
    });
  });

  it("returns the callback's value", () => {
    expect(runWithAuth({ user: alice, guard: "token" }, () => 42)).toBe(42);
  });
});
