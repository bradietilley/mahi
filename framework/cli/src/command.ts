import type { Application } from "@mahi/core";
import type { Command as CommanderCommand } from "commander";
import {
  Tui,
  isInteractive,
  type AskOptions,
  type ConfirmOptions,
  type SecretOptions,
  type SelectOptions,
} from "@mahi/tui";

/**
 * Base class for CLI commands. Subclasses declare a `signature` (the
 * command name, as understood by Commander — may include `<required>`
 * and `[optional]` argument placeholders) and implement `handle()`.
 *
 * For anything beyond simple positional args (flags/options), override
 * `configure()` to add them to the underlying Commander command before it
 * is registered.
 *
 * The protected `ask`/`confirm`/`secret`/`choice`/`table`/`info`/etc.
 * methods below are thin forwarding wrappers over `@mahi/tui`'s
 * `Tui` facade — Laravel-`Command`-familiar ergonomics (`this.ask(...)`
 * instead of `Tui.ask(...)`) with zero new architecture, since `Tui`
 * already has no dependency on `@mahi/core`/the container.
 * Subclasses are free to call `Tui.*` directly instead; both are
 * equivalent.
 *
 * **Invoking one command from another** (Laravel's `$this->call(...)`):
 * there's no formal `call()`/`callSilently()` helper here — `Command`
 * instances are cheap, explicit-DI objects (`new SomeCommand(this.app)`),
 * not container-resolved singletons, so the accepted idiom is simply
 * constructing and running the other command directly, e.g.
 * `await new DbSeedCommand(this.app).handle()` (see `migrate-fresh.ts`/
 * `migrate-refresh.ts`). A formal wrapper would mostly be sugar over
 * this — not built, on purpose.
 */
export abstract class Command {
  /**
   * Mark a command as usable only from a checkout, so that a packaged or
   * compiled build does not offer it.
   *
   * Set it for anything that writes into the application's source tree
   * (`make:*`), shells out to a dev dependency (`test` → vitest), or
   * re-executes the app through a development runner (`serve` → tsx). Such a
   * command in a shipped binary is worse than absent: it appears in `--help`,
   * and then fails on a missing file the user has no reason to expect.
   *
   * Static, because the kernel filters the command *classes* before
   * constructing any of them — construction is what gives a command the
   * Application, and a command that will not run should not get one.
   *
   * See `ConsoleKernel.registeredCommands()` and `RuntimeMode`.
   */
  static devOnly = false;

  abstract signature: string;
  abstract description: string;

  constructor(protected app: Application) {}

  /** Hook to add Commander options/flags. Default: no extra options. */
  configure(program: CommanderCommand): void {
    void program;
  }

  abstract handle(...args: any[]): void | Promise<void>;

  /** Prompts for free-form text input. ≈ Laravel's `$this->ask(...)`. */
  protected ask(label: string, options?: AskOptions): Promise<string> {
    return Tui.ask(label, options);
  }

  /** Prompts for masked (password-style) input. ≈ Laravel's `$this->secret(...)`. */
  protected secret(label: string, options?: SecretOptions): Promise<string> {
    return Tui.secret(label, options);
  }

  /** Prompts for a yes/no answer. ≈ Laravel's `$this->confirm(...)`. */
  protected confirm(label: string, options?: ConfirmOptions): Promise<boolean> {
    return Tui.confirm(label, options);
  }

  /** Prompts to pick one option from a list. ≈ Laravel's `$this->choice(...)`. */
  protected choice<T extends string | number>(
    label: string,
    options: SelectOptions<T>,
  ): Promise<T> {
    return Tui.select(label, options);
  }

  /** Renders a table. ≈ Laravel's `$this->table(...)`. */
  protected table(headers: string[], rows: (string | number)[][]): void;
  protected table(rows: (string | number)[][]): void;
  protected table(
    headersOrRows: string[] | (string | number)[][],
    rows?: (string | number)[][],
  ): void {
    if (rows === undefined) {
      Tui.table(headersOrRows as (string | number)[][]);
    } else {
      Tui.table(headersOrRows as string[], rows);
    }
  }

  /** Writes a plain message line. ≈ Laravel's `$this->line(...)`. */
  protected line(message: string): void {
    Tui.note(message);
  }

  /** Writes an informational message. ≈ Laravel's `$this->info(...)`. */
  protected info(message: string): void {
    Tui.info(message);
  }

  /** Writes a success message. */
  protected success(message: string): void {
    Tui.success(message);
  }

  /** Writes a warning message. ≈ Laravel's `$this->warn(...)`. */
  protected warn(message: string): void {
    Tui.warning(message);
  }

  /** Writes an error message. ≈ Laravel's `$this->error(...)`. */
  protected error(message: string): void {
    Tui.error(message);
  }

  /**
   * The guard every destructive command asks before touching a
   * production database — Laravel's `ConfirmableTrait::confirmToProceed()`.
   *
   *   if (!(await this.confirmToProceed(options))) return;
   *
   * Returns `true` (proceed) outside production, since the whole point
   * is to protect the one environment where a mistake is unrecoverable;
   * a local `migrate:fresh` must stay a single keystroke.
   *
   * In production it returns `true` only if `--force` was passed, or the
   * operator answers yes to an interactive prompt. **Non-interactive
   * production runs therefore fail closed**: a CI job or a deploy script
   * with no TTY cannot be prompted, so it must pass `--force` to say so
   * explicitly. That is the entire safety property — an unattended
   * pipeline should never be able to drop a production schema because
   * nobody was watching the terminal.
   *
   * Interactivity is `Tui.isInteractive()` rather than a hand-rolled
   * `process.stdin.isTTY`: it also checks stdout (so `./artisan migrate |
   * tee log` is correctly treated as unattended) and honours the
   * `Tui.interactive()` override that tests use.
   *
   * The two refusal paths differ in exit code, deliberately. No TTY sets
   * `process.exitCode = 1` — nobody was asked, so the work silently not
   * happening is a failure the pipeline must see. A human answering "no"
   * leaves it 0, because that is a decision, not a fault.
   */
  protected async confirmToProceed(options: { force?: boolean } = {}): Promise<boolean> {
    if (!this.app.isProduction()) {
      return true;
    }

    if (options.force) {
      return true;
    }

    if (!isInteractive()) {
      Tui.error(
        `This command is destructive and the application is in production (APP_ENV=` +
          `${this.app.environment()}). There is no terminal to confirm on — re-run with ` +
          `--force if that is genuinely what you want.`,
      );

      // Non-zero, so a pipeline that forgot `--force` FAILS rather than
      // reporting success for work that never happened. Silently exiting 0
      // here would let a deploy continue against an unmigrated schema,
      // which is worse than the migration not running.
      process.exitCode = 1;

      return false;
    }

    Tui.warning(`The application is in production (APP_ENV=${this.app.environment()}).`);

    if (await Tui.confirm("Do you really wish to run this command?", { default: false })) {
      return true;
    }

    // A human said no. That is a deliberate decision rather than a failure,
    // so the exit code stays 0 — unlike the no-TTY branch above, where
    // nobody was asked.
    return false;
  }
}

export type CommandClass = (new (app: Application) => Command) & {
  /** See `Command.devOnly`. Optional so plain classes still satisfy the type. */
  devOnly?: boolean;
};
