/**
 * `@mahi/process` — a reusable process-execution wrapper, port
 * of Laravel's `Illuminate\Process` component (`Process::run()`/
 * `Process::fake()`/`Process::assertRan()`), scoped to synchronous
 * `run()` (no `pipe()`/`pool()`/async background processes).
 * Thin wrapper over Node's built-in `node:child_process` — no
 * `execa` dependency. No dependency on `@mahi/core` or any
 * other framework package — usable standalone.
 *
 * ```ts
 * import { Process } from "@mahi/process";
 *
 * const result = await Process.run(["git", "rev-parse", "HEAD"]);
 * if (result.successful()) console.log(result.stdout.trim());
 * ```
 */
export { Process } from "./process.js";
export type { ProcessOptions, FakeProcessHandler } from "./process.js";
export type { ProcessResult } from "./process-result.js";
export { makeProcessResult } from "./process-result.js";
export { ProcessFailedError } from "./process-failed-error.js";
