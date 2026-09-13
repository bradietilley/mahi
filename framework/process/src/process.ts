import { spawn } from "node:child_process";
import { makeProcessResult, type ProcessResult } from "./process-result.js";
import { commandToString, wildcardMatch } from "./matching.js";

export interface ProcessOptions {
  /** Working directory the process runs in. Defaults to the current process's cwd. */
  cwd?: string;
  /** Kills the process (`SIGTERM`) if it hasn't exited after this many milliseconds. */
  timeoutMs?: number;
  /** Merged on top of the current `process.env` (not a full replacement), matches Node's own `spawn({ env })` semantics. */
  env?: Record<string, string>;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
}

/** A registered `Process.fake()` handler: either a fixed result, or a function computing one from the actual command string (sync or async). */
export type FakeProcessHandler =
  ProcessResult | ((command: string) => ProcessResult | Promise<ProcessResult>);

/**
 * `@mahiframework/process`, a reusable process-execution wrapper, port
 * of Laravel's `Illuminate\Process\Factory`/`PendingProcess`
 * (`Process::run()`/`Process::fake()`/`Process::assertRan()`). Thin
 * wrapper over Node's built-in `node:child_process`, no `execa`
 * dependency, matching the framework's established "minimal
 * dependencies" pattern.
 *
 * Static facade over module-level state (fake handlers, call history),
 * mirroring `@mahiframework/tui`'s `Tui` class, no dependency on
 * `@mahiframework/core`/the container, since there's nothing here that
 * needs DI (this is a pure utility, like `Tui`, not an app service).
 *
 * ```ts
 * import { Process } from "@mahiframework/process";
 *
 * const result = await Process.run(["git", "rev-parse", "HEAD"]);
 * if (result.successful()) console.log(result.stdout.trim());
 *
 * // In tests:
 * import { makeProcessResult } from "@mahiframework/process";
 * Process.fake({ "git *": makeProcessResult("git rev-parse HEAD", 0, "abc123\n", "") });
 * await Process.run(["git", "rev-parse", "HEAD"]);
 * Process.assertRan("git *");
 * Process.restore();
 * ```
 */
export class Process {
  private static fakeHandlers: Array<{ pattern: string; handler: FakeProcessHandler }> | undefined;
  private static history: string[] = [];

  /**
   * Runs `command` (an argv array, spawned directly with no shell
   * involved, the safer default; or a single string, run through the
   * platform shell so pipes/redirects/globs work) and resolves with a
   * `ProcessResult` once it exits. Never rejects: a failed spawn (e.g.
   * command not found) resolves with `exitCode: 1` and the spawn
   * error's message in `stderr`, just like a non-zero exit, inspect
   * `result.successful()`/`.failed()`, or call `result.throw()` to opt
   * into throwing a `ProcessFailedError`.
   */
  static async run(
    command: string | string[],
    options: ProcessOptions = {},
  ): Promise<ProcessResult> {
    const commandString = commandToString(command);

    if (Process.fakeHandlers) {
      // Only record history while faking, otherwise a long-lived server
      // or worker accumulates every real command it ever ran for the
      // lifetime of the process. `ran()`/`assertRan()` are test affordances.
      Process.history.push(commandString);

      return Process.resolveFake(commandString);
    }

    return Process.spawnReal(command, commandString, options);
  }

  private static async resolveFake(commandString: string): Promise<ProcessResult> {
    const match = Process.fakeHandlers!.find((entry) =>
      wildcardMatch(entry.pattern, commandString),
    );

    if (!match) {
      // No matching handler registered, default to a generic
      // successful, empty-output result, matching Laravel's
      // `Process::fake()` default-unmatched behavior.
      //
      // NOTE: `@mahiframework/http-client`'s `Http.fake()` deliberately does the
      // opposite, an unmatched request raises `StrayRequestError` rather
      // than being quietly satisfied, because a typo'd pattern otherwise
      // looks like a passing test. The two packages having opposite
      // defaults is worse than either default; this should adopt the
      // stray-throw behaviour too (with an `allowStrayProcesses()` opt-out),
      // as a follow-up that needs its own deprecation window.
      return makeProcessResult(commandString, 0, "", "");
    }

    return typeof match.handler === "function" ? await match.handler(commandString) : match.handler;
  }

