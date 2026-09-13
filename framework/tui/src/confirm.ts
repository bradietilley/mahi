import { cyan, dim, gray, green, red, strikethrough, yellow } from "./ansi/colors.js";
import { drawBox } from "./render/box.js";
import { truncate } from "./render/text-width.js";
import { InteractivePrompt } from "./prompt/interactive-prompt.js";
import { Key } from "./terminal/key.js";
import { cols } from "./context.js";

export interface ConfirmOptions {
  default?: boolean;
  yes?: string;
  no?: string;
  hint?: string;
  /** `true` = required with the default "Required." message; a string = custom required-error message. Confirm is unusual in that it's always "answered" (true/false), so this only matters combined with `validate`. */
  required?: boolean | string;
  validate?: (value: boolean) => string | undefined | Promise<string | undefined>;
}

const TOGGLE_KEYS: string[] = [
  Key.TAB,
  Key.UP,
  Key.DOWN,
  Key.LEFT,
  Key.RIGHT,
  Key.CTRL_P,
  Key.CTRL_N,
  "h",
  "j",
  "k",
  "l",
];

/** Port of `laravel/prompts`' `ConfirmPrompt.php` + `ConfirmPromptRenderer.php`. */
class ConfirmPrompt extends InteractivePrompt<boolean> {
  private confirmed: boolean;

  constructor(
    private label: string,
    private options: ConfirmOptions,
  ) {
    super();
    this.confirmed = options.default ?? true;
    this.required = options.required ?? false;
    this.validateFn = options.validate;

    this.onKey(async (key) => {
      switch (key) {
        case "y":
        case "Y":
          this.confirmed = true;
          break;
        case "n":
        case "N":
          this.confirmed = false;
          break;
        case Key.ENTER:
        case Key.ENTER_ALT:
          await this.submit();
          break;
        default:
          if (TOGGLE_KEYS.includes(key)) {
            this.confirmed = !this.confirmed;
          }

          break;
      }
    });
  }

  protected value(): boolean {
    return this.confirmed;
  }

  private selectedLabel(): string {
    return this.confirmed ? (this.options.yes ?? "Yes") : (this.options.no ?? "No");
  }

  protected isInvalidWhenRequired(): boolean {
    // A confirm prompt always has a definite true/false answer. There's
    // no "unanswered" state the way `ask`'s empty-string or `select`'s
    // `null`-highlight represent. `required` only has teeth when paired
    // with a custom `validate` (e.g. requiring `true` specifically).
    return false;
  }

  private renderOptions(terminalCols: number): string {
    const length = Math.floor((terminalCols - 14) / 2);
    const yes = truncate(this.options.yes ?? "Yes", length);
    const no = truncate(this.options.no ?? "No", length);

    if (this.state === "cancel") {
      return this.confirmed
        ? dim(`● ${strikethrough(yes)} / ○ ${strikethrough(no)}`)
        : dim(`○ ${strikethrough(yes)} / ● ${strikethrough(no)}`);
    }

    return this.confirmed
      ? `${green("●")} ${yes} ${dim(`/ ○ ${no}`)}`
      : `${dim(`○ ${yes} /`)} ${green("●")} ${no}`;
  }

  protected renderFrame(): string {
    const terminalCols = cols();
    const truncatedLabel = truncate(this.label, terminalCols - 6);

    switch (this.state) {
      case "submit":
        return drawBox(
          { title: dim(truncatedLabel), body: truncate(this.selectedLabel(), terminalCols - 6) },
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
        const hintLine = this.options.hint
          ? gray(`  ${truncate(this.options.hint, terminalCols - 6)}`)
          : "";

        return `${box}\n${hintLine}`;
      }
    }
  }
}

export async function confirm(label: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new ConfirmPrompt(label, options).run();
}
