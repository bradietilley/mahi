import type { RenderedMail } from "./mail-transport.js";

/**
 * The result of a transport accepting a message for delivery — the return
 * value of `MailTransport.send()` / `MailManager.send()`.
 *
 * `messageId` is the transport-assigned identifier (SMTP's `Message-ID`
 * header, or a synthetic id for the log/array drivers). `original` is the
 * exact `RenderedMail` that was handed to the transport, retained so
 * callers (and tests inspecting an `ArrayTransport`) can assert on what was
 * actually sent without re-deriving it. `accepted`/`rejected` echo the
 * per-recipient outcome for transports that report it (SMTP does; the
 * log/array drivers treat every recipient as accepted).
 */
export interface SentMessage {
  messageId: string;
  original: RenderedMail;
  accepted: string[];
  rejected: string[];
  /**
   * `true` when the send was **deferred** until an enclosing
   * `DB.transaction()` commits (`Mailable.afterCommit()` / mail config
   * `afterCommit`) — the transport hasn't run yet, so `messageId`/
   * `accepted`/`rejected` are placeholders and only `original` is
   * meaningful. Absent (falsy) for a message that was actually sent.
   */
  deferred?: boolean;
}
