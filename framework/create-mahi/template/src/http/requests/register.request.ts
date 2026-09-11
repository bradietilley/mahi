import { Request, rule } from "@mahi/http";
import { User } from "../../models/user.model.js";

/** POST /auth/register body validation. */
export class RegisterRequest extends Request {
  rules() {
    return {
      name: rule().string().required().min(1),
      email: rule().string().email().required().unique(User, "email"),
      password: rule().string().required().min(8),
    } as const;
  }
}
