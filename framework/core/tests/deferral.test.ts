import { afterEach, describe, expect, it } from "vitest";
import {
  afterCommit,
  inTransaction,
  setAfterCommitResolver,
  clearAfterCommitResolver,
} from "../src/deferral.js";

describe("after-commit deferral seam", () => {
  afterEach(() => clearAfterCommitResolver());

  describe("with no resolver installed (no database)", () => {
    it("runs afterCommit() callbacks immediately and awaits them", async () => {
      const order: string[] = [];
      await afterCommit(async () => {
        await Promise.resolve();
        order.push("callback");
      });
      order.push("after");
      expect(order).toEqual(["callback", "after"]);
    });

    it("reports inTransaction() as false", () => {
      expect(inTransaction()).toBe(false);
    });
  });

  describe("with a resolver installed", () => {
    it("delegates afterCommit() and inTransaction() to the resolver", async () => {
      const deferred: Array<() => void | Promise<void>> = [];
      let active = true;
      setAfterCommitResolver({
        run: async (cb) => void deferred.push(cb),
        active: () => active,
      });

      const ran: string[] = [];
      await afterCommit(() => void ran.push("cb"));

      // The resolver captured it instead of running it.
      expect(ran).toEqual([]);
      expect(inTransaction()).toBe(true);

      // Draining it (as the real transaction() would after commit) runs it.
      for (const cb of deferred) {
        await cb();
      }

      expect(ran).toEqual(["cb"]);

      active = false;
      expect(inTransaction()).toBe(false);
    });

    it("clearAfterCommitResolver() restores immediate execution", async () => {
      setAfterCommitResolver({ run: async () => {}, active: () => true });
      clearAfterCommitResolver();

      let ran = false;
      await afterCommit(() => void (ran = true));
      expect(ran).toBe(true);
      expect(inTransaction()).toBe(false);
    });
  });
});
