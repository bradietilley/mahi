import type { Context, MiddlewareHandler, Next as HonoNext } from "hono";
import { Pipeline, type Pipe, type PipeFn } from "@mahiframework/pipeline";
import { Request, requestFromContext } from "../request.js";
import type { ResponseInput } from "../response.js";
import { finalizeResponse } from "../boundary.js";

/**
 * A global HTTP middleware stage, written against `@mahiframework/pipeline`'s
 * `Pipe` shape. The passable is the framework `Request`, not Hono's
 * `Context`, app and provider code never import Hono.
 *
 *   const requestId: HttpPipe = async (request, next) => {
 *     request.share("requestId", crypto.randomUUID());
 *     const res = await next(request);
 *     res.headers.set("X-Request-Id", request.shared<string>("requestId")!);
 *     return res;
 *   };
 */
export type HttpPipe = Pipe<Request, ResponseInput>;

/**
 * The closure half of `HttpPipe`, what the middleware *factories*
 * (`trustProxies()`, `trustHosts()`, `throttle()`) actually return.
 *
 * They are declared with this rather than the wider `HttpPipe` union so a
 * caller holding the result can invoke it directly: a `PipeObject` member
 * in the union has no call signature, so `trustProxies(...)(req, next)`
 * would not typecheck even though the returned value is always a function.
 * Every `HttpPipeFn` is still an `HttpPipe`, so nothing that consumes
 * these values needs to change.
 */
export type HttpPipeFn = PipeFn<Request, ResponseInput>;

/**
 * Adapts an ordered list of `HttpPipe`s into a single Hono
 * `MiddlewareHandler`. Used by `HttpKernel` (provider `middleware()`
 * hooks) and `Router.middleware()` / `Router.use()`.
 *
 * Constructs `Request` on first encounter (eager body parse) and reuses
 * it for the rest of the call. A pipe that returns its own `Response`
 * without calling `next(request)` short-circuits.
 *
 * Accepts a **thunk** as well as an array, for a caller that must register
 * the middleware before it knows what will be in it. `HttpKernel` needs
 * exactly that: Hono's `use("*")` only applies to routes registered after
 * it, so the global slot has to be claimed in the kernel's constructor while
 * the provider pipes are not collected until `collectFromProviders()`. See
 * `HttpKernel.pipes`.
 */
export function toHonoMiddleware(pipes: HttpPipe[] | (() => HttpPipe[])): MiddlewareHandler {
  const resolve = typeof pipes === "function" ? pipes : () => pipes;

  return async (c: Context, honoNext: HonoNext) => {
    const stages = resolve();

    // Nothing to run, don't pay for a `Request` (and its eager body parse)
    // just to hand it to an empty pipeline.
    if (stages.length === 0) {
      return honoNext();
    }

    const request = await requestFromContext(c);
    const response = await new Pipeline<Request, ResponseInput>()
      .send(request)
      .through(stages)
      .run(async () => {
        await honoNext();

        return c.res;
      });

    // Writes queued cookies and merges Hono's own queued headers, then
    // publishes onto the context. A pipe that short-circuits (returning
    // without calling `next`) is finalized here too, so a cookie queued
    // before a 401 still reaches the browser.
    await finalizeResponse(c, request, response);
  };
}
