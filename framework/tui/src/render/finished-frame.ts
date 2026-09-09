import type { Output } from "../output/output.js";

/**
 * Writes a single, non-interactive "finished" frame (used by
 * `note`/`table`, and implicitly by interactive prompts once they reach
 * `submit`/`cancel`): prefixes exactly enough blank lines so there are
 * always 2 blank lines between blocks (port of `Renderer::__toString()`'s
 * `str_repeat(PHP_EOL, max(2 - newLinesWritten, 0))`), then the frame
 * itself, then a trailing newline.
 */
export function writeFinishedFrame(output: Output, frame: string): void {
  const blankLines = "\n".repeat(Math.max(2 - output.newLinesWritten(), 0));
  output.write(`${blankLines}${frame}\n`);
}
