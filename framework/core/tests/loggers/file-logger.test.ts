import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileLogger } from "../../src/loggers/file-logger.js";

describe("FileLogger", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "mahi-file-logger-test-"));
    filePath = path.join(tmpDir, "logs", "app.log");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("appends a formatted line to the file, creating parent directories as needed", async () => {
    const logger = new FileLogger(filePath);
    logger.info("hello");

    const contents = await readFile(filePath, "utf-8");
    expect(contents).toMatch(/^\[.+\] INFO: hello\n$/);
  });

  it("appends context as trailing JSON, same shape as ConsoleLogger's format", async () => {
    const logger = new FileLogger(filePath);
    logger.error("boom", { code: 42 });

    const contents = await readFile(filePath, "utf-8");
    expect(contents).toMatch(/^\[.+\] ERROR: boom \{"code":42\}\n$/);
  });

  it("subsequent calls append rather than overwrite", async () => {
    const logger = new FileLogger(filePath);
    logger.debug("first");
    logger.warning("second");

    const contents = await readFile(filePath, "utf-8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("DEBUG: first");
    expect(lines[1]).toContain("WARNING: second");
  });

  it("an unwritable path does not throw — the line falls back to stderr", () => {
    // A directory where a file is expected: appendFileSync will EISDIR.
    // Point the logger at tmpDir itself (a directory), so the write fails.
    const logger = new FileLogger(tmpDir);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(() => logger.error("cannot write this")).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("ERROR: cannot write this"));

    stderr.mockRestore();
  });

  it("an unwritable directory at construction does not throw", () => {
    // Constructing under a path whose parent is a file (not a dir) makes
    // mkdirSync throw; the constructor must swallow it.
    const notADir = path.join(tmpDir, "logs", "app.log");
    new FileLogger(notADir); // succeeds (dir creatable) — sanity
    const nested = path.join(notADir, "deeper", "x.log"); // parent is a file
    expect(() => new FileLogger(nested)).not.toThrow();
  });
});
