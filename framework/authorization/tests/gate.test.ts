import { beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "@mahi/core";
import { HttpError } from "@mahi/http";
import { GateRegistry } from "../src/gate.js";
import { Policy } from "../src/policy.js";
import { requireAuth } from "../src/guards.js";

interface User {
  id: string;
  admin?: boolean;
}
interface PostRow {
  id: string;
  user_id: string;
  published: boolean;
}

const alice: User = { id: "alice" };
const bob: User = { id: "bob" };
const admin: User = { id: "root", admin: true };

class Post {}
class Unregistered {}

class PostPolicy extends Policy<User, PostRow> {
  view(user: User | null, post: PostRow): boolean {
    if (post.published) {
      return true;
    }

    return user !== null && post.user_id === user.id;
  }

  update = requireAuth<User, [PostRow]>((user, post) => post.user_id === user.id);

  create = requireAuth<User, []>(() => true);

  async slowCheck(user: User | null): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, 1));

    return user?.id === alice.id;
  }
}

const alicePost: PostRow = { id: "p1", user_id: "alice", published: false };
const publishedPost: PostRow = { id: "p2", user_id: "bob", published: true };

/**
 * A gate with no AUTH_TOKEN bound — every check sees a guest unless
 * `forUser()` is used. Keeps these tests focused on resolution logic
 * rather than on auth wiring (which `can.test.ts` covers).
 */
function makeGate(): GateRegistry {
  const gate = new GateRegistry(new Application());
  gate.policy(Post, PostPolicy);

  return gate;
}

