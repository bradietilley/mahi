/**
 * Raw ANSI SGR (Select Graphic Rendition) wrappers, direct port of
 * `laravel/prompts`' `Concerns/Colors.php`. No external color library
 * (no `chalk`/`picocolors`); the rest of the monorepo doesn't depend on
 * one either, and these wrappers are simple enough not to warrant one.
 *
 * Every wrapper is a no-op (returns the text unchanged) when colour is
 * disabled, piped output, `NO_COLOR`, a non-TTY (see `colorsEnabled()`),
 * so redirecting the CLI to a file or a CI log does not produce `^[[90m`
 * escape garbage.
 */
import { colorsEnabled } from "../context.js";

/** Wrap `text` in the given SGR open/close codes, unless colour is disabled. */
function sgr(open: number, close: number, text: string): string {
  if (!colorsEnabled()) {
    return text;
  }

  return `\x1b[${open}m${text}\x1b[${close}m`;
}

export function bold(text: string): string {
  return sgr(1, 22, text);
}

export function dim(text: string): string {
  return sgr(2, 22, text);
}

export function italic(text: string): string {
  return sgr(3, 23, text);
}

export function underline(text: string): string {
  return sgr(4, 24, text);
}

export function inverse(text: string): string {
  return sgr(7, 27, text);
}

export function strikethrough(text: string): string {
  return sgr(9, 29, text);
}

export function black(text: string): string {
  return sgr(30, 39, text);
}

export function red(text: string): string {
  return sgr(31, 39, text);
}

export function green(text: string): string {
  return sgr(32, 39, text);
}

export function yellow(text: string): string {
  return sgr(33, 39, text);
}

export function blue(text: string): string {
  return sgr(34, 39, text);
}

export function magenta(text: string): string {
  return sgr(35, 39, text);
}

export function cyan(text: string): string {
  return sgr(36, 39, text);
}

export function white(text: string): string {
  return sgr(37, 39, text);
}

export function gray(text: string): string {
  return sgr(90, 39, text);
}

export function bgBlack(text: string): string {
  return sgr(40, 49, text);
}

export function bgRed(text: string): string {
  return sgr(41, 49, text);
}

export function bgGreen(text: string): string {
  return sgr(42, 49, text);
}

export function bgYellow(text: string): string {
  return sgr(43, 49, text);
}

export function bgBlue(text: string): string {
  return sgr(44, 49, text);
}

export function bgMagenta(text: string): string {
  return sgr(45, 49, text);
}

export function bgCyan(text: string): string {
  return sgr(46, 49, text);
}

export function bgWhite(text: string): string {
  return sgr(47, 49, text);
}

export type ColorFn = (text: string) => string;

/**
 * Named lookup for renderers that need to pick a color by state (e.g.
 * "gray" for idle, "yellow" for error), replaces PHP's dynamic
 * `$this->{$colorName}(...)` method-name dispatch, which has no clean
 * TypeScript equivalent.
 */
export const colorByName: Record<"gray" | "cyan" | "yellow" | "red" | "green", ColorFn> = {
  gray,
  cyan,
  yellow,
  red,
  green,
};
