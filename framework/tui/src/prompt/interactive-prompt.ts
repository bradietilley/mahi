import { hideCursor, showCursor } from "../ansi/cursor.js";
import { Key } from "../terminal/key.js";
import { renderFrame as diffRenderFrame } from "../render/frame-renderer.js";
import {
  cols,
  rows,
  createKeySource,
  getCancelHandler,
  getOutput,
  isInteractive,
} from "../context.js";
import type { KeySource } from "../terminal/raw-terminal.js";
import type { Output } from "../output/output.js";

export type PromptState = "initial" | "active" | "error" | "submit" | "cancel";

/**
 * Thrown by `InteractivePrompt.run()` in non-interactive mode
 * (`process.stdin`/`stdout` isn't a TTY, and no `Tui.interactive(true)`
 * override is set) when the default value fails validation — port of
 * PHP's `NonInteractiveValidationException` behavior in `Interactivity::
 * default()`.
 */
export class NonInteractiveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonInteractiveValidationError";
  }
}

/**
 * Abstract base every interactive prompt (`ask`, `select`) extends —
 * port of `Prompt.php`'s state machine + key loop + validation, minus
 * the PHP-only `stty`/`FormRevertedException`/theme-registry machinery
 * that has no use here (single hardcoded theme, no multi-step forms in
 * scope).
 */
export abstract class InteractivePrompt<TValue> {
  state: PromptState = "initial";
  error = "";
  cancelMessage = "Cancelled.";
  protected required: boolean | string = false;
  protected validateFn?: (value: TValue) => string | undefined | Promise<string | undefined>;

  private prevFrame = "";
  private validated = false;
  private initialNewLines = 0;
  private listeners: Array<(key: string) => void | Promise<void>> = [];
  private keySource: KeySource;
  private outputRef: Output;

  constructor() {
    this.keySource = createKeySource();
    this.outputRef = getOutput();
  }

  /** The prompt's current (untransformed) value. */
  protected abstract value(): TValue;

  /**
   * Builds the "theme" frame for the current state — the box/content,
   * without the shared blank-line-spacing wrapper (that's applied once,
   * uniformly, by this base class — see `wrapFrame()`).
   */
  protected abstract renderFrame(): string;

  protected onKey(handler: (key: string) => void | Promise<void>): void {
    this.listeners.push(handler);
  }

  /**
   * Determines whether `value` counts as "empty" for the `required`
   * check — overridable since `select`'s notion of "no value" (`null`)
   * differs from `ask`'s (`""`).
   */
  protected isInvalidWhenRequired(value: TValue): boolean {
    return value === "" || value === null || value === undefined || value === false;
  }

  protected async submit(): Promise<void> {
    await this.validate(this.value());

    if (this.state !== "error") {
      this.state = "submit";
    }
  }

  private async validate(value: TValue): Promise<void> {
    this.validated = true;

    if (this.required !== false && this.isInvalidWhenRequired(value)) {
      this.state = "error";
      this.error =
        typeof this.required === "string" && this.required.length > 0 ? this.required : "Required.";

      return;
    }

    if (!this.validateFn) {
      return;
    }

    const error = await this.validateFn(value);

    if (typeof error === "string" && error.length > 0) {
      this.state = "error";
      this.error = error;
    }
  }

  async run(): Promise<TValue> {
    this.initialNewLines = this.outputRef.newLinesWritten();

    if (!isInteractive()) {
      return this.runNonInteractive();
    }

    this.keySource.start();
    this.outputRef.writeDirectly(hideCursor());
    this.renderAndDiff();

    try {
      while (true) {
        const key = await this.keySource.nextKey();

        if (this.state === "error") {
          this.state = "active";
        }

        for (const listener of this.listeners) {
          await listener(key);
        }

        let shouldStop = false;

        if ((this.state as PromptState) === "submit") {
          shouldStop = true;
        } else if (key === Key.CTRL_C) {
          this.state = "cancel";
          shouldStop = true;
        } else if (this.validated) {
          await this.validate(this.value());
        }

        this.renderAndDiff();

        if (shouldStop) {
          break;
        }
      }
    } finally {
      this.keySource.stop();
      this.outputRef.writeDirectly(showCursor());
    }

    if ((this.state as PromptState) === "cancel") {
      getCancelHandler()();
    }

    return this.value();
  }

  private async runNonInteractive(): Promise<TValue> {
    const value = this.value();
    await this.validate(value);

    if (this.state === "error") {
      throw new NonInteractiveValidationError(this.error);
    }

    return value;
  }

  private wrapFrame(inner: string): string {
    const blankPrefix = "\n".repeat(Math.max(2 - this.initialNewLines, 0));
    const trailingNewline = this.state === "submit" || this.state === "cancel" ? "\n" : "";

    return blankPrefix + inner + trailingNewline;
  }

  private renderAndDiff(): void {
    const frame = this.wrapFrame(this.renderFrame());
    diffRenderFrame(this.outputRef, this.prevFrame, frame, rows());
    this.prevFrame = frame;
  }

  /** Convenience for subclass renderers: current terminal column count. */
  protected terminalCols(): number {
    return cols();
  }
}
