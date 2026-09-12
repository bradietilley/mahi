import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Application } from "@mahiframework/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageManager } from "../src/storage-manager.js";
import { LocalStorageDriver } from "../src/drivers/local-storage-driver.js";

describe("StorageManager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-storage-manager-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function buildManager(): StorageManager {
    const app = new Application();
    const manager = new StorageManager(app, {
      default: "local",
      disks: {
        local: { root: path.join(tmpDir, "local") },
        secondary: { root: path.join(tmpDir, "secondary") },
      },
    });
    manager.extend(
      "local",
      () => new LocalStorageDriver((manager.diskConfig("local") as { root: string }).root),
    );
    manager.extend(
      "secondary",
      () => new LocalStorageDriver((manager.diskConfig("secondary") as { root: string }).root),
    );

    return manager;
  }

  it("disk() resolves the configured default", () => {
    const manager = buildManager();
    expect(manager.disk()).toBeInstanceOf(LocalStorageDriver);
  });

  it("disk() resolves and caches the same instance across calls", () => {
    const manager = buildManager();
    expect(manager.disk()).toBe(manager.disk());
  });

  it("a second named disk resolves independently of the default, and both can be used at once", async () => {
    const manager = buildManager();

    await manager.disk().put("a.txt", "default-disk");
    await manager.disk("secondary").put("a.txt", "secondary-disk");

    expect((await manager.disk().get("a.txt")).toString()).toBe("default-disk");
    expect((await manager.disk("secondary").get("a.txt")).toString()).toBe("secondary-disk");
  });

  it("url() delegates to the named (or default) disk; a private disk throws, path() gives its filesystem location", () => {
    const app = new Application();
    const manager = new StorageManager(app, {
      default: "public",
      disks: {
        public: { root: path.join(tmpDir, "public"), url: "/storage" },
        local: { root: path.join(tmpDir, "local") },
      },
    });
    manager.extend(
      "public",
      () =>
        new LocalStorageDriver(
          (manager.diskConfig("public") as { root: string; url?: string }).root,
          (manager.diskConfig("public") as { root: string; url?: string }).url,
        ),
    );
    manager.extend(
      "local",
      () => new LocalStorageDriver((manager.diskConfig("local") as { root: string }).root),
    );

    expect(manager.url("avatars/a.png")).toBe("/storage/avatars/a.png");
    // Private disk: url() throws, path() returns the filesystem location.
    expect(() => manager.url("avatars/a.png", "local")).toThrow(/does not support retrieving URLs/);
    expect(path.isAbsolute(manager.path("avatars/a.png", "local"))).toBe(true);
  });
});
