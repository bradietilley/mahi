import { afterEach, describe, expect, it, vi } from "vitest";
import { Application } from "../src/application.js";
import { ServiceProvider } from "../src/service-provider.js";
import { app as currentApp, clearCurrentApp } from "../src/global-app.js";

afterEach(() => {
  clearCurrentApp();
});

describe("Application", () => {
  it("calls register() on every provider before boot() on any provider", async () => {
    const events: string[] = [];

    class A extends ServiceProvider {
      register() {
        events.push("A.register");
      }
      boot() {
        events.push("A.boot");
      }
    }

    class B extends ServiceProvider {
      register() {
        events.push("B.register");
      }
      boot() {
        events.push("B.boot");
      }
    }

    const app = new Application();
    app.register(A);
    app.register(B);
    await app.bootstrap();

    expect(events).toEqual(["A.register", "B.register", "A.boot", "B.boot"]);
  });

  it("boots providers sequentially, in registration order, awaiting async boot()", async () => {
    const events: string[] = [];

    class Slow extends ServiceProvider {
      async boot() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push("Slow.boot");
      }
    }

    class Fast extends ServiceProvider {
      boot() {
        events.push("Fast.boot");
      }
    }

    const app = new Application();
    app.register(Slow);
    app.register(Fast);
    await app.bootstrap();

    // Fast is registered after Slow, but if boot() were parallel (Promise.all)
    // Fast's synchronous boot would finish before Slow's 20ms delay resolves.
    // Sequential boot guarantees Slow.boot completes first regardless.
    expect(events).toEqual(["Slow.boot", "Fast.boot"]);
  });

  it("bootstrap() is idempotent. A second call does not re-run providers", async () => {
    let registerCalls = 0;

    class Once extends ServiceProvider {
      register() {
        registerCalls += 1;
      }
    }

    const app = new Application();
    app.register(Once);
    await app.bootstrap();
    await app.bootstrap();

    expect(registerCalls).toBe(1);
    expect(app.isBooted()).toBe(true);
  });

  it("getProviders() exposes every instantiated provider after bootstrap", async () => {
    class A extends ServiceProvider {}

    const app = new Application();
    app.register(A);
    await app.bootstrap();

    expect(app.getProviders()).toHaveLength(1);
    expect(app.getProviders()[0]).toBeInstanceOf(A);
  });

  /**
   * The global must be set BEFORE providers run: otherwise `app()`, and
   * therefore every facade built on it (Log, Events, Context), throws
   * "No Application instance is currently registered" inside the exact
   * hooks where a provider is most likely to need one. Laravel binds
   * the container globally before providers run.
   */
  it("app() resolves this application inside register() and boot()", async () => {
    const seen: Application[] = [];

    class Reaching extends ServiceProvider {
      register() {
        seen.push(currentApp());
      }
      boot() {
        seen.push(currentApp());
      }
    }

    const app = new Application();
    app.register(Reaching);
    await app.bootstrap();

    expect(seen).toEqual([app, app]);
  });

  /**
   * `booted` is only true once the last provider has booted, so two
   * callers racing here both cleared the `if (this.booted) return` guard
   * and booted every provider a second time, double-binding singletons
   * and opening two of every pool.
   */
  it("concurrent bootstrap() calls run every provider exactly once", async () => {
    let registers = 0;
    let boots = 0;

    class Counting extends ServiceProvider {
      register() {
        registers += 1;
      }
      async boot() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        boots += 1;
      }
    }

    const app = new Application();
    app.register(Counting);
    await Promise.all([app.bootstrap(), app.bootstrap()]);

    expect(registers).toBe(1);
    expect(boots).toBe(1);
  });

  /**
   * A provider whose boot() throws leaves the app un-booted and a caller
   * may retry. Re-running register() on that retry re-instantiated every
   * provider and re-bound every singleton, an app that looked recovered
   * but had two of everything.
   */
  it("a retry after a failed boot() does not re-run register()", async () => {
    let registers = 0;
    let attempts = 0;

    class Flaky extends ServiceProvider {
      register() {
        registers += 1;
      }
      boot() {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("boom");
        }
      }
    }

    const app = new Application();
    app.register(Flaky);

    await expect(app.bootstrap()).rejects.toThrow("boom");
    expect(app.isBooted()).toBe(false);

    await app.bootstrap();

    expect(registers).toBe(1);
    expect(attempts).toBe(2);
    expect(app.isBooted()).toBe(true);
  });

  it("a retry after a failed boot() resumes at the provider that threw", async () => {
    const events: string[] = [];
    let attempts = 0;

    class First extends ServiceProvider {
      boot() {
        events.push("First.boot");
      }
    }

    class Second extends ServiceProvider {
      boot() {
        attempts += 1;
        events.push("Second.boot");

        if (attempts === 1) {
          throw new Error("boom");
        }
      }
    }

    const app = new Application();
    app.register(First);
    app.register(Second);

    await expect(app.bootstrap()).rejects.toThrow("boom");
    await app.bootstrap();

    // First booted once, not twice, its boot() is not idempotent in
    // general (it mounts routes, opens pools) and must not be repeated.
    expect(events).toEqual(["First.boot", "Second.boot", "Second.boot"]);
  });
});

