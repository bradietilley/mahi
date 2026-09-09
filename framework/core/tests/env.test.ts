import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadEnv } from "../src/env.js";

const TOUCHED_KEYS = ["APP_NAME", "APP_TIER", "MAHI_TEST_ONLY_IN_FILE"];

describe("loadEnv", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mahi-env-"));
  });

  afterEach(async () => {
    for (const key of TOUCHED_KEYS) {
      delete process.env[key];
    }

    await rm(dir, { recursive: true, force: true });
  });

  const schema = z.object({
    APP_NAME: z.string().optional(),
    APP_TIER: z.string().optional(),
    MAHI_TEST_ONLY_IN_FILE: z.string().optional(),
  });

  it("does NOT override a variable already present in the real environment", async () => {
    process.env.APP_NAME = "from-real-env";
    await writeFile(path.join(dir, ".env"), "APP_NAME=from-dotfile\n");

    loadEnv({ schema, path: path.join(dir, ".env"), environment: "production" });

    expect(process.env.APP_NAME).toBe("from-real-env");
  });

  it("still loads variables the real environment does not set", async () => {
    await writeFile(path.join(dir, ".env"), "MAHI_TEST_ONLY_IN_FILE=loaded\n");

    loadEnv({ schema, path: path.join(dir, ".env"), environment: "production" });

    expect(process.env.MAHI_TEST_ONLY_IN_FILE).toBe("loaded");
  });

  it("lets a more-specific file override a less-specific one", async () => {
    await writeFile(path.join(dir, ".env"), "APP_TIER=base\n");
    await writeFile(path.join(dir, ".env.production"), "APP_TIER=prod\n");

    loadEnv({ schema, path: path.join(dir, ".env"), environment: "production" });

    expect(process.env.APP_TIER).toBe("prod");
  });

  it("still lets the real environment win over a more-specific file", async () => {
    process.env.APP_TIER = "from-real-env";
    await writeFile(path.join(dir, ".env"), "APP_TIER=base\n");
    await writeFile(path.join(dir, ".env.production"), "APP_TIER=prod\n");

    loadEnv({ schema, path: path.join(dir, ".env"), environment: "production" });

    expect(process.env.APP_TIER).toBe("from-real-env");
  });
});
