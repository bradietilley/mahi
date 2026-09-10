import { Hono, type Context, type MiddlewareHandler } from "hono";
import { Pipeline } from "@mahi/pipeline";
import { Request, requestFromContext } from "./request.js";
import { toHonoMiddleware, type HttpPipe } from "./middleware/pipeline-middleware.js";
import { toWebResponse, type ResponseInput } from "./response.js";
import { finalizeResponse } from "./boundary.js";
import {
  controllerToHandler,
  isControllerClass,
  type ControllerClass,
  type RouteHandler,
} from "./controller.js";
import { RouteRegistry } from "./route-registry.js";

export type { RouteHandler };

/** A route target: a plain handler function or a class-based controller. */
export type RouteTarget = RouteHandler | ControllerClass<any>;

/** Normalise a route target into a `RouteHandler`. */
function toRouteHandler(target: RouteTarget): RouteHandler {
  return isControllerClass(target) ? controllerToHandler(target) : target;
}

/**
 * The verbs a `Router` can register. `any` is expanded to this list when
 * mounting (Hono has no single "match every method" primitive that also
 * reports back through `hono.routes`), and `query` is the (draft) HTTP
 * QUERY method.
 */
const ANY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "QUERY"];

/**
 * Translate a framework route pattern (`/posts/{post}`, `/files/{path?}`)
 * into the Hono pattern (`/posts/:post`, `/files/:path?`). This framework
 * standardised on Laravel-style `{param}` braces, so a raw Hono `:param`
 * segment is rejected loudly rather than silently working — one syntax,
 * no ambiguity.
 */
export function translatePath(path: string): string {
  if (/(^|\/):[A-Za-z]/.test(path)) {
    throw new Error(
      `Route path "${path}" uses ":param" syntax; this framework uses "{param}" ` +
        `(e.g. "${path.replace(/(^|\/):([A-Za-z0-9_]+)/g, "$1{$2}")}").`,
    );
  }

  return path.replace(/\{([A-Za-z0-9_]+)(\?)?\}/g, (_all, name: string, optional?: string) =>
    optional ? `:${name}?` : `:${name}`,
  );
}

/**
 * A registered route, returned by `get`/`post`/… so `.middleware()` and
 * `.name()` can be chained. Middleware is stored on this object and run at
 * request time — Hono registration happens immediately with a wrapper that
 * reads `this.pipes`.
 */
export class PendingRoute {
  private pipes: HttpPipe[] = [];

  constructor(
    private handler: RouteHandler,
    private readonly methods: string[],
    /** Full path in `{param}` form, used for named-route URL generation. */
    private readonly path: string,
    private readonly registry?: RouteRegistry,
  ) {}

  middleware(...pipes: HttpPipe[]): this {
    this.pipes.push(...pipes);

    return this;
  }

  /**
   * Give this route a name so it can be resolved by `URL.route(name, …)`.
   * The name is registered into the shared `RouteRegistry` the router was
   * constructed with.
   */
  name(routeName: string): this {
    this.registry?.register(routeName, { methods: this.methods, path: this.path });

    return this;
  }

  toHonoHandler(): MiddlewareHandler {
    return async (c: Context) => {
      const request = await requestFromContext(c);
      // Convert the handler's result to a web `Response` at the innermost
      // point so route-level pipes always observe a real `Response` from
      // `next()` (e.g. reading `.status`), matching legacy behaviour. A
      // pipe that short-circuits with a framework `Response` is normalized
      // by the outer `toWebResponse`.
      const response = await new Pipeline<Request, ResponseInput>()
        .send(request)
        .through(this.pipes)
        .run(async (req) => toWebResponse(await this.handler(req)));

      // Cookies queued on the Request (by a guard, a pipe, the handler)
      // are written here, along with any headers Hono queued on the
      // context — neither survives returning a bare `Response`. See
      // `finalizeResponse`.
      return finalizeResponse(c, request, response);
    };
  }
}

/**
 * Thin typed facade over a Hono instance, passed into each provider's
 * `routes(router)` hook. Handlers take `Request`, not Hono `Context`.
 *
 * Route paths use Laravel-style `{param}` syntax; the router translates
 * them to Hono's `:param` form before mounting (see `translatePath`).
 */
export class Router {
  /**
   * @param hono      The Hono instance routes mount onto.
   * @param registry  Shared name → route table for `.name(...)`; the same
   *                  instance is threaded into every `group()` sub-router.
   * @param prefix    Path prefix accumulated by enclosing `group()` calls,
   *                  in `{param}` form, so a named route inside a group
   *                  records its full path.
   */
  /**
   * How many routes have been registered on THIS router, used only to
   * reject a too-late `middleware()` call. Counted rather than read back
   * off `hono.routes`, which also contains `use()` entries.
   */
  private registeredRoutes = 0;

  constructor(
    private hono: Hono,
    private registry?: RouteRegistry,
    private prefix = "",
  ) {}

