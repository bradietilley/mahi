import { Auth } from "@mahiframework/auth";
import { Controller, HttpError, HttpResponse } from "@mahiframework/http";
import { ResetPasswordRequest } from "../requests/reset-password.request.js";

/**
 * POST /auth/reset-password
 *
 * Consumes a reset token and sets the new password. A successful reset
 * also destroys every existing session and personal access token for the
 * account, password reset is the account-recovery path, so leaving an
 * attacker's existing session alive would defeat the entire exercise. The
 * broker does that; nothing is needed here.
 *
 * The user is deliberately NOT logged in afterwards. Doing so would turn
 * a leaked reset link into a session in one step, and the client has the
 * new password already. It can call `/auth/login`.
 */
export class ResetPasswordController extends Controller<ResetPasswordRequest> {
  request = ResetPasswordRequest;

  async handle(request: ResetPasswordRequest) {
    const { email, token, password } = request.validated();

    const result = await Auth.passwordBroker().reset(email, token, password);

    if (result.status === "reset") {
      return HttpResponse.json({ message: "Your password has been reset." });
    }

    if (result.status === "expired-token") {
      throw new HttpError(422, "This password reset link has expired.");
    }

    // One message for a bad token and a vanished user, so neither can be used
    // to probe which addresses have a reset pending.
    throw new HttpError(422, "This password reset link is invalid.");
  }
}
