import { Application } from "@mahiframework/core";
import { describe, expect, it } from "vitest";
import type { Router } from "../src/router.js";
import { HttpKernel } from "../src/http-kernel.js";
import { HttpError } from "../src/http-error.js";
import { HttpResponse } from "../src/response.js";
import type { HttpPipe } from "../src/middleware/pipeline-middleware.js";

describe("HttpKernel", () => {
  it("collects routes() from every provider and mounts them", async () => {
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

    const res = await kernel.raw().request("/todos");
    expect(await res.json()).toEqual([]);
  });

  it("listRoutes() counts a .middleware() route once", () => {
    class MiddlewareProvider {
      routes(router: Router) {
        router
          .post("/todos", () => HttpResponse.json({}))
          .middleware(async (request, next) => next(request));
      }
    }

    const app = new Application();
    (app as any).providers = [new MiddlewareProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const postRoutes = kernel
      .listRoutes()
      .filter((r) => r.method === "POST" && r.path === "/todos");
    expect(postRoutes).toHaveLength(1);
  });

  it("listRoutes() excludes synthetic ALL entries registered via use()", () => {
    class MiddlewareOnlyProvider {
      routes(router: Router) {
        router.use("/*", async (request, next) => next(request));
        router.get("/health", () => HttpResponse.json({ ok: true }));
      }
    }

    const app = new Application();
    (app as any).providers = [new MiddlewareOnlyProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    expect(kernel.listRoutes()).toEqual([{ method: "GET", path: "/health" }]);
  });

  it("central error handler converts a thrown HttpError into a JSON response with its status", async () => {
    class FailingProvider {
      routes(router: Router) {
        router.get("/boom", () => {
          throw HttpError.notFound("Nope");
        });
      }
    }

    const app = new Application();
    (app as any).providers = [new FailingProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/boom");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Nope", details: undefined });
  });

  it("installs CORS headers when app config sets the http.cors namespace", async () => {
    class HealthProvider {
      routes(router: Router) {
        router.get("/health", () => HttpResponse.json({ ok: true }));
      }
    }

    const app = new Application();
    app.config.set("http", { cors: { origin: "http://localhost:3000" } });
    (app as any).providers = [new HealthProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/health", {
      headers: { Origin: "http://localhost:3000" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  it("does not install CORS when app config has no http.cors namespace", async () => {
    class HealthProvider {
      routes(router: Router) {
        router.get("/health", () => HttpResponse.json({ ok: true }));
      }
    }

    const app = new Application();
    (app as any).providers = [new HealthProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/health", {
      headers: { Origin: "http://localhost:3000" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("central error handler converts unexpected errors into a generic 500", async () => {
    class FailingProvider {
      routes(router: Router) {
        router.get("/boom", () => {
          throw new Error("unexpected");
        });
      }
    }

    const app = new Application();
    (app as any).providers = [new FailingProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: "Internal Server Error" });
  });

  it("maps ValidationException to 422 with a field → string[] bag", async () => {
    const { ValidationException } = await import("@mahiframework/validation");

    class FailingProvider {
      routes(router: Router) {
        router.post("/users", () => {
          throw new ValidationException({ email: ["The email field is required."] });
        });
      }
    }

    const app = new Application();
    (app as any).providers = [new FailingProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/users", { method: "POST" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      message: "Validation failed",
      errors: { email: ["The email field is required."] },
    });
  });

  it("maps ModelNotFoundError to a 404, not the generic 500", async () => {
    const { ModelNotFoundError } = await import("@mahiframework/database");

    class FailingProvider {
      routes(router: Router) {
        // What `Post.findOrFail(id)` throws from a controller.
        router.get("/posts/{id}", () => {
          throw new ModelNotFoundError("Post", "42");
        });
      }
    }

    const app = new Application();
    (app as any).providers = [new FailingProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/posts/42");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Not Found" });
  });

  it("does not leak the model name or id through the 404 body, even when local", async () => {
    const { ModelNotFoundError } = await import("@mahiframework/database");

    class FailingProvider {
      routes(router: Router) {
        router.get("/posts/{id}", () => {
          throw new ModelNotFoundError("Post", "42");
        });
      }
    }

    const app = new Application().useEnvironment("local");
    (app as any).providers = [new FailingProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/posts/42");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Post");
  });

  it("includes the real error message in the generic 500 when the app is local", async () => {
    class FailingProvider {
      routes(router: Router) {
        router.get("/boom", () => {
          throw new Error("kysely constraint violation");
        });
      }
    }

    const app = new Application().useEnvironment("local");
    (app as any).providers = [new FailingProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      message: "kysely constraint violation",
    });
  });

  it("lets a registered renderer shape the response for an error it matches", async () => {
    class ConstraintError extends Error {
      constructor(public detail: string) {
        super("constraint");
        this.name = "ConstraintError";
      }
    }

    class FailingProvider {
      routes(router: Router) {
        router.get("/boom", () => {
          throw new ConstraintError("email already taken");
        });
      }
    }

    const app = new Application();
    (app as any).providers = [new FailingProvider()];

    const kernel = new HttpKernel(app);
    kernel.registerRenderer(
      (e): e is ConstraintError => e instanceof ConstraintError,
      (e, c) => c.json({ error: "Conflict", detail: e.detail }, 409),
    );
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/boom");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Conflict", detail: "email already taken" });
  });

  it("falls through to built-in mapping when no renderer matches", async () => {
    class ConstraintError extends Error {}

    class FailingProvider {
      routes(router: Router) {
        router.get("/boom", () => {
          throw HttpError.notFound("Nope");
        });
      }
    }

    const app = new Application();
    (app as any).providers = [new FailingProvider()];

    const kernel = new HttpKernel(app);
    kernel.registerRenderer(
      (e): e is ConstraintError => e instanceof ConstraintError,
      (e, c) => c.json({ error: "never" }, 409),
    );
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/boom");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Nope", details: undefined });
  });

  it("collects middleware() pipes from every provider, running them ahead of route dispatch", async () => {
    const order: string[] = [];

    class TracingProvider {
      middleware(): HttpPipe[] {
        return [
          async (request, next) => {
            order.push("tracing");

            return next(request);
          },
        ];
      }
    }

    class TodosProvider {
      routes(router: Router) {
        router.get("/todos", () => {
          order.push("handler");

          return HttpResponse.json([]);
        });
      }
    }

    const app = new Application();
    (app as any).providers = [new TracingProvider(), new TodosProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/todos");

    expect(order).toEqual(["tracing", "handler"]);
    expect(await res.json()).toEqual([]);
  });

  it("runs middleware() pipes from multiple providers in provider registration order", async () => {
    const order: string[] = [];

    class FirstProvider {
      middleware(): HttpPipe[] {
        return [
          async (request, next) => {
            order.push("first");

            return next(request);
          },
        ];
      }
    }

    class SecondProvider {
      middleware(): HttpPipe[] {
        return [
          async (request, next) => {
            order.push("second");

            return next(request);
          },
        ];
      }
      routes(router: Router) {
        router.get("/health", () => HttpResponse.json({ ok: true }));
      }
    }

    const app = new Application();
    (app as any).providers = [new FirstProvider(), new SecondProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    await kernel.raw().request("/health");

    expect(order).toEqual(["first", "second"]);
  });

  it("lets a middleware() pipe short-circuit with its own Response, skipping the route handler", async () => {
    let handlerRan = false;

    class BlockingProvider {
      middleware(): HttpPipe[] {
        return [async () => HttpResponse.json({ blocked: true }, 403)];
      }
    }

    class TodosProvider {
      routes(router: Router) {
        router.get("/todos", () => {
          handlerRan = true;

          return HttpResponse.json([]);
        });
      }
    }

    const app = new Application();
    (app as any).providers = [new BlockingProvider(), new TodosProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/todos");

    expect(handlerRan).toBe(false);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ blocked: true });
  });

  it("registers GET /up when http.liveness config is set", async () => {
    const app = new Application();
    app.config.set("http", { liveness: {} });
    (app as any).providers = [];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/up");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("honours a custom liveness path", async () => {
    const app = new Application();
    app.config.set("http", { liveness: { path: "/healthz" } });
    (app as any).providers = [];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    expect((await kernel.raw().request("/healthz")).status).toBe(200);
  });

  it("does not register a liveness route when neither key is set", async () => {
    const app = new Application();
    (app as any).providers = [];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    expect((await kernel.raw().request("/up")).status).toBe(404);
  });

  it("does not install any global middleware when no provider implements middleware()", async () => {
    class TodosProvider {
      routes(router: Router) {
        router.get("/todos", () => HttpResponse.json([]));
      }
    }

    const app = new Application();
    (app as any).providers = [new TodosProvider()];

    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const res = await kernel.raw().request("/todos");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
