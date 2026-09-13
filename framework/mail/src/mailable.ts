import { Envelope } from "./mailables/envelope.js";
import { Content } from "./mailables/content.js";
import type { Attachment } from "./mailables/attachment.js";
import type { Address } from "./mailables/address.js";
import type { RenderedMail } from "./mail-transport.js";
import { MailException } from "./mail-exception.js";
import { assertNoCrlf, assertAddressClean, assertAddressesClean } from "./sanitize.js";

/**
 * Fluent builder for a single message, the mail analogue of a queue
 * `Job`. There are two interchangeable ways to describe a message, mirror-
 * ing Laravel's modern `Mailable`:
 *
 *   1. Declarative overrides, override `envelope()` / `content()` /
 *      `attachments()` to return the objects directly. This is the usual
 *      style:
 *
 *        class WelcomeMailable extends Mailable {
 *          constructor(private user: User) { super(); }
 *          envelope() { return new Envelope({ subject: "Welcome", to: [{ address: this.user.email }] }); }
 *          content()  { return new Content({ html: () => renderWelcome(this.user) }); }
 *        }
 *
 *   2. Fluent build, override `build()` and chain the protected
 *      `to()/subject()/view()/attach()/...` setters. Handy for
 *      one-off/ad-hoc messages assembled imperatively.
 *
 * `MailManager.send()` calls `render()`, which runs `build()` (if any),
 * then reads `envelope()`/`content()`/`attachments()` and flattens them
 * (awaiting body renderer thunks) into a transport-ready `RenderedMail`.
 *
 * This is Laravel's `Illuminate\Mail\Mailable` reduced to its essential
 * shape, minus the two things that don't port cleanly:
 *   - No Blade `view(name, data)` template system. Bodies are thunks that
 *     produce the final string via whatever the app chooses.
 *   - None of the ~30 `assertXxx()` PHPUnit helpers, tests assert against
 *     an `ArrayTransport`'s captured messages with Vitest matchers instead.
 *
 * There is deliberately no `queue()` method ON THE MAILABLE. Deferring a
 * send is `MailManager.queue()`, which renders here and enqueues the
 * resulting plain-JSON `RenderedMail`, so there is no second
 * serialization mechanism and a `Mailable` never needs registering. A
 * mailable carrying a credential (a reset link, a one-time code) must not
 * be queued at all; see `MailManager.queue()`.
 */
export abstract class Mailable {
  /**
   * The envelope the fluent setters accumulate into, and the default
   * `envelope()` returns. A `Mailable` that overrides `envelope()` ignores
   * this entirely.
   */
  protected _envelope = new Envelope();

  /**
   * The content the fluent `view()/html()/text()` setters accumulate into,
   * and the default `content()` returns.
   */
  protected _content = new Content();

  protected attachmentsList: Attachment[] = [];

  /**
   * Extra headers the fluent `header()` setter accumulates into. Kept
   * beside the envelope rather than on it because these are transport-
   * level plumbing (`X-Priority`, `List-Unsubscribe`, an ESP's routing
   * header) rather than part of the message's addressing, and only the
   * `smtp` transport does anything with them.
   */
  protected headersMap: Record<string, string> = {};

  /**
   * Optional imperative build step. Override this *or* the declarative
   * `envelope()/content()/attachments()` methods, the fluent setters
   * called here mutate `_envelope`/`_content`, which the default
   * `envelope()/content()` return. Runs once, before `render()` reads the
   * envelope/content. No-op by default.
   */
  build(): void | Promise<void> {}

  /**
   * Whether this message should be sent only after the enclosing
   * `DB.transaction()` commits, Laravel's `Mailable::afterCommit()`.
   * Return `true` on a mailable that reads rows written by the transaction
   * it is sent from, so the send is held until the data is durable and
   * dropped if the transaction rolls back. Outside a transaction it sends
   * immediately. `undefined` (the default) falls back to the mail config's
   * `afterCommit`, then `false`.
   *
   *   class OrderShipped extends Mailable {
   *     override afterCommit() { return true; }
   *   }
   */
  afterCommit(): boolean | undefined {
    return undefined;
  }

  /**
   * The message envelope. Defaults to the one the fluent setters built;
   * override to return a fully-formed `Envelope` in one shot.
   */
  envelope(): Envelope {
    return this._envelope;
  }

  /**
   * The message body. Defaults to the one the fluent setters built;
   * override to return a fully-formed `Content` in one shot.
   */
  content(): Content {
    return this._content;
  }

  /**
   * The message attachments. Defaults to the ones added via `attach()`;
   * override to return the list directly.
   */
  attachments(): Attachment[] {
    return this.attachmentsList;
  }

  to(address: string, name?: string): this {
    this._envelope.to.push({ address, name });

    return this;
  }

  cc(address: string, name?: string): this {
    this._envelope.cc.push({ address, name });

    return this;
  }

  bcc(address: string, name?: string): this {
    this._envelope.bcc.push({ address, name });

    return this;
  }

  replyTo(address: string, name?: string): this {
    this._envelope.replyTo.push({ address, name });

    return this;
  }