  private static spawnReal(
    command: string | string[],
    commandString: string,
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    return new Promise((resolve) => {
      const env = options.env ? { ...process.env, ...options.env } : undefined;
      const child = Array.isArray(command)
        ? spawn(command[0] ?? "", command.slice(1), {
            cwd: options.cwd,
            env,
            timeout: options.timeoutMs,
          })
        : spawn(command, { cwd: options.cwd, env, timeout: options.timeoutMs, shell: true });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      if (child.stdin) {
        // A child that exits before draining stdin (`grep -q`, `head`, a
        // script that `process.exit()`s early) makes the write fail with
        // `EPIPE`. Without this listener that surfaces as an uncaught
        // exception and takes down the host process, swallow it here,
        // since `run()` is documented to never reject.
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE") {
            resolve(makeProcessResult(commandString, 1, stdout, stderr || error.message));
          }
        });

        if (options.input !== undefined) {
          child.stdin.write(options.input);
        }

        child.stdin.end();
      }

      // Spawn-time failure (e.g. ENOENT), resolve, don't reject, so
      // callers only ever need to check `result.failed()`.
      child.on("error", (error) => {
        resolve(makeProcessResult(commandString, 1, stdout, stderr || error.message));
      });

      // Resolve on `close`, not `exit`: `exit` fires as soon as the child
      // ends, but its stdio streams may still be flushing, so reading exit
      // there can truncate `stdout`/`stderr`. `close` fires once all stdio
      // is drained. (`error`/`close` still resolve exactly once, extra
      // `resolve` calls after the first are no-ops.)
      child.on("close", (code) => {
        // Node reports both "killed by signal" (including our own
        // `timeoutMs` kill) and "never started" as a `null` exit code.
        // There's no more specific POSIX convention worth inventing, so
        // both collapse to exit code 1.
        resolve(makeProcessResult(commandString, code ?? 1, stdout, stderr));
      });
    });
  }

  /**
   * Swaps `run()` to resolve from `handlers` instead of actually
   * spawning anything, port of `Process::fake([...])`. Keys are
   * `*`-wildcard command patterns matched against the joined command
   * string (e.g. `"git *"`, `"npm run *"`); the first matching handler
   * wins. Call with no arguments to fake every command with the
   * generic default result. Always pairs with `Process.restore()`
   * (e.g. in an `afterEach`) to avoid leaking fake state across tests.
   */
  static fake(handlers: Record<string, FakeProcessHandler> = {}): void {
    Process.fakeHandlers = Object.entries(handlers).map(([pattern, handler]) => ({
      pattern,
      handler,
    }));
  }

  /** True while `Process.fake()` is active (i.e. `run()` won't actually spawn). */
  static isFaked(): boolean {
    return Process.fakeHandlers !== undefined;
  }

  /** Every command string `run()` has been called with while faking, oldest first. Real (non-faked) runs are not recorded. */
  static ran(): readonly string[] {
    return Process.history;
  }

  /**
   * Asserts at least one recorded `run()` call matched `matcher` (a
   * `*`-wildcard command pattern, or a predicate over the raw command
   * string), port of `Process::assertRan(...)`. Throws a plain `Error`
   * (picked up by any test runner's assertion-failure handling) if not.
   */
  static assertRan(matcher: string | ((command: string) => boolean)): void {
    const matches =
      typeof matcher === "function" ? matcher : (cmd: string) => wildcardMatch(matcher, cmd);

    if (!Process.history.some(matches)) {
      const label = typeof matcher === "string" ? `"${matcher}"` : "the given predicate";
      const ran = Process.history.length === 0 ? "(none)" : Process.history.join(", ");
      throw new Error(`Expected a process matching ${label} to have run. Ran: ${ran}`);
    }
  }

  /** Asserts no recorded `run()` call matched `matcher`, port of `Process::assertNotRan(...)`. */
  static assertNotRan(matcher: string | ((command: string) => boolean)): void {
    const matches =
      typeof matcher === "function" ? matcher : (cmd: string) => wildcardMatch(matcher, cmd);

    if (Process.history.some(matches)) {
      const label = typeof matcher === "string" ? `"${matcher}"` : "the given predicate";
      throw new Error(`Expected no process matching ${label} to have run, but one did.`);
    }
  }

  /** Clears fake handlers and call history, restoring real process spawning. Undoes `fake()`. */
  static restore(): void {
    Process.fakeHandlers = undefined;
    Process.history = [];
  }
}
