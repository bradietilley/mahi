import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Application, clearBasePath, setBasePath } from "@mahiframework/core";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Router } from "../../src/router.js";
import { HttpKernel } from "../../src/http-kernel.js";
import { HttpResponse } from "../../src/response.js";
import {
  MaintenanceMode,
  MAINTENANCE_MODE_TOKEN,
  maintenanceFilePath,
} from "../../src/maintenance/maintenance-mode.js";
import { MAINTENANCE_BYPASS_COOKIE } from "../../src/maintenance/maintenance-middleware.js";

/**
 * Maintenance state lives in `storage/framework/down`, resolved through
 * `base_path()`. Point that at a temp dir per test so nothing touches
 * the repo and files can't leak between tests.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mahi-maintenance-"));
  setBasePath(root);
});

afterEach(async () => {
  clearBasePath();
  await rm(root, { recursive: true, force: true });
});

function buildApp(): Application {
  const app = new Application();
  app.singleton(MAINTENANCE_MODE_TOKEN, (a) => new MaintenanceMode(a));

  return app;
}

describe("MaintenanceMode", () => {
  let app: Application;
  let mode: MaintenanceMode;

  beforeEach(() => {
    app = buildApp();
    mode = app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN);
  });

  it("starts inactive", async () => {
    expect(await mode.active()).toBe(false);
    expect(await mode.data()).toBeUndefined();
  });

  it("activate() stores the payload and marks the app down", async () => {
    await mode.activate({ retryAfter: 30, message: "brb" });
    expect(await mode.active()).toBe(true);
    expect(await mode.data()).toEqual({ retryAfter: 30, message: "brb" });
  });

  it("deactivate() brings the app back up", async () => {
    await mode.activate({ message: "brb" });
    await mode.deactivate();
    expect(await mode.active()).toBe(false);
    expect(await mode.data()).toBeUndefined();
  });

  it("deactivate() is a no-op when already up", async () => {
    await expect(mode.deactivate()).resolves.toBeUndefined();
  });

  it("writes a marker FILE, so state survives the CLI process that set it", async () => {
    // The whole point of the file. `maintenance:down` runs in a separate
    // process from the server; with the previous cache-backed state and
    // the default `array` driver, it wrote the flag into its own heap
    // and exited, and the server kept serving traffic.
    await mode.activate({ message: "brb" });

    expect(await readFile(maintenanceFilePath(), "utf8")).toBe('{"message":"brb"}');

    // A completely separate instance, standing in for the server
    // process, sees it.
    const otherProcess = new MaintenanceMode(buildApp());
    expect(await otherProcess.active()).toBe(true);
  });

  it("stays DOWN when the marker file is corrupt", async () => {
    // Existence is the signal; the payload is decoration. Coming back up
    // because the JSON was truncated mid-write is the worse failure.
    await mkdir(path.dirname(maintenanceFilePath()), { recursive: true });
    await writeFile(maintenanceFilePath(), "{not json", "utf8");

    expect(await mode.active()).toBe(true);
    expect(await mode.data()).toEqual({});
  });

  it("caches reads briefly, but invalidates on its own writes", async () => {
    expect(await mode.active()).toBe(false);
    await mode.activate({ message: "brb" });
    // Without invalidation the operator would be told the app is still
    // up for another second after taking it down.
    expect(await mode.active()).toBe(true);
    await mode.deactivate();
    expect(await mode.active()).toBe(false);
  });
});

describe("maintenance middleware (via HttpKernel)", () => {
  class HealthProvider {
    routes(router: Router) {
      router.get("/up", () => HttpResponse.json({ ok: true }));
      router.get("/todos", () => HttpResponse.json([]));
    }
  }

  function kernelFor(app: Application): HttpKernel {
    (app as any).providers = [new HealthProvider()];
    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    return kernel;
  }

  it("passes requests through untouched when the app is up", async () => {
    const app = buildApp();
    const kernel = kernelFor(app);
    const res = await kernel.raw().request("/todos");
    expect(res.status).toBe(200);
  });

  it("returns 503 with Retry-After while down", async () => {
    const app = buildApp();
    await app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN).activate({
      retryAfter: 42,
      message: "Deploying",
    });
    const kernel = kernelFor(app);

    const res = await kernel.raw().request("/todos");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(await res.json()).toEqual({ message: "Deploying" });
  });

  it("lets excepted paths through while down", async () => {
    const app = buildApp();
    await app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN).activate({ except: ["/up"] });
    const kernel = kernelFor(app);

    expect((await kernel.raw().request("/up")).status).toBe(200);
    expect((await kernel.raw().request("/todos")).status).toBe(503);
  });

  it("lets a request carrying the bypass secret header through", async () => {
    const app = buildApp();
    await app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN).activate({ secret: "letmein" });
    const kernel = kernelFor(app);

    const res = await kernel.raw().request("/todos", {
      headers: { "X-Maintenance-Secret": "letmein" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong secret", async () => {
    const app = buildApp();
    await app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN).activate({ secret: "letmein" });
    const kernel = kernelFor(app);

    const res = await kernel.raw().request("/todos", {
      headers: { "X-Maintenance-Secret": "letmeout" },
    });
    expect(res.status).toBe(503);
  });

  it("exchanges the /<secret> URL for a cookie and a redirect", async () => {
    const app = buildApp();
    await app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN).activate({ secret: "letmein" });
    const kernel = kernelFor(app);

    // Merely skipping the 503 is not enough: the request would fall
    // through to routing, match nothing and 404. The documented bypass
    // would never reach the app, and its only effect would be writing the
    // secret into every access log in front of it.
    const res = await kernel.raw().request("/letmein");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");

    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain(`${MAINTENANCE_BYPASS_COOKIE}=letmein`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
  });

  it("marks the bypass cookie Secure on an https request", async () => {
    const app = buildApp();
    await app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN).activate({ secret: "letmein" });
    const kernel = kernelFor(app);

    const res = await kernel.raw().request("https://example.com/letmein");
    expect(res.headers.get("Set-Cookie")).toContain("Secure");
  });

  it("honours the bypass cookie on subsequent requests", async () => {
    const app = buildApp();
    await app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN).activate({ secret: "letmein" });
    const kernel = kernelFor(app);

    const res = await kernel.raw().request("/todos", {
      headers: { cookie: `${MAINTENANCE_BYPASS_COOKIE}=letmein` },
    });
    expect(res.status).toBe(200);
  });

  it("ignores a bypass cookie holding the wrong secret", async () => {
    const app = buildApp();
    await app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN).activate({ secret: "letmein" });
    const kernel = kernelFor(app);

    const res = await kernel.raw().request("/todos", {
      headers: { cookie: `${MAINTENANCE_BYPASS_COOKIE}=nope` },
    });
    expect(res.status).toBe(503);
  });

  it("uses a custom status when configured", async () => {
    const app = buildApp();
    await app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN).activate({ status: 418 });
    const kernel = kernelFor(app);

    expect((await kernel.raw().request("/todos")).status).toBe(418);
  });

  it("keeps the auto-registered liveness route reachable while down", async () => {
    const app = buildApp();
    app.config.set("http", { liveness: {} });
    await app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN).activate({ message: "brb" });
    (app as any).providers = [];
    const kernel = new HttpKernel(app);
    kernel.collectFromProviders();

    const up = await kernel.raw().request("/up");
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ status: "ok" });
  });
});
