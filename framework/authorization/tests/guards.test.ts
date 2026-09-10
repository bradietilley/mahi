import { describe, expect, it, vi } from "vitest";
import { requireAuth, requireGuest } from "../src/guards.js";

interface User {
  id: string;
}

const alice: User = { id: "alice" };

describe("requireAuth", () => {
  it("denies a guest without invoking the callback", async () => {
    const callback = vi.fn(() => true);
    const ability = requireAuth<User, []>(callback);

    expect(await ability(null)).toBe(false);
    // Not invoking is the point: the callback's signature promises a
    // non-null user, so calling it with null would be a type lie and a
    // latent null-dereference.
    expect(callback).not.toHaveBeenCalled();
  });

  it("passes an authenticated user and the remaining arguments through", async () => {
    const ability = requireAuth<User, [string, number]>((user, name, count) => {
      expect(user).toBe(alice);
      expect(name).toBe("thing");
      expect(count).toBe(2);

      return true;
    });

    expect(await ability(alice, "thing", 2)).toBe(true);
  });

  it("preserves the callback's decision", async () => {
    expect(await requireAuth<User, []>(() => false)(alice)).toBe(false);
  });

  it("supports async callbacks", async () => {
    const ability = requireAuth<User, []>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));

      return true;
    });

    expect(await ability(alice)).toBe(true);
  });

  it("stays synchronous when the callback is synchronous", () => {
    // Not incidental: the wrapper must not wrap a sync callback in a
    // promise. `GateRegistry.check()` awaits and compares `=== true`, so
    // it's safe either way — this pins the cheaper behaviour and documents
    // that a policy method's sync-ness survives wrapping.
    expect(requireAuth<User, []>(() => true)(alice)).toBe(true);
    expect(requireAuth<User, []>(() => true)(null)).toBe(false);
  });
});

describe("requireGuest", () => {
  it("allows a guest and never passes a user to the callback", async () => {
    const callback = vi.fn((published: boolean) => published);
    const ability = requireGuest<[boolean]>(callback);

    expect(await ability(null, true)).toBe(true);
    expect(callback).toHaveBeenCalledWith(true);
  });

  it("denies an authenticated user without invoking the callback", async () => {
    const callback = vi.fn(() => true);
    const ability = requireGuest<[]>(callback);

    expect(await ability(alice)).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it("is the exact inverse of requireAuth on who reaches the callback", async () => {
    const authOnly = requireAuth<User, []>(() => true);
    const guestOnly = requireGuest<[]>(() => true);

    expect(await authOnly(alice)).toBe(true);
    expect(await guestOnly(alice)).toBe(false);

    expect(await authOnly(null)).toBe(false);
    expect(await guestOnly(null)).toBe(true);
  });

  it("supports async callbacks", async () => {
    const ability = requireGuest<[]>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));

      return true;
    });

    expect(await ability(null)).toBe(true);
  });
});
