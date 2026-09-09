import type { ProcessResult } from "./process-result.js";

/** Thrown by `Process.run(...).throw()` when the process exited non-zero — port of Laravel's `Illuminate\Process\Exceptions\ProcessFailedException`. */
export class ProcessFailedError extends Error {
  constructor(public readonly result: ProcessResult) {
    super(
      `Process failed with exit code ${result.exitCode}: ${result.command}` +
        (result.stderr.trim() ? `\n${result.stderr.trim()}` : ""),
    );
    this.name = "ProcessFailedError";
  }
}
