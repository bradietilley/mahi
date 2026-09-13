import { Auth } from "@mahiframework/auth";
import { Controller, HttpResponse } from "@mahiframework/http";
import type { User } from "../../models/user.model.js";
import { UserResource } from "../resources/user.resource.js";

/** GET /auth/me, the currently authenticated user. */
export class MeController extends Controller {
  async handle() {
    const user = Auth.user<User>();

    return HttpResponse.json(new UserResource(user).toJson());
  }
}