  get(path: string, handler: RouteTarget): PendingRoute {
    return this.register(["GET"], path, handler);
  }

  post(path: string, handler: RouteTarget): PendingRoute {
    return this.register(["POST"], path, handler);
  }

  put(path: string, handler: RouteTarget): PendingRoute {
    return this.register(["PUT"], path, handler);
  }

  patch(path: string, handler: RouteTarget): PendingRoute {
    return this.register(["PATCH"], path, handler);
  }

  delete(path: string, handler: RouteTarget): PendingRoute {
    return this.register(["DELETE"], path, handler);
  }

  options(path: string, handler: RouteTarget): PendingRoute {
    return this.register(["OPTIONS"], path, handler);
  }

  head(path: string, handler: RouteTarget): PendingRoute {
    return this.register(["HEAD"], path, handler);
  }

  /** The (draft) HTTP QUERY method — a body-carrying, safe/idempotent GET. */
  query(path: string, handler: RouteTarget): PendingRoute {
    return this.register(["QUERY"], path, handler);
  }

  /** Respond to every HTTP method on `path`. Laravel's `Route::any`. */
  any(path: string, handler: RouteTarget): PendingRoute {
    return this.register([...ANY_METHODS], path, handler);
  }

  /** Respond to a specific set of methods. Laravel's `Route::match`. */
  match(methods: string[], path: string, handler: RouteTarget): PendingRoute {
    return this.register(
      methods.map((m) => m.toUpperCase()),
      path,
      handler,
    );
  }

  /**
   * Group-level pipes, mounted on this router's Hono instance (typically
   * a `group()` sub-router) for every request under it.
   *
   * MUST be called BEFORE the routes it should protect. Hono matches
   * `use("*")` handlers against routes registered *after* them, so
   * middleware declared at the bottom of a `group()` callback applies to
   * nothing:
   *
   * ```ts
   * router.group("/admin", (admin) => {
   *   admin.middleware(authenticate());   // ✅ guards both routes below
   *   admin.get("/users", ListUsers);
   *   admin.get("/stats", ShowStats);
   * });
   *
   * router.group("/admin", (admin) => {
   *   admin.get("/users", ListUsers);
   *   admin.middleware(authenticate());   // ❌ throws — routes came first
   * });
   * ```
   *
   * Calling it after a route has been registered **throws** rather than
   * being a documented footgun: the failure mode
   * is not a broken page, it is an authentication middleware that
   * silently guards nothing, on endpoints whose whole purpose is to be
   * guarded. Nothing about that is visible in the route table, in tests
   * that pass, or in a code review that reads top to bottom. A footgun
   * you can only detect by getting breached is a bug.
   *
   * Per-route `.middleware()` on the `PendingRoute` has no such ordering
   * constraint — it's attached to the route object itself — and
   * `use(path, ...)` is the escape hatch for deliberately mounting a
   * path-scoped pipe late.
   */
  middleware(...pipes: HttpPipe[]): this {
    if (this.registeredRoutes > 0) {
      throw new Error(
        "Router.middleware() was called after routes were registered on this router, " +
          "so it would apply to none of them (Hono only matches `use()` against routes " +
          "registered afterwards). Move the middleware() call above the routes it should " +
          "guard, or attach it per-route with `.middleware()`.",
      );
    }

    this.hono.use("*", toHonoMiddleware(pipes));

    return this;
  }

  /** Path-scoped pipes — `use("/protected/*", authenticate())`. */
  use(path: string, ...pipes: HttpPipe[]): void {
    this.hono.use(translatePath(path), toHonoMiddleware(pipes));
  }

  /** Mount a sub-router under a base path. */
  group(basePath: string, callback: (router: Router) => void): void {
    const sub = new Hono();
    callback(new Router(sub, this.registry, joinPaths(this.prefix, basePath)));
    this.hono.route(translatePath(basePath), sub);
  }

  /** Escape hatch to the raw Hono instance, for advanced use. */
  raw(): Hono {
    return this.hono;
  }

  private register(methods: string[], path: string, handler: RouteTarget): PendingRoute {
    const fullPath = joinPaths(this.prefix, path);
    const route = new PendingRoute(toRouteHandler(handler), methods, fullPath, this.registry);
    const honoPath = translatePath(path);
    const honoHandler = route.toHonoHandler();

    for (const method of methods) {
      this.hono.on(method, honoPath, honoHandler);
    }

    this.registeredRoutes++;

    return route;
  }
}

/** Join two route segments in `{param}` form, collapsing duplicate slashes. */
function joinPaths(prefix: string, path: string): string {
  if (!prefix) {
    return path;
  }

  const left = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const right = path.startsWith("/") ? path : `/${path}`;
  const joined = `${left}${right}`;

  // A trailing "/" on a group path (e.g. group("/posts") + get("/")) should
  // not leave a dangling slash.
  return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
}
