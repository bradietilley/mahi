import { cyan, dim, gray, red, strikethrough, yellow } from "./ansi/colors.js";
import { drawBox } from "./render/box.js";
import { truncate } from "./render/text-width.js";
import { InteractivePrompt } from "./prompt/interactive-prompt.js";
import { TypedValue, addCursor } from "./prompt/typed-value.js";
import { cols } from "./context.js";

export interface SecretOptions {
  placeholder?: string;
  /** `true` = required with the default "Required." message; a string = custom required-error message. */
  required?: boolean | string;
  validate?: (value: string) => string | undefined | Promise<string | undefined>;
  hint?: string;
  transform?: (value: string) => string;
}

/** Port of `laravel/prompts`' `PasswordPrompt.php` + `PasswordPromptRenderer.php`, masked (`•`) echo, otherwise identical editing behavior to `ask()`. */
class PasswordPrompt extends InteractivePrompt<string> {
  private typedValue: TypedValue;

  constructor(
    private label: string,
    private options: SecretOptions,
  ) {
    super();
    this.typedValue = new TypedValue("");
    this.required = options.required ?? false;
    this.validateFn = options.validate;

    this.onKey(async (key) => {
      const { submit } = this.typedValue.handleKey(key);

      if (submit) {
        await this.submit();
      }
    });
  }

  protected value(): string {
    const raw = this.typedValue.value;

    return this.options.transform ? this.options.transform(raw) : raw;
  }

  protected isInvalidWhenRequired(value: string): boolean {
    return value === "";
  }

  private masked(): string {
    return "•".repeat([...this.typedValue.value].length);
  }

  private maskedWithCursor(maxWidth: number): string {
    if (this.typedValue.value === "") {
      return dim(addCursor(this.options.placeholder ?? "", 0, maxWidth));
    }

    return addCursor(this.masked(), this.typedValue.cursorPosition, maxWidth);
  }

  protected renderFrame(): string {
    const terminalCols = cols();
    const maxWidth = terminalCols - 6;
    const truncatedLabel = truncate(this.label, terminalCols - 6);

    switch (this.state) {
      case "submit":
        return drawBox(
          { title: dim(truncatedLabel), body: truncate(this.masked(), maxWidth) },
          terminalCols,
        );

      case "cancel": {
        const shown = this.masked() || this.options.placeholder || "";
        const box = drawBox(
          {
            title: truncatedLabel,
            body: strikethrough(dim(truncate(shown, maxWidth))),
            color: red,
          },
          terminalCols,
        );

        return `${box}\n${red(` ⚠ ${this.cancelMessage}`)}`;
      }

      case "error": {
        const box = drawBox(
          {
            title: dim(truncatedLabel),
            body: this.maskedWithCursor(maxWidth),
            color: yellow,
          },
          terminalCols,
        );

        return `${box}\n${yellow(` ⚠ ${truncate(this.error, terminalCols - 5)}`)}`;
      }

      default: {
        const box = drawBox(
          { title: cyan(truncatedLabel), body: this.maskedWithCursor(maxWidth) },
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

export async function secret(label: string, options: SecretOptions = {}): Promise<string> {
  return new PasswordPrompt(label, options).run();
}
