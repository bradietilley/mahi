/**
 * Key constants ported byte-for-byte from `laravel/prompts`' `Key.php`
 * (these are standard terminal escape sequences, not PHP-specific).
 */
export const Key = {
  UP: "\x1b[A",
  UP_ARROW: "\x1b[A",
  DOWN: "\x1b[B",
  DOWN_ARROW: "\x1b[B",
  RIGHT: "\x1b[C",
  RIGHT_ARROW: "\x1b[C",
  LEFT: "\x1b[D",
  LEFT_ARROW: "\x1b[D",

  // SS3 (application-mode) arrow key variants some terminals send.
  UP_ARROW_SS3: "\x1bOA",
  DOWN_ARROW_SS3: "\x1bOB",
  RIGHT_ARROW_SS3: "\x1bOC",
  LEFT_ARROW_SS3: "\x1bOD",

  HOME: "\x1b[H",
  HOME_ALT: "\x1b[1~",
  END: "\x1b[F",
  END_ALT: "\x1b[4~",

  DELETE: "\x1b[3~",
  PAGE_UP: "\x1b[5~",
  PAGE_DOWN: "\x1b[6~",

  ENTER: "\r",
  ENTER_ALT: "\n",
  TAB: "\t",
  SHIFT_TAB: "\x1b[Z",
  ESCAPE: "\x1b",
  BACKSPACE: "\x7f",
  BACKSPACE_ALT: "\x08",
  OPTION_BACKSPACE: "\x1b\x7f",

  CTRL_A: "\x01",
  CTRL_B: "\x02",
  CTRL_C: "\x03",
  CTRL_D: "\x04",
  CTRL_E: "\x05",
  CTRL_F: "\x06",
  CTRL_K: "\x0b",
  CTRL_N: "\x0e",
  CTRL_P: "\x10",
  CTRL_U: "\x15",
  CTRL_W: "\x17",
} as const;

export type KeyValue = (typeof Key)[keyof typeof Key];

/**
 * Splits a raw chunk from `process.stdin`'s `'data'` event into
 * individual key tokens (a complete escape sequence, or one printable
 * character). Node's `'data'` event may deliver multiple keystrokes (or
 * a paste burst) in a single chunk, PHP's `Terminal::read()` does one
 * blocking `fread(1024)` per key-loop iteration and doesn't need this,
 * see the plan's "Key differences" section.
 */
export function splitKeys(chunk: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < chunk.length) {
    if (chunk[i] === "\x1b") {
      if (chunk[i + 1] === "[") {
        // CSI sequence: ESC [ ... <final byte 0x40-0x7E>
        let j = i + 2;

        while (j < chunk.length && !/[\x40-\x7e]/.test(chunk[j]!)) {
          j++;
        }

        tokens.push(chunk.slice(i, j + 1));
        i = j + 1;
      } else if (chunk[i + 1] === "O") {
        // SS3 sequence (application-mode arrow keys): ESC O <letter>
        tokens.push(chunk.slice(i, i + 3));
        i += 3;
      } else if (chunk[i + 1] === "\x7f") {
        // Option+Backspace
        tokens.push(chunk.slice(i, i + 2));
        i += 2;
      } else if (i + 1 >= chunk.length) {
        tokens.push("\x1b"); // bare Escape key
        i += 1;
      } else {
        tokens.push(chunk.slice(i, i + 2)); // unrecognized ESC + 1 char, don't hang
        i += 2;
      }
    } else {
      // Iterate by codepoint (not UTF-16 code unit) so astral-plane
      // characters (e.g. emoji typed/pasted into ask()) survive as one
      // token instead of being split into two lone surrogate halves.
      const codepoint = chunk.codePointAt(i)!;
      const char = String.fromCodePoint(codepoint);
      tokens.push(char);
      i += char.length;
    }
  }

  return tokens;
}
