import { afterCommit, inTransaction, type Application } from "@mahiframework/core";
import { MailManager, type MailConfig, type QueueMailOptions } from "./mail-manager.js";
import type { Mailable } from "./mailable.js";
import type { SentMessage } from "./sent-message.js";

/** A `Mailable` subclass constructor, for asserting by class. */
export type MailableClass<M extends Mailable = Mailable> = abstract new (...args: never[]) => M;

/**
 * The mail equivalent of Laravel's `Mail::fake()`.
 *
 * A drop-in `MailManager` subclass that **records** every `send()` call and
 * then **suppresses** the real delivery. No transport is resolved, nothing
 * leaves the process. Because a transport only ever sees the flattened
 * `RenderedMail` (the `Mailable` class identity is lost at that boundary),
 * the fake has to intercept at `send(mailable)` and keep the actual
 * `Mailable` instances so `assertSent(WelcomeMailable)` can match by class.
 *
 * Swap it in for the real manager for a test run (see `@mahiframework/testing`'s
 * `createTestApplication({ fakeMail: true })`), then assert:
 *
 *   mail.assertSent(WelcomeMailable);
 *   mail.assertSent(WelcomeMailable, (m) => m.envelope().to[0]?.address === user.email);
 *   mail.assertNotSent(PasswordResetMailable);
 *   expect(mail.sent(WelcomeMailable)).toHaveLength(1);
 *
 * Assertions throw a plain `Error` on failure rather than using a vitest
 * matcher, keeping this package free of any test-runner dependency.
 */
export class RecordingMailManager extends MailManager {
  private recorded: Mailable[] = [];
  private queuedMailables: Mailable[] = [];

  constructor(app: Application, config: MailConfig) {
    super(app, config);
  }

  /**
   * Record the mailable and return a synthetic `SentMessage` without
   * resolving a transport, rendering, or validating, deliberately: a
   * fake proves the *intent* to send, so it must accept a half-built
   * mailable (no body, no global `mail.from`) that `render()` would
   * rightly reject. `build()` is still run so the envelope's
   * recipients/subject are populated for `assertSent` predicates.
   */
  override async send(mailable: Mailable, _options?: { mailer?: string }): Promise<SentMessage> {
    await mailable.build();

    const envelope = mailable.envelope();

    // Defer the recording the way the real manager defers the send, so a
    // test can prove a rolled-back transaction recorded nothing. The
    // synthetic result is returned now (the transport never runs anyway).
    if (this.shouldSendAfterCommit(mailable) && inTransaction()) {
      await afterCommit(() => void this.recorded.push(mailable));
      const recipients = [...envelope.to, ...envelope.cc, ...envelope.bcc].map((a) => a.address);

      return {
        messageId: "fake-deferred",
        original: {
          from: envelope.from,
          to: envelope.to,
          cc: envelope.cc,
          bcc: envelope.bcc,
          replyTo: envelope.replyTo,
          subject: envelope.subject,
          attachments: mailable.attachments(),
          tags: envelope.tags,
          metadata: envelope.metadata,
        },
        accepted: recipients,
        rejected: [],
        deferred: true,
      };
    }

    this.recorded.push(mailable);
    const recipients = [...envelope.to, ...envelope.cc, ...envelope.bcc].map((a) => a.address);

    return {
      messageId: `fake-${this.recorded.length}`,
      // A minimal `RenderedMail`-shaped echo; the transport was never
      // reached, so there is no fully-rendered body here.
      original: {
        from: envelope.from,
        to: envelope.to,
        cc: envelope.cc,
        bcc: envelope.bcc,
        replyTo: envelope.replyTo,
        subject: envelope.subject,
        attachments: mailable.attachments(),
        tags: envelope.tags,
        metadata: envelope.metadata,
      },
      accepted: recipients,
      rejected: [],
    };
  }

  /**
   * Record a queued send exactly like an immediate one.
   *
   * `assertSent()` deliberately matches both: a test asserting "the
   * welcome email went out" should not break because the app switched
   * `send()` to `queue()`, which is a delivery-mechanism change and not a
   * behaviour change. Use `queued()` / `assertQueued()` when the
   * distinction is what's under test.
   *
   * Like `send()`, this skips `render()`, so a mailable that would fail
   * the real `queue()`'s in-memory-attachment guard still records here. A
   * fake proves intent; it is not a validation harness.
   */
  override async queue(mailable: Mailable, _options?: QueueMailOptions): Promise<void> {
    await mailable.build();

    this.queuedMailables.push(mailable);
    this.recorded.push(mailable);
  }

