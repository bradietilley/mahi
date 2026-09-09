import { eraseDown } from "../ansi/erase.js";
import { moveCursorToColumn, moveCursorUp } from "../ansi/cursor.js";
import type { Output } from "../output/output.js";

/**
 * The diff/redraw algorithm — port of `Prompt::render()` in
 * `laravel/prompts`' `src/Prompt.php`. Given the previously written
 * frame and a newly rendered frame, either no-ops (unchanged), writes
 * the frame in full (first render, `prevFrame === ""`), or moves the
 * cursor up to the start of the previous frame, erases to the end of
 * the screen, and writes the new frame — sliced from the top if it's
 * taller than the terminal, so the visible render stays pinned to the
 * bottom of the screen.
 *
 * The `dropFromTop` arithmetic (`abs(min(0, terminalLines -
 * previousFrameHeight))`) is transcribed directly from the PHP source
 * rather than reasoned out independently; `frame-renderer.test.ts` covers
 * it directly.
 */
export function renderFrame(
  output: Output,
  prevFrame: string,
  frame: string,
  terminalLines: number,
): void {
  if (frame === prevFrame) {
    return;
  }

  if (prevFrame === "") {
    output.write(frame);

    return;
  }

  const previousFrameHeight = prevFrame.split("\n").length;
  const frameLines = frame.split("\n");
  const dropFromTop = Math.abs(Math.min(0, terminalLines - previousFrameHeight));
  const renderableLines = frameLines.slice(dropFromTop);

  output.writeDirectly(moveCursorToColumn(1));
  output.writeDirectly(moveCursorUp(Math.min(terminalLines, previousFrameHeight) - 1));
  output.writeDirectly(eraseDown());
  output.write(renderableLines.join("\n"));
}
