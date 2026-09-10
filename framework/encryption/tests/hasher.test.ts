import { describe, expect, it } from "vitest";
import * as argon2 from "argon2";
import { Hasher } from "../src/hasher.js";

describe("Hasher", () => {
  it("make() produces a hash that check() validates correctly", async () => {
    const hasher = new Hasher();
    const hash = await hasher.make("correct-password");
    expect(await hasher.check("correct-password", hash)).toBe(true);
  });

  it("a wrong password fails check()", async () => {
    const hasher = new Hasher();
    const hash = await hasher.make("correct-password");
    expect(await hasher.check("wrong-password", hash)).toBe(false);
  });

  it("two make() calls on the same input produce different hashes (salting), but both check() successfully", async () => {
    const hasher = new Hasher();
    const hash1 = await hasher.make("same-input");
    const hash2 = await hasher.make("same-input");
    expect(hash1).not.toBe(hash2);
    expect(await hasher.check("same-input", hash1)).toBe(true);
    expect(await hasher.check("same-input", hash2)).toBe(true);
  });

  it("check() returns false (not throws) for a malformed hash", async () => {
    const hasher = new Hasher();
    await expect(hasher.check("value", "not-a-real-hash")).resolves.toBe(false);
  });

  it("needsRehash() is false for a hash it just produced", async () => {
    const hasher = new Hasher();
    const hash = await hasher.make("password");
    expect(hasher.needsRehash(hash)).toBe(false);
  });

  it("needsRehash() is true for a hash built with weaker parameters", async () => {
    const hasher = new Hasher();
    // Explicitly under-parameterised relative to argon2's defaults, which
    // is exactly the situation needsRehash() exists to detect.
    const weak = await argon2.hash("password", { timeCost: 2, memoryCost: 1 << 12 });
    expect(hasher.needsRehash(weak)).toBe(true);
  });

  it("needsRehash() returns true (not throws) for a malformed hash", () => {
    const hasher = new Hasher();
    expect(hasher.needsRehash("not-a-real-hash")).toBe(true);
  });

  it("make() produces an argon2id hash explicitly (not relying on the library default)", async () => {
    const hasher = new Hasher();
    const hash = await hasher.make("password");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("honours configured cost parameters", async () => {
    const hasher = new Hasher({ memory: 1 << 13, time: 2, threads: 1 });
    const hash = await hasher.make("password");

    // The chosen params are baked into the encoded hash…
    expect(hash).toContain("m=8192");
    expect(hash).toContain("t=2");
    expect(hash).toContain("p=1");
    // …and still verify round-trip.
    expect(await hasher.check("password", hash)).toBe(true);
  });

  it("needsRehash() is true when a hash's params differ from the configured cost", async () => {
    const weak = await new Hasher({ memory: 1 << 12, time: 2 }).make("password");
    const strong = new Hasher({ memory: 1 << 16, time: 4 });
    expect(strong.needsRehash(weak)).toBe(true);
  });

  it("needsRehash() is false for a hash this Hasher just made", async () => {
    const hasher = new Hasher({ memory: 1 << 13, time: 2, threads: 1 });
    expect(hasher.needsRehash(await hasher.make("password"))).toBe(false);
  });

  it("needsRehash() flags a hash made with a different argon2 variant", async () => {
    // The library's own needsRehash() compares only version/memory/time,
    // so an argon2i hash — the GPU-weak variant `make()` pins argon2id
    // specifically to avoid — reports "fine" and check() keeps accepting
    // it forever. A silent downgrade that survives every login.
    const argon2i = await argon2.hash("password", { type: argon2.argon2i });

    const hasher = new Hasher();
    expect(await hasher.check("password", argon2i)).toBe(true); // still verifies…
    expect(hasher.needsRehash(argon2i)).toBe(true); // …and must be upgraded
  });

  it("needsRehash() flags a hash made with different parallelism", async () => {
    const wide = await argon2.hash("password", { type: argon2.argon2id, parallelism: 4 });
    expect(new Hasher({ threads: 1 }).needsRehash(wide)).toBe(true);
  });

  it("needsRehash() ignores parallelism when it isn't configured", async () => {
    // An unconfigured Hasher takes the library default; pinning it here
    // would mean a library upgrade silently marked every stored hash
    // stale, forcing a fleet-wide rehash nobody asked for.
    const wide = await argon2.hash("password", { type: argon2.argon2id, parallelism: 4 });
    expect(new Hasher().needsRehash(wide)).toBe(false);
  });

  it("needsRehash() is true for a hash it cannot parse", async () => {
    // Fail-safe direction: the alternative is leaving a hash we can't
    // reason about in place forever.
    expect(new Hasher().needsRehash("not-a-hash")).toBe(true);
    expect(new Hasher().needsRehash("$bcrypt$v=19$whatever")).toBe(true);
  });
});
