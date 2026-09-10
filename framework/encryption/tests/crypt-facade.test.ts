import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp } from "@mahi/core";
import { EncryptionServiceProvider } from "../src/encryption-service-provider.js";
import { Crypt } from "../src/crypt-facade.js";

async function buildApp(): Promise<Application> {
  const app = new Application();
  app.instance("env", { APP_KEY: `base64:${randomBytes(32).toString("base64")}` });
  app.register(EncryptionServiceProvider);
  await app.bootstrap();

  return app;
}

describe("Crypt facade", () => {
  afterEach(() => {
    clearCurrentApp();
  });

  it("encrypt()/decrypt() round-trip via the current app()'s Encrypter", async () => {
    await buildApp();
    const encrypted = Crypt.encrypt("sensitive value");
    expect(encrypted).not.toBe("sensitive value");
    expect(encrypted).toMatch(/^[a-zA-Z0-9_-]{50,70}$/);
    expect(Crypt.decrypt(encrypted)).toBe("sensitive value");
  });

  it("forwards aad to the underlying Encrypter on both calls", async () => {
    await buildApp();
    const encrypted = Crypt.encrypt("sensitive value", "users.ssn");
    expect(encrypted).not.toBe("sensitive value");
    expect(encrypted).toMatch(/^[a-zA-Z0-9_-]{50,70}$/);
    expect(Crypt.decrypt(encrypted, "users.ssn")).toBe("sensitive value");
    // Would pass silently if the facade dropped the argument.
    expect(() => Crypt.decrypt(encrypted, "users.notes")).toThrow();
    expect(() => Crypt.decrypt(encrypted)).toThrow();
  });

  it("throws app()'s own error when no Application has bootstrapped yet", () => {
    expect(() => Crypt.encrypt("value")).toThrow(/No Application instance is currently registered/);
  });
});
