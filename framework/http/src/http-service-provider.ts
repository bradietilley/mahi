import { ServiceProvider } from "@mahi/core";
import { HttpKernel } from "./http-kernel.js";
import { RouteListCommand } from "./commands/route-list.js";
import { DownCommand } from "./commands/down.js";
import { UpCommand } from "./commands/up.js";
import { ServeCommand } from "./commands/serve.js";
import { MaintenanceMode, MAINTENANCE_MODE_TOKEN } from "./maintenance/maintenance-mode.js";
import { UrlGenerator, URL_GENERATOR_TOKEN } from "./url-generator.js";
import { ROOT_ROUTER_TOKEN } from "./route-facade.js";

export const HTTP_KERNEL_TOKEN = "http.kernel";

/**
 * Registers the HttpKernel singleton and contributes `route:list`,
 * `maintenance:down`/`maintenance:up`, and `serve`. Routes are collected from
 * every provider during this provider's own `boot()`, so by the time
 * `bin/server.ts` or `artisan serve` calls `listenHttpServer()`, or
 * `route:list` runs via the console, every route is already mounted —
 * regardless of which entrypoint booted the Application.
 */
export class HttpServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(MAINTENANCE_MODE_TOKEN, (app) => new MaintenanceMode(app));
    this.app.singleton(HTTP_KERNEL_TOKEN, (app) => new HttpKernel(app));
    // The root Router and URL generator both read state off the kernel
    // (the shared RouteRegistry, the root Router), so they resolve it
    // rather than owning their own — keeping one source of truth for
    // registered routes and names.
    this.app.singleton(ROOT_ROUTER_TOKEN, (app) =>
      app.make<HttpKernel>(HTTP_KERNEL_TOKEN).rootRouter(),
    );
    this.app.singleton(
      URL_GENERATOR_TOKEN,
      (app) => new UrlGenerator(app, app.make<HttpKernel>(HTTP_KERNEL_TOKEN).routeRegistry()),
    );
  }

  boot(): void {
    const kernel = this.app.make<HttpKernel>(HTTP_KERNEL_TOKEN);
    kernel.collectFromProviders();
  }

  commands() {
    return [RouteListCommand, DownCommand, UpCommand, ServeCommand];
  }
}
