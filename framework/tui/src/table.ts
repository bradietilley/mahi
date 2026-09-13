import { dim, gray } from "./ansi/colors.js";
import { displayWidth, pad } from "./render/text-width.js";
import { writeFinishedFrame } from "./render/finished-frame.js";
import type { Output } from "./output/output.js";

/**
 * Port of `laravel/prompts`' `Table.php` + `TableRenderer.php`, the
 * one feature with no direct TS equivalent to delegate to (PHP hands
 * grid-drawing off to Symfony Console's `Table` helper). Hand-rolled
 * column-width + box-grid renderer: border set `┌ ┬ ┐ / ├ ┼ ┤ / └ ┴ ┘ /
 * ─ / │`; every column's width = max display-width across its header +
 * all rows, plus 1 space padding each side; header row is `dim`, the
 * outer border is `gray`; when `headers` is empty, the header row and
 * its divider are skipped entirely. No multi-line cell/header support.
 */
export function renderTable(headers: string[], rows: (string | number)[][]): string {
  const stringRows = rows.map((row) => row.map(String));
  const columnCount = Math.max(headers.length, ...stringRows.map((r) => r.length), 0);

  const widths = Array.from({ length: columnCount }, (_, col) =>
    Math.max(
      displayWidth(headers[col] ?? ""),
      ...stringRows.map((r) => displayWidth(r[col] ?? "")),
    ),
  );

  const border = (left: string, mid: string, right: string): string =>
    left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;

  const dataRow = (cells: string[], format: (s: string) => string): string =>
    "│" + widths.map((w, i) => ` ${format(pad(cells[i] ?? "", w))} `).join("│") + "│";

  const lines: string[] = [];
  lines.push(gray(border("┌", "┬", "┐")));

  if (headers.length > 0) {
    lines.push(dataRow(headers, dim));
    lines.push(gray(border("├", "┼", "┤")));
  }

  for (const row of stringRows) {
    lines.push(dataRow(row, (s) => s));
  }

  lines.push(gray(border("└", "┴", "┘")));

  return lines.map((l) => ` ${l}`).join("\n"); // 1-space left indent
}

export function writeTable(output: Output, headers: string[], rows: (string | number)[][]): void {
  writeFinishedFrame(output, renderTable(headers, rows));
}
