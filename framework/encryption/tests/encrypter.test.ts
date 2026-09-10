import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Encrypter } from "../src/encrypter.js";

describe("Encrypter", () => {
  it("encrypt/decrypt round-trips correctly", () => {
    const encrypter = new Encrypter(randomBytes(32));
    const encrypted = encrypter.encrypt("sensitive value");
    expect(encrypted).not.toBe("sensitive value");
    expect(encrypter.decrypt(encrypted)).toBe("sensitive value");
  });

  it("decrypting with a different key throws", () => {
    const encrypter = new Encrypter(randomBytes(32));
    const other = new Encrypter(randomBytes(32));
    const encrypted = encrypter.encrypt("sensitive value");
    expect(() => other.decrypt(encrypted)).toThrow();
  });

  it("decrypting a tampered ciphertext throws (GCM authentication catches tampering)", () => {
    const encrypter = new Encrypter(randomBytes(32));
    const encrypted = encrypter.encrypt("sensitive value");
    const raw = Buffer.from(encrypted, "base64url");
    // flip one byte in the ciphertext portion (after iv + authTag)
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    const tampered = raw.toString("base64url");
    expect(() => encrypter.decrypt(tampered)).toThrow();
  });

  describe("auth tag length enforcement", () => {
    // Without `authTagLength: 16` on createDecipheriv, Node accepts
    // 4/8/12-byte GCM tags. A decrypt oracle then lets an attacker forge
    // at 2^-32 per attempt rather than 2^-128.
    it.each([4, 8, 12, 15])("rejects a payload carrying a %i-byte auth tag", (tagBytes) => {
      const encrypter = new Encrypter(randomBytes(32));
      const raw = Buffer.from(encrypter.encrypt("sensitive value"), "base64url");

      // version(1) + iv(12) + tag(16) + ct — rebuild with the tag truncated
      const version = raw.subarray(0, 1);
      const iv = raw.subarray(1, 13);
      const authTag = raw.subarray(13, 29);
      const ciphertext = raw.subarray(29);
      const truncated = Buffer.concat([
        version,
        iv,
        authTag.subarray(0, tagBytes),
        ciphertext,
      ]).toString("base64url");

      expect(() => encrypter.decrypt(truncated)).toThrow();
    });

    it("still round-trips with a full 16-byte tag", () => {
      const encrypter = new Encrypter(randomBytes(32));
      expect(encrypter.decrypt(encrypter.encrypt("sensitive value"))).toBe("sensitive value");
    });

    it("rejects a tampered auth tag", () => {
      const encrypter = new Encrypter(randomBytes(32));
      const raw = Buffer.from(encrypter.encrypt("sensitive value"), "base64url");
      raw[13] = raw[13]! ^ 0xff; // first byte of the tag
      expect(() => encrypter.decrypt(raw.toString("base64url"))).toThrow();
    });
  });

  describe("payload length guard", () => {
    it("rejects a payload shorter than version + iv + tag", () => {
      const encrypter = new Encrypter(randomBytes(32));
      const raw = Buffer.from(encrypter.encrypt("sensitive value"), "base64url");

      for (const length of [0, 1, 13, 28]) {
        const short = raw.subarray(0, length).toString("base64url");
        expect(() => encrypter.decrypt(short)).toThrow();
      }
    });

    it("accepts the minimum valid payload — an encrypted empty string", () => {
      const encrypter = new Encrypter(randomBytes(32));
      const encrypted = encrypter.encrypt("");
      expect(Buffer.from(encrypted, "base64url")).toHaveLength(29);
      expect(encrypter.decrypt(encrypted)).toBe("");
    });

    it("rejects a payload that isn't valid base64url at all", () => {
      const encrypter = new Encrypter(randomBytes(32));
      expect(() => encrypter.decrypt("not-a-real-payload")).toThrow();
      expect(() => encrypter.decrypt("")).toThrow();
    });
  });

  describe("version byte", () => {
    it("prefixes payloads with version 1", () => {
      const encrypter = new Encrypter(randomBytes(32));
      expect(Buffer.from(encrypter.encrypt("value"), "base64url")[0]).toBe(1);
    });

    it("rejects an unknown version byte", () => {
      const encrypter = new Encrypter(randomBytes(32));
      const raw = Buffer.from(encrypter.encrypt("value"), "base64url");
      raw[0] = 2;
      expect(() => encrypter.decrypt(raw.toString("base64url"))).toThrow();
    });
  });

  describe("additional authenticated data", () => {
    it("round-trips when the same aad is supplied to both calls", () => {
      const encrypter = new Encrypter(randomBytes(32));
      const encrypted = encrypter.encrypt("secret", "users.ssn");
      expect(encrypter.decrypt(encrypted, "users.ssn")).toBe("secret");
    });

    it("fails when decrypting under a different aad — no cross-context replay", () => {
      const encrypter = new Encrypter(randomBytes(32));
      const encrypted = encrypter.encrypt("secret", "users.ssn");
      expect(() => encrypter.decrypt(encrypted, "users.notes")).toThrow();
    });

    it("fails when an aad-bound payload is decrypted without one, and vice versa", () => {
      const encrypter = new Encrypter(randomBytes(32));
      expect(() => encrypter.decrypt(encrypter.encrypt("secret", "ctx"))).toThrow();
      expect(() => encrypter.decrypt(encrypter.encrypt("secret"), "ctx")).toThrow();
    });

    it("still honours key rotation with an aad", () => {
      const oldKey = randomBytes(32);
      const newKey = randomBytes(32);
      const encrypted = new Encrypter(oldKey).encrypt("secret", "ctx");
      expect(new Encrypter(newKey, [oldKey]).decrypt(encrypted, "ctx")).toBe("secret");
    });
  });

  it("constructor rejects a key that isn't exactly 32 bytes", () => {
    expect(() => new Encrypter(randomBytes(16))).toThrow();
    expect(() => new Encrypter(randomBytes(31))).toThrow();
    expect(() => new Encrypter(randomBytes(33))).toThrow();
  });

  it("constructor rejects a previous key that isn't exactly 32 bytes", () => {
    expect(() => new Encrypter(randomBytes(32), [randomBytes(16)])).toThrow();
  });

  describe("key rotation", () => {
    it("decrypts data encrypted under a previous key once it's passed to previousKeys", () => {
      const oldKey = randomBytes(32);
      const newKey = randomBytes(32);

      const oldEncrypter = new Encrypter(oldKey);
      const encrypted = oldEncrypter.encrypt("secret from before rotation");

      const rotatedEncrypter = new Encrypter(newKey, [oldKey]);
      expect(rotatedEncrypter.decrypt(encrypted)).toBe("secret from before rotation");
    });

    it("encrypt() always uses the current key, never a previous one", () => {
      const oldKey = randomBytes(32);
      const newKey = randomBytes(32);
      const rotatedEncrypter = new Encrypter(newKey, [oldKey]);

      const encrypted = rotatedEncrypter.encrypt("new secret");

      // An Encrypter with only the old key as its *current* key should
      // NOT be able to decrypt something encrypted after rotation.
      const oldOnlyEncrypter = new Encrypter(oldKey);
      expect(() => oldOnlyEncrypter.decrypt(encrypted)).toThrow();
    });

    it("tries previous keys in order and still throws if none match", () => {
      const key = randomBytes(32);
      const wrongKey1 = randomBytes(32);
      const wrongKey2 = randomBytes(32);
      const encrypter = new Encrypter(key);
      const encrypted = encrypter.encrypt("secret");

      const otherEncrypter = new Encrypter(randomBytes(32), [wrongKey1, wrongKey2]);
      expect(() => otherEncrypter.decrypt(encrypted)).toThrow();
    });
  });
});
