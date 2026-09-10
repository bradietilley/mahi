import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveKey, parseAppKey, parsePreviousAppKeys } from "../src/app-key.js";

describe("parseAppKey", () => {
  it("parses a base64: prefixed key into a 32-byte Buffer", () => {
    const raw = `base64:${randomBytes(32).toString("base64")}`;
    const key = parseAppKey(raw);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("parses a bare base64 key (no prefix) into a 32-byte Buffer", () => {
    const raw = randomBytes(32).toString("base64");
    const key = parseAppKey(raw);
    expect(key.length).toBe(32);
  });

  it("throws when APP_KEY is unset", () => {
    expect(() => parseAppKey(undefined)).toThrow(/APP_KEY is not set/);
    expect(() => parseAppKey("")).toThrow(/APP_KEY is not set/);
  });

  it("throws when the decoded key isn't exactly 32 bytes", () => {
    const raw = randomBytes(16).toString("base64");
    expect(() => parseAppKey(raw)).toThrow(/32 bytes/);
  });
});

describe("deriveKey", () => {
  it("derives a 32-byte subkey", () => {
    const master = randomBytes(32);
    const derived = deriveKey(master, "encryption");
    expect(derived.length).toBe(32);
  });

  it("different contexts derive different keys from the same master key", () => {
    const master = randomBytes(32);
    const encryptionKey = deriveKey(master, "encryption");
    const signingKey = deriveKey(master, "signing");
    expect(encryptionKey.equals(signingKey)).toBe(false);
  });

  it("the same master key + context always derives the same subkey (deterministic)", () => {
    const master = randomBytes(32);
    expect(deriveKey(master, "encryption").equals(deriveKey(master, "encryption"))).toBe(true);
  });
});

describe("parsePreviousAppKeys", () => {
  it("returns an empty array when unset", () => {
    expect(parsePreviousAppKeys(undefined)).toEqual([]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parsePreviousAppKeys("")).toEqual([]);
  });

  it("parses a single previous key", () => {
    const raw = `base64:${randomBytes(32).toString("base64")}`;
    const keys = parsePreviousAppKeys(raw);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.length).toBe(32);
  });

  it("parses multiple comma-separated previous keys", () => {
    const key1 = `base64:${randomBytes(32).toString("base64")}`;
    const key2 = `base64:${randomBytes(32).toString("base64")}`;
    const keys = parsePreviousAppKeys(`${key1},${key2}`);
    expect(keys).toHaveLength(2);
    expect(keys[0]?.equals(parseAppKey(key1))).toBe(true);
    expect(keys[1]?.equals(parseAppKey(key2))).toBe(true);
  });

  it("trims whitespace around entries and ignores empty entries from trailing commas", () => {
    const key1 = `base64:${randomBytes(32).toString("base64")}`;
    const key2 = `base64:${randomBytes(32).toString("base64")}`;
    const keys = parsePreviousAppKeys(` ${key1} , ${key2} ,`);
    expect(keys).toHaveLength(2);
  });

  it("throws when an entry is malformed (wrong decoded length)", () => {
    const badKey = randomBytes(16).toString("base64");
    expect(() => parsePreviousAppKeys(badKey)).toThrow(/32 bytes/);
  });
});
