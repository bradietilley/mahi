import { type ColorFn, gray } from "../ansi/colors.js";
import { displayWidth, longestWidth, pad, stripAnsi, truncate } from "./text-width.js";

/**
 * Port of `laravel/prompts`' `DrawsBoxes::box()` — the routine every
 * non-`table` renderer uses to draw the `┌─title─┐ / │ body │ /
 * └─...info─┘` box every prompt lives inside.
 */
export interface BoxOptions {
  /** Title text, inlined into the top border (`┌ Title ┐`). Empty string omits the title inset. */
  title: string;
  /** Multi-line body text (may already contain ANSI codes). */
  body: string;
  /** Validation error / cancel message, rendered below a divider. */
  footer?: string;
  /** Right-aligned into the bottom border (select's hint / progress's "N / M"), truncated to fit. */
  info?: string;
  /** Border + title color. Default `gray`. */
  color?: ColorFn;
  /** Minimum box width, clamped to `terminalCols - 6`. Default 60. */
  minWidth?: number;
}

export function drawBox(options: BoxOptions, terminalCols: number): string {
  const { title, body, footer = "", info = "", color = gray, minWidth = 60 } = options;

  const effectiveMinWidth = Math.min(minWidth, terminalCols - 6);
  const bodyLines = body.split("\n");
  const footerLines = footer.split("\n").filter((line) => line !== "");

  const width = Math.max(effectiveMinWidth, longestWidth([...bodyLines, ...footerLines, title]));

  const titleLength = displayWidth(stripAnsi(title));
  const titleLabel = titleLength > 0 ? ` ${title} ` : "";
  const topBorder = "─".repeat(width - titleLength + (titleLength > 0 ? 0 : 2));

  const lines: string[] = [];
  lines.push(`${color(" ┌")}${titleLabel}${color(`${topBorder}┐`)}`);

  for (const line of bodyLines) {
    lines.push(`${color(" │")} ${pad(line, width)} ${color("│")}`);
  }

  if (footerLines.length > 0) {
    lines.push(color(` ├${"─".repeat(width + 2)}┤`));

    for (const line of footerLines) {
      lines.push(`${color(" │")} ${pad(line, width)} ${color("│")}`);
    }
  }

  let infoText = info;

  if (infoText) {
    infoText = truncate(infoText, width - 1);
  }

  const bottomRepeat = infoText ? width - displayWidth(stripAnsi(infoText)) : width + 2;
  lines.push(
    color(` └${"─".repeat(Math.max(0, bottomRepeat))}${infoText ? ` ${infoText} ` : ""}┘`),
  );

  return lines.join("\n");
}
