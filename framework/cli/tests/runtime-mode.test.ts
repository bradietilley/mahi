import { describe, expect, it } from "vitest";
import { deriveProgramName, isCompiledBinary, resolveRuntimeMode } from "../src/runtime-mode.js";

/**
 * A Mahi app is run as `./artisan` from a checkout and as a named executable
 * once it ships. These three functions are what let the SAME ConsoleKernel be
 * correct in both, so each case below is a real invocation shape rather than a
 * hypothetical one.
 */
describe("isCompiledBinary", () => {
  /**
   * A `bun build --compile` executable reports `argv[1]` as a path inside its
   * own virtual filesystem, which does not exist on disk. That is the only
   * reliable signal: `process.execPath` is the executable in both the compiled
   * case and a plain `bun run`, so it cannot distinguish them.
   */
  it("recognises a bun-compiled executable by its virtual argv[1]", () => {
    expect(isCompiledBinary(["bun", "/$bunfs/root/hivemind", "migrate"])).toBe(true);
    expect(isCompiledBinary(["bun", "B:\\~BUN\\root\\hivemind.exe"])).toBe(true);
  });

  it("does not mistake a real script path for one", () => {
    expect(isCompiledBinary(["node", "/app/bin/console.ts", "migrate"])).toBe(false);
    expect(isCompiledBinary(["node", "/usr/local/bin/hivemind"])).toBe(false);
    expect(isCompiledBinary(["node"])).toBe(false);
  });
});

describe("resolveRuntimeMode", () => {
  it("treats a compiled binary as user mode and a checkout as dev mode", () => {
    expect(resolveRuntimeMode({}, ["bun", "/$bunfs/root/hivemind"])).toBe("user");
    expect(resolveRuntimeMode({}, ["node", "/app/bin/console.ts"])).toBe("dev");
  });

  /**
   * The override is what makes a packaged-but-not-compiled install (a `bin`
   * script over bundled JS) able to declare itself. There is nothing about
   * its argv that distinguishes it from a checkout.
   */
  it("lets MAHI_MODE override detection in both directions", () => {
    expect(resolveRuntimeMode({ MAHI_MODE: "user" }, ["node", "/app/bin/console.ts"])).toBe("user");
    expect(resolveRuntimeMode({ MAHI_MODE: "dev" }, ["bun", "/$bunfs/root/hivemind"])).toBe("dev");
  });

  it("ignores a MAHI_MODE that is not a mode, rather than trusting it", () => {
    expect(resolveRuntimeMode({ MAHI_MODE: "production" }, ["node", "/app/bin/console.ts"])).toBe(
      "dev",
    );
  });
});

describe("deriveProgramName", () => {
  /**
   * The name matters: it is what Commander prints in `Usage:` and in
   * "unknown command" errors, i.e. the text a confused user will retype.
   */
  it("names itself after the executable, so a shipped binary self-labels", () => {
    expect(deriveProgramName(["bun", "/$bunfs/root/hivemind", "migrate"])).toBe("hivemind");
    expect(deriveProgramName(["node", "/proj/node_modules/.bin/myapp"])).toBe("myapp");
  });

  it("strips the extension from a script entry point", () => {
    expect(deriveProgramName(["node", "/app/bin/console.ts"])).toBe("console");
    expect(deriveProgramName(["node", "/app/dist/bin/console.js"])).toBe("console");
    expect(deriveProgramName(["node", "/app/bin/console.mjs"])).toBe("console");
  });

  it("falls back when argv carries no script at all", () => {
    expect(deriveProgramName(["node"], "fallback")).toBe("fallback");
    expect(deriveProgramName(["node", ""], "fallback")).toBe("fallback");
  });
});
