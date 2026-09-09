export type { Address } from "./mailables/address.js";
export { formatAddress, formatAddressList } from "./mailables/address.js";
export type { Attachment } from "./mailables/attachment.js";
export { Envelope } from "./mailables/envelope.js";
export type { EnvelopeOptions } from "./mailables/envelope.js";
export { Content } from "./mailables/content.js";
export type { ContentOptions, BodyRenderer } from "./mailables/content.js";

export type { MailTransport, RenderedMail } from "./mail-transport.js";
export type { SentMessage } from "./sent-message.js";

export { Mailable } from "./mailable.js";
export { Message } from "./message.js";

export { MailMessage, useThemeResolver } from "./messages/mail-message.js";
export type { ThemeResolver } from "./messages/mail-message.js";
export { DefaultMailTheme } from "./messages/default-mail-theme.js";
export type { MailTheme, MailThemeConfig, RenderedBody } from "./messages/mail-theme.js";
export type {
  MailBlock,
  MailMessageData,
  MessageLevel,
  LineBlock,
  ButtonBlock,
  PanelBlock,
  TableBlock,
} from "./messages/blocks.js";

export { MailException } from "./mail-exception.js";
export { assertNoCrlf, assertAddressClean, assertAddressesClean } from "./sanitize.js";
export { escapeHtml } from "./escape-html.js";

export { SmtpTransport } from "./transports/smtp-transport.js";
export type { SmtpTransportConfig } from "./transports/smtp-transport.js";
export { LogTransport } from "./transports/log-transport.js";
export { ArrayTransport } from "./transports/array-transport.js";

export { MailManager } from "./mail-manager.js";
export type {
  MailConfig,
  ThemeFactory,
  QueueMailOptions,
  QueuedMailHandler,
} from "./mail-manager.js";

export { RecordingMailManager } from "./recording-mail-manager.js";
export type { MailableClass } from "./recording-mail-manager.js";

export { MailServiceProvider, MAIL_TOKEN } from "./mail-service-provider.js";

export { Mail } from "./mail-facade.js";
