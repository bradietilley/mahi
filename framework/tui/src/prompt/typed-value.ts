import { dim, inverse } from "../ansi/colors.js";
import { Key } from "../terminal/key.js";
import { displayWidth } from "../render/text-width.js";

/**
 * The text-input engine behind `ask()` — port of `Concerns/
 * TypedValue.php`: owns `value`/`cursorPosition`, handles arrow-key/
 * Home/End/Backspace/Delete/word-delete/printable-char editing, and
 * exposes `renderWithCursor()` (the `addCursor()` port — inverse-video
 * block cursor, left/right ellipsis when the value is wider than the
 * available box width).
 */
export class TypedValue {
  value: string;
  cursorPosition: number;

  constructor(initial = "") {
    this.value = initial;
    this.cursorPosition = [...initial].length;
  }

  /**
   * Handles one key token. Returns `true` if Enter was pressed and the
   * caller (`ask.ts`'s `TextPrompt`) should submit.
   */
  handleKey(key: string): { submit: boolean } {
    const chars = [...this.value];

    const navigationKeys: string[] = [Key.CTRL_B, Key.CTRL_F, Key.CTRL_A, Key.CTRL_E];

    if (key !== "" && (key[0] === "\x1b" || navigationKeys.includes(key))) {
      switch (key) {
        case Key.LEFT:
        case Key.LEFT_ARROW_SS3:
        case Key.CTRL_B:
          this.cursorPosition = Math.max(0, this.cursorPosition - 1);
          break;
        case Key.RIGHT:
        case Key.RIGHT_ARROW_SS3:
        case Key.CTRL_F:
          this.cursorPosition = Math.min(chars.length, this.cursorPosition + 1);
          break;
        case Key.HOME:
        case Key.HOME_ALT:
        case Key.CTRL_A:
          this.cursorPosition = 0;
          break;
        case Key.END:
        case Key.END_ALT:
        case Key.CTRL_E:
          this.cursorPosition = chars.length;
          break;
        case Key.DELETE:
          this.value = chars
            .slice(0, this.cursorPosition)
            .concat(chars.slice(this.cursorPosition + 1))
            .join("");
          break;
        case Key.OPTION_BACKSPACE:
          this.deleteWordBackward();
          break;
        default:
          break;
      }

      return { submit: false };
    }

    if (key === Key.ENTER || key === Key.ENTER_ALT) {
      return { submit: true };
    }

    if (key === Key.BACKSPACE || key === Key.BACKSPACE_ALT) {
      if (this.cursorPosition === 0) {
        return { submit: false };
      }

      const c = [...this.value];
      this.value = c
        .slice(0, this.cursorPosition - 1)
        .concat(c.slice(this.cursorPosition))
        .join("");
      this.cursorPosition--;

      return { submit: false };
    }

    const codepoint = key.codePointAt(0);

    if (codepoint !== undefined && codepoint >= 32) {
      const c = [...this.value];
      this.value = c
        .slice(0, this.cursorPosition)
        .concat([key], c.slice(this.cursorPosition))
        .join("");
      this.cursorPosition++;
    }

    return { submit: false };
  }

  private deleteWordBackward(): void {
    if (this.cursorPosition === 0) {
      return;
    }

    const start = this.findWordStartBeforeCursor();
    const chars = [...this.value];
    this.value = chars.slice(0, start).concat(chars.slice(this.cursorPosition)).join("");
    this.cursorPosition = start;
  }

  /**
   * Character offset of the word boundary immediately before the
   * cursor. Punctuation is treated as a word boundary (so
   * "word.word" deletes in two steps) — a simplified port of PHP's
   * `findWordStartBeforeCursor()` (skips the ICU `IntlBreakIterator`
   * refinement, which has no direct Node/JS equivalent without a new
   * dependency; the regex-based fallback PHP itself falls back to
   * when the `intl` extension isn't loaded is what this mirrors).
   */
  private findWordStartBeforeCursor(): number {
    const before = [...this.value].slice(0, this.cursorPosition).join("");

    if (before === "") {
      return 0;
    }

    const matches = [...before.matchAll(/(?:\p{L}\p{M}*|\p{N})+/gu)];

    if (matches.length === 0) {
      return 0;
    }

    const last = matches[matches.length - 1]!;
    const index = last.index ?? 0;

    return [...before.slice(0, index)].length;
  }

  /**
   * Renders the value with a virtual inverse-video block cursor,
   * truncating (with a dim ellipsis) on either side when the value is
   * wider than `maxWidth` — port of `TypedValue::addCursor()`.
   */
  renderWithCursor(maxWidth?: number): string {
    return addCursor(this.value, this.cursorPosition, maxWidth);
  }
}

/**
 * Renders `value` with a virtual inverse-video block cursor at
 * `cursorPosition`, truncating (with a dim ellipsis) on either side
 * when wider than `maxWidth` — exported standalone so `ask.ts` can
 * render a placeholder with the cursor pinned to position 0 without
 * constructing a full `TypedValue` instance.
 */
export function addCursor(value: string, cursorPosition: number, maxWidth?: number): string {
  const chars = [...value];
  const before = chars.slice(0, cursorPosition).join("");
  const current = chars[cursorPosition] ?? "";
  const after = chars.slice(cursorPosition + 1).join("");

  const cursorChar = current.length > 0 && current !== "\n" ? current : " ";

  const noLimit = maxWidth === undefined || maxWidth < 0;
  const spaceBefore = noLimit
    ? displayWidth(before)
    : maxWidth! - displayWidth(cursorChar) - (displayWidth(after) > 0 ? 1 : 0);

  const beforeTooWide = displayWidth(before) > spaceBefore;
  const truncatedBefore = beforeTooWide
    ? trimWidthBackwards(before, Math.max(0, spaceBefore - 1))
    : before;

  const spaceAfter = noLimit
    ? displayWidth(after)
    : maxWidth! -
      (beforeTooWide ? 1 : 0) -
      displayWidth(truncatedBefore) -
      displayWidth(cursorChar);

  const afterTooWide = displayWidth(after) > spaceAfter;
  const truncatedAfter = afterTooWide
    ? trimWidthForward(after, Math.max(0, spaceAfter - 1))
    : after;

  return (
    (beforeTooWide ? dim("…") : "") +
    truncatedBefore +
    inverse(cursorChar) +
    (current === "\n" ? "\n" : "") +
    truncatedAfter +
    (afterTooWide ? dim("…") : "")
  );
}

function trimWidthForward(text: string, width: number): string {
  let result = "";
  let w = 0;

  for (const char of text) {
    const charWidth = displayWidth(char);

    if (w + charWidth > width) {
      break;
    }

    result += char;
    w += charWidth;
  }

  return result;
}

function trimWidthBackwards(text: string, width: number): string {
  const chars = [...text];
  let result = "";
  let w = 0;

  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i]!;
    const charWidth = displayWidth(char);

    if (w + charWidth > width) {
      break;
    }

    result = char + result;
    w += charWidth;
  }

  return result;
}
