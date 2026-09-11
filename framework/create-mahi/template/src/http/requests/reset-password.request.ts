import { Request, rule } from "@mahi/http";

/** POST /auth/reset-password body validation. */
export class ResetPasswordRequest extends Request {
  rules() {
    return {
      email: rule().string().email().required(),
      token: rule().string().required().min(1),
      // Same minimum as registration — a reset must not be a way to set a
      // weaker password than signup would have allowed.
      password: rule().string().required().min(8),
    } as const;
  }
}
