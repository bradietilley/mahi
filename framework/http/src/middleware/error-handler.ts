import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ValidationException } from "@mahi/validation";
import { ModelNotFoundError } from "@mahi/database";
import type { Application } from "@mahi/core";
import { HttpError } from "../http-error.js";

/**
 * A predicate deciding whether a given error should be handled by a
 * registered renderer. Narrow the error type here (e.g.
 * `(err): err is DatabaseError => err instanceof DatabaseError`) so the
 * paired `ErrorRenderer` receives it already typed.
 */
export type ErrorPredicate<E extends Error = Error> = (err: Error) => err is E;

/**
 * Maps a matched error into a `Response`. Receives the Hono `Context` too,
 * for the rare renderer that needs request data — most only need the
 * error. Return a `Response` (e.g. via `c.json(...)`).
 */
export type ErrorRenderer<E extends Error = Error> = (
  err: E,
  c: Context,
) => Response | Promise<Response>;

interface RegisteredRenderer {
  predicate: (err: Error) => boolean;
  render: ErrorRenderer<any>;
}

/**
 * A registry of app-supplied `(predicate, renderer)` pairs, consulted by
 * the central error handler before its built-in `HttpError`/
 * `ValidationException` mapping. This is the extension point for shaping
 * responses from errors an app doesn't control the throw site of — e.g. a
 * third-party library's constraint-violation error that would otherwise
 * fall through to the generic 500. Renderers are tried in registration
 * order; the first whose predicate matches wins.
 *
 * Deliberately explicit and app-registered (no auto-discovery), matching
 * the framework's "no magic" stance.
 */
export class ErrorRendererRegistry {
  private renderers: RegisteredRenderer[] = [];

  /**
   * Register a renderer for errors matching `predicate`. The predicate
   * should be a type guard so `render` receives the error already typed.
   */
  register<E extends Error>(predicate: ErrorPredicate<E>, render: ErrorRenderer<E>): void {
    this.renderers.push({ predicate, render });
  }

  /** The first matching renderer for `err`, or `undefined`. */
  match(err: Error): RegisteredRenderer | undefined {
    return this.renderers.find((r) => r.predicate(err));
  }
}

/**
 * Whether to include the real error message in a generic 500 body.
 *
 * Deliberately broader than `app.isLocal()`, which is strictly
 * `=== "local"` for Laravel parity. Nothing in this framework's own
 * tooling ever produces `"local"`: `Application` seeds its environment
 * from `NODE_ENV`, and the scaffolded `config/env.ts` constrains that to
 * `development | test | production`. So the local-DX branch below was
 * unreachable in every app the framework itself generates — a developer
 * staring at "Internal Server Error" with the actual cause visible only
 * in the log.
 *
 * `production` is excluded by construction (it is not in the list), which
 * is the property that actually matters here.
 */
function showsDebugMessages(app: Application): boolean {
  return app.environment("local", "development", "dev");
}

/**
 * Central error handler: consults app-registered renderers first (see
 * `ErrorRendererRegistry`), then maps `HttpError`/`ValidationException`/
 * `ModelNotFoundError`/Hono's `HTTPException` into consistent JSON error
 * responses; anything else becomes a 500 with a generic message (the real
 * error is still logged via `app.logger`). In a local/development
 * environment the generic 500 body carries the real error message too,
 * purely for DX — never in `production`.
 *
 * The envelope mirrors Laravel: every error body carries a top-level
 * `message`; a `ValidationException` additionally carries a per-field
 * `errors` bag (`{ field: string[] }`), and an `HttpError` may carry
 * free-form `details` and response `headers`.
 */
export function createErrorHandler(
  app: Application,
  renderers: ErrorRendererRegistry = new ErrorRendererRegistry(),
): ErrorHandler {
  return async (err, c) => {
    const matched = renderers.match(err);

    if (matched) {
      return matched.render(err, c);
    }

    if (err instanceof HttpError) {
      return c.json({ message: err.message, details: err.details }, err.status as any, err.headers);
    }

    if (err instanceof ValidationException) {
      return c.json({ message: "Validation failed", errors: err.errors }, 422);
    }

    // `findOrFail()`/`firstOrFail()` in a controller means "this row is
    // required and isn't there" — a 404, exactly as Laravel's handler
    // maps `ModelNotFoundException`. Without this it fell through to the
    // generic 500, so the single most common "not found" spelling in a
    // controller reported a server fault. `request.model()` already
    // 404'd; this makes the direct call agree.
    //
    // The message is deliberately generic: the thrown one names the
    // model class and the id, which is internal detail no client needs.
    if (err instanceof ModelNotFoundError) {
      app.logger.debug("Model not found while handling request", { message: err.message });

      return c.json({ message: "Not Found" }, 404);
    }

    // Hono's own error type, thrown by its built-in middleware — most
    // importantly `bodyLimit()`, which raises a 413. Without this branch
    // an oversize body is reported to the client as a 500 "Internal
    // Server Error", i.e. as our bug rather than their request, and is
    // logged as an unhandled error on every occurrence.
    if (err instanceof HTTPException) {
      return c.json({ message: err.message || statusText(err.status) }, err.status as any);
    }

    app.logger.error("Unhandled error in HTTP request", {
      message: err.message,
      stack: err.stack,
    });

    const body = showsDebugMessages(app)
      ? { message: err.message }
      : { message: "Internal Server Error" };

    return c.json(body, 500);
  };
}

/** Fallback message for an `HTTPException` thrown without one. */
function statusText(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 413:
      return "Payload Too Large";
    case 429:
      return "Too Many Requests";
    default:
      return "Error";
  }
}
