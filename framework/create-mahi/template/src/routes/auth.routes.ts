import { authenticate } from "@mahi/auth";
import { throttle, validateSignature, type Router } from "@mahi/http";
import { RegisterController } from "../http/controllers/register.controller.js";
import { LoginController } from "../http/controllers/login.controller.js";
import { LogoutController } from "../http/controllers/logout.controller.js";
import { MeController } from "../http/controllers/me.controller.js";
import { ForgotPasswordController } from "../http/controllers/forgot-password.controller.js";
import { ResetPasswordController } from "../http/controllers/reset-password.controller.js";
import { VerifyEmailController } from "../http/controllers/verify-email.controller.js";
import { ResendVerificationController } from "../http/controllers/resend-verification.controller.js";

/**
 * Routes are registered from a provider's `routes()` hook rather than a
 * global route file, so a feature's routes live next to the rest of it.
 * See `AppServiceProvider.routes()`.
 *
 * The `throttle("login")` / `throttle("register")` names refer to rate
 * limiters registered in `AppServiceProvider.boot()`.
 */
export function registerAuthRoutes(router: Router): void {
  router.group("/auth", (auth) => {
    auth
      .post("/register", RegisterController)
      .middleware(throttle("register"))
      .name("auth.register");
    auth.post("/login", LoginController).middleware(throttle("login")).name("auth.login");
    auth.post("/logout", LogoutController).middleware(authenticate()).name("auth.logout");
    auth.get("/me", MeController).middleware(authenticate()).name("auth.me");

    // Password reset. Both are unauthenticated by necessity — the user
    // cannot log in, which is the whole problem. `throttle("passwords")`
    // limits per-IP; the broker's own `throttleSeconds` limits per-mailbox,
    // which is what stops an attacker rotating IPs to flood one inbox.
    auth
      .post("/forgot-password", ForgotPasswordController)
      .middleware(throttle("passwords"))
      .name("auth.password.forgot");
    auth
      .post("/reset-password", ResetPasswordController)
      .middleware(throttle("passwords"))
      .name("auth.password.reset");

    // Email verification. The GET carries no `authenticate()`: the
    // signature IS the credential, and requiring a session as well would
    // break clicking the link from a mail client that isn't logged in.
    auth
      .get("/verify-email", VerifyEmailController)
      .middleware(validateSignature())
      .name("auth.verification.verify");
    auth
      .post("/verify-email/resend", ResendVerificationController)
      .middleware(authenticate(), throttle("passwords"))
      .name("auth.verification.resend");
  });
}
