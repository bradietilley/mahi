import { MailMessage } from "@mahi/mail";

/**
 * The password-reset email.
 *
 * Yours to edit — this is scaffolded into your app, not shipped by
 * `@mahi/auth`, which has no mail dependency at all. Change the copy, the
 * theme, or replace the whole class; nothing in the framework refers to
 * it. To stop sending it entirely, set `AUTH_SEND_RESET_EMAIL=false` (see
 * `config/auth.ts`) and deliver the link yourself.
 *
 * It extends `MailMessage`, so the body is blocks rendered by a theme
 * rather than hand-written HTML. `new MailMessage("alternative")` — or a
 * `static theme` here — switches the look without touching the copy.
 */
export class ResetPasswordMail extends MailMessage {
  constructor(email: string, url: string, expiresInMinutes: number) {
    super();

    this.to(email)
      .subject("Reset your password")
      .line(
        "You are receiving this email because we received a password reset request for your account.",
      )
      .button("Reset Password", url)
      .line(`This password reset link will expire in ${expiresInMinutes} minutes.`)
      .line("If you did not request a password reset, no further action is required.")
      // The raw URL as fine print: some clients strip or mangle the
      // button, and a reset link the user cannot reach is a support ticket.
      .footer(
        "If you're having trouble with the button above, copy and paste this URL into your browser:",
      )
      .footer(url);
  }
}
