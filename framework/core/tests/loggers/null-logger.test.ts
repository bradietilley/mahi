import { describe, expect, it } from "vitest";
import { NullLogger } from "../../src/loggers/null-logger.js";

describe("NullLogger", () => {
  it("every level is a safe no-op", () => {
    const logger = new NullLogger();

    expect(() => {
      logger.debug("d");
      logger.info("i", { foo: "bar" });
      logger.warning("w");
      logger.error("e");
    }).not.toThrow();
  });
});
