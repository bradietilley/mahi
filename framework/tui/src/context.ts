import { NodeOutput, type Output } from "./output/output.js";
import { RawTerminal } from "./terminal/raw-terminal.js";
import type { KeySource } from "./terminal/raw-terminal.js";
import * as dimensions from "./terminal/dimensions.js";

/**
 * Module-level indirection point every feature (`note`, `table`,
 * `ask`, `select`, `progress`, `spinner`) resolves `output`/the key
 * source/terminal dimensions/interactivity through, instead of
 * constructing `NodeOutput`/`RawTerminal` directly inline — mirrors
 * PHP's `static Prompt::$output`/`$terminal`. `Tui.fake()` swaps these
 * out; without this indirection `fake()` would have nothing to
 * intercept.
 */

let currentOutput: Output = new NodeOutput();
let terminalFactory: () => KeySource = () => new RawTerminal();
let interactiveOverride: boolean | undefined;
let cancelHandler: () => void = () => process.exit(130);
let dimensionsOverride: { cols: number; rows: number } | undefined;
let colorOverride: boolean | undefined;

export function getOutput(): Output {
  return currentOutput;
}

export function setOutput(output: Output): void {
  currentOutput = output;
}

export function createKeySource(): KeySource {
  return terminalFactory();
}

export function setKeySourceFactory(factory: () => KeySource): void {
  terminalFactory = factory;
}

/** Force (or clear, via `undefined`) the TTY-detection result used by `isInteractive()`. */
export function setInteractiveOverride(value: boolean | undefined): void {
  interactiveOverride = value;
}

export function isInteractive(): boolean {
  if (interactiveOverride !== undefined) {
    return interactiveOverride;
  }

  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Invoked when Ctrl+C cancels an interactive prompt. Defaults to
 * `process.exit(130)` (matching PHP's `Terminal::exit()`) — `Tui.fake()` swaps this to
 * a no-op so simulated Ctrl+C presses don't kill the test process,
 * matching PHP's `FakesInputOutput` mocking `Terminal::exit()`.
 */
export function getCancelHandler(): () => void {
  return cancelHandler;
}

export function setCancelHandler(handler: () => void): void {
  cancelHandler = handler;
}

/**
 * Whether ANSI colour/styling should be emitted. Follows the de-facto
 * cross-tool convention:
 *
 * - `NO_COLOR` set (to anything) → never colour (https://no-color.org).
 * - `FORCE_COLOR` set (to anything non-empty, and not `"0"`) → always colour,
 *   even when piped (CI logs want this).
 * - otherwise colour only when stdout is an interactive terminal.
 *
 * Without this every `note`/`table`/`task` wrote raw `\x1b[...m` sequences
 * unconditionally, so `./artisan migrate:status | cat` (or any redirect to a
 * file / CI log) was full of `^[[90m` garbage.
 */
export function colorsEnabled(): boolean {
  if (colorOverride !== undefined) {
    return colorOverride;
  }

  const env = process.env;

  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }

  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") {
    return true;
  }

  return Boolean(process.stdout.isTTY);
}

/** Force (or clear, via `undefined`) the colour-detection result. Used by `Tui.fake()` and tests. */
export function setColorOverride(value: boolean | undefined): void {
  colorOverride = value;
}

export function cols(): number {
  return dimensionsOverride?.cols ?? dimensions.cols();
}

export function rows(): number {
  return dimensionsOverride?.rows ?? dimensions.rows();
}

export function setDimensionsOverride(value: { cols: number; rows: number } | undefined): void {
  dimensionsOverride = value;
}

/** Resets every override back to real `process.stdin`/`process.stdout` wiring. */
export function resetContext(): void {
  currentOutput = new NodeOutput();
  terminalFactory = () => new RawTerminal();
  interactiveOverride = undefined;
  cancelHandler = () => process.exit(130);
  dimensionsOverride = undefined;
  colorOverride = undefined;
}
