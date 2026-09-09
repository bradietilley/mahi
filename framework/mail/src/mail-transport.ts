import type { Address } from "./mailables/address.js";
import type { Attachment } from "./mailables/attachment.js";
import type { SentMessage } from "./sent-message.js";

/**
 * A fully-resolved, transport-ready message: the flattened output of
 * `Mailable.render()`, with every renderer thunk already awaited into a
 * concrete `html`/`text` string and every envelope field materialized.
 * This is the single value type crossing the boundary into a
 * `MailTransport` — a transport never sees a `Mailable`, only this.
 */
export interface RenderedMail {
  from?: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject: string;
  html?: string;
  text?: string;
  attachments: Attachment[];
  tags: string[];
  metadata: Record<string, string>;
  /** Extra raw headers, merged onto whatever the transport sets itself. */
  headers?: Record<string, string>;
}

/**
 * The one interface every mail driver implements — the mail analogue of
 * `CacheStore`/`QueueDriver`. Resolved by name through `MailManager`
 * (`smtp`/`log`/`array` built in, more via `MailManager.extend()`).
 *
 * `send()` is the whole contract: take a `RenderedMail`, hand it to the
 * underlying medium, resolve with a `SentMessage` describing the outcome.
 * Any driver needing async connection warm-up (an SMTP pool, say) does its
 * I/O lazily on first `send()` rather than exposing a separate connect
 * step — see the `Manager` module doc on `Connectable` for the escape
 * hatch if eager warm-up is ever genuinely needed.
 */
export interface MailTransport {
  send(message: RenderedMail): Promise<SentMessage>;
}
