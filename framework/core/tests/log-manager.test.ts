import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application } from "../src/application.js";
import { ConsoleLogger } from "../src/logger.js";
import { LogManager, type LogConfig } from "../src/log-manager.js";
import { FileLogger } from "../src/loggers/file-logger.js";
import { DailyLogger } from "../src/loggers/daily-logger.js";
import { setBasePath, clearBasePath, storage_path } from "../src/paths.js";
import { ArrayLogger } from "../src/loggers/array-logger.js";
import { NullLogger } from "../src/loggers/null-logger.js";
import { StackLogger } from "../src/loggers/stack-logger.js";

function buildManager(config: LogConfig): LogManager {
  const app = new Application();
  const manager = new LogManager(app, config);

  // Register creators by *driver* name, mirroring LoggingServiceProvider,
  // each receives the resolving channel's own config.
  manager.extendDriver("console", () => new ConsoleLogger());
  manager.extendDriver("single", (cfg) => new FileLogger((cfg as { path: string }).path));
  manager.extendDriver("daily", (cfg) => {
    const c = cfg as { path: string; maxFiles?: number };

    return new DailyLogger(c.path, c.maxFiles);
  });
  manager.extendDriver("array", () => new ArrayLogger());
  manager.extendDriver("null", () => new NullLogger());
  manager.extendDriver("stack", (cfg, mgr) => {
    const c = cfg as { channels: string[] };

    return new StackLogger(c.channels.map((name) => mgr.channel(name)));
  });

  return manager;
}

describe("LogManager", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-log-manager-test-"));
    filePath = path.join(tmpDir, "app.log");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("channel() resolves the configured default", () => {
    const manager = buildManager({
      default: "console",
      channels: { console: { driver: "console" } },
    });

    expect(manager.channel()).toBeInstanceOf(ConsoleLogger);
  });

  it("channel(name) resolves a specific named channel, independent of the default", () => {
    const manager = buildManager({
      default: "console",
      channels: { console: { driver: "console" }, single: { driver: "single", path: filePath } },
    });

    expect(manager.channel("single")).toBeInstanceOf(FileLogger);
  });

  it("'daily' resolves to a DailyLogger", () => {
    const manager = buildManager({
      default: "daily",
      channels: { daily: { driver: "daily", path: filePath } },
    });

    expect(manager.channel()).toBeInstanceOf(DailyLogger);
  });

  it("'array' collects entries in memory, 'null' discards them", () => {
    const manager = buildManager({
      default: "array",
      channels: { array: { driver: "array" }, null: { driver: "null" } },
    });

    const array = manager.channel() as ArrayLogger;
    array.info("hello", { foo: "bar" });
    expect(array.entries).toEqual([{ level: "info", message: "hello", context: { foo: "bar" } }]);

    expect(manager.channel("null")).toBeInstanceOf(NullLogger);
    expect(() => manager.channel("null").error("boom")).not.toThrow();
  });

  it("a 'stack' channel composes its constituent channels via manager.channel(name) recursively", () => {
    const manager = buildManager({
      default: "stack",
      channels: {
        console: { driver: "console" },
        single: { driver: "single", path: filePath },
        stack: { driver: "stack", channels: ["console", "single"] },
      },
    });

    expect(manager.channel()).toBeInstanceOf(StackLogger);
  });

  it("a message logged through 'stack' actually reaches the single-file channel", async () => {
    const manager = buildManager({
      default: "stack",
      channels: {
        console: { driver: "console" },
        single: { driver: "single", path: filePath },
        stack: { driver: "stack", channels: ["single"] },
      },
    });

    manager.channel().info(`marker-${randomUUID()}`);

    const contents = await readFile(filePath, "utf-8");
    expect(contents).toContain("INFO:");
  });

  describe("emergency fallback", () => {
    it("channel() falls back to the emergency logger when the requested driver isn't registered", async () => {
      const emergencyPath = path.join(tmpDir, "emergency.log");
      const app = new Application();
      const manager = new LogManager(app, {
        default: "console",
        channels: { console: { driver: "console" } },
        emergency: { path: emergencyPath },
      });
      manager.extendDriver("console", () => new ConsoleLogger());
      // "missing" is not a configured channel at all.

      const logger = manager.channel("missing");
      expect(logger).toBeInstanceOf(FileLogger);

      const contents = await readFile(emergencyPath, "utf-8");
      expect(contents).toContain("Unable to create configured logger");
    });

    it("channel() falls back to the emergency logger when a driver factory throws", async () => {
      const emergencyPath = path.join(tmpDir, "emergency.log");
      const app = new Application();
      const manager = new LogManager(app, {
        default: "console",
        channels: { console: { driver: "console" } },
        emergency: { path: emergencyPath },
      });
      manager.extendDriver("console", () => {
        throw new Error("boom");
      });

      const logger = manager.channel();
      expect(logger).toBeInstanceOf(FileLogger);

      const contents = await readFile(emergencyPath, "utf-8");
      expect(contents).toContain("boom");
    });

    it("channel() falls back when a channel names a driver that was never registered", async () => {
      const emergencyPath = path.join(tmpDir, "emergency.log");
      const app = new Application();
      const manager = new LogManager(app, {
        default: "app",
        channels: { app: { driver: "sentry" } as never },
        emergency: { path: emergencyPath },
      });
      manager.extendDriver("console", () => new ConsoleLogger());
      // "sentry" driver deliberately not registered.

      const logger = manager.channel("app");
      expect(logger).toBeInstanceOf(FileLogger);

      const contents = await readFile(emergencyPath, "utf-8");
      expect(contents).toContain("Unable to create configured logger");
    });

    it("channel() does not throw when the logging config itself is undefined", () => {
      // Pin the app root at the temp dir: the emergency fallback builds a
      // FileLogger at storage_path('logs/mahi.log'), which mkdir's its
      // directory, keep that out of the repo's cwd.
      setBasePath(tmpDir);
      try {
        const app = new Application();
        // A LogManager built with no config at all (e.g. config.get('logging')
        // returned undefined) must still degrade to emergency, not throw
        // 'Cannot read properties of undefined'.
        const manager = new LogManager(app, undefined as never);

        expect(() => manager.channel()).not.toThrow();
        expect(manager.channel()).toBeInstanceOf(FileLogger);
      } finally {
        clearBasePath();
      }
    });

    it("emergency() defaults to storage_path('logs/mahi.log') when no emergency config is given", () => {
      // Pin the app root at the temp dir so constructing the emergency
      // FileLogger creates `storage/logs` under a throwaway path rather than
      // in the repository's cwd.
      setBasePath(tmpDir);
      try {
        const app = new Application();
        const manager = new LogManager(app, {
          default: "console",
          channels: { console: { driver: "console" } },
        });

        expect((manager.emergency() as FileLogger)["path"]).toBe(storage_path("logs", "mahi.log"));
        expect((manager.emergency() as FileLogger)["path"]).toBe(
          path.join(tmpDir, "storage", "logs", "mahi.log"),
        );
      } finally {
        clearBasePath();
      }
    });
  });
});
