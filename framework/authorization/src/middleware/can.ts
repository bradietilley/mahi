import { app } from "@mahi/core";
import { HttpError, type HttpPipe, type Request } from "@mahi/http";
import type { GateRegistry } from "../gate.js";
import type { ModelClass } from "../policy.js";
import { GATE_TOKEN } from "../tokens.js";

/**
 * Per-route authorization. The ability and model are static; the row (for
 * abilities that operate on one) is loaded by the resolver.
 *
 *   todos.post("/", createTodo).middleware(authenticate(), can("create", Todo));
 *
 * Prefer the `authorize()` helper inside the controller when the row is
 * needed by the handler anyway (`request.model()` caches on the instance).
 */
export function can(
  ability: string,
  model?: ModelClass,
  resolve?: (request: Request) => unknown | Promise<unknown>,
): HttpPipe {
  return async (request, next) => {
    const gate = app().make<GateRegistry>(GATE_TOKEN);

    const args: unknown[] = [];

    if (model !== undefined) {
      args.push(model);
    }

    if (resolve !== undefined) {
      const resolved = await resolve(request);

      // A resolver that found nothing means the row doesn't exist — 404,
      // as Laravel's implicit binding does. Passing `undefined` into the
      // policy instead produced a `TypeError` on the first property
      // access and a 500, turning "no such post" into "the server is
      // broken". Distinguished from `null`, which a resolver may return
      // deliberately for an ability that takes an optional subject.
      if (resolved === undefined) {
        throw HttpError.notFound();
      }

      args.push(resolved);
    }

    // Goes through authorize() (not a bare allows()) so a policy's rich
    // denial — custom message, or denyAsNotFound()'s 404 — is honoured
    // here too, not just when calling authorize() from a controller.
    await gate.authorize(ability, ...args);

    return next(request);
  };
}
