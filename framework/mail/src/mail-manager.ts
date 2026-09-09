import { Manager, afterCommit, inTransaction, type Application } from "@mahi/core";
import type { MailTransport, RenderedMail } from "./mail-transport.js";
import type { SentMessage } from "./sent-message.js";
import type { Mailable } from "./mailable.js";
import { MailException } from "./mail-exception.js";
import type { MailTheme, MailThemeConfig } from "./messages/mail-theme.js";

export type ThemeFactory = (config: MailThemeConfig) => MailTheme;

/** Options `queue()` forwards to whatever enqueues the send. */
export interface QueueMailOptions {
  mailer?: string;
  delaySeconds?: number;
  connection?: string;
  queue?: string;
}

/**
 * Enqueues an already-rendered message for later delivery. Filled in by
 * `QueueServiceProvider` when `@mahi/mail` is present.
 *
 * The handler slot is the same inversion `EventDispatcher`
 * uses for queued listeners: mail declares the shape and the queue package
 * fills it, so `@mahi/mail` keeps its two-dependency footprint and an app
 * without a queue simply never binds one.
 */
export type QueuedMailHandler = (message: RenderedMail, options: QueueMailOptions) => Promise<void>;

export interface MailConfig {
  default: string;
  mailers: Record<string, unknown>;
  /**
   * Per-theme settings for `MailMessage`, keyed by theme name. The
   * `default` entry configures the theme a bare `new MailMessage()` uses.
   *
   *   themes: {
   *     default:     { productName: "Acme" },
   *     alternative: { productName: "Acme", primaryColor: "#7c3aed" },
   *   }
   *
   * A name listed here with no registered factory falls back to
   * `DefaultMailTheme` configured with these values — which is what makes
   * a second look available from config alone, with no code.
   */
  themes?: Record<string, MailThemeConfig>;
  /**
   * Optional process-wide default sender, applied by `Mailable.render()`
   * to any message that didn't set its own `from()`. Mirrors Laravel's
   * `mail.from` global — most apps set this once rather than repeating
   * `from()` in every `Mailable`.
   */
  from?: { address: string; name?: string };
  /**
   * Process-wide default for "hold the send until the enclosing
   * `DB.transaction()` commits" — Laravel's `mail.after_commit`. A
   * mailable's own `afterCommit()` overrides this; both default to sending
   * immediately.
   */
  afterCommit?: boolean;
}

/**
 * Resolves named mailers (`"smtp"`, `"log"`, `"array"`), synchronously,
 * exactly like `CacheManager`/`QueueManager`. Built-in mailers are
 * registered via `extend()` by `MailServiceProvider` — the same mechanism
 * a plugin would use to add e.g. a `"ses"` transport later.
 */
export class MailManager extends Manager<MailTransport> {
  private themeFactories = new Map<string, ThemeFactory>();
  private resolvedThemes = new Map<string, MailTheme>();
  private queuedMailHandler: QueuedMailHandler | undefined;

  constructor(
    app: Application,
    private config: MailConfig,
  ) {
    super(app);
  }

  getDefaultDriver(): string {
    return this.config.default;
  }

  /**
   * Register a `MailMessage` theme factory under a name.
   *
   * A parallel registry to `extend()` rather than a reuse of it, for the
   * same reason `AuthManager` keeps `extendUserProvider()` separate from
   * `extend()`: themes and transports are orthogonal axes that happen to
   * share an owner. A message rendered by the "alternative" theme can go
   * out through any mailer.
   *
   * The factory receives that theme's `mail.themes.<name>` config, so a
   * custom theme reads its own settings the same way a transport does.
   */
  extendTheme(name: string, factory: ThemeFactory): this {
    this.themeFactories.set(name, factory);
    this.resolvedThemes.delete(name);

    return this;
  }

  /**
   * Resolve (and cache) a theme by name.
   *
   * A name with no registered factory but a `mail.themes.<name>` config
   * entry resolves to the built-in theme configured with it. That is the
   * cheap path to a second look — a different accent colour and product
   * name is pure config — while `extendTheme()` remains there for a theme
   * that needs real code. A name with neither throws, because a silent
   * fallback to the default theme would render a message in the wrong
   * brand and look like it worked.
   */
  theme(name = "default"): MailTheme {
    const cached = this.resolvedThemes.get(name);

    if (cached !== undefined) {
      return cached;
    }

    const settings = this.config.themes?.[name];
    const factory = this.themeFactories.get(name);

    if (factory === undefined && settings === undefined && name !== "default") {
      throw new MailException(
        `Mail theme "${name}" is not registered. Add it to config/mail.ts under ` +
          `themes, or register a factory with MailManager.extendTheme("${name}", ...).`,
      );
    }

    const build = factory ?? this.themeFactories.get("default");

    if (build === undefined) {
      throw new MailException(
        `Mail theme "${name}" cannot be resolved: no default theme factory is registered.`,
      );
    }

    const theme = build(settings ?? {});
    this.resolvedThemes.set(name, theme);

    return theme;
  }

  /** Domain-flavored alias for `driver()`, mirroring `CacheManager.store()`. */
  mailer(name?: string): MailTransport {
    return this.driver(name);
  }

  mailerConfig(name: string): unknown {
    return this.config.mailers[name];
  }

