import path from "node:path";

/**
 * How the CLI is being run.
 *
 * - `dev`  — from a checkout, through `./artisan` / `tsx bin/console.ts`.
 *   The app's source tree is present and writable, `node_modules` exists.
 * - `user` — as a packaged/compiled executable on an end user's machine.
 *   There is no source tree, no `node_modules`, and no reason to believe the
 *   current directory has anything to do with the application.
 *
 * The distinction exists because a handful of built-in commands are only
 * meaningful in a checkout: `make:*` writes TypeScript into `app/`, `test`
 * shells out to the app's own `vitest`, and `serve` re-executes itself through
 * `tsx`. Offering them from a shipped binary lists commands that cannot work.
 */
export type RuntimeMode = "dev" | "user";

/**
 * True when running inside a single-file executable produced by
 * `bun build --compile`.
 *
 * Detected from `argv[1]`, which such a binary reports as a path inside its
 * virtual filesystem root (`/$bunfs/...`; `B:\~BUN\...` on Windows) rather
 * than a real file. `process.execPath` is NOT usable for this — it is the
 * executable's own path in both the compiled and the plain `bun run` case.
 */
export function isCompiledBinary(argv: readonly string[] = process.argv): boolean {
  const script = argv[1];

  if (script === undefined) {
    return false;
  }

  return (
    script.startsWith("/$bunfs/") || script.startsWith("B:\\~BUN") || script.startsWith("/~BUN/")
  );
}

/**
 * Resolve the runtime mode.
 *
 * `MAHI_MODE` overrides everything, which is what makes the mode testable and
 * lets a packaged-but-not-compiled install (a `bin` script over bundled JS)
 * declare itself. Otherwise a compiled binary is `user` and anything else is
 * `dev` — the safe default, since being wrong in that direction only shows
 * commands that would have worked anyway.
 */
export function resolveRuntimeMode(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): RuntimeMode {
  const declared = env.MAHI_MODE;

  if (declared === "dev" || declared === "user") {
    return declared;
  }

  return isCompiledBinary(argv) ? "user" : "dev";
}

/**
 * The name the CLI should call itself in `--help` and in error messages.
 *
 * Laravel has it easy here: `artisan` is always `artisan`. A Mahi app is run as
 * `./artisan` in development and as whatever the user named the binary once it
 * ships, so a hardcoded name is wrong in one of the two modes — and the name
 * matters. It is what appears in `Usage:` and in Commander's "unknown
 * command" output, i.e. exactly the text a confused user will retype.
 *
 * Derived from `argv[1]`'s basename, with extensions stripped, falling back to
 * `fallback` when that yields nothing useful:
 *
 * - `./artisan migrate`            → argv[1] is `bin/console.ts` → `console`*
 * - `hivemind migrate` (compiled)  → argv[1] is `/$bunfs/root/hivemind` → `hivemind`
 * - `npx myapp migrate`            → argv[1] is `.../node_modules/.bin/myapp` → `myapp`
 *
 * (*) which is why an app with a wrapper script of its own should pass its
 * real name explicitly rather than relying on derivation; see
 * `ConsoleKernel`'s `name` option.
 */
export function deriveProgramName(
  argv: readonly string[] = process.argv,
  fallback = "console",
): string {
  const script = argv[1];

  if (script === undefined || script === "") {
    return fallback;
  }

  const base = path.basename(script).replace(/\.(m|c)?[jt]s$/, "");

  return base === "" ? fallback : base;
}
