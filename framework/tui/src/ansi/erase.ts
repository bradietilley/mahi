/** Raw ANSI escape codes for erasing terminal content. */

/** Erases from the cursor to the end of the current line. */
export function eraseLine(): string {
  return "\x1b[K";
}

/** Erases from the cursor to the end of the screen. */
export function eraseDown(): string {
  return "\x1b[J";
}
