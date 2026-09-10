import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Signer } from "../src/signer.js";

describe("Signer", () => {
  it("sign()/verify() round-trips", () => {
    const signer = new Signer(randomBytes(32));
    const token = signer.sign("payload-data");
    expect(signer.verify(token)).toBe("payload-data");
  });

  it("a tampered payload fails verify() (returns null, doesn't throw)", () => {
    const signer = new Signer(randomBytes(32));
    const token = signer.sign("payload-data");
    const tampered = token.replace("payload-data", "payload-evil");
    expect(signer.verify(tampered)).toBeNull();
  });

  it("a tampered signature fails verify()", () => {
    const signer = new Signer(randomBytes(32));
    const token = signer.sign("payload-data");
    const tampered = `${token}x`;
    expect(signer.verify(tampered)).toBeNull();
  });

  it("verifying a payload signed with a different key fails", () => {
    const signer = new Signer(randomBytes(32));
    const other = new Signer(randomBytes(32));
    const token = signer.sign("payload-data");
    expect(other.verify(token)).toBeNull();
  });

  it("a malformed input with no '.' separator returns null rather than throwing", () => {
    const signer = new Signer(randomBytes(32));
    expect(signer.verify("no-dot-here")).toBeNull();
  });

  describe("key length", () => {
    it("rejects an empty key", () => {
      expect(() => new Signer(Buffer.alloc(0))).toThrow();
    });

    it("rejects a key shorter than 32 bytes", () => {
      expect(() => new Signer(randomBytes(16))).toThrow();
      expect(() => new Signer(randomBytes(31))).toThrow();
    });

    it("rejects a short previous key", () => {
      expect(() => new Signer(randomBytes(32), [randomBytes(8)])).toThrow();
    });

    it("accepts 32 bytes and longer", () => {
      expect(() => new Signer(randomBytes(32))).not.toThrow();
      expect(() => new Signer(randomBytes(64))).not.toThrow();
    });
  });

  describe("purpose separation", () => {
    it("a signature for purpose A does not verify under purpose B", () => {
      const signer = new Signer(randomBytes(32));
      const token = signer.for("url").sign("/reset?user=1");
      expect(signer.for("session").verify(token)).toBeNull();
    });

    it("a purpose-scoped signature does not verify under the root signer", () => {
      const signer = new Signer(randomBytes(32));
      const token = signer.for("session").sign("session-id");
      expect(signer.verify(token)).toBeNull();
    });

    it("a root signature does not verify under a purpose", () => {
      const signer = new Signer(randomBytes(32));
      const token = signer.sign("session-id");
      expect(signer.for("session").verify(token)).toBeNull();
    });

    it("the same purpose round-trips, and is stable across calls to for()", () => {
      const signer = new Signer(randomBytes(32));
      const token = signer.for("session").sign("session-id");
      expect(signer.for("session").verify(token)).toBe("session-id");
    });

    it("different root keys give different signatures for the same purpose", () => {
      const token = new Signer(randomBytes(32)).for("url").sign("/a");
      expect(new Signer(randomBytes(32)).for("url").verify(token)).toBeNull();
    });

    it("key rotation still works through a purpose", () => {
      const oldKey = randomBytes(32);
      const newKey = randomBytes(32);

      const token = new Signer(oldKey).for("session").sign("session-id");

      const rotated = new Signer(newKey, [oldKey]).for("session");
      expect(rotated.verify(token)).toBe("session-id");
    });
  });

  describe("key rotation", () => {
    it("verifies a token signed under a previous key once it's passed to previousKeys", () => {
      const oldKey = randomBytes(32);
      const newKey = randomBytes(32);

      const oldSigner = new Signer(oldKey);
      const token = oldSigner.sign("payload-from-before-rotation");

      const rotatedSigner = new Signer(newKey, [oldKey]);
      expect(rotatedSigner.verify(token)).toBe("payload-from-before-rotation");
    });

    it("sign() always uses the current key, never a previous one", () => {
      const oldKey = randomBytes(32);
      const newKey = randomBytes(32);
      const rotatedSigner = new Signer(newKey, [oldKey]);

      const token = rotatedSigner.sign("new payload");

      const oldOnlySigner = new Signer(oldKey);
      expect(oldOnlySigner.verify(token)).toBeNull();
    });

    it("tries previous keys in order and still returns null if none match", () => {
      const key = randomBytes(32);
      const wrongKey1 = randomBytes(32);
      const wrongKey2 = randomBytes(32);
      const signer = new Signer(key);
      const token = signer.sign("payload");

      const otherSigner = new Signer(randomBytes(32), [wrongKey1, wrongKey2]);
      expect(otherSigner.verify(token)).toBeNull();
    });
  });
});
