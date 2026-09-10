import { Application } from "@mahi/core";
import { Tui } from "@mahi/tui";
import { describe, expect, it } from "vitest";
import type { Router } from "../../src/router.js";
import { HttpResponse } from "../../src/response.js";
import { HttpKernel } from "../../src/http-kernel.js";
import { HTTP_KERNEL_TOKEN } from "../../src/http-service-provider.js";
import { RouteListCommand } from "../../src/commands/route-list.js";

describe("RouteListCommand", () => {
  it("prints a bordered table row for every registered route", () => {
    class TodosProvider {
      routes(router: Router) {
        router.get("/todos", () => HttpResponse.json([]));
        router.post("/todos", () => HttpResponse.json({ created: true }));
      }
    }

    const app = new Application();
    (app as any).providers = [new TodosProvider()];
    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();
    app.instance(HTTP_KERNEL_TOKEN, kernel);

    const fake = Tui.fake([]);
    const command = new RouteListCommand(app);
    command.handle();

    const output = fake.strippedOutput();
    expect(output).toContain("GET");
    expect(output).toContain("POST");
    expect(output).toContain("/todos");
    expect(output).toContain("┌");
    expect(output).toContain("│");
    fake.restore();
  });

  it("colors each HTTP method distinctly", () => {
    class TodosProvider {
      routes(router: Router) {
        router.get("/todos", () => HttpResponse.json([]));
        router.delete("/todos/{id}", () => HttpResponse.json({}));
      }
    }

    const app = new Application();
    (app as any).providers = [new TodosProvider()];
    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();
    app.instance(HTTP_KERNEL_TOKEN, kernel);

    const fake = Tui.fake([]);
    const command = new RouteListCommand(app);
    command.handle();

    const output = fake.output(); // raw, with ANSI codes
    expect(output).toContain("\x1b[34m"); // GET -> blue
    expect(output).toContain("\x1b[31m"); // DELETE -> red
    fake.restore();
  });

  it("prints an info message when no routes are registered", () => {
    const app = new Application();
    const kernel = new HttpKernel(app);
    app.instance(HTTP_KERNEL_TOKEN, kernel);

    const fake = Tui.fake([]);
    const command = new RouteListCommand(app);
    command.handle();

    expect(fake.strippedOutput()).toContain("No routes registered.");
    fake.restore();
  });
});
