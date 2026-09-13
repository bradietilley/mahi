import { Command } from "@mahiframework/cli";
import { Tui, colors } from "@mahiframework/tui";
import { HTTP_KERNEL_TOKEN } from "../http-service-provider.js";
import type { HttpKernel } from "../http-kernel.js";

/** Matches Laravel's `RouteListCommand::$verbColors`, color-codes each HTTP method for quick scanning. */
const METHOD_COLORS: Record<string, (text: string) => string> = {
  ANY: colors.red,
  GET: colors.blue,
  HEAD: colors.gray,
  OPTIONS: colors.gray,
  POST: colors.yellow,
  PUT: colors.yellow,
  PATCH: colors.yellow,
  DELETE: colors.red,
  QUERY: colors.blue,
};

function colorizeMethod(method: string): string {
  const colorize = METHOD_COLORS[method] ?? colors.white;

  return colorize(method);
}

export class RouteListCommand extends Command {
  signature = "route:list";
  description = "List every registered HTTP route.";

  handle(): void {
    const kernel = this.app.make<HttpKernel>(HTTP_KERNEL_TOKEN);
    const routes = kernel.listRoutes();

    if (routes.length === 0) {
      Tui.info("No routes registered.");

      return;
    }

    Tui.table(
      ["Method", "URI", "Name"],
      routes.map((r) => [colorizeMethod(r.method), r.path, r.name ? colors.gray(r.name) : ""]),
    );
  }
}
