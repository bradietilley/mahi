import { Request, rule } from "@mahiframework/http";

/** POST /auth/forgot-password body validation. */
export class ForgotPasswordRequest extends Request {
  rules() {
    return {
      email: rule().string().email().required(),
    } as const;
  }
}
