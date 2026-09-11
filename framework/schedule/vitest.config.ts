import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    /**
     * Above vitest's 5s default because `next-run-fuzz.test.ts` is a
     * genuinely slow property test — its reference implementation steps one
     * minute at a time, which for a sparse expression like `0 0 L * *`
     * means ~350k `Intl.DateTimeFormat.formatToParts()` calls per case.
     * That is ~800ms idle but ~2.4s when the full monorepo suite saturates
     * the machine, leaving too little headroom under a 5s budget.
     *
     * Matches `@mahi/auth`/`@mahi/testing`, which set the same value for
     * their own argon2 cost.
     */
    testTimeout: 15000,
  },
});
