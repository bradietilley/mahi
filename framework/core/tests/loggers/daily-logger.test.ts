import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailyLogger } from "../../src/loggers/daily-logger.js";

describe("DailyLogger", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-daily-logger-test-"));
    filePath = path.join(tmpDir, "logs", "mahi.log");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes to a UTC-date-suffixed file derived from the configured path, not the path itself", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));

    const logger = new DailyLogger(filePath);
    logger.info("hello");

    const expectedPath = path.join(tmpDir, "logs", "mahi-2026-08-21.log");
    const contents = await readFile(expectedPath, "utf-8");
    expect(contents).toMatch(/INFO: hello/);

    await expect(readFile(filePath, "utf-8")).rejects.toThrow();
  });

  it("uses the UTC date for the filename so it agrees with the UTC line timestamps around midnight", async () => {
    vi.useFakeTimers();
    // 23:30 UTC on the 21st — a machine in e.g. UTC+2 would compute a
    // *local* date of the 22nd, disagreeing with the UTC line timestamp.
    vi.setSystemTime(new Date("2026-08-21T23:30:00Z"));

    const logger = new DailyLogger(filePath);
    logger.info("near midnight");

    const contents = await readFile(path.join(tmpDir, "logs", "mahi-2026-08-21.log"), "utf-8");
    // The line timestamp (UTC) and the filename date must match.
    expect(contents).toMatch(/\[2026-08-21 23:30:00\]/);
  });

  it("rotates to a new file when the date changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));

    const logger = new DailyLogger(filePath);
    logger.info("day one");

    vi.setSystemTime(new Date("2026-08-22T12:00:00Z"));
    logger.info("day two");

    const day1 = await readFile(path.join(tmpDir, "logs", "mahi-2026-08-21.log"), "utf-8");
    const day2 = await readFile(path.join(tmpDir, "logs", "mahi-2026-08-22.log"), "utf-8");
    expect(day1).toContain("day one");
    expect(day2).toContain("day two");
  });

  it("prunes files older than maxFiles, keeping only the most recent", async () => {
    vi.useFakeTimers();

    const logger = new DailyLogger(filePath, 2);

    vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));
    logger.info("d1");
    vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
    logger.info("d2");
    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
    logger.info("d3");

    const files = (await readdir(path.join(tmpDir, "logs"))).sort();
    expect(files).toEqual(["mahi-2026-08-20.log", "mahi-2026-08-21.log"]);
  });

  it("without maxFiles, no pruning happens", async () => {
    vi.useFakeTimers();

    const logger = new DailyLogger(filePath);

    vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));
    logger.info("d1");
    vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
    logger.info("d2");

    const files = (await readdir(path.join(tmpDir, "logs"))).sort();
    expect(files).toEqual(["mahi-2026-08-19.log", "mahi-2026-08-20.log"]);
  });

  it("with maxFiles: 0 (Laravel's 'unlimited'), keeps every file instead of wiping them", async () => {
    vi.useFakeTimers();

    const logger = new DailyLogger(filePath, 0);

    vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));
    logger.info("d1");
    vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
    logger.info("d2");
    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
    logger.info("d3");

    const files = (await readdir(path.join(tmpDir, "logs"))).sort();
    expect(files).toEqual(["mahi-2026-08-19.log", "mahi-2026-08-20.log", "mahi-2026-08-21.log"]);
  });
});
