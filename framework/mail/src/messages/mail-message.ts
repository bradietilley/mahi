import { Mailable } from "../mailable.js";
import { Content } from "../mailables/content.js";
import { MailException } from "../mail-exception.js";
import type { MailBlock, MailMessageData, MessageLevel } from "./blocks.js";
import type { MailTheme } from "./mail-theme.js";

/**
 * Resolves a theme by name. Supplied by `MailManager` so a `MailMessage`
 * can find its theme without importing the manager (which would be a
 * cycle) and without reaching for the global `app()`.
 */
export type ThemeResolver = (name: string) => MailTheme;

let resolver: ThemeResolver | undefined;

/**
 * Bind the process-wide theme resolver. Called by `MailServiceProvider`.
 *
 * A module-level binding rather than a constructor argument because
 * `new MailMessage()` must stay callable with zero arguments from anywhere,
 * a notification's `toMail()`, a controller, a test. It mirrors how
 * `EventDispatcher.useQueuedListenerHandler()` lets the queue package fill
 * a slot the events package declared, and how facades resolve off the
 * current app: convenient by default, explicitly overridable via the
 * `theme` instance passed to the constructor when a test wants isolation.
 */
export function useThemeResolver(next: ThemeResolver | undefined): void {
  resolver = next;
}

/**
 * Fluent builder for a simple transactional email, rendered by a swappable
 * `MailTheme`.
 *
 *   await Mail.send(
 *     new MailMessage()
 *       .to(user.email, user.name)
 *       .subject("Reset your password")
 *       .greeting(`Hi ${user.name},`)
 *       .line("You are receiving this because we received a password reset request.")
 *       .button("Reset Password", url)
 *       .line("This link expires in 60 minutes."),
 *   );
 *
 * ## Why this extends `Mailable`
 *
 * In Laravel these are two unrelated types: `MailMessage` is what a
 * notification's `toMail()` returns, `Mailable` is what `Mail::send()`
 * takes, and the two have overlapping-but-different APIs for the same
 * concepts. Here `MailMessage` IS a `Mailable`, so it goes anywhere a
 * mailable goes, `Mail.send()`, a notification's `toMail()`, a test's
 * `render()`, with no adapter and one set of addressing methods.
 *
 * ## Choosing a theme
 *
 *   new MailMessage()               // the "default" theme
 *   new MailMessage("alternative")  // a theme registered under that name
 *   new MailMessage(myThemeObject)  // an ad-hoc instance, no registration
 *
 * The string form is the primary one, and it is a string for consistency:
 * every other named thing in the framework is resolved this way
 * (`Mail.mailer("smtp")`, `Cache.store("redis")`,
 * `queue.connection("redis")`), all backed by `Manager.extend()`. Themes
 * are registered from config (`mail.themes`) or from a provider via
 * `MailManager.extendTheme()`.
 *
 * A subclass may instead declare `static theme`, which is the idiom the
 * codebase already uses for class-level metadata (`Job.unique`,
 * `Notification.type`, `Model.morphName`):
 *
 *   class AlertMessage extends MailMessage {
 *     static override theme = "alert";
 *   }
 *
 * An explicit constructor argument wins over `static theme`.
 */
export class MailMessage extends Mailable {
  /**
   * Theme name used when the constructor is given none. Set on a subclass
   * to bake a theme into a family of messages.
   */
  static theme?: string;

  private readonly chosenTheme: string | MailTheme | undefined;
  private _level: MessageLevel = "info";
  private _greeting: string | undefined;
  private _salutation: string | undefined;
  private _footer: string[] = [];
  private _productName: string | undefined;
  private blocks: MailBlock[] = [];

  constructor(theme?: string | MailTheme) {
    super();
    this.chosenTheme = theme;
  }

  /** Set the message tone, which drives theme colours and the default button level. */
  level(level: MessageLevel): this {
    this._level = level;

    return this;
  }

  /** Shorthand for `level("success")`. */
  success(): this {
    return this.level("success");
  }

  /** Shorthand for `level("error")`. */
  error(): this {
    return this.level("error");
  }

  /** Opening line. Omit to accept the theme's default ("Hello!"). */
  greeting(text: string): this {
    this._greeting = text;

    return this;
  }

