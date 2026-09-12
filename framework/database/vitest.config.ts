import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      // Temp JS migration fixtures import `@mahiframework/database`; point
      // them at source so this package's tests don't depend on a stale dist.
      "@mahiframework/database": path.resolve(root, "src/index.ts"),
    },
  },
});
