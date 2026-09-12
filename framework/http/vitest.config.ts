import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    /**
     * Above the 5s default, matching auth/testing/authorization/schedule.
     *
     * A handful of tests here `await import()` a module cold —
     * `controller.test.ts`'s 422 case pulls in `HttpKernel` and
     * `@mahiframework/core` — which takes ~400ms idle but far longer when all 27
     * packages are competing under a full `pnpm test`. It intermittently
     * crossed 5s there while passing in isolation every time.
     */
    testTimeout: 15000,
  },
});
