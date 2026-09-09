import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application } from "../src/application.js";
import { LoggingServiceProvider, LOG_TOKEN } from "../src/logging-service-provider.js";
import { LogManager, type LogConfig } from "../src/log-manager.js";
import { DailyLogger } from "../src/loggers/daily-logger.js";
import { FileLogger } from "../src/loggers/file-logger.js";
import { ArrayLogger } from "../src/loggers/array-logger.js";

async function buildManager(config: LogConfig): Promise<LogManager> {
  const app = new Application();
  app.config.set("logging", config);
  app.register(LoggingServiceProvider);
  await app.bootstrap();

  return app.make<LogManager>(LOG_TOKEN);
}

describe("LoggingServiceProvider", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-logging-provider-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves Laravel-shaped channels by their configured driver, not their name", async () => {
    // Channel names differ from driver names entirely.
    const manager = await buildManager({
      default: "app",
      channels: {
        app: { driver: "daily", path: path.join(tmpDir, "app.log") },
        errors: { driver: "single", path: path.join(tmpDir, "errors.log") },
        memory: { driver: "array" },
      },
    });

    expect(manager.channel("app")).toBeInstanceOf(DailyLogger);
    expect(manager.channel("errors")).toBeInstanceOf(FileLogger);
    expect(manager.channel("memory")).toBeInstanceOf(ArrayLogger);
  });

  it("supports two channels of the same driver writing to two different files", async () => {
    const manager = await buildManager({
      default: "primary",
      channels: {
        primary: { driver: "single", path: path.join(tmpDir, "primary.log") },
        audit: { driver: "single", path: path.join(tmpDir, "audit.log") },
      },
    });

    manager.channel("primary").info("to primary");
    manager.channel("audit").info("to audit");

    expect(await readFile(path.join(tmpDir, "primary.log"), "utf-8")).toContain("to primary");
    expect(await readFile(path.join(tmpDir, "audit.log"), "utf-8")).toContain("to audit");
    // And they didn't cross-contaminate.
    expect(await readFile(path.join(tmpDir, "primary.log"), "utf-8")).not.toContain("to audit");
  });

  it("caches the resolved logger per channel name", async () => {
    const manager = await buildManager({
      default: "memory",
      channels: { memory: { driver: "array" } },
    });

    expect(manager.channel("memory")).toBe(manager.channel("memory"));
  });

  it("an unknown driver falls back to the emergency logger (and logs the failure)", async () => {
    const emergencyPath = path.join(tmpDir, "emergency.log");
    const manager = await buildManager({
      default: "app",
      channels: { app: { driver: "sentry" } as never },
      emergency: { path: emergencyPath },
    });

    const logger = manager.channel("app");
    expect(logger).toBeInstanceOf(FileLogger);

    const contents = await readFile(emergencyPath, "utf-8");
    expect(contents).toContain("Unable to create configured logger");
  });

  it("a stack channel fans out to its configured constituent channels", async () => {
    const filePath = path.join(tmpDir, "combined.log");
    const manager = await buildManager({
      default: "everything",
      channels: {
        memory: { driver: "array" },
        file: { driver: "single", path: filePath },
        everything: { driver: "stack", channels: ["memory", "file"] },
      },
    });

    manager.channel().warning("fan out");

    expect((manager.channel("memory") as ArrayLogger).entries).toEqual([
      { level: "warning", message: "fan out", context: undefined },
    ]);
    expect(await readFile(filePath, "utf-8")).toContain("WARNING: fan out");
  });
});
