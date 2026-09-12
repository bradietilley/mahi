import { MailMessage } from "@mahiframework/mail";

/**
 * The email-verification email.
 *
 * Yours to edit, like `ResetPasswordMail` — scaffolded into your app, not
 * shipped by the framework. Set `AUTH_SEND_VERIFY_EMAIL=false` to stop
 * sending it and deliver the link yourself.
 */
export class VerifyEmailMail extends MailMessage {
  constructor(email: string, url: string, expiresInMinutes: number) {
    super();

    this.to(email)
      .subject("Verify your email address")
      .line(
        "Thanks for signing up! Please confirm your email address by clicking the button below.",
      )
      .button("Verify Email Address", url)
      .line(`This verification link will expire in ${expiresInMinutes} minutes.`)
      .line("If you did not create an account, no further action is required.")
      .footer(
        "If you're having trouble with the button above, copy and paste this URL into your browser:",
      )
      .footer(url);
  }
}
