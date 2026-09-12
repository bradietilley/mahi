import { Facade } from "@mahiframework/facades";
import {
  UrlGenerator,
  URL_GENERATOR_TOKEN,
  type RouteParams,
  type UrlOptions,
  type SignedRouteOptions,
} from "./url-generator.js";

/**
 * Facade over the `UrlGenerator` singleton — Laravel's
 * `Illuminate\Support\Facades\URL` and the `route()` helper, in one place.
 *
 *   URL.route("posts.show", { post: 42 });
 *   URL.signedRoute("unsubscribe", { user: id }, { expiresInSeconds: 86400 });
 *   URL.to("/dashboard");
 *
 * Prefer constructor-injecting `UrlGenerator` (via `URL_GENERATOR_TOKEN`)
 * where that's practical.
 */
export class URL extends Facade<UrlGenerator>(() => URL_GENERATOR_TOKEN) {
  /** Absolute URL for a bare path, e.g. `URL.to("/dashboard")`. */
  static to(path: string, options?: UrlOptions): string {
    return this.instance().to(path, options);
  }

  /** URL for a named route. */
  static route(name: string, params?: RouteParams, options?: UrlOptions): string {
    return this.instance().route(name, params, options);
  }

  /** Tamper-evident, optionally-expiring URL for a named route. */
  static signedRoute(name: string, params?: RouteParams, options?: SignedRouteOptions): string {
    return this.instance().signedRoute(name, params, options);
  }

  /** Whether a route name is registered. */
  static has(name: string): boolean {
    return this.instance().has(name);
  }
}
