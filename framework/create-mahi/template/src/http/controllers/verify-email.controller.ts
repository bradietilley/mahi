import { Auth } from "@mahiframework/auth";
import { Controller, HttpError, HttpResponse } from "@mahiframework/http";
import type { Request } from "@mahiframework/http";

/**
 * GET /auth/verify-email?id=&hash=&expires=&signature=
 *
 * The route carries `validateSignature()`, which rejects a tampered or
 * expired link before this runs — so by the time we get here the URL is
 * known-authentic and only the two things a signature *cannot* prove are
 * left to check: that the user still exists, and that the address hasn't
 * changed since the link was issued. The broker does both.
 *
 * This endpoint is intentionally unauthenticated. The signature is the
 * credential — requiring a session too would break the common case of
 * clicking the link in a mail client that isn't logged in.
 */
export class VerifyEmailController extends Controller {
  async handle(request: Request) {
    const id = request.query("id");
    const hash = request.query("hash");

    if (id === undefined || hash === undefined) {
      throw new HttpError(422, "This verification link is malformed.");
    }

    const result = await Auth.verificationBroker().verify(id, hash);

    if (result.status === "verified") {
      return HttpResponse.json({ message: "Your email address has been verified." });
    }

    if (result.status === "already-verified") {
      return HttpResponse.json({ message: "Your email address is already verified." });
    }

    // A valid signature over a stale or mismatched payload — the address was
    // changed after the link was issued, or the account is gone.
    throw new HttpError(422, "This verification link is no longer valid.");
  }
}