describe("Application.terminate()", () => {
  it("runs terminating() callbacks in LIFO order", async () => {
    const events: string[] = [];

    const app = new Application();
    app.terminating(() => {
      events.push("first");
    });
    app.terminating(() => {
      events.push("second");
    });

    await app.terminate();

    expect(events).toEqual(["second", "first"]);
  });

  it("awaits async terminating() callbacks", async () => {
    const events: string[] = [];

    const app = new Application();
    app.terminating(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("slow");
    });
    app.terminating(() => {
      events.push("fast");
    });

    await app.terminate();

    // LIFO: "fast" was registered last so it runs first, and "slow" is
    // still awaited before terminate() resolves.
    expect(events).toEqual(["fast", "slow"]);
  });

  it("terminating() returns the app for chaining", () => {
    const app = new Application();
    expect(app.terminating(() => {})).toBe(app);
  });

  /**
   * Reverse of boot order, so a provider tears down before the providers
   * it booted on top of, the database connection an auth provider uses
   * must still be open while auth is shutting down.
   */
  it("runs providers' shutdown() in reverse registration order", async () => {
    const events: string[] = [];

    class A extends ServiceProvider {
      shutdown() {
        events.push("A.shutdown");
      }
    }
    class B extends ServiceProvider {
      shutdown() {
        events.push("B.shutdown");
      }
    }
    class NoHook extends ServiceProvider {}

    const app = new Application();
    app.register(A);
    app.register(NoHook);
    app.register(B);
    await app.bootstrap();
    await app.terminate();

    expect(events).toEqual(["B.shutdown", "A.shutdown"]);
  });

  it("runs terminating() callbacks before any provider shutdown()", async () => {
    const events: string[] = [];

    class P extends ServiceProvider {
      shutdown() {
        events.push("provider");
      }
    }

    const app = new Application();
    app.register(P);
    await app.bootstrap();
    app.terminating(() => {
      events.push("callback");
    });
    await app.terminate();

    expect(events).toEqual(["callback", "provider"]);
  });

  it("is idempotent: a second terminate() runs nothing", async () => {
    let shutdowns = 0;
    let callbacks = 0;

    class P extends ServiceProvider {
      shutdown() {
        shutdowns += 1;
      }
    }

    const app = new Application();
    app.register(P);
    await app.bootstrap();
    app.terminating(() => {
      callbacks += 1;
    });

    await app.terminate();
    await app.terminate();

    expect(shutdowns).toBe(1);
    expect(callbacks).toBe(1);
    expect(app.isTerminated()).toBe(true);
  });

  /**
   * Shutdown is best-effort: the process is going down regardless, and
   * one broken teardown must not strand a database pool that the next
   * hook would have closed.
   */
  it("logs and continues when a terminating callback throws", async () => {
    const app = new Application();
    const error = vi.spyOn(app.logger, "error").mockImplementation(() => {});
    const events: string[] = [];

    app.terminating(() => {
      events.push("survivor");
    });
    app.terminating(() => {
      throw new Error("boom");
    });

    await expect(app.terminate()).resolves.toBeUndefined();

    expect(events).toEqual(["survivor"]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("terminating callback"),
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("logs and continues when a provider's shutdown() throws", async () => {
    const events: string[] = [];

    class Broken extends ServiceProvider {
      shutdown() {
        throw new Error("boom");
      }
    }
    class Fine extends ServiceProvider {
      shutdown() {
        events.push("Fine.shutdown");
      }
    }

    const app = new Application();
    const error = vi.spyOn(app.logger, "error").mockImplementation(() => {});
    app.register(Fine);
    app.register(Broken);
    await app.bootstrap();

    await expect(app.terminate()).resolves.toBeUndefined();

    // Broken is registered last so it shuts down first; Fine still runs.
    expect(events).toEqual(["Fine.shutdown"]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Broken.shutdown()"),
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("clears the global app() so a terminated application is unreachable", async () => {
    const app = new Application();
    await app.bootstrap();
    expect(currentApp()).toBe(app);

    await app.terminate();

    expect(() => currentApp()).toThrow(/No Application instance is currently registered/);
  });

  /**
   * A test file that terminates its own second application must not blank
   * out the global another one legitimately owns.
   */
  it("does not clear the global when a different application is current", async () => {
    const first = new Application();
    await first.bootstrap();

    const second = new Application();
    await second.bootstrap();
    expect(currentApp()).toBe(second);

    await first.terminate();

    expect(currentApp()).toBe(second);
  });

  it("shuts down providers that booted before a failed bootstrap", async () => {
    const events: string[] = [];

    class Opened extends ServiceProvider {
      boot() {
        events.push("Opened.boot");
      }
      shutdown() {
        events.push("Opened.shutdown");
      }
    }
    class Fails extends ServiceProvider {
      boot() {
        throw new Error("boom");
      }
    }

    const app = new Application();
    app.register(Opened);
    app.register(Fails);

    await expect(app.bootstrap()).rejects.toThrow("boom");
    await app.terminate();

    // The pool the first provider opened is closed even though the app
    // never finished booting, otherwise a failed boot hangs the process.
    expect(events).toEqual(["Opened.boot", "Opened.shutdown"]);
  });

  describe("environment()", () => {
    it("returns the environment name with no arguments", () => {
      const app = new Application().useEnvironment("local");
      expect(app.environment()).toBe("local");
    });

    it("returns true/false depending on whether any given name matches", () => {
      const app = new Application().useEnvironment("local");
      expect(app.environment("local")).toBe(true);
      expect(app.environment("production")).toBe(false);
      expect(app.environment("staging", "local")).toBe(true);
      expect(app.environment("staging", "testing")).toBe(false);
    });

    it("isLocal()/isProduction() reflect the current environment", () => {
      const local = new Application().useEnvironment("local");
      expect(local.isLocal()).toBe(true);
      expect(local.isProduction()).toBe(false);

      const prod = new Application().useEnvironment("production");
      expect(prod.isProduction()).toBe(true);
      expect(prod.isLocal()).toBe(false);
    });

    it("useEnvironment() returns the app for chaining", () => {
      const app = new Application();
      expect(app.useEnvironment("test")).toBe(app);
    });

    it("normalizes 'development' to 'local' (Node → Laravel vocabulary)", () => {
      const app = new Application().useEnvironment("development");
      expect(app.environment()).toBe("local");
      expect(app.isLocal()).toBe(true);
    });
  });
});
