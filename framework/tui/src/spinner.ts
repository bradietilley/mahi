import { cyan } from "./ansi/colors.js";
import { hideCursor, moveCursorToColumn, moveCursorUp, showCursor } from "./ansi/cursor.js";
import { eraseDown } from "./ansi/erase.js";
import { renderFrame as diffRenderFrame } from "./render/frame-renderer.js";
import { getOutput, isInteractive, rows } from "./context.js";
import type { Output } from "./output/output.js";

const FRAMES = ["⠂", "⠒", "⠐", "⠰", "⠠", "⠤", "⠄", "⠆"];
const STATIC_FRAME = "⠶";
const INTERVAL_MS = 80; // PHP's spinner uses an accidental 75ms; 80ms is the deliberate round number here

/**
 * Port of `laravel/prompts`' `Spinner.php` + `SpinnerRenderer.php` +
 * `Concerns/HasSpinner.php` — with a materially different animation
 * mechanism: PHP forks an OS process (`pcntl_fork()`) to run the render
 * loop in parallel with the callback; Node has no equivalent (single-
 * threaded event loop) and doesn't need one — `setInterval` around an
 * `await`ed callback achieves the same interleaved-animation effect for
 * async work. **Caveat**: a synchronous, CPU-bound callback pauses the
 * animation for its duration — same tradeoff every Node CLI spinner
 * library (e.g. `ora`) documents.
 */
export async function spin<T>(message: string, callback: () => T | Promise<T>): Promise<T> {
  const output = getOutput();

  if (!isInteractive()) {
    output.write(` ${STATIC_FRAME} ${message}\n`);

    return callback();
  }

  let frame = 0;
  let prevFrame = "";

  output.writeDirectly(hideCursor());

  const render = (): void => {
    const text = ` ${cyan(FRAMES[frame % FRAMES.length]!)} ${message}`;
    diffRenderFrame(output, prevFrame, text, rows());
    prevFrame = text;
    frame++;
  };
  render();

  const timer = setInterval(render, INTERVAL_MS);
  try {
    return await callback();
  } finally {
    clearInterval(timer);
    eraseRenderedLines(output, prevFrame);
    output.writeDirectly(showCursor());
  }
}

/**
 * Clears the spinner's last rendered frame from the terminal once the
 * callback finishes — port of `Spinner::eraseRenderedLines()` (moves
 * the cursor to column 1, up to the top of the rendered frame, then
 * erases down).
 */
function eraseRenderedLines(output: Output, prevFrame: string): void {
  const lineCount = prevFrame.split("\n").length;
  output.writeDirectly(moveCursorToColumn(1));
  output.writeDirectly(moveCursorUp(lineCount - 1));
  output.writeDirectly(eraseDown());
}
