import type { Logger } from "@mahiframework/core";
import type { MailTransport, RenderedMail } from "../mail-transport.js";
import type { SentMessage } from "../sent-message.js";
import { formatAddress, formatAddressList } from "../mailables/address.js";

/**
 * Writes the rendered message to the app `Logger` instead of sending it,
 * the mail analogue of a dev-time "print, don't do it" driver. Matches
 * Laravel's `log` mailer: ideal for local development where you want to see
 * exactly what *would* have been sent (subject, recipients, body) in the
 * app log without configuring an SMTP server.
 *
 * The body is logged verbatim (text preferred, HTML as fallback) so the
 * output is a faithful preview, not a summary.
 */
export class LogTransport implements MailTransport {
  private counter = 0;

  constructor(private logger: Logger) {}

  async send(message: RenderedMail): Promise<SentMessage> {
    const body = message.text ?? message.html ?? "";

    this.logger.info(`Mail: ${message.subject}`, {
      from: message.from ? formatAddress(message.from) : undefined,
      to: formatAddressList(message.to),
      cc: message.cc.length ? formatAddressList(message.cc) : undefined,
      bcc: message.bcc.length ? formatAddressList(message.bcc) : undefined,
      body,
    });

    const recipients = [...message.to, ...message.cc, ...message.bcc].map((a) => a.address);

    return {
      messageId: `log-${++this.counter}`,
      original: message,
      accepted: recipients,
      rejected: [],
    };
  }
}
