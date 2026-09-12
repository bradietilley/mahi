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
     * 15s still was not enough: the DST cases (`30 2 1 * *` and `0 0 L * *`
     * in Lord_Howe/New_York) are ~700ms idle but blew the budget when 27
     * packages tested in parallel on a loaded machine. The scan is CPU-bound
     * on `Intl`, so it degrades with core contention rather than hanging.
     */
    testTimeout: 30000,
  },
});
