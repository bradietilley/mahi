import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Application } from "@mahi/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyGenerateCommand } from "../../src/commands/key-generate.js";

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "key-generate-test-"));
  envPath = path.join(dir, ".env");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(options: { path: string; force?: boolean }) {
  const app = new Application();
  const command = new KeyGenerateCommand(app);

  return command.handle({ path: options.path, force: options.force ?? false });
}

describe("KeyGenerateCommand", () => {
  it("writes an APP_KEY in the expected base64:... format when .env doesn't exist yet", async () => {
    await run({ path: envPath });
    const content = readFileSync(envPath, "utf-8");
    const match = content.match(/^APP_KEY=(base64:.+)$/m);
    expect(match).not.toBeNull();
  });

  it("two invocations against separate files produce different keys", async () => {
    const envPath2 = path.join(dir, ".env2");
    await run({ path: envPath });
    await run({ path: envPath2 });
    const key1 = readFileSync(envPath, "utf-8").match(/^APP_KEY=(.+)$/m)?.[1];
    const key2 = readFileSync(envPath2, "utf-8").match(/^APP_KEY=(.+)$/m)?.[1];
    expect(key1).toBeDefined();
    expect(key2).toBeDefined();
    expect(key1).not.toBe(key2);
  });

  it("does not overwrite an existing APP_KEY by default", async () => {
    writeFileSync(envPath, "APP_KEY=base64:existing-key\nOTHER=value\n");
    await run({ path: envPath });
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("APP_KEY=base64:existing-key");
  });

  it("overwrites an existing APP_KEY when --force is passed", async () => {
    writeFileSync(envPath, "APP_KEY=base64:existing-key\nOTHER=value\n");
    await run({ path: envPath, force: true });
    const content = readFileSync(envPath, "utf-8");
    expect(content).not.toContain("APP_KEY=base64:existing-key");
    expect(content).toMatch(/^APP_KEY=base64:.+$/m);
    expect(content).toContain("OTHER=value");
  });

  it("preserves other existing lines in .env when adding APP_KEY", async () => {
    writeFileSync(envPath, "NODE_ENV=development\nPORT=3000\n");
    await run({ path: envPath });
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("NODE_ENV=development");
    expect(content).toContain("PORT=3000");
    expect(content).toMatch(/^APP_KEY=base64:.+$/m);
  });
});
