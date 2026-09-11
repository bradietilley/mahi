import { describe, expect, it } from "vitest";
import { SequentialIdentifierResolver } from "../src/identifier-resolvers/sequential-identifier-resolver.js";

describe("SequentialIdentifierResolver", () => {
  it("issues 9000000000000000001 then increments, grouped independently", () => {
    const resolver = new SequentialIdentifierResolver();

    expect(String(resolver.identifier(0, 0, "User"))).toBe("9000000000000000001");
    expect(String(resolver.identifier(0, 0, "User"))).toBe("9000000000000000002");
    expect(String(resolver.identifier(0, 0, "Post"))).toBe("9000000000000000001");
    expect(String(resolver.identifier(0, 0, "User"))).toBe("9000000000000000003");
  });

  it("reset() restarts counters", () => {
    const resolver = new SequentialIdentifierResolver();
    resolver.identifier(0, 0, "User");
    resolver.reset();
    expect(String(resolver.identifier(0, 0, "User"))).toBe("9000000000000000001");
  });
});
