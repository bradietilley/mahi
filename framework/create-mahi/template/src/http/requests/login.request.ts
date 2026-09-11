import { Request, rule } from "@mahi/http";

/** POST /auth/login body validation. */
export class LoginRequest extends Request {
  rules() {
    return {
      email: rule().string().email().required(),
      // Deliberately no `.min(8)` here, unlike registration: rejecting a
      // short password at validation time tells an attacker their guess was
      // too short to be this account's password. Login validates shape only;
      // correctness is decided uniformly by Auth.attempt().
      password: rule().string().required().min(1),
    } as const;
  }
}