  /** Closing line. Omit to accept the theme's default ("Regards,"). */
  salutation(text: string): this {
    this._salutation = text;

    return this;
  }

  /** Append a paragraph of body copy. */
  line(text: string): this {
    this.blocks.push({ type: "line", text });

    return this;
  }

  /** Append several paragraphs in one call. */
  lines(texts: string[]): this {
    for (const text of texts) {
      this.line(text);
    }

    return this;
  }

  /**
   * Append a call-to-action button. `level` defaults to the message's own
   * level, so an `error()` message gets a red button without repeating it.
   */
  button(label: string, url: string, level?: MessageLevel): this {
    this.blocks.push({ type: "button", label, url, level: level ?? this._level });

    return this;
  }

  /** Alias of `button()`, matching Laravel's naming. */
  action(label: string, url: string, level?: MessageLevel): this {
    return this.button(label, url, level);
  }

  /** Append a visually set-apart block. */
  panel(text: string): this {
    this.blocks.push({ type: "panel", text });

    return this;
  }

  /** Append a table. Pass an empty `header` for a headerless table. */
  table(header: string[], rows: string[][]): this {
    this.blocks.push({ type: "table", header, rows });

    return this;
  }

  /** Append a line of de-emphasised fine print below the salutation. */
  footer(text: string): this {
    this._footer.push(text);

    return this;
  }

  /** Override the product name the theme brands with. */
  productName(name: string): this {
    this._productName = name;

    return this;
  }

  /**
   * The accumulated, theme-agnostic description of this message.
   *
   * Public so a test can assert on structure,
   * `expect(message.data().blocks).toContainEqual({ type: "button", ... })`,
   * instead of string-matching rendered HTML, which would couple the
   * test to the active theme.
   */
  data(): MailMessageData {
    return {
      level: this._level,
      greeting: this._greeting,
      salutation: this._salutation,
      blocks: [...this.blocks],
      footer: [...this._footer],
      productName: this._productName,
    };
  }

  /** Resolve the theme this message renders through. */
  theme(): MailTheme {
    const chosen = this.chosenTheme ?? (this.constructor as typeof MailMessage).theme;

    if (chosen !== undefined && typeof chosen !== "string") {
      return chosen;
    }

    if (resolver === undefined) {
      throw new MailException(
        "No mail theme resolver is bound. Register MailServiceProvider, or pass a " +
          "MailTheme instance directly: new MailMessage(new DefaultMailTheme()).",
      );
    }

    return resolver(chosen ?? "default");
  }

  /**
   * Render the accumulated blocks through the theme.
   *
   * Overriding `content()` is what makes the inherited `html()`/`text()`/
   * `view()`/`textView()` setters unreachable, the documented hazard of
   * overriding `content()`. Rather than let them silently no-op, they are
   * overridden below to throw, because a caller who reaches for `.html()`
   * on a `MailMessage` has a genuine misunderstanding about which of the
   * two body sources wins, and a thrown error answers that immediately
   * where a discarded body would surface as a blank email in production.
   */
  override content(): Content {
    const theme = this.theme();
    const data = this.data();

    return new Content({
      html: async () => (await theme.render(data)).html,
      text: async () => (await theme.render(data)).text,
    });
  }

  override html(): never {
    throw new MailException(
      "MailMessage renders its body through a MailTheme, so html() would be discarded. " +
        "Use line()/button()/panel(), or send a plain Message for a hand-written body.",
    );
  }

  override text(): never {
    throw new MailException(
      "MailMessage renders its body through a MailTheme, so text() would be discarded. " +
        "Use line()/button()/panel(), or send a plain Message for a hand-written body.",
    );
  }

  override view(): never {
    throw new MailException(
      "MailMessage renders its body through a MailTheme, so view() would be discarded. " +
        "Use line()/button()/panel(), or send a plain Message for a hand-written body.",
    );
  }

  override textView(): never {
    throw new MailException(
      "MailMessage renders its body through a MailTheme, so textView() would be discarded. " +
        "Use line()/button()/panel(), or send a plain Message for a hand-written body.",
    );
  }
}
