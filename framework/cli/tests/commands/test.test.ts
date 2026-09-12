import { EventEmitter } from "node:events";
import { Application } from "@mahiframework/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestCommand } from "../../src/commands/test.js";

const spawnMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

/** Minimal fake ChildProcess: an EventEmitter that supports `.on("exit"/"error")`. */
function fakeChild(): EventEmitter {
  return new EventEmitter();
}

describe("TestCommand", () => {
  afterEach(() => {
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    process.exitCode = undefined;
  });

  it("runs the app's local vitest binary when present, with passthrough args", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    existsSyncMock.mockReturnValue(true);

    const app = new Application();
    const command = new TestCommand(app);
    const handled = command.handle(["--watch", "tests/todos.test.ts"]);

    child.emit("exit", 0);
    await handled;

    const [command0, args0, opts0] = spawnMock.mock.calls[0]!;
    expect(command0).toMatch(/[\\/]node_modules[\\/]\.bin[\\/]vitest(\.cmd)?$/);
    expect(args0).toEqual(["run", "--watch", "tests/todos.test.ts"]);
    expect(opts0).toEqual({ stdio: "inherit" });
  });

  it("falls back to `npx vitest run` when the local binary is absent", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    existsSyncMock.mockReturnValue(false);

    const app = new Application();
    const command = new TestCommand(app);
    const handled = command.handle();

    child.emit("exit", 0);
    await handled;

    expect(spawnMock).toHaveBeenCalledWith("npx", ["vitest", "run"], { stdio: "inherit" });
  });

  it("leaves process.exitCode untouched on a successful (0) exit", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const app = new Application();
    const command = new TestCommand(app);
    const handled = command.handle([]);

    child.emit("exit", 0);
    await handled;

    expect(process.exitCode).toBeUndefined();
  });

  it("propagates a non-zero vitest exit code via process.exitCode", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const app = new Application();
    const command = new TestCommand(app);
    const handled = command.handle([]);

    child.emit("exit", 1);
    await handled;

    expect(process.exitCode).toBe(1);
  });

  it("treats a null exit code (signal-terminated) as a failure (exit code 1)", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const app = new Application();
    const command = new TestCommand(app);
    const handled = command.handle([]);

    child.emit("exit", null);
    await handled;

    expect(process.exitCode).toBe(1);
  });

  it("rejects if the child process itself fails to spawn (e.g. npx not found)", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const app = new Application();
    const command = new TestCommand(app);
    const handled = command.handle([]);

    const spawnError = new Error("spawn npx ENOENT");
    child.emit("error", spawnError);

    await expect(handled).rejects.toThrow("spawn npx ENOENT");
  });
});
