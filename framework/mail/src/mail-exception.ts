/**
 * A message could not be built or sent — the mail package's own error
 * type, thrown by `Mailable.render()` when a message is malformed
 * (no recipient, no subject/body, header-injection attempt) *before* it
 * reaches a transport. Framework-level validation means the same clear
 * failure surfaces for every transport (`log`/`array`/`smtp`/future),
 * not just nodemailer-specific errors for `smtp`.
 */
export class MailException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailException";
  }
}
