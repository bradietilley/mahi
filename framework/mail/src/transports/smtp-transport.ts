import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { MailTransport, RenderedMail } from "../mail-transport.js";
import type { SentMessage } from "../sent-message.js";
import { formatAddress } from "../mailables/address.js";
import type { Address } from "../mailables/address.js";
import type { Attachment } from "../mailables/attachment.js";

export interface SmtpTransportConfig {
  host: string;
  port?: number;
  /** `true` for implicit TLS (port 465); `false` for STARTTLS/plain. */
  secure?: boolean;
  auth?: { user: string; pass: string };
  /** Passed straight through to nodemailer's `createTransport`. */
  pool?: boolean;
  /**
   * Refuse to send unless the connection is encrypted.
   *
   * With `secure: false` the default behaviour is opportunistic: STARTTLS
   * is used when the server offers it and **silently skipped when it does
   * not**, so a misconfigured relay downgrades to plaintext without
   * complaint — credentials and message body included. Set this on a
   * submission port (587) to make that a hard failure instead.
   */
  requireTLS?: boolean;
  /**
   * TLS socket options, forwarded to nodemailer.
   *
   * The one that matters is `rejectUnauthorized`. It defaults to `true`,
   * which is correct; setting it to `false` disables certificate
   * verification and makes the connection trivially interceptable. It
   * exists for self-signed certificates on an internal relay — and for
   * this package's own tests — not for silencing a certificate error in
   * production.
   */
  tls?: { rejectUnauthorized?: boolean; servername?: string; ciphers?: string };
}

/**
 * The one universally-needed real-world sender — SMTP via `nodemailer`
 * (mature, connection-pooling, zero-config-friendly), `@mahiframework/mail`'s
 * single real runtime dependency (matching `better-sqlite3` in
 * `@mahiframework/database` as the "one focused dependency per package"
 * precedent).
 *
 * The nodemailer `Transporter` is created lazily on first `send()` rather
 * than in the constructor, so merely *resolving* the `smtp` mailer (which
 * `MailManager`/`Manager.driver()` does synchronously) never opens a
 * connection or pool — I/O happens only when a message is actually sent,
 * consistent with the `Manager` module's driver-resolution contract.
 */
export class SmtpTransport implements MailTransport {
  private transporter?: Transporter;

  constructor(private config: SmtpTransportConfig) {}

  private transport(): Transporter {
    if (!this.transporter) {
      const options: SMTPTransport.Options & { pool?: boolean } = {
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure,
        auth: this.config.auth,
        pool: this.config.pool,
        requireTLS: this.config.requireTLS,
        tls: this.config.tls,
      };
      this.transporter = nodemailer.createTransport(options);
    }

    return this.transporter;
  }

  async send(message: RenderedMail): Promise<SentMessage> {
    const headers: Record<string, string> = { ...message.headers };

    if (message.tags.length) {
      headers["X-Tag"] = message.tags.join(",");
    }

    for (const [key, value] of Object.entries(message.metadata)) {
      headers[`X-Metadata-${key}`] = value;
    }

    const info = await this.transport().sendMail({
      from: message.from ? formatAddress(message.from) : undefined,
      to: toNodemailer(message.to),
      cc: toNodemailer(message.cc),
      bcc: toNodemailer(message.bcc),
      replyTo: toNodemailer(message.replyTo),
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments.map(toNodemailerAttachment),
      headers,
    });

    return {
      messageId: info.messageId,
      original: message,
      accepted: (info.accepted ?? []).map(addressString),
      rejected: (info.rejected ?? []).map(addressString),
    };
  }

  /**
   * Tear down the underlying transporter, closing any pooled connections.
   *
   * Only meaningful with `pool: true`, where nodemailer keeps sockets open
   * for reuse and those sockets hold the event loop open — a short-lived
   * process (a queue worker draining, a test run) would otherwise hang
   * until they idle out. Safe and cheap to call when no transporter was
   * ever created, so callers need not track whether a send happened.
   */
  close(): void {
    this.transporter?.close();
    this.transporter = undefined;
  }
}

function toNodemailer(addresses: Address[]): { name: string; address: string }[] | undefined {
  if (!addresses.length) {
    return undefined;
  }

  return addresses.map((a) => ({ name: a.name ?? "", address: a.address }));
}

function toNodemailerAttachment(a: Attachment) {
  const content =
    a.content instanceof Uint8Array && !Buffer.isBuffer(a.content)
      ? Buffer.from(a.content)
      : a.content;

  return {
    filename: a.filename,
    content,
    path: a.path,
    contentType: a.contentType,
    cid: a.cid,
  };
}

function addressString(value: string | { address: string }): string {
  return typeof value === "string" ? value : value.address;
}
