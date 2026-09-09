import { cyan, dim, gray, red, strikethrough, yellow } from "./ansi/colors.js";
import { drawBox } from "./render/box.js";
import { longestWidth, pad, truncate } from "./render/text-width.js";
import { InteractivePrompt } from "./prompt/interactive-prompt.js";
import { Scrolling, scrollPosition } from "./prompt/scrolling.js";
import { Key } from "./terminal/key.js";
import { cols } from "./context.js";

export interface SelectOptions<T extends string | number> {
  /** List form: the value IS the option. Record form: the key is the value, the string is the display label. */
  options: T[] | Record<string, string>;
  default?: T;
  /** Number of options visible at once before scrolling kicks in. Default 5. */
  scroll?: number;
  hint?: string;
  /** Default `true` — a select is always effectively required (there's no "no selection" state). */
  required?: boolean | string;
  validate?: (value: T) => string | undefined | Promise<string | undefined>;
}

interface NormalizedOption<T extends string | number> {
  value: T;
  label: string;
}

function normalizeOptions<T extends string | number>(
  options: T[] | Record<string, string>,
): NormalizedOption<T>[] {
  if (Array.isArray(options)) {
    return options.map((value) => ({ value, label: String(value) }));
  }

  return Object.entries(options).map(([key, label]) => ({ value: key as T, label }));
}

/** Port of `laravel/prompts`' `SelectPrompt.php` + `SelectPromptRenderer.php` + `DrawsScrollbars.php`. */
class SelectPrompt<T extends string | number> extends InteractivePrompt<T> {
  private options: NormalizedOption<T>[];
  private scrolling: Scrolling;

  constructor(
    private label: string,
    private opts: SelectOptions<T>,
  ) {
    super();
    this.options = normalizeOptions(opts.options);
    this.required = opts.required ?? true;
    this.validateFn = opts.validate;

    const scroll = Math.max(1, opts.scroll ?? 5);
    const defaultIndex =
      opts.default !== undefined ? this.options.findIndex((o) => o.value === opts.default) : -1;

    this.scrolling = new Scrolling(scroll, defaultIndex >= 0 ? defaultIndex : 0);

    if (defaultIndex >= 0) {
      this.scrolling.scrollToHighlighted(this.options.length);
    }

    this.onKey(async (key) => {
      switch (key) {
        case Key.UP:
        case Key.LEFT:
        case Key.SHIFT_TAB:
        case Key.CTRL_P:
        case "k":
        case "h":
          this.scrolling.highlightPrevious(this.options.length);
          break;
        case Key.DOWN:
        case Key.RIGHT:
        case Key.TAB:
        case Key.CTRL_N:
        case "j":
        case "l":
          this.scrolling.highlightNext(this.options.length);
          break;
        case Key.HOME:
        case Key.CTRL_A:
          this.scrolling.highlight(0);
          break;
        case Key.END:
        case Key.CTRL_E:
          this.scrolling.highlight(this.options.length - 1);
          break;
        case Key.ENTER:
        case Key.ENTER_ALT:
          await this.submit();
          break;
        default:
          break;
      }
    });
  }

  protected value(): T {
    const highlighted = this.scrolling.highlighted;

    return this.options[highlighted ?? 0]!.value;
  }

  private highlightedLabel(): string {
    const highlighted = this.scrolling.highlighted;

    return this.options[highlighted ?? 0]?.label ?? "";
  }

  protected isInvalidWhenRequired(): boolean {
    return this.scrolling.highlighted === null;
  }

  private visible(): NormalizedOption<T>[] {
    return this.options.slice(
      this.scrolling.firstVisible,
      this.scrolling.firstVisible + this.scrolling.scroll,
    );
  }

  private renderOptions(terminalCols: number): string {
    const visible = this.visible();
    const isCancel = this.state === "cancel";
    const width = Math.min(longestWidth(this.options.map((o) => o.label)) + 6, terminalCols - 6);

    const lines = visible.map((option, i) => {
      const index = this.scrolling.firstVisible + i;
      const label = truncate(option.label, terminalCols - 12);

      let line: string;

      if (isCancel) {
        line =
          this.scrolling.highlighted === index
            ? dim(`› ● ${strikethrough(label)}  `)
            : dim(`  ○ ${strikethrough(label)}  `);
      } else {
        line =
          this.scrolling.highlighted === index
            ? `${cyan("›")} ${cyan("●")} ${label}  `
            : `  ${dim("○")} ${dim(label)}  `;
      }

      return line;
    });

    return this.scrollbar(lines, width, isCancel ? "dim" : "cyan").join("\n");
  }

  /** Port of `DrawsScrollbars::scrollbar()`. */
  private scrollbar(lines: string[], width: number, color: "dim" | "cyan"): string[] {
    const total = this.options.length;
    const height = this.scrolling.scroll;

    if (height >= total) {
      return lines;
    }

    const position = scrollPosition(this.scrolling.firstVisible, height, total);
    const colorFn = color === "dim" ? dim : cyan;

    return lines.map((line, index) => {
      const padded = pad(line, width);
      const bar = index === position ? colorFn("┃") : gray("│");
      // Replace the last display character with the scrollbar glyph.
      const chars = [...padded];
      chars[chars.length - 1] = bar;

      return chars.join("");
    });
  }

  protected renderFrame(): string {
    const terminalCols = cols();
    const maxWidth = terminalCols - 6;
    const truncatedLabel = truncate(this.label, terminalCols - 6);

    switch (this.state) {
      case "submit":
        return drawBox(
          { title: dim(truncatedLabel), body: truncate(this.highlightedLabel(), maxWidth) },
          terminalCols,
        );

      case "cancel": {
        const box = drawBox(
          { title: truncatedLabel, body: this.renderOptions(terminalCols), color: red },
          terminalCols,
        );

        return `${box}\n${red(` ⚠ ${this.cancelMessage}`)}`;
      }

      case "error": {
        const box = drawBox(
          { title: truncatedLabel, body: this.renderOptions(terminalCols), color: yellow },
          terminalCols,
        );

        return `${box}\n${yellow(` ⚠ ${truncate(this.error, terminalCols - 5)}`)}`;
      }

      default: {
        const box = drawBox(
          { title: cyan(truncatedLabel), body: this.renderOptions(terminalCols) },
          terminalCols,
        );
        const hintLine = this.opts.hint
          ? gray(`  ${truncate(this.opts.hint, terminalCols - 6)}`)
          : "";

        return `${box}\n${hintLine}`;
      }
    }
  }
}

export async function select<T extends string | number>(
  label: string,
  options: SelectOptions<T>,
): Promise<T> {
  return new SelectPrompt(label, options).run();
}
