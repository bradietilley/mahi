import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    /**
     * Above the 5s default, matching auth/testing/authorization/schedule/http.
     *
     * The `multi-process` suite spawns real child processes that perform
     * 200 lock-acquire/release cycles against the same file. Idle that is
     * ~150ms, but under a full 27-package run it competes for disk with
     * everything else, and 5s is also exactly `LOCK_TIMEOUT_MS`, so the
     * test deadline and the lock deadline were racing each other. Raising
     * the test timeout leaves the lock timeout as the thing that fails,
     * which is the one that actually means something.
     */
    testTimeout: 15000,
  },
});
