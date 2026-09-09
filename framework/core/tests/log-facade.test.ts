import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application } from "../src/application.js";
import { clearCurrentApp } from "../src/global-app.js";
import { LoggingServiceProvider } from "../src/logging-service-provider.js";
import type { LogConfig } from "../src/log-manager.js";
import { ArrayLogger } from "../src/loggers/array-logger.js";
import { Log } from "../src/log-facade.js";
import { Context } from "../src/context-facade.js";

async function buildApp(config: LogConfig): Promise<Application> {
  const app = new Application();
  app.config.set("logging", config);
  app.register(LoggingServiceProvider);
  await app.bootstrap();

  return app;
}

describe("Log facade", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-log-facade-test-"));
  });

  afterEach(async () => {
    clearCurrentApp();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws when no Application has bootstrapped yet, same as app()", () => {
    expect(() => Log.info("hello")).toThrow(/No Application instance is currently registered/);
  });

  it("every PSR-3 level (and log()) writes through the current app()'s default channel", async () => {
    await buildApp({ default: "array", channels: { array: { driver: "array" } } });

    Log.debug("d");
    Log.info("i", { foo: "bar" });
    Log.notice("n");
    Log.warning("w");
    Log.error("e");
    Log.critical("c");
    Log.alert("a");
    Log.emergency("em");
    Log.log("info", "via-log");

    const array = Log.channel() as ArrayLogger;
    expect(array.entries).toEqual([
      { level: "debug", message: "d", context: undefined },
      { level: "info", message: "i", context: { foo: "bar" } },
      { level: "notice", message: "n", context: undefined },
      { level: "warning", message: "w", context: undefined },
      { level: "error", message: "e", context: undefined },
      { level: "critical", message: "c", context: undefined },
      { level: "alert", message: "a", context: undefined },
      { level: "emergency", message: "em", context: undefined },
      { level: "info", message: "via-log", context: undefined },
    ]);
  });

  it("channel(name) resolves a specific named channel, independent of the default", async () => {
    await buildApp({
      default: "console",
      channels: { console: { driver: "console" }, array: { driver: "array" } },
    });

    const logger = Log.channel("array") as ArrayLogger;
    logger.info("only on the named channel");

    expect(logger.entries).toEqual([
      { level: "info", message: "only on the named channel", context: undefined },
    ]);
  });

  it("a message logged through 'stack' reaches every constituent channel, including a file-backed one", async () => {
    const filePath = path.join(tmpDir, "app.log");
    await buildApp({
      default: "stack",
      channels: {
        array: { driver: "array" },
        single: { driver: "single", path: filePath },
        stack: { driver: "stack", channels: ["array", "single"] },
      },
    });

    Log.info("goes everywhere");

    const contents = await readFile(filePath, "utf-8");
    expect(contents).toContain("INFO: goes everywhere");
  });

  it("provider-built channels render env.LEVEL and Context facade data on every line", async () => {
    const filePath = path.join(tmpDir, "context.log");
    const app = await buildApp({
      default: "single",
      channels: { single: { driver: "single", path: filePath } },
    });
    app.useEnvironment("production");

    Context.add("deploy", "abc123");
    Log.warning("cache stale", { key: "users" });

    const contents = await readFile(filePath, "utf-8");
    expect(contents).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] production\.WARNING: cache stale \{"key":"users"\} \{"deploy":"abc123"\}\n$/,
    );
  });

  it("instance() resolves the LogManager itself", async () => {
    await buildApp({ default: "array", channels: { array: { driver: "array" } } });

    expect(Log.instance().channel()).toBeInstanceOf(ArrayLogger);
  });
});
