import { Facade } from "@mahi/facades";
import { Router, PendingRoute } from "./router.js";
import type { RouteTarget } from "./router.js";
import type { HttpPipe } from "./middleware/pipeline-middleware.js";

/** Token the kernel binds its root `Router` under, for the `Route` facade. */
export const ROOT_ROUTER_TOKEN = "http.router";

/**
 * Static registration entrypoint — Laravel's `Route` facade. Forwards to
 * the kernel's root `Router`, so routes can be registered outside a
 * provider's `routes(router)` hook (the hook still works and is still the
 * recommended home for a package's routes):
 *
 *   Route.get("/health", () => json({ ok: true })).name("health");
 *   Route.get("/posts/{post}", ShowPostController);   // class controller
 *   Route.group("/admin", (admin) => admin.get("/", dashboard));
 *
 * Handlers are typed `RouteTarget` — a plain function OR a class-based
 * `Controller`, matching `Router` exactly.
 */
export class Route extends Facade<Router>(() => ROOT_ROUTER_TOKEN) {
  static get(path: string, handler: RouteTarget): PendingRoute {
    return this.instance().get(path, handler);
  }

  static post(path: string, handler: RouteTarget): PendingRoute {
    return this.instance().post(path, handler);
  }

  static put(path: string, handler: RouteTarget): PendingRoute {
    return this.instance().put(path, handler);
  }

  static patch(path: string, handler: RouteTarget): PendingRoute {
    return this.instance().patch(path, handler);
  }

  static delete(path: string, handler: RouteTarget): PendingRoute {
    return this.instance().delete(path, handler);
  }

  static options(path: string, handler: RouteTarget): PendingRoute {
    return this.instance().options(path, handler);
  }

  static head(path: string, handler: RouteTarget): PendingRoute {
    return this.instance().head(path, handler);
  }

  static query(path: string, handler: RouteTarget): PendingRoute {
    return this.instance().query(path, handler);
  }

  static any(path: string, handler: RouteTarget): PendingRoute {
    return this.instance().any(path, handler);
  }

  static match(methods: string[], path: string, handler: RouteTarget): PendingRoute {
    return this.instance().match(methods, path, handler);
  }

  static group(basePath: string, callback: (router: Router) => void): void {
    this.instance().group(basePath, callback);
  }

  static middleware(...pipes: HttpPipe[]): Router {
    return this.instance().middleware(...pipes);
  }

  static use(path: string, ...pipes: HttpPipe[]): void {
    this.instance().use(path, ...pipes);
  }
}
