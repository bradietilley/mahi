import { dim, gray, green, red, yellow } from "./ansi/colors.js";
import { displayWidth } from "./render/text-width.js";
import { cols, getOutput, isInteractive } from "./context.js";
import type { Output } from "./output/output.js";

/**
 * Port of Laravel's `Illuminate\Console\View\Components\Task` (the
 * `$this->components->task(...)` helper, and the dotted-line status
 * format `Seeder::call()`/`Migrator::write()` use via `TwoColumnDetail`),
 * a single status line with a label, a variable-length row of dots
 * filling the remaining terminal width, and a right-aligned status word
 * (`RUNNING` while a task is in flight in a live TTY, `DONE`/`FAIL`
 * once it settles). Not part of `laravel/prompts` (this is a Laravel
 * *console component*, not a *prompts* renderer), added here as the
 * natural small extension the shared color/text-width plumbing already
 * supports. Unlike `note`/`table`, task lines are meant to be printed
 * back-to-back in a tight sequential list (e.g. one per migration),
 * no forced blank-line spacing between them.
 */
export type TaskResult = "done" | "failed" | "skipped";

const STATUS_LABEL: Record<TaskResult, string> = {
  done: "DONE",
  failed: "FAIL",
  skipped: "SKIPPED",
};

const STATUS_COLOR: Record<TaskResult, (text: string) => string> = {
  done: green,
  failed: red,
  skipped: yellow,
};

function dotsLine(label: string, statusText: string, terminalCols: number): string {
  const width = Math.min(terminalCols, 150);
  const labelWidth = displayWidth(label);
  const statusWidth = displayWidth(statusText);
  const dots = Math.max(width - labelWidth - statusWidth - 8, 0);

  return dots > 0 ? gray(".".repeat(dots)) : "";
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/**
 * Renders one status line: `  label ......... DONE` (or `FAIL`/
 * `SKIPPED`), with an optional gray duration before the status word.
 */
export function renderTaskLine(
  label: string,
  result: TaskResult,
  durationMs?: number,
  terminalCols = cols(),
): string {
  const durationText = durationMs !== undefined ? `${formatDuration(durationMs)} ` : "";
  const statusText = `${durationText}${STATUS_LABEL[result]}`;
  const dots = dotsLine(label, statusText, terminalCols);
  const statusColored = STATUS_COLOR[result](STATUS_LABEL[result]);
  const durationColored = durationText ? gray(durationText) : "";

  return `  ${label}${dots ? ` ${dots}` : ""} ${durationColored}${statusColored}`;
}

/** Writes a single, already-settled task-status line, for when you already know the outcome and don't need a RUNNING state (e.g. reporting a "skipped" result). */
export function writeTaskLine(label: string, result: TaskResult, durationMs?: number): void {
  getOutput().write(`${renderTaskLine(label, result, durationMs)}\n`);
}

/**
 * Runs `callback`, printing a `label ......... RUNNING` line while it's
 * in flight (overwritten in place once settled, same "erase and
 * rewrite" idea `Tui.spinner()` uses, simplified since a task line is
 * always exactly one line tall) and replacing it with
 * `label ......... 12ms DONE` (or `FAIL` if it throws). Falls back to
 * a single, settled status line with no RUNNING flicker under a
 * non-interactive output (mirrors `Tui.spinner()`'s non-interactive
 * fallback).
 */
export async function task<T>(label: string, callback: () => T | Promise<T>): Promise<T> {
  const output = getOutput();
  const start = Date.now();
  const interactive = isInteractive();

  if (interactive) {
    const terminalCols = cols();
    const statusText = "RUNNING";
    const dots = dotsLine(label, statusText, terminalCols);
    output.write(`  ${label}${dots ? ` ${dots}` : ""} ${dim(statusText)}`);
  }

  try {
    const result = await callback();
    finishLine(output, label, "done", Date.now() - start, interactive);

    return result;
  } catch (error) {
    finishLine(output, label, "failed", Date.now() - start, interactive);
    throw error;
  }
}

function finishLine(
  output: Output,
  label: string,
  result: TaskResult,
  durationMs: number,
  interactive: boolean,
): void {
  if (interactive) {
    // Overwrite the in-flight RUNNING line in place: return to column 1
    // and erase the line before writing the settled status.
    output.writeDirectly("\r\x1b[K");
  }

  output.write(`${renderTaskLine(label, result, durationMs)}\n`);
}
