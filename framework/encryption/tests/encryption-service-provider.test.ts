import { randomBytes } from "node:crypto";
import { Application } from "@mahi/core";
import { describe, expect, it } from "vitest";
import {
  EncryptionServiceProvider,
  ENCRYPTER_TOKEN,
  HASHER_TOKEN,
  SIGNER_TOKEN,
} from "../src/encryption-service-provider.js";
import { Encrypter } from "../src/encrypter.js";
import { Hasher } from "../src/hasher.js";
import { Signer } from "../src/signer.js";
import { KeyGenerateCommand } from "../src/commands/key-generate.js";

async function buildApp(): Promise<Application> {
  const app = new Application();
  app.instance("env", { APP_KEY: `base64:${randomBytes(32).toString("base64")}` });
  app.register(EncryptionServiceProvider);
  await app.bootstrap();

  return app;
}

describe("EncryptionServiceProvider", () => {
  it("registers an Encrypter singleton that can round-trip data", async () => {
    const app = await buildApp();
    const encrypter = app.make<Encrypter>(ENCRYPTER_TOKEN);
    expect(encrypter).toBeInstanceOf(Encrypter);
    expect(encrypter.decrypt(encrypter.encrypt("hello"))).toBe("hello");
  });

  it("registers a Hasher singleton", async () => {
    const app = await buildApp();
    const hasher = app.make<Hasher>(HASHER_TOKEN);
    expect(hasher).toBeInstanceOf(Hasher);
    const hash = await hasher.make("pw");
    expect(await hasher.check("pw", hash)).toBe(true);
  });

  it("registers a Signer singleton", async () => {
    const app = await buildApp();
    const signer = app.make<Signer>(SIGNER_TOKEN);
    expect(signer).toBeInstanceOf(Signer);
    expect(signer.verify(signer.sign("payload"))).toBe("payload");
  });

  it("derives keys deterministically from APP_KEY (same env produces interoperable Signer instances across apps)", async () => {
    // Key derivation itself (that Encrypter and Signer get *different*
    // derived keys from the same APP_KEY) is covered directly in
    // app-key.test.ts; this just confirms the provider wiring produces
    // a deterministic, reproducible Signer key given the same APP_KEY.
    const appKey = `base64:${randomBytes(32).toString("base64")}`;
    const appA = new Application();
    appA.instance("env", { APP_KEY: appKey });
    appA.register(EncryptionServiceProvider);
    await appA.bootstrap();

    const appB = new Application();
    appB.instance("env", { APP_KEY: appKey });
    appB.register(EncryptionServiceProvider);
    await appB.bootstrap();

    const signerA = appA.make<Signer>(SIGNER_TOKEN);
    const signerB = appB.make<Signer>(SIGNER_TOKEN);
    const token = signerA.sign("payload");
    expect(signerB.verify(token)).toBe("payload");
  });

  it("throws when APP_KEY is missing on env", async () => {
    const app = new Application();
    app.instance("env", { APP_KEY: "" });
    app.register(EncryptionServiceProvider);
    await app.bootstrap();
    expect(() => app.make<Encrypter>(ENCRYPTER_TOKEN)).toThrow(/APP_KEY is not set/);
  });

  it("exposes KeyGenerateCommand via commands()", async () => {
    const app = new Application();
    const provider = new EncryptionServiceProvider(app);
    expect(provider.commands()).toEqual([KeyGenerateCommand]);
  });

  describe("APP_PREVIOUS_KEYS wiring", () => {
    it("Encrypter decrypts data encrypted under a previous APP_KEY once it's listed in APP_PREVIOUS_KEYS", async () => {
      const oldAppKey = `base64:${randomBytes(32).toString("base64")}`;
      const newAppKey = `base64:${randomBytes(32).toString("base64")}`;

      const oldApp = new Application();
      oldApp.instance("env", { APP_KEY: oldAppKey });
      oldApp.register(EncryptionServiceProvider);
      await oldApp.bootstrap();
      const encrypted = oldApp
        .make<Encrypter>(ENCRYPTER_TOKEN)
        .encrypt("secret from before rotation");

      const rotatedApp = new Application();
      rotatedApp.instance("env", { APP_KEY: newAppKey, APP_PREVIOUS_KEYS: oldAppKey });
      rotatedApp.register(EncryptionServiceProvider);
      await rotatedApp.bootstrap();

      const decrypted = rotatedApp.make<Encrypter>(ENCRYPTER_TOKEN).decrypt(encrypted);
      expect(decrypted).toBe("secret from before rotation");
    });

    it("Signer verifies a token signed under a previous APP_KEY once it's listed in APP_PREVIOUS_KEYS", async () => {
      const oldAppKey = `base64:${randomBytes(32).toString("base64")}`;
      const newAppKey = `base64:${randomBytes(32).toString("base64")}`;

      const oldApp = new Application();
      oldApp.instance("env", { APP_KEY: oldAppKey });
      oldApp.register(EncryptionServiceProvider);
      await oldApp.bootstrap();
      const token = oldApp.make<Signer>(SIGNER_TOKEN).sign("payload-from-before-rotation");

      const rotatedApp = new Application();
      rotatedApp.instance("env", { APP_KEY: newAppKey, APP_PREVIOUS_KEYS: oldAppKey });
      rotatedApp.register(EncryptionServiceProvider);
      await rotatedApp.bootstrap();

      expect(rotatedApp.make<Signer>(SIGNER_TOKEN).verify(token)).toBe(
        "payload-from-before-rotation",
      );
    });

    it("without APP_PREVIOUS_KEYS, data encrypted under the old key is no longer decryptable after rotation", async () => {
      const oldAppKey = `base64:${randomBytes(32).toString("base64")}`;
      const newAppKey = `base64:${randomBytes(32).toString("base64")}`;

      const oldApp = new Application();
      oldApp.instance("env", { APP_KEY: oldAppKey });
      oldApp.register(EncryptionServiceProvider);
      await oldApp.bootstrap();
      const encrypted = oldApp.make<Encrypter>(ENCRYPTER_TOKEN).encrypt("secret");

      const rotatedApp = new Application();
      rotatedApp.instance("env", { APP_KEY: newAppKey }); // no APP_PREVIOUS_KEYS
      rotatedApp.register(EncryptionServiceProvider);
      await rotatedApp.bootstrap();

      expect(() => rotatedApp.make<Encrypter>(ENCRYPTER_TOKEN).decrypt(encrypted)).toThrow();
    });
  });
});
