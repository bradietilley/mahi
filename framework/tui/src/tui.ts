import { writeNote, type NoteType } from "./note.js";
import { writeTable } from "./table.js";
import { ask, type AskOptions } from "./ask.js";
import { select, type SelectOptions } from "./select.js";
import { confirm, type ConfirmOptions } from "./confirm.js";
import { secret, type SecretOptions } from "./secret.js";
import { createProgress, mapProgress, ProgressBar } from "./progress.js";
import { spin } from "./spinner.js";
import { task, writeTaskLine, type TaskResult } from "./task.js";
import { stripAnsi } from "./ansi/strip.js";
import { BufferedOutput } from "./output/buffered-output.js";
import { FakeTerminal } from "./terminal/fake-terminal.js";
import {
  getOutput,
  resetContext,
  setCancelHandler,
  setColorOverride,
  setDimensionsOverride,
  setInteractiveOverride,
  setKeySourceFactory,
  setOutput,
} from "./context.js";

export interface FakeTuiHandle {
  /** Raw captured output, including ANSI escape codes. */
  output(): string;
  /** Captured output with ANSI escape codes stripped. */
  strippedOutput(): string;
  /** Undoes the fake, restoring real stdin/stdout wiring. */
  restore(): void;
}

/**
 * The `@mahiframework/tui` public facade — one static method per feature.
 * Talks directly to `process.stdin`/`process.stdout` (through the
 * module-level indirection in `context.ts`); no dependency on
 * `@mahiframework/core`, the container, or any other framework package.
 */
export class Tui {
  static note(message: string): void {
    writeNote(getOutput(), message, "note");
  }

  static error(message: string): void {
    writeNote(getOutput(), message, "error");
  }

  static warning(message: string): void {
    writeNote(getOutput(), message, "warning");
  }

  static info(message: string): void {
    writeNote(getOutput(), message, "info");
  }

  static success(message: string): void {
    writeNote(getOutput(), message, "success");
  }

  static intro(message: string): void {
    writeNote(getOutput(), message, "intro");
  }

  static outro(message: string): void {
    writeNote(getOutput(), message, "outro");
  }

  /** Low-level entry point matching `renderNote`'s full `NoteType` set — `note`/`error`/etc. above are thin wrappers over this. */
  static display(message: string, type: NoteType): void {
    writeNote(getOutput(), message, type);
  }

  static async ask(label: string, options: AskOptions = {}): Promise<string> {
    return ask(label, options);
  }

  static async select<T extends string | number>(
    label: string,
    options: SelectOptions<T>,
  ): Promise<T> {
    return select(label, options);
  }

  /** Boolean yes/no prompt — port of Laravel's `$this->confirm($question, $default = false)` / `laravel/prompts`' `confirm()`. Toggle with y/n or arrow/tab keys, submit with Enter. */
  static async confirm(label: string, options: ConfirmOptions = {}): Promise<boolean> {
    return confirm(label, options);
  }

  /** Masked (`•`) text input — port of Laravel's `$this->secret($question)` / `laravel/prompts`' `password()`, for values that shouldn't echo to the terminal (passwords, tokens). */
  static async secret(label: string, options: SecretOptions = {}): Promise<string> {
    return secret(label, options);
  }

  static progress(label: string, total: number, options?: { hint?: string }): ProgressBar;
  static progress<TItem, TResult>(
    label: string,
    items: TItem[] | Iterable<TItem>,
    callback: (item: TItem, bar: ProgressBar) => TResult | Promise<TResult>,
    options?: { hint?: string },
  ): Promise<TResult[]>;
  static progress<TItem, TResult>(
    label: string,
    totalOrItems: number | TItem[] | Iterable<TItem>,
    callbackOrOptions?:
      ((item: TItem, bar: ProgressBar) => TResult | Promise<TResult>) | { hint?: string },
    options?: { hint?: string },
  ): ProgressBar | Promise<TResult[]> {
    if (typeof totalOrItems === "number") {
      return createProgress(
        label,
        totalOrItems,
        callbackOrOptions as { hint?: string } | undefined,
      );
    }

    return mapProgress(
      label,
      totalOrItems,
      callbackOrOptions as (item: TItem, bar: ProgressBar) => TResult | Promise<TResult>,
      options,
    );
  }