  /** Every mailable passed to `queue()`, in call order. */
  queued<M extends Mailable>(
    mailableClass?: MailableClass<M>,
    filter?: (mailable: M) => boolean,
  ): M[] {
    let matches = (
      mailableClass === undefined
        ? this.queuedMailables
        : this.queuedMailables.filter((m) => m instanceof mailableClass)
    ) as M[];

    if (filter) {
      matches = matches.filter(filter);
    }

    return matches;
  }

  /** Assert a mailable of `mailableClass` was QUEUED (not merely sent). Throws on failure. */
  assertQueued<M extends Mailable>(
    mailableClass: MailableClass<M>,
    filter?: (mailable: M) => boolean,
  ): void {
    if (this.queued(mailableClass, filter).length === 0) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected mailable [${mailableClass.name}] to have been queued${detail}, but it was not. ` +
          `Queued mailables: ${this.describe(this.queuedMailables)}.`,
      );
    }
  }

  /** Assert a mailable of `mailableClass` was never queued. Throws on failure. */
  assertNotQueued<M extends Mailable>(
    mailableClass: MailableClass<M>,
    filter?: (mailable: M) => boolean,
  ): void {
    if (this.queued(mailableClass, filter).length > 0) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected mailable [${mailableClass.name}] not to have been queued${detail}, but it was.`,
      );
    }
  }

  /**
   * Every recorded mailable of type `mailableClass`, in send order (all
   * recorded mailables when called with no argument). Optionally filtered
   * by a predicate on the mailable instance.
   */
  sent<M extends Mailable>(
    mailableClass?: MailableClass<M>,
    filter?: (mailable: M) => boolean,
  ): M[] {
    let matches = (
      mailableClass === undefined
        ? this.recorded
        : this.recorded.filter((m) => m instanceof mailableClass)
    ) as M[];

    if (filter) {
      matches = matches.filter(filter);
    }

    return matches;
  }

  /** Whether a mailable of `mailableClass` was sent (optionally matching `filter`). */
  hasSent<M extends Mailable>(
    mailableClass: MailableClass<M>,
    filter?: (mailable: M) => boolean,
  ): boolean {
    return this.sent(mailableClass, filter).length > 0;
  }

  /**
   * Assert a mailable of `mailableClass` was sent at least once. With a
   * `filter`, at least one matching mailable must exist. Throws on failure.
   */
  assertSent<M extends Mailable>(
    mailableClass: MailableClass<M>,
    filter?: (mailable: M) => boolean,
  ): void {
    if (!this.hasSent(mailableClass, filter)) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected mailable [${mailableClass.name}] to have been sent${detail}, but it was not. ` +
          `Sent mailables: ${this.describeSent()}.`,
      );
    }
  }

  /**
   * Assert a mailable of `mailableClass` was never sent. With a `filter`,
   * assert no *matching* mailable exists. Throws on failure.
   */
  assertNotSent<M extends Mailable>(
    mailableClass: MailableClass<M>,
    filter?: (mailable: M) => boolean,
  ): void {
    if (this.hasSent(mailableClass, filter)) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected mailable [${mailableClass.name}] not to have been sent${detail}, but it was.`,
      );
    }
  }

  /**
   * Assert a mailable of `mailableClass` was sent exactly `times` times
   * (optionally counting only mailables matching `filter`). Throws on
   * failure.
   */
  assertSentTimes<M extends Mailable>(
    mailableClass: MailableClass<M>,
    times: number,
    filter?: (mailable: M) => boolean,
  ): void {
    const actual = this.sent(mailableClass, filter).length;

    if (actual !== times) {
      const detail = filter ? " matching the given filter" : "";
      throw new Error(
        `Expected mailable [${mailableClass.name}] to have been sent ${times} time(s)${detail}, ` +
          `but it was sent ${actual} time(s).`,
      );
    }
  }

  /** Assert nothing at all was sent. Throws on failure. */
  assertNothingSent(): void {
    if (this.recorded.length > 0) {
      throw new Error(`Expected no mail to have been sent, but found: ${this.describeSent()}.`);
    }
  }

  /** Discard all recorded mailables, handy from a `beforeEach()` for per-test isolation. */
  reset(): void {
    this.recorded = [];
    this.queuedMailables = [];
  }

  private describeSent(): string {
    return this.describe(this.recorded);
  }

  private describe(mailables: Mailable[]): string {
    if (mailables.length === 0) {
      return "(none)";
    }

    return mailables.map((m) => m.constructor.name).join(", ");
  }
}
