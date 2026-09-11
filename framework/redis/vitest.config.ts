import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The integration tests share one real Redis and some clean up with
    // FLUSHDB, which is global — running test files in parallel would let
    // one suite wipe another's in-flight keys. Force serial file execution
    // so each suite has the server to itself.
    fileParallelism: false,
  },
});