  /**
   * Render a `Mailable` to a `RenderedMail` and hand it to the named (or
   * default) mailer. The one entry point application code uses:
   *
   *   await mail.send(new WelcomeMailable(user));
   *   await mail.send(new WelcomeMailable(user), { mailer: "smtp" });
   *
   * The global `config.from` default is applied here (via `render()`) so a
   * `Mailable` that omits `from()` still leaves with a sender.
   *
   * ## After-commit sending
   *
   * When the mailable's `afterCommit()` returns `true` (or the mail
   * config sets `afterCommit: true`) and a `DB.transaction()` is open, the
   * send is held until that transaction commits and dropped if it rolls
   * back. In that case this resolves with a placeholder `SentMessage`
   * (`{ deferred: true }`) rather than the transport's real result, since
   * the actual send happens later — mirroring how a deferred queue push
   * resolves before the job runs. Outside a transaction it sends
   * immediately and returns the transport's `SentMessage` as before.
   */
  async send(mailable: Mailable, options?: { mailer?: string }): Promise<SentMessage> {
    const rendered = await mailable.render(this.config.from);

    // Defer only when opted in AND a transaction is actually open — outside
    // one there is nothing to wait for, so send now and return the real
    // transport result rather than a deferred placeholder.
    if (this.shouldSendAfterCommit(mailable) && inTransaction()) {
      await afterCommit(() => void this.mailer(options?.mailer).send(rendered));

      return { messageId: "", original: rendered, accepted: [], rejected: [], deferred: true };
    }

    return this.mailer(options?.mailer).send(rendered);
  }

  /**
   * Bind the handler that enqueues a rendered message. Called by
   * `QueueServiceProvider`; apps do not call this directly.
   */
  useQueuedMailHandler(handler: QueuedMailHandler | undefined): void {
    this.queuedMailHandler = handler;
  }

  /**
   * Render a `Mailable` now and hand the result to the queue for delivery
   * later.
   *
   *   await mail.queue(new WelcomeMailable(user));
   *
   * ## Rendering happens HERE, not in the worker
   *
   * The message is rendered in the calling process and the resulting
   * `RenderedMail` — plain JSON: strings, arrays, plain objects — is what
   * gets enqueued. Laravel instead serializes the `Mailable` itself and
   * re-renders on the worker, which needs a name registry and a
   * rehydration path of its own.
   *
   * Rendering at dispatch is better on three counts. There is no second
   * serialization mechanism to learn (a `Mailable` needs no registration).
   * Validation fires at the CALL SITE, so a missing subject is a 500 in
   * your controller rather than a `failed_jobs` row at 3am. And the
   * message cannot drift: re-rendering on a worker reads rows that may
   * have changed since dispatch, which is a real source of "why did that
   * email say the old price".
   *
   * The cost is payload size — the full HTML body rides in the job row. A
   * 50KB email is a 50KB row. For bulk sending, prefer a hand-written
   * `Job` that carries an id and constructs the mailable in `handle()`.
   *
   * ## Never queue a message carrying a credential
   *
   * A queued message is written to the `jobs` table in plaintext, and to
   * `failed_jobs` indefinitely if delivery fails. Anything in the body is
   * readable by anyone with database access, for as long as the row
   * lives. That rules out password-reset links, magic links, one-time
   * codes and invitation tokens.
   *
   * This is not an argument against queueing those flows — it is an
   * argument against queueing the RENDERED MESSAGE. Queue a job that
   * carries an id, mints the credential inside `handle()`, and sends
   * immediately:
   *
   *   class SendResetLink extends Job {
   *     constructor(public readonly email: string) { super(); }
   *     async handle() {
   *       const { token } = await Auth.passwordBroker().sendResetLink(this.email);
   *       if (token) await Mail.send(new ResetPasswordMail(this.email, token));
   *     }
   *   }
   *
   * The token then exists only in the worker's memory. See
   * `docs/mail/README.md`.
   */
  async queue(mailable: Mailable, options: QueueMailOptions = {}): Promise<void> {
    if (this.queuedMailHandler === undefined) {
      throw new MailException(
        "Mail.queue() requires @mahi/queue's QueueServiceProvider to be registered. " +
          "Register it in config/app.ts, or use Mail.send() to deliver immediately.",
      );
    }

    const rendered = await mailable.render(this.config.from);

    assertQueueable(rendered);

    await this.queuedMailHandler(rendered, options);
  }

  /**
   * Whether this send waits for the enclosing transaction: the mailable's
   * own `afterCommit()` first (explicit beats config), then the mail
   * config's `afterCommit`, then `false`. `protected` so
   * `RecordingMailManager` can defer its recording the same way.
   */
  protected shouldSendAfterCommit(mailable: Mailable): boolean {
    const own = mailable.afterCommit();

    if (own !== undefined) {
      return own;
    }

    return this.config.afterCommit ?? false;
  }
}

/**
 * Reject a message the queue cannot faithfully carry.
 *
 * An attachment's `content` is a `Buffer`/`Uint8Array`, which does not
 * survive `JSON.stringify` — it becomes `{"0":137,"1":80,...}`, a
 * plain object the worker would hand to the transport as garbage. Caught
 * here with a directive message rather than base64-encoded silently,
 * because inlining bytes into a job row is a size decision the caller
 * should make knowingly: a 5MB PDF becomes a ~6.7MB row, on every retry.
 *
 * `path` attachments queue fine — the worker reads the file at send time,
 * which is also why the file must still exist then.
 */
function assertQueueable(message: RenderedMail): void {
  for (const attachment of message.attachments) {
    if (attachment.content !== undefined) {
      throw new MailException(
        `Cannot queue mail with an in-memory attachment ("${attachment.filename}"): ` +
          `binary content does not survive JSON serialization. Use a { path } attachment ` +
          `so the worker reads it at send time, or send this message immediately.`,
      );
    }
  }
}
