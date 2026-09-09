import { describe, expect, it } from "vitest";
import { ArrayLogger } from "../../src/loggers/array-logger.js";

describe("ArrayLogger", () => {
  it("collects entries in call order instead of writing anywhere", () => {
    const logger = new ArrayLogger();

    logger.debug("d");
    logger.info("i", { foo: "bar" });
    logger.warning("w");
    logger.error("e", { code: 42 });

    expect(logger.entries).toEqual([
      { level: "debug", message: "d", context: undefined },
      { level: "info", message: "i", context: { foo: "bar" } },
      { level: "warning", message: "w", context: undefined },
      { level: "error", message: "e", context: { code: 42 } },
    ]);
  });

  it("records all eight PSR-3 levels and the generic log()", () => {
    const logger = new ArrayLogger();

    logger.emergency("em");
    logger.alert("a");
    logger.critical("c");
    logger.notice("n");
    logger.log("info", "via-log");

    expect(logger.entries.map((e) => e.level)).toEqual([
      "emergency",
      "alert",
      "critical",
      "notice",
      "info",
    ]);
  });

  it("starts empty", () => {
    expect(new ArrayLogger().entries).toEqual([]);
  });
});