  static async spinner<T>(message: string, callback: () => T | Promise<T>): Promise<T> {
    return spin(message, callback);
  }

  /**
   * Runs `callback`, printing a `label ......... RUNNING` line while
   * it's in flight and replacing it with `label ......... 12ms DONE`
   * (or `FAIL` if it throws) once it settles — port of Laravel's
   * `$this->components->task(...)`. See `task.ts` for the non-TTY
   * fallback and in-place-overwrite behavior.
   */
  static async task<T>(label: string, callback: () => T | Promise<T>): Promise<T> {
    return task(label, callback);
  }

  /** Prints a single, already-settled task-status line (no RUNNING state) — e.g. to report a "skipped" outcome. */
  static taskLine(label: string, result: TaskResult, durationMs?: number): void {
    writeTaskLine(label, result, durationMs);
  }

  static table(headers: string[], rows: (string | number)[][]): void;
  static table(rows: (string | number)[][]): void;
  static table(
    headersOrRows: string[] | (string | number)[][],
    rows?: (string | number)[][],
  ): void {
    const [headers, body] =
      rows === undefined
        ? [[], headersOrRows as (string | number)[][]]
        : [headersOrRows as string[], rows];
    writeTable(getOutput(), headers, body);
  }

  /**
   * Force the TTY-detection result every feature checks before deciding
   * whether to run interactively — matches PHP's `Prompt::interactive()`.
   * `Tui.fake()` calls this internally with `true` so `ask()`/`select()`
   * take the interactive code path even under a non-TTY test runner.
   *
   *   Tui.interactive();        // force ON
   *   Tui.interactive(false);   // force OFF
   *   Tui.clearInteractive();   // back to real TTY detection
   *
   * Clearing is a separate method rather than `interactive(undefined)`
   * because a default parameter fires on an explicit `undefined` too — so
   * with `value = true` the "clear" call was indistinguishable from
   * "force on", and silently did the opposite of what it read as.
   *
   * The override is process-global, so a test that sets it must clear it
   * again or it leaks into every later test in the same worker.
   */
  static interactive(value = true): void {
    setInteractiveOverride(value);
  }

  /** Drop the `interactive()` override and resume real TTY detection. */
  static clearInteractive(): void {
    setInteractiveOverride(undefined);
  }

  /**
   * Swaps in a `BufferedOutput` + a `FakeTerminal` that yields `keys`
   * one at a time instead of reading real stdin, and forces
   * `Tui.interactive(true)`. Public API (not test-only internals) —
   * mirrors `Prompt::fake([...keys])` being part of `laravel/prompts`'
   * own public surface, so consumers' tests (e.g. `@mahiframework/cli`
   * command tests) can simulate a terminal without a real TTY.
   */
  static fake(keys: string[] = []): FakeTuiHandle {
    const buffered = new BufferedOutput();
    setOutput(buffered);
    // One shared FakeTerminal for the whole fake() session — every
    // prompt constructed while faked (e.g. ask() then select() in the
    // same test) draws from the same queue, matching PHP's single
    // static `Prompt::$terminal` mock shared across every Prompt
    // instance created during a `Prompt::fake([...keys])` session.
    const terminal = new FakeTerminal(keys);
    setKeySourceFactory(() => terminal);
    setInteractiveOverride(true);
    // Force colour on under fake(): output is captured into a buffer (never a
    // TTY), and tests assert on the ANSI-styled result (`strippedOutput()`
    // exists precisely because `output()` keeps the codes). `restore()` clears
    // it again via `resetContext()`.
    setColorOverride(true);
    setCancelHandler(() => {
      /* no-op under Tui.fake() — matches PHP's mocked Terminal::exit() */
    });
    setDimensionsOverride({ cols: 80, rows: 24 });

    return {
      output: () => buffered.output(),
      strippedOutput: () => stripAnsi(buffered.output()),
      restore: () => resetContext(),
    };
  }
}