describe("GateRegistry", () => {
  let gate: GateRegistry;

  beforeEach(() => {
    gate = makeGate();
  });

  describe("defined abilities", () => {
    it("resolves a defined ability", async () => {
      gate.define<User>("view-dashboard", (user) => user?.id === "alice");

      await expect(gate.forUser(alice).allows("view-dashboard")).resolves.toBe(true);
      await expect(gate.forUser(bob).allows("view-dashboard")).resolves.toBe(false);
    });

    it("passes extra arguments through", async () => {
      gate.define<User>("edit-tenant", (user, tenantId) => tenantId === "t1" && user !== null);

      await expect(gate.forUser(alice).allows("edit-tenant", "t1")).resolves.toBe(true);
      await expect(gate.forUser(alice).allows("edit-tenant", "t2")).resolves.toBe(false);
    });

    it("denies an unknown ability rather than throwing", async () => {
      // Fail-closed: a typo that 403s beats one that 500s in production.
      await expect(gate.forUser(alice).allows("no-such-ability")).resolves.toBe(false);
    });

    it("has() reports registration", () => {
      gate.define("known", () => true);
      expect(gate.has("known")).toBe(true);
      expect(gate.has("unknown")).toBe(false);
    });
  });

  describe("policy dispatch", () => {
    it("dispatches to the policy for a registered model with a row", async () => {
      await expect(gate.forUser(alice).allows("update", Post, alicePost)).resolves.toBe(true);
      await expect(gate.forUser(bob).allows("update", Post, alicePost)).resolves.toBe(false);
    });

    it("dispatches to the policy for a bare model class", async () => {
      await expect(gate.forUser(alice).allows("create", Post)).resolves.toBe(true);
      await expect(gate.forUser(null).allows("create", Post)).resolves.toBe(false);
    });

    it("denies when the policy has no method for that ability", async () => {
      await expect(gate.forUser(alice).allows("incinerate", Post, alicePost)).resolves.toBe(false);
    });

    it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
      "denies the built-in name %s without throwing",
      async (ability) => {
        // A plain property lookup finds these on Object.prototype, so
        // `allows("constructor", Post)` called the class constructor
        // without `new` and threw a TypeError out of the gate — a 500
        // from an authorization check, reachable by anyone who can
        // influence an ability name. A clean deny is the correct answer.
        await expect(gate.forUser(alice).allows(ability, Post, alicePost)).resolves.toBe(false);
      },
    );

    it("still dispatches to an ability inherited from a base policy", async () => {
      // The prototype walk must stop at Object.prototype, not at the
      // policy's own prototype — a shared base policy is a normal thing
      // to have.
      class BasePolicy extends Policy<User, PostRow> {
        archive(): boolean {
          return true;
        }
      }
      class ChildPolicy extends BasePolicy {}

      const registry = new GateRegistry(new Application());
      registry.policy(Unregistered, ChildPolicy);

      await expect(registry.forUser(alice).allows("archive", Unregistered)).resolves.toBe(true);
    });

    it("falls through to defined abilities for an unregistered model class", async () => {
      // An unregistered class is just another argument, not an error.
      gate.define("inspect", (_user, target) => target === Unregistered);

      await expect(gate.forUser(alice).allows("inspect", Unregistered)).resolves.toBe(true);
    });

    it("awaits async policy methods", async () => {
      // The single easiest way to accidentally authorize everything: an
      // unawaited promise is a truthy object. If this regresses, every
      // async policy silently returns "allowed".
      await expect(gate.forUser(alice).allows("slowCheck", Post)).resolves.toBe(true);
      await expect(gate.forUser(bob).allows("slowCheck", Post)).resolves.toBe(false);
    });

    it("treats a non-boolean truthy return as denial", async () => {
      // Strict === true, so a policy accidentally returning a promise,
      // object or string can't grant access.
      gate.define("sloppy", () => "yes" as unknown as boolean);
      await expect(gate.forUser(alice).allows("sloppy")).resolves.toBe(false);
    });

    it("caches the policy instance across checks", async () => {
      const spy = vi.spyOn(PostPolicy.prototype, "view");

      await gate.forUser(alice).allows("view", Post, alicePost);
      await gate.forUser(alice).allows("view", Post, alicePost);

      // Same `this` both times — policies are stateless singletons.
      expect(spy.mock.instances[0]).toBe(spy.mock.instances[1]);
      spy.mockRestore();
    });
  });

  describe("guests", () => {
    it("lets a guest-aware policy method allow anonymous access", async () => {
      await expect(gate.forUser(null).allows("view", Post, publishedPost)).resolves.toBe(true);
      await expect(gate.forUser(null).allows("view", Post, alicePost)).resolves.toBe(false);
    });

    it("denies guests on requireAuth-wrapped abilities", async () => {
      await expect(gate.forUser(null).allows("update", Post, alicePost)).resolves.toBe(false);
    });
  });

  describe("before()", () => {
    it("short-circuits with true", async () => {
      gate.before<User>((user) => (user?.admin === true ? true : null));

      // Bob doesn't own this post; the admin hook overrides the policy.
      await expect(gate.forUser(admin).allows("update", Post, alicePost)).resolves.toBe(true);
    });

    it("short-circuits with false", async () => {
      gate.before<User>((user) => (user?.id === "banned" ? false : null));

      await expect(
        gate.forUser({ id: "banned" }).allows("view", Post, publishedPost),
      ).resolves.toBe(false);
    });

    it("falls through on null", async () => {
      gate.before(() => null);

      await expect(gate.forUser(alice).allows("update", Post, alicePost)).resolves.toBe(true);
    });

    it("runs callbacks in registration order and stops at the first decision", async () => {
      const calls: string[] = [];
      gate.before(() => {
        calls.push("first");

        return null;
      });
      gate.before(() => {
        calls.push("second");

        return true;
      });
      gate.before(() => {
        calls.push("third");

        return false;
      });

      await expect(gate.forUser(alice).allows("anything")).resolves.toBe(true);
      expect(calls).toEqual(["first", "second"]);
    });

    it("skips after() hooks when it short-circuits", async () => {
      const after = vi.fn(() => false);
      gate.before(() => true);
      gate.after(after);

      await expect(gate.forUser(alice).allows("anything")).resolves.toBe(true);
      expect(after).not.toHaveBeenCalled();
    });
  });

  describe("after()", () => {
    it("can override the result", async () => {
      gate.after(() => false);

      await expect(gate.forUser(alice).allows("update", Post, alicePost)).resolves.toBe(false);
    });

    it("leaves the result alone when it returns null", async () => {
      gate.after(() => null);

      await expect(gate.forUser(alice).allows("update", Post, alicePost)).resolves.toBe(true);
    });

    it("receives the resolved result", async () => {
      const seen: boolean[] = [];
      gate.after((_user, _ability, result) => {
        seen.push(result);

        return null;
      });

      await gate.forUser(alice).allows("update", Post, alicePost);
      await gate.forUser(bob).allows("update", Post, alicePost);

      expect(seen).toEqual([true, false]);
    });
  });

  describe("authorize() / denies()", () => {
    it("authorize() resolves silently when allowed", async () => {
      await expect(
        gate.forUser(alice).authorize("update", Post, alicePost),
      ).resolves.toBeUndefined();
    });

    it("authorize() throws a 403 HttpError when denied", async () => {
      await expect(gate.forUser(bob).authorize("update", Post, alicePost)).rejects.toThrow(
        HttpError,
      );

      await gate
        .forUser(bob)
        .authorize("update", Post, alicePost)
        .catch((error: HttpError) => {
          expect(error.status).toBe(403);
        });
    });

    it("denies() is the inverse of allows()", async () => {
      await expect(gate.forUser(bob).denies("update", Post, alicePost)).resolves.toBe(true);
      await expect(gate.forUser(alice).denies("update", Post, alicePost)).resolves.toBe(false);
    });
  });

  describe("ambient user, resolved through AUTH_TOKEN", () => {
    /** Stands in for @mahi/auth's AuthManager — resolved by string, never imported. */
    function gateWithUser(user: User | null): GateRegistry {
      const app = new Application();
      app.instance("auth", { userOrNull: () => user });

      const withUser = new GateRegistry(app);
      withUser.policy(Post, PostPolicy);

      return withUser;
    }

    it("reads the current user without being passed one", async () => {
      await expect(gateWithUser(alice).allows("update", Post, alicePost)).resolves.toBe(true);
      await expect(gateWithUser(bob).allows("update", Post, alicePost)).resolves.toBe(false);
    });

    it("abilitiesFor() resolves several abilities for one target", async () => {
      await expect(
        gateWithUser(alice).abilitiesFor(["view", "update", "incinerate"], Post, alicePost),
      ).resolves.toEqual({ view: true, update: true, incinerate: false });

      await expect(
        gateWithUser(bob).abilitiesFor(["view", "update"], Post, alicePost),
      ).resolves.toEqual({ view: false, update: false });
    });

    it("abilitiesFor() works for a bare model class", async () => {
      await expect(gateWithUser(alice).abilitiesFor(["create"], Post)).resolves.toEqual({
        create: true,
      });
    });

    it("forUser() overrides the ambient user", async () => {
      await expect(
        gateWithUser(bob).forUser(alice).allows("update", Post, alicePost),
      ).resolves.toBe(true);
    });
  });

  describe("without @mahi/auth installed", () => {
    it("treats every request as a guest instead of throwing", async () => {
      // Authorization must be usable in an app that has no auth package
      // bound at all — every check simply sees a guest.
      await expect(gate.allows("view", Post, publishedPost)).resolves.toBe(true);
      await expect(gate.allows("update", Post, alicePost)).resolves.toBe(false);
    });
  });
});
