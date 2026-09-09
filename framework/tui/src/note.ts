import { bgCyan, bgGreen, black, red, yellow, green } from "./ansi/colors.js";
import { displayWidth, pad } from "./render/text-width.js";
import { writeFinishedFrame } from "./render/finished-frame.js";
import type { Output } from "./output/output.js";

/**
 * Port of `laravel/prompts`' `Note.php` + `NoteRenderer.php`. No box,
 * no TTY/raw-mode interaction — the simplest feature: build the colored
 * lines, write once.
 *
 * Laravel's type set is `note | error | warning | alert | info | intro
 * | outro`. This port adds `success` (green, the natural counterpart to
 * `error` — matches the common JS-CLI convention, e.g. `ora`) and drops
 * `alert` (a second red/block variant with no clear distinct use case
 * over `error`, easy to add back if ever needed).
 */
export type NoteType = "note" | "error" | "warning" | "info" | "success" | "intro" | "outro";

function renderBlock(lines: string[], colorize: (text: string) => string): string {
  const padded = lines.map((l) => ` ${l} `);
  const width = Math.max(...padded.map(displayWidth));

  return padded.map((l) => ` ${colorize(pad(l, width))}`).join("\n");
}

export function renderNote(message: string, type: NoteType): string {
  const lines = message.split("\n");
  switch (type) {
    case "intro":
    case "outro":
      return renderBlock(lines, (l) => bgCyan(black(l)));
    case "success":
      return renderBlock(lines, (l) => bgGreen(black(l)));
    case "warning":
      return lines.map((l) => yellow(` ${l}`)).join("\n");
    case "error":
      return lines.map((l) => red(` ${l}`)).join("\n");
    case "info":
      return lines.map((l) => green(` ${l}`)).join("\n");
    default:
      return lines.map((l) => ` ${l}`).join("\n");
  }
}

/** Writes a rendered note to `output` using the shared finished-frame spacing rule. */
export function writeNote(output: Output, message: string, type: NoteType): void {
  writeFinishedFrame(output, renderNote(message, type));
}
