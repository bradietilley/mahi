import { stripAnsi } from "../ansi/strip.js";

export { stripAnsi };

/**
 * Ranges of Unicode codepoints considered "wide" (occupy two terminal
 * columns) under East Asian Width (`W`/`F` categories), CJK
 * ideographs/punctuation, Hangul syllables, fullwidth forms, common
 * emoji blocks. This is a minimal, hand-rolled table (not the full
 * Unicode East-Asian-Width database PHP's `mb_strwidth()` uses),
 * covers the common cases (CJK text, most emoji) but isn't exhaustive.
 *
 * KNOWN LIMITATION: uncommon wide characters outside these ranges will
 * be measured as width 1 instead of 2, which can throw off box/table
 * alignment by a column or two. The tradeoff is deliberate (no new runtime
 * dependency vs. a small `string-width`-style package), revisit if this
 * causes real bugs.
 */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals, Kangxi Radicals, CJK Symbols and Punctuation
  [0x3041, 0x33ff], // Hiragana .. CJK Compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi Syllables and Radicals
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth Signs
  [0x1f300, 0x1f64f], // Misc Symbols and Pictographs, Emoticons
  [0x1f900, 0x1f9ff], // Supplemental Symbols and Pictographs
  [0x20000, 0x3fffd], // CJK Unified Ideographs Extension B..
];

/**
 * Combining marks (zero display width). A minimal set covering common
 * combining diacriticals; not the full Unicode combining-class table.
 */
function isCombiningMark(codepoint: number): boolean {
  return (
    (codepoint >= 0x0300 && codepoint <= 0x036f) || // Combining Diacritical Marks
    (codepoint >= 0x200b && codepoint <= 0x200f) || // zero-width space/joiners/marks
    (codepoint >= 0xfe00 && codepoint <= 0xfe0f) || // variation selectors
    codepoint === 0x00ad // soft hyphen
  );
}

function isWide(codepoint: number): boolean {
  for (const [start, end] of WIDE_RANGES) {
    if (codepoint >= start && codepoint <= end) {
      return true;
    }
  }

  return false;
}

/**
 * Computes the on-screen width of `text` in terminal columns: ANSI
 * escape sequences and combining marks count as 0, wide (CJK/emoji)
 * codepoints count as 2, everything else counts as 1.
 */
export function displayWidth(text: string): number {
  const stripped = stripAnsi(text);
  let width = 0;

  for (const char of stripped) {
    const codepoint = char.codePointAt(0)!;

    if (isCombiningMark(codepoint)) {
      continue;
    }

    width += isWide(codepoint) ? 2 : 1;
  }

  return width;
}

/**
 * Truncates `text` to fit within `width` display columns, appending an
 * ellipsis (`…`) when truncation occurs. ANSI-aware only in that it
 * measures via `displayWidth`, does not attempt to preserve/re-close
 * SGR codes mid-truncation (renderers using this apply color after
 * truncating, not before).
 */
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) {
    return text;
  }

  if (width <= 0) {
    return "";
  }

  const stripped = stripAnsi(text);
  let result = "";
  let currentWidth = 0;

  for (const char of stripped) {
    const codepoint = char.codePointAt(0)!;
    const charWidth = isCombiningMark(codepoint) ? 0 : isWide(codepoint) ? 2 : 1;

    if (currentWidth + charWidth > width - 1) {
      break;
    }

    result += char;
    currentWidth += charWidth;
  }

  return `${result}…`;
}

/**
 * Right-pads `text` with `char` until it reaches `width` display
 * columns (measuring via `displayWidth`, so ANSI codes in `text` don't
 * count against the padding). No-op if `text` is already `>= width`.
 */
export function pad(text: string, width: number, char = " "): string {
  const currentWidth = displayWidth(text);

  return currentWidth >= width ? text : text + char.repeat(width - currentWidth);
}

/**
 * Returns the display width of the widest string in `texts`. Convenience
 * used by box/table renderers to compute column widths.
 */
export function longestWidth(texts: string[]): number {
  return texts.reduce((max, text) => Math.max(max, displayWidth(text)), 0);
}
