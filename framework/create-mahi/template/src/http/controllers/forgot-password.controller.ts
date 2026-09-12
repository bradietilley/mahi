import { Auth, PasswordResetToken } from "@mahiframework/auth";
import { app } from "@mahiframework/core";
import { Controller, HttpResponse, signedUrl } from "@mahiframework/http";
import { Mail } from "@mahiframework/mail";
import { ResetPasswordMail } from "../../mail/reset-password.mail.js";
import { ForgotPasswordRequest } from "../requests/forgot-password.request.js";

/**
 * POST /auth/forgot-password
 *
 * Mints a reset token and emails the link.
 *
 * ## Why this sends synchronously
 *
 * `sendResetLink()` returns the raw token exactly once — only its argon2
 * hash is stored, so the plaintext is unrecoverable afterwards. Queueing
 * the send would therefore write a live credential into the `jobs` table,
 * and into `failed_jobs` indefinitely if the send failed. Sending inline
 * keeps the token in memory only. The cost is that SMTP latency is in the
 * request and SMTP downtime fails it — acceptable for an endpoint this
 * infrequent, and the failure is handled below.
 *
 * ## Why the token is deleted when the send fails
 *
 * The row is written before the email goes out, so a throwing send would
 * otherwise leave a token the user never received AND start the
 * per-mailbox throttle window — locking them out of retrying for a minute
 * over a failure that was entirely ours. Deleting it first makes the retry
 * immediate.
 */
export class ForgotPasswordController extends Controller<ForgotPasswordRequest> {
  request = ForgotPasswordRequest;

  async handle(request: ForgotPasswordRequest) {
    const { email } = request.validated();

    const result = await Auth.passwordBroker().sendResetLink(email);

    if (result.status === "throttled") {
      return HttpResponse.json(
        { message: "A reset link was sent recently. Please check your inbox." },
        429,
      );
    }

    // No token means no account matched. The broker returns the same
    // "sent" status either way so this endpoint can't be used to
    // enumerate which addresses have accounts — do not branch the
    // response on it.
    if (result.token !== undefined && this.shouldSendEmail()) {
      const expiresInMinutes = app().config.get<number>("auth.passwords.expiresInMinutes", 60);
      const url = signedUrl(
        "/auth/reset-password",
        { email: result.email, token: result.token },
        { expiresInSeconds: expiresInMinutes * 60 },
      );

      try {
        await Mail.send(new ResetPasswordMail(result.email, url, expiresInMinutes));
      } catch (error) {
        await PasswordResetToken.delete(result.email);
        throw error;
      }
    }

    return HttpResponse.json({ message: "If that account exists, a reset link has been sent." });
  }

  /** `AUTH_SEND_RESET_EMAIL=false` hands delivery back to the app. */
  private shouldSendEmail(): boolean {
    return app().config.get<boolean>("auth.notifications.resetPassword", true);
  }
}
