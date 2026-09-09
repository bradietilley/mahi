import { afterEach, describe, expect, it, vi } from "vitest";
import { Application } from "../src/application.js";
import { ContextRepository } from "../src/context.js";
import { ConsoleLogger, formatLogLine, safeStringify, type LogSource } from "../src/logger.js";

const TIMESTAMP = String.raw`\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]`;

function makeSource(environment = "production"): LogSource {
  return { environment: () => environment, context: new ContextRepository() };
}

describe("formatLogLine", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a Laravel-style timestamp and bare uppercased level when no source is given", () => {
    expect(formatLogLine("info", "hello")).toMatch(new RegExp(`^${TIMESTAMP} INFO: hello$`));
  });

  it("renders env.LEVEL when a source is given — Laravel's production.DEBUG style", () => {
    expect(formatLogLine("debug", "hello", undefined, makeSource())).toMatch(
      new RegExp(`^${TIMESTAMP} production\\.DEBUG: hello$`),
    );
    expect(formatLogLine("error", "boom", undefined, makeSource("local"))).toMatch(
      new RegExp(`^${TIMESTAMP} local\\.ERROR: boom$`),
    );
  });

  it("appends per-call context as trailing JSON", () => {
    expect(formatLogLine("info", "msg", { code: 42 }, makeSource())).toMatch(
      /production\.INFO: msg \{"code":42\}$/,
    );
  });

  it("appends global context after per-call context — Laravel's %context% %extra% order", () => {
    const source = makeSource();
    source.context.add("deploy", "abc123");

    expect(formatLogLine("warn", "msg", { per: "call" }, source)).toMatch(
      /production\.WARN: msg \{"per":"call"\} \{"deploy":"abc123"\}$/,
    );
  });

  it("appends global context even without per-call context", () => {
    const source = makeSource();
    source.context.add("deploy", "abc123");

    expect(formatLogLine("info", "msg", undefined, source)).toMatch(
      /production\.INFO: msg \{"deploy":"abc123"\}$/,
    );
  });

  it("omits both JSON objects entirely when empty — ignoreEmptyContextAndExtra", () => {
    expect(formatLogLine("info", "msg", {}, makeSource())).toMatch(/production\.INFO: msg$/);
  });

  it("reflects context changes made after the source was captured (read at format time)", () => {
    const source = makeSource();

    expect(formatLogLine("info", "before", undefined, source)).toMatch(/before$/);
    source.context.add("late", true);
    expect(formatLogLine("info", "after", undefined, source)).toMatch(/after \{"late":true\}$/);
  });
});

describe("formatLogLine context serialization (safe)", () => {
  it("renders an Error's name/message/stack instead of the useless {}", () => {
    const line = formatLogLine("error", "failed", { error: new Error("boom") });
    expect(line).toContain('"name":"Error"');
    expect(line).toContain('"message":"boom"');
    expect(line).toContain('"stack":"Error: boom');
  });

  it("includes an Error's cause when present", () => {
    const err = new Error("outer", { cause: new Error("inner") });
    const line = formatLogLine("error", "failed", { error: err });
    expect(line).toContain('"cause":{');
    expect(line).toContain('"message":"inner"');
  });

  it("does not throw on a circular context — renders [Circular] instead", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular["self"] = circular;
    expect(() => formatLogLine("info", "msg", circular)).not.toThrow();
    expect(formatLogLine("info", "msg", circular)).toContain('"self":"[Circular]"');
  });

  it("serializes BigInt as a decimal string instead of throwing", () => {
    expect(() => formatLogLine("info", "msg", { n: 1n })).not.toThrow();
    expect(formatLogLine("info", "msg", { n: 42n })).toContain('"n":"42"');
  });

  it("serializes Date as ISO 8601", () => {
    const line = formatLogLine("info", "msg", { at: new Date("2026-08-21T00:00:00Z") });
    expect(line).toContain('"at":"2026-08-21T00:00:00.000Z"');
  });
});

describe("safeStringify", () => {
  it("caps deep nesting with [Object] rather than recursing forever", () => {
    let deep: Record<string, unknown> = { leaf: true };

    for (let i = 0; i < 20; i++) {
      deep = { nested: deep };
    }

    expect(() => safeStringify(deep)).not.toThrow();
    expect(safeStringify(deep)).toContain("[Object]");
  });

  it("tags functions and symbols instead of dropping/throwing", () => {
    expect(safeStringify({ fn: function named() {} })).toContain("[Function: named]");
    expect(safeStringify({ s: Symbol("x") })).toContain("Symbol(x)");
  });

  it("honours a user-defined toJSON", () => {
    const obj = { toJSON: () => ({ custom: true }) };
    expect(safeStringify({ obj })).toContain('"custom":true');
  });

  it("renders non-finite numbers as strings", () => {
    expect(safeStringify({ n: Infinity })).toContain('"n":"Infinity"');
    expect(safeStringify({ n: NaN })).toContain('"n":"NaN"');
  });
});

describe("ConsoleLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("without a source, logs bare LEVEL lines (standalone construction)", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    new ConsoleLogger().info("hello");

    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${TIMESTAMP} INFO: hello$`)),
    );
  });

  it("Application.logger renders env + global context from the owning app", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const app = new Application();
    app.useEnvironment("staging");
    app.context.add("deploy", "abc123");

    app.logger.error("Something broke", { per: "call" });

    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `^${TIMESTAMP} staging\\.ERROR: Something broke \\{"per":"call"\\} \\{"deploy":"abc123"\\}$`,
        ),
      ),
    );
  });
});
