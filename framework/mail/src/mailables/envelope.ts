import type { Address } from "./address.js";

export interface EnvelopeOptions {
  from?: Address;
  to?: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address[];
  subject?: string;
  tags?: string[];
  metadata?: Record<string, string>;
}

/**
 * The "who / what subject" half of a message, everything except the body
 * and attachments. Two ways to produce one:
 *
 *   - Fluent: a `Mailable`'s `to()/cc()/subject()/...` setters accumulate
 *     into the instance the base `Mailable` holds.
 *   - Declarative: a `Mailable` overrides `envelope()` and returns
 *     `new Envelope({ subject, to, ... })` in one shot, mirroring
 *     Laravel's modern `Envelope` value object.
 *
 * `Mailable.render()` reads the resulting `Envelope` and spreads it into a
 * `RenderedMail`. Mutable (not a frozen value object) so the fluent path
 * can build it incrementally; the immutability that matters is at the
 * `RenderedMail` boundary handed to a transport.
 */
export class Envelope {
  from?: Address;
  to: Address[] = [];
  cc: Address[] = [];
  bcc: Address[] = [];
  replyTo: Address[] = [];
  subject = "";

  /**
   * Arbitrary string tags (e.g. `"welcome"`, `"password-reset"`), passed
   * through to transports that understand them for categorization/analytics
   * (SMTP maps them to `X-Tag` headers; log/array drivers just carry them).
   * Mirrors Laravel's `Envelope::$tags`.
   */
  tags: string[] = [];

  /**
   * Arbitrary key/value metadata, same pass-through contract as `tags`.
   * Mirrors Laravel's `Envelope::$metadata`.
   */
  metadata: Record<string, string> = {};

  constructor(options: EnvelopeOptions = {}) {
    if (options.from) {
      this.from = options.from;
    }

    if (options.to) {
      this.to = options.to;
    }

    if (options.cc) {
      this.cc = options.cc;
    }

    if (options.bcc) {
      this.bcc = options.bcc;
    }

    if (options.replyTo) {
      this.replyTo = options.replyTo;
    }

    if (options.subject !== undefined) {
      this.subject = options.subject;
    }

    if (options.tags) {
      this.tags = options.tags;
    }

    if (options.metadata) {
      this.metadata = options.metadata;
    }
  }
}
