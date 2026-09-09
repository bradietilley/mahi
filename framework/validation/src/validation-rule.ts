/**
 * Custom validation rule — one interface, async-capable, with explicit
 * `pass()` / `fail(message)` rather than Laravel's three historical
 * Rule / InvokableRule / ValidationRule shapes.
 *
 *   class ValidPostTitle extends ValidationRule {
 *     run(attribute: string, value: unknown): this {
 *       if (typeof value === "string" && value.includes("spam")) {
 *         return this.fail("The title looks like spam.");
 *       }
 *       return this.pass();
 *     }
 *   }
 */
export abstract class ValidationRule {
  private _failed = false;
  private _message: string | undefined;

  abstract run(attribute: string, value: unknown): this | Promise<this>;

  pass(): this {
    this._failed = false;
    this._message = undefined;

    return this;
  }

  fail(message: string): this {
    this._failed = true;
    this._message = message;

    return this;
  }

  failed(): boolean {
    return this._failed;
  }

  message(): string | undefined {
    return this._message;
  }

  /** Reset pass/fail state so a single instance can be reused across fields. */
  reset(): this {
    this._failed = false;
    this._message = undefined;

    return this;
  }

  /**
   * Produce a fresh instance with the same configuration but clean
   * pass/fail state. Used to isolate a module-scope rule from concurrent
   * validations: each `Validator` clones the rules it's handed, so an
   * `await` inside one `run()` can't observe another request's state.
   * Constructor-set config (own enumerable properties) is copied; the
   * internal `_failed`/`_message` flags are reset.
   */
  clone(): this {
    const copy = Object.create(Object.getPrototypeOf(this)) as this;
    Object.assign(copy, this);
    copy.reset();

    return copy;
  }
}