  from(address: string, name?: string): this {
    this._envelope.from = { address, name };

    return this;
  }

  subject(text: string): this {
    this._envelope.subject = text;

    return this;
  }

  tag(name: string): this {
    this._envelope.tags.push(name);

    return this;
  }

  metadata(key: string, value: string): this {
    this._envelope.metadata[key] = value;

    return this;
  }

  /**
   * Set the HTML body via a (possibly async) renderer thunk. The thunk is
   * not invoked until `render()`, keeping construction cheap and letting an
   * app-chosen template engine be awaited.
   */
  view(render: () => string | Promise<string>): this {
    this._content.html = render;

    return this;
  }

  /** Set an already-rendered HTML body string. */
  html(html: string): this {
    this._content.html = () => html;

    return this;
  }

  /** Set the plain-text body via a renderer thunk. */
  textView(render: () => string | Promise<string>): this {
    this._content.text = render;

    return this;
  }

  /** Set an already-rendered plain-text body string. */
  text(text: string): this {
    this._content.text = () => text;

    return this;
  }

  attach(file: Attachment): this {
    this.attachmentsList.push(file);

    return this;
  }

  /**
   * Set an arbitrary header on the outgoing message.
   *
   *   new Message().header("X-Priority", "1")
   *
   * Header values are a classic injection sink, so these go through the
   * same CRLF guard as every other header field. Reaching
   * `RenderedMail.headers` any other way, building a `RenderedMail` by
   * hand and passing it to `Mail.mailer(name).send()`, bypasses
   * `validate()` entirely.
   *
   * Only the `smtp` transport forwards these. `log` and `array` ignore
   * them (they are visible on the captured `RenderedMail` in tests).
   */
  header(key: string, value: string): this {
    this.headersMap[key] = value;

    return this;
  }

  /** The extra headers. Override to return them directly, as with `attachments()`. */
  headers(): Record<string, string> {
    return this.headersMap;
  }

  /**
   * Run `build()`, then read `envelope()`/`content()`/`attachments()` and
   * flatten everything into a `RenderedMail`, awaiting the HTML/text
   * renderer thunks. `globalFrom` (from `mail.from`) is used only when the
   * envelope set no `from` of its own.
   */
  async render(globalFrom?: Address): Promise<RenderedMail> {
    await this.build();

    const envelope = this.envelope();
    const content = this.content();

    const html = content.html ? await content.html() : undefined;
    const text = content.text ? await content.text() : undefined;

    const from = envelope.from ?? globalFrom;

    this.validate(envelope, from, html, text);

    return {
      from,
      to: envelope.to,
      cc: envelope.cc,
      bcc: envelope.bcc,
      replyTo: envelope.replyTo,
      subject: envelope.subject,
      html,
      text,
      attachments: this.attachments(),
      tags: envelope.tags,
      metadata: envelope.metadata,
      headers: this.headers(),
    };
  }

  /**
   * Validate a rendered message before it reaches a transport. Two jobs:
   *
   *   1. Completeness, a message with no recipient, no subject, or no body
   *      is almost always a bug; surfacing it here as a `MailException`
   *      beats a cryptic transport error (or, with `log`/`array`, a silent
   *      send of nothing).
   *   2. Header-injection safety, reject CR/LF in every field that maps to
   *      a header (addresses, display names, subject, tags, metadata keys
   *      and values, and explicit `header()` names/values), at the
   *      framework level so `log`/`array`/future transports are as
   *      protected as `smtp` is by nodemailer.
   */
  protected validate(
    envelope: Envelope,
    from: Address | undefined,
    html: string | undefined,
    text: string | undefined,
  ): void {
    if (envelope.to.length === 0 && envelope.cc.length === 0 && envelope.bcc.length === 0) {
      throw new MailException("Mail has no recipient — set at least one to()/cc()/bcc().");
    }

    if (from === undefined) {
      throw new MailException(
        "Mail has no sender — set from() on the mailable or configure a global `mail.from`.",
      );
    }

    if (envelope.subject === "") {
      throw new MailException("Mail has no subject — call subject().");
    }

    if (html === undefined && text === undefined && this.attachments().length === 0) {
      throw new MailException("Mail has no content — set an html()/text() body or an attachment.");
    }

    assertAddressClean(from, "from");
    assertAddressesClean(envelope.to, "to");
    assertAddressesClean(envelope.cc, "cc");
    assertAddressesClean(envelope.bcc, "bcc");
    assertAddressesClean(envelope.replyTo, "reply-to");
    assertNoCrlf(envelope.subject, "subject");

    for (const tag of envelope.tags) {
      assertNoCrlf(tag, "tag");
    }

    for (const [key, value] of Object.entries(envelope.metadata)) {
      assertNoCrlf(key, "metadata key");
      assertNoCrlf(value, "metadata value");
    }

    for (const [key, value] of Object.entries(this.headers())) {
      assertNoCrlf(key, "header name");
      assertNoCrlf(value, "header value");
    }
  }
}
