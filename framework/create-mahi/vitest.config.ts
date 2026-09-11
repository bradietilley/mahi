import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `template/` is a scaffolding payload, not source: its files are
    // copied verbatim into a generated app, where their `@mahi/*` imports
    // resolve against that app's own node_modules. `template/tests/` is
    // the *generated app's* suite — it runs there, not here.
    exclude: ["**/node_modules/**", "**/dist/**", "template/**"],
  },
});
