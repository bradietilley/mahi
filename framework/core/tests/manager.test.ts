import { describe, expect, it, vi } from "vitest";
import { Application } from "../src/application.js";
import { DriverNotRegisteredError, Manager, isDisconnectable } from "../src/manager.js";

interface FakeDriver {
  name: string;
  disconnect?: () => Promise<void>;
}

class FakeManager extends Manager<FakeDriver> {
  getDefaultDriver(): string {
    return "sqlite";
  }
}

describe("Manager", () => {
  it("driver() resolves the default driver when called without a name", () => {
    const app = new Application();
    const manager = new FakeManager(app);
    manager.extend("sqlite", () => ({ name: "sqlite" }));

    expect(manager.driver().name).toBe("sqlite");
  });

  it("driver(name) resolves an explicitly named driver, independent of the default", () => {
    const app = new Application();
    const manager = new FakeManager(app);
    manager.extend("sqlite", () => ({ name: "sqlite" }));
    manager.extend("analytics", () => ({ name: "analytics" }));

    const primary = manager.driver();
    const secondary = manager.driver("analytics");

    expect(primary.name).toBe("sqlite");
    expect(secondary.name).toBe("analytics");
  });

  it("caches resolved drivers. The factory only runs once per name", () => {
    const app = new Application();
    const manager = new FakeManager(app);
    let calls = 0;
    manager.extend("sqlite", () => {
      calls += 1;

      return { name: "sqlite" };
    });

    const a = manager.driver();
    const b = manager.driver();

    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it("multiple named drivers can be resolved and live simultaneously", () => {
    const app = new Application();
    const manager = new FakeManager(app);
    manager.extend("sqlite", () => ({ name: "sqlite" }));
    manager.extend("analytics", () => ({ name: "analytics" }));

    manager.driver();
    manager.driver("analytics");

    expect(manager.resolvedDriverNames().sort()).toEqual(["analytics", "sqlite"]);
  });

  it("throws DriverNotRegisteredError for an unregistered driver name", () => {
    const app = new Application();
    const manager = new FakeManager(app);

    expect(() => manager.driver("postgres")).toThrow(DriverNotRegisteredError);
  });

  it("plugin-contributed drivers register via extend() just like built-ins", () => {
    const app = new Application();
    const manager = new FakeManager(app);
    manager.extend("sqlite", () => ({ name: "sqlite" }));

    // A "plugin" extending the manager after construction, same as a
    // ServiceProvider calling manager.extend() during its own boot().
    manager.extend("ollama", () => ({ name: "ollama" }));

    expect(manager.driver("ollama").name).toBe("ollama");
  });

  it("resolvedDrivers() returns the resolved driver objects, in resolution order", () => {
    const manager = new FakeManager(new Application());
    manager.extend("sqlite", () => ({ name: "sqlite" }));
    manager.extend("analytics", () => ({ name: "analytics" }));

    manager.driver("analytics");
    manager.driver();

    expect(manager.resolvedDrivers().map((d) => d.name)).toEqual(["analytics", "sqlite"]);
  });
});

describe("Manager.disconnectAll()", () => {
  it("disconnects every resolved driver that has a disconnect()", async () => {
    const sqlite = vi.fn(async () => {});
    const analytics = vi.fn(async () => {});

    const manager = new FakeManager(new Application());
    manager.extend("sqlite", () => ({ name: "sqlite", disconnect: sqlite }));
    manager.extend("analytics", () => ({ name: "analytics", disconnect: analytics }));
    manager.driver();
    manager.driver("analytics");

    await manager.disconnectAll();

    expect(sqlite).toHaveBeenCalledOnce();
    expect(analytics).toHaveBeenCalledOnce();
  });

  /**
   * Resolving a driver in order to close it would CONSTRUCT it, for a
   * real driver that means opening a pool during shutdown, which is the
   * opposite of the point.
   */
  it("never resolves a driver that was never used", async () => {
    const factory = vi.fn(() => ({ name: "analytics", disconnect: async () => {} }));

    const manager = new FakeManager(new Application());
    manager.extend("sqlite", () => ({ name: "sqlite" }));
    manager.extend("analytics", factory);
    manager.driver();

    await manager.disconnectAll();

    expect(factory).not.toHaveBeenCalled();
  });

  it("skips drivers with no disconnect() rather than throwing", async () => {
    const manager = new FakeManager(new Application());
    manager.extend("sqlite", () => ({ name: "sqlite" }));
    manager.driver();

    await expect(manager.disconnectAll()).resolves.toEqual([]);
  });

  /**
   * Best-effort: one unreachable Redis must not leave a MySQL pool open
   * and hang the process, so every driver is attempted and the failures
   * come back for the caller to log.
   */
  it("attempts every driver even when one rejects, and returns the errors", async () => {
    const second = vi.fn(async () => {});

    const manager = new FakeManager(new Application());
    manager.extend("sqlite", () => ({
      name: "sqlite",
      disconnect: async () => {
        throw new Error("boom");
      },
    }));
    manager.extend("analytics", () => ({ name: "analytics", disconnect: second }));
    manager.driver();
    manager.driver("analytics");

    const errors = await manager.disconnectAll();

    expect(second).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "boom" });
  });

  it("forgets the drivers it disconnected", async () => {
    const manager = new FakeManager(new Application());
    manager.extend("sqlite", () => ({ name: "sqlite", disconnect: async () => {} }));
    manager.driver();

    await manager.disconnectAll();

    expect(manager.resolvedDriverNames()).toEqual([]);
    expect(manager.isResolved("sqlite")).toBe(false);
  });
});

describe("isDisconnectable()", () => {
  /**
   * Half a `Connectable` is a legitimate shape: SqliteDriver has nothing
   * to warm up (better-sqlite3 connects in its constructor) but very much
   * has a file handle to close.
   */
  it("accepts a driver with only disconnect(), which isConnectable rejects", () => {
    expect(isDisconnectable({ disconnect: async () => {} })).toBe(true);
    expect(isDisconnectable({ connect: async () => {} })).toBe(false);
    expect(isDisconnectable(null)).toBe(false);
    expect(isDisconnectable("nope")).toBe(false);
  });
});
