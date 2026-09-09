/** Raw ANSI escape codes for cursor movement/visibility. */

export function hideCursor(): string {
  return "\x1b[?25l";
}

export function showCursor(): string {
  return "\x1b[?25h";
}

/** Moves the cursor to the given 1-indexed column on the current line. */
export function moveCursorToColumn(column: number): string {
  return `\x1b[${column}G`;
}

/** Moves the cursor up `lines` rows. A no-op (empty string) when `lines <= 0`. */
export function moveCursorUp(lines: number): string {
  return lines > 0 ? `\x1b[${lines}A` : "";
}

/** Moves the cursor down `lines` rows. A no-op (empty string) when `lines <= 0`. */
export function moveCursorDown(lines: number): string {
  return lines > 0 ? `\x1b[${lines}B` : "";
}

export function moveCursorLeft(columns: number): string {
  return columns > 0 ? `\x1b[${columns}D` : "";
}

export function moveCursorRight(columns: number): string {
  return columns > 0 ? `\x1b[${columns}C` : "";
}
