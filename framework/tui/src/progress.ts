import { cyan, dim, gray, red } from "./ansi/colors.js";
import { hideCursor, showCursor } from "./ansi/cursor.js";
import { drawBox } from "./render/box.js";
import { truncate } from "./render/text-width.js";
import { renderFrame as diffRenderFrame } from "./render/frame-renderer.js";
import { cols, getOutput, rows } from "./context.js";
import type { Output } from "./output/output.js";

const BAR_CHARACTER = "█";

type ProgressState = "active" | "error" | "cancel" | "submit";

/**
 * Port of `laravel/prompts`' `Progress.php` + `ProgressRenderer.php`.
 * Not keypress-driven — no raw mode, no `RawTerminal`. Ctrl+C during a
 * progress bar arrives as a real `SIGINT` (progress never enables raw
 * mode, so Node's default signal delivery just works) — mirrors PHP's
 * `pcntl_signal(SIGINT, ...)` handling.
 */
export class ProgressBar {
  progress = 0;
  state: ProgressState = "active";
  cancelMessage = "Cancelled.";
  hint: string;

  private prevFrame = "";
  private initialNewLines = 0;
  private sigintHandler?: () => void;
  private outputRef: Output;

  constructor(
    public label: string,
    public readonly total: number,
    hint = "",
  ) {
    this.hint = hint;
    this.outputRef = getOutput();
  }

  percentage(): number {
    return this.progress / this.total;
  }

  start(): void {
    this.initialNewLines = this.outputRef.newLinesWritten();
    this.outputRef.writeDirectly(hideCursor());

    this.sigintHandler = () => {
      this.state = "cancel";
      this.render();
      process.exit(130);
    };
    process.on("SIGINT", this.sigintHandler);

    this.render();
  }

  advance(step = 1): void {
    this.progress = Math.min(this.progress + step, this.total);
    this.render();
  }

  finish(): void {
    this.state = "submit";
    this.render();

    if (this.sigintHandler) {
      process.off("SIGINT", this.sigintHandler);
      this.sigintHandler = undefined;
    }

    this.outputRef.writeDirectly(showCursor());
  }

  private render(): void {
    const inner = this.renderFrame();
    const blankPrefix = "\n".repeat(Math.max(2 - this.initialNewLines, 0));
    const trailingNewline = this.state === "submit" || this.state === "cancel" ? "\n" : "";
    const frame = blankPrefix + inner + trailingNewline;

    diffRenderFrame(this.outputRef, this.prevFrame, frame, rows());
    this.prevFrame = frame;
  }

  private fractionCompleted(): string {
    return `${this.progress.toLocaleString()} / ${this.total.toLocaleString()}`;
  }

  private renderFrame(): string {
    const terminalCols = cols();
    const barWidth = Math.min(60, terminalCols - 6);
    const filled = BAR_CHARACTER.repeat(Math.ceil(this.percentage() * barWidth));
    const truncatedLabel = truncate(this.label, terminalCols - 6);

    switch (this.state) {
      case "submit":
        return drawBox(
          { title: dim(truncatedLabel), body: dim(filled), info: this.fractionCompleted() },
          terminalCols,
        );

      case "error":
        return drawBox(
          { title: truncatedLabel, body: dim(filled), color: red, info: this.fractionCompleted() },
          terminalCols,
        );

      case "cancel": {
        const box = drawBox(
          { title: truncatedLabel, body: dim(filled), color: red, info: this.fractionCompleted() },
          terminalCols,
        );

        return `${box}\n${red(` ⚠ ${this.cancelMessage}`)}`;
      }

      default: {
        const box = drawBox(
          { title: cyan(truncatedLabel), body: dim(filled), info: this.fractionCompleted() },
          terminalCols,
        );
        const hintLine = this.hint ? gray(`  ${truncate(this.hint, terminalCols - 6)}`) : "";

        return `${box}\n${hintLine}`;
      }
    }
  }
}

export function createProgress(
  label: string,
  total: number,
  options?: { hint?: string },
): ProgressBar {
  if (total <= 0) {
    throw new RangeError("Progress bar must have at least one item.");
  }

  return new ProgressBar(label, total, options?.hint ?? "");
}

/**
 * Auto-map overload — matches Laravel's `progress($label, $steps,
 * $callback)`: iterates `items`, calling `callback` once per item and
 * advancing the bar automatically, returning the collected results.
 */
export async function mapProgress<TItem, TResult>(
  label: string,
  items: TItem[] | Iterable<TItem>,
  callback: (item: TItem, bar: ProgressBar) => TResult | Promise<TResult>,
  options?: { hint?: string },
): Promise<TResult[]> {
  const list = Array.isArray(items) ? items : Array.from(items);
  const bar = createProgress(label, list.length, options);
  bar.start();

  const results: TResult[] = [];
  try {
    for (const item of list) {
      results.push(await callback(item, bar));
      bar.advance();
    }
  } catch (error) {
    bar.state = "error";
    process.stdout.write(showCursor());
    throw error;
  }

  bar.finish();

  return results;
}
