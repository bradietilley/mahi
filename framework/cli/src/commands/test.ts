import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Command as CommanderCommand } from "commander";
import { base_path } from "@mahiframework/core";
import { Command } from "../command.js";

/**
 * `./artisan test` — a thin passthrough to `vitest run`, shelled out via
 * `npx` (same approach the `artisan` script itself uses for `tsx`) so it resolves
 * whichever `vitest` is installed in the invoking app's own
 * `node_modules`, using that app's own `vitest.config.ts`. Not a
 * reimplementation of vitest's CLI — every argument after `test` is
 * passed straight through unparsed (`allowUnknownOption()` below), so
 * `./artisan test --watch`, `./artisan test tests/todos.test.ts`, and
 * `./artisan test -t "creates a todo"` all behave exactly as the
 * equivalent `vitest run ...` invocation would.
 *
 * Resolves the app's OWN `node_modules/.bin/vitest` directly rather than
 * shelling to `npx vitest` — `npx` may (silently, over the network) fetch
 * and run a foreign copy of vitest if the local one is missing or on a
 * different major, which is exactly the trap the top of the `artisan`
 * script warns about. Falls back to `npx` only if the local binary is not
 * present.
 *
 * Runs in the current working directory (the app's own directory when
 * invoked via `./artisan`, which `cd`s there first) so it picks up that
 * app's `vitest.config.ts` — this command intentionally has no opinion
 * about *which* app's tests it runs; it is not itself a test runner.
 */
export class TestCommand extends Command {
  // Shells out to the app's own vitest, a dev dependency.
  static override devOnly = true;

  signature = "test [args...]";
  description = "Run the application's test suite (passthrough to `vitest run`).";

  configure(program: CommanderCommand): void {
    program.allowUnknownOption();
  }

  async handle(args: string[] = []): Promise<void> {
    const [command, commandArgs] = this.resolveVitest(args);
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(command, commandArgs, { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });

    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  }

  /**
   * The command + args to run: the app's local `vitest` binary when present,
   * otherwise `npx vitest` as a last resort. `.cmd` on Windows.
   */
  private resolveVitest(args: string[]): [string, string[]] {
    const binName = process.platform === "win32" ? "vitest.cmd" : "vitest";
    const local = base_path("node_modules", ".bin", binName);

    if (existsSync(local)) {
      return [local, ["run", ...args]];
    }

    return ["npx", ["vitest", "run", ...args]];
  }
}
