/**
 * Strips ANSI escape sequences from a string — used for display-width
 * measurement (colored text must not count its escape codes as visible
 * characters) and for normalizing captured output in tests.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*\x07/g, "") // OSC sequences (e.g. hyperlinks)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); // CSI sequences (SGR colors, cursor movement, erase)
}
