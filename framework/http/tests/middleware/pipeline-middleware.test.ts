import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpResponse, type ResponseInput } from "../../src/response.js";
import { toHonoMiddleware, type HttpPipe } from "../../src/middleware/pipeline-middleware.js";
import type { Request } from "../../src/request.js";
import type { Next } from "@mahi/pipeline";

describe("toHonoMiddleware", () => {
  it("runs pipes in order ahead of the matched route handler", async () => {
    const order: string[] = [];

    const pipeA: HttpPipe = async (request, next) => {
      order.push("a");

      return next(request);
    };
    const pipeB: HttpPipe = async (request, next) => {
      order.push("b");

      return next(request);
    };

    const hono = new Hono();
    hono.use("*", toHonoMiddleware([pipeA, pipeB]));
    hono.get("/things", (c) => {
      order.push("handler");

      return c.json({ ok: true });
    });

    const res = await hono.request("/things");

    expect(order).toEqual(["a", "b", "handler"]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("lets a pipe short-circuit with its own Response, skipping the route handler", async () => {
    let handlerRan = false;

    const blocker: HttpPipe = async () => HttpResponse.json({ blocked: true }, 403);

    const hono = new Hono();
    hono.use("*", toHonoMiddleware([blocker]));
    hono.get("/things", (c) => {
      handlerRan = true;

      return c.json({ ok: true });
    });

    const res = await hono.request("/things");

    expect(handlerRan).toBe(false);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ blocked: true });
  });

  it("lets a pipe run logic after the route handler by awaiting next()", async () => {
    const hono = new Hono();

    const afterHandler: HttpPipe = async (request, next) => {
      const res = await next(request);
      res.headers.set("X-Traced", "1");

      return res;
    };

    hono.use("*", toHonoMiddleware([afterHandler]));
    hono.get("/things", (c) => c.json({ ok: true }));

    const res = await hono.request("/things");

    expect(res.headers.get("X-Traced")).toBe("1");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("supports object pipes with a handle() method", async () => {
    const order: string[] = [];

    class TracePipe {
      async handle(request: Request, next: Next<Request, ResponseInput>) {
        order.push("object-pipe");

        return next(request);
      }
    }

    const hono = new Hono();
    hono.use("*", toHonoMiddleware([new TracePipe()]));
    hono.get("/things", (c) => {
      order.push("handler");

      return c.json({ ok: true });
    });

    await hono.request("/things");

    expect(order).toEqual(["object-pipe", "handler"]);
  });

  it("no-ops (0 pipes) still reaches the route handler", async () => {
    const hono = new Hono();
    hono.use("*", toHonoMiddleware([]));
    hono.get("/things", (c) => c.json({ ok: true }));

    const res = await hono.request("/things");
    expect(await res.json()).toEqual({ ok: true });
  });
});
