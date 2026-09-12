import { Auth, TokenGuard } from "@mahiframework/auth";
import { Controller, HttpResponse, type Request } from "@mahiframework/http";
import type { User } from "../../models/user.model.js";

/**
 * POST /auth/logout — revokes only the token that made this request, so
 * logging out on a phone doesn't sign you out on a laptop.
 */
export class LogoutController extends Controller {
  async handle(request: Request) {
    const guard = Auth.guard("token") as TokenGuard<User>;

    const tokenId = guard.currentTokenId(request);

    if (tokenId !== null) {
      await guard.revokeToken(tokenId);
    }

    return HttpResponse.json({ ok: true });
  }
}
