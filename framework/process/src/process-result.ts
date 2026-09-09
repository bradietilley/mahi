import { ProcessFailedError } from "./process-failed-error.js";

/**
 * The outcome of a completed process — port of Laravel's
 * `Illuminate\Process\ProcessResult` (itself a thin wrapper around
 * Symfony's `Process` object), minus the parts that only make sense
 * with a Symfony `Process` behind them (`seeInOutput()`/
 * `seeInErrorOutput()` are one-line `.stdout.includes(...)` calls a
 * consumer can do directly).
 */
export interface ProcessResult {
  /** The command as it was invoked — the joined argv for array-form commands, or the raw string for shell-form commands. Mainly useful for logging/debugging and `Process.assertRan()`. */
  command: string;
  /** The process's exit code. `1` if the process was killed by a signal (including a `timeoutMs` timeout) or failed to spawn at all (e.g. command not found) — Node reports both of those as a `null` exit code, and there's no more specific POSIX convention worth inventing here. */
  exitCode: number;
  stdout: string;
  stderr: string;
  successful(): boolean;
  failed(): boolean;
  /** No-op if `successful()`; otherwise throws a `ProcessFailedError` wrapping this result. ≈ Laravel's `ProcessResult::throw()`. */
  throw(): ProcessResult;
}

export function makeProcessResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): ProcessResult {
  const result: ProcessResult = {
    command,
    exitCode,
    stdout,
    stderr,
    successful: () => exitCode === 0,
    failed: () => exitCode !== 0,
    throw: () => {
      if (exitCode !== 0) {
        throw new ProcessFailedError(result);
      }

      return result;
    },
  };

  return result;
}
