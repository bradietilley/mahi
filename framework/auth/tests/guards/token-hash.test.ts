import { describe, expect, it } from "vitest";
import { hashToken, splitToken, verifyTokenHash } from "../../src/guards/token-hash.js";

describe("token hashing", () => {
  it("hashToken() is deterministic and hex-encoded", () => {
    expect(hashToken("secret")).toBe(hashToken("secret"));
    expect(hashToken("secret")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different secrets produce different digests", () => {
    expect(hashToken("secret-a")).not.toBe(hashToken("secret-b"));
  });

  it("verifyTokenHash() accepts the matching secret and rejects others", () => {
    const digest = hashToken("the-secret");
    expect(verifyTokenHash("the-secret", digest)).toBe(true);
    expect(verifyTokenHash("the-secre", digest)).toBe(false);
    expect(verifyTokenHash("", digest)).toBe(false);
  });

  it("verifyTokenHash() returns false (not throws) for a malformed digest", () => {
    expect(verifyTokenHash("secret", "not-hex")).toBe(false);
    expect(verifyTokenHash("secret", "")).toBe(false);
  });

  describe("splitToken", () => {
    it("splits the '<id>|<secret>' format", () => {
      expect(splitToken("abc|xyz")).toEqual(["abc", "xyz"]);
    });

    it("keeps later pipes as part of the secret", () => {
      // base64url never emits '|', but being lenient here costs nothing
      // and avoids a silent truncation bug if the encoding ever changes.
      expect(splitToken("abc|xy|z")).toEqual(["abc", "xy|z"]);
    });

    it("rejects anything without a usable id and secret", () => {
      expect(splitToken("no-separator")).toBeNull();
      expect(splitToken("|leading-separator")).toBeNull();
      expect(splitToken("trailing-separator|")).toBeNull();
      expect(splitToken("")).toBeNull();
    });
  });
});
