import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp } from "@mahi/core";
import { EncryptionServiceProvider } from "../src/encryption-service-provider.js";
import { Hash } from "../src/hash-facade.js";

async function buildApp(): Promise<Application> {
  const app = new Application();
  app.instance("env", { APP_KEY: `base64:${randomBytes(32).toString("base64")}` });
  app.register(EncryptionServiceProvider);
  await app.bootstrap();

  return app;
}

describe("Hash facade", () => {
  afterEach(() => {
    clearCurrentApp();
  });

  it("make()/check() work via the current app()'s Hasher", async () => {
    await buildApp();
    const hash = await Hash.make("user-password");
    expect(await Hash.check("user-password", hash)).toBe(true);
    expect(await Hash.check("wrong-password", hash)).toBe(false);
  });

  it("throws app()'s own error when no Application has bootstrapped yet", () => {
    expect(() => Hash.make("value")).toThrow(/No Application instance is currently registered/);
  });
});
