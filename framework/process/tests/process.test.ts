import { afterEach, describe, expect, it } from "vitest";
import { Process } from "../src/process.js";
import { ProcessFailedError } from "../src/process-failed-error.js";
import { makeProcessResult } from "../src/process-result.js";
import { wildcardMatch } from "../src/matching.js";

describe("wildcardMatch", () => {
  it("treats `?` as a literal, not a regex quantifier", () => {
    expect(wildcardMatch("git?", "gi")).toBe(false);
    expect(wildcardMatch("git?", "git?")).toBe(true);
  });

  it("only gives `*` special meaning", () => {
    expect(wildcardMatch("git *", "git status")).toBe(true);
    expect(wildcardMatch("a.b", "aXb")).toBe(false);
    expect(wildcardMatch("a.b", "a.b")).toBe(true);
  });
});

describe("Process.run: real spawning", () => {
  afterEach(() => {
    Process.restore();
  });

  it("runs an argv-array command and captures stdout", async () => {
    const result = await Process.run(["node", "-e", "process.stdout.write('hello')"]);
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.successful()).toBe(true);
    expect(result.failed()).toBe(false);
  });

  it("captures stderr separately from stdout", async () => {
    const result = await Process.run(["node", "-e", "process.stderr.write('oops')"]);
    expect(result.stderr).toBe("oops");
    expect(result.stdout).toBe("");
  });

  it("reports a non-zero exit code as failed()", async () => {
    const result = await Process.run(["node", "-e", "process.exit(3)"]);
    expect(result.exitCode).toBe(3);
    expect(result.successful()).toBe(false);
    expect(result.failed()).toBe(true);
  });

  it("runs a shell-form (single string) command through the platform shell", async () => {
    const result = await Process.run("node -e \"process.stdout.write('shellform')\"");
    expect(result.stdout).toBe("shellform");
    expect(result.successful()).toBe(true);
  });

  it("resolves (does not reject) when the command fails to spawn", async () => {
    const result = await Process.run(["this-command-does-not-exist-xyz"]);
    expect(result.failed()).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("passes `input` to the child's stdin", async () => {
    const result = await Process.run(
      ["node", "-e", "process.stdin.on('data', (d) => process.stdout.write(d))"],
      { input: "piped-in" },
    );
    expect(result.stdout).toBe("piped-in");
  });

  it("passes extra `env` vars through to the child, merged with the current env", async () => {
    const result = await Process.run(
      ["node", "-e", "process.stdout.write(process.env.MY_TEST_VAR ?? '')"],
      {
        env: { MY_TEST_VAR: "custom-value" },
      },
    );
    expect(result.stdout).toBe("custom-value");
  });

  it("runs in the given `cwd`", async () => {
    const result = await Process.run(["node", "-e", "process.stdout.write(process.cwd())"], {
      cwd: "/tmp",
    });
    // macOS /tmp is a symlink to /private/tmp, accept either form.
    expect(result.stdout.replace(/^\/private/, "")).toBe("/tmp");
  });

  it("records the command string in the result", async () => {
    const result = await Process.run(["node", "-e", "1"]);
    expect(result.command).toBe("node -e 1");
  });

  it("kills the process and reports failure after `timeoutMs` elapses", async () => {
    const result = await Process.run(["node", "-e", "setTimeout(() => {}, 5000)"], {
      timeoutMs: 50,
    });
    expect(result.failed()).toBe(true);
  }, 10_000);

  it("does not crash the host with EPIPE when a child exits before draining a large stdin", async () => {
    const uncaught: Error[] = [];
    const onUncaught = (error: Error) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      // The child exits immediately without reading stdin; writing 4 MiB
      // to its closed pipe would raise EPIPE if unhandled.
      const result = await Process.run(["node", "-e", "process.exit(0)"], {
        input: "y".repeat(4 * 1024 * 1024),
      });
      expect(result.exitCode).toBe(0);
      // Give any stray async error a tick to surface.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("captures large stdout in full (resolves on close, not exit)", async () => {
    const size = 512 * 1024;
    const result = await Process.run(["node", "-e", `process.stdout.write("x".repeat(${size}))`]);
    expect(result.stdout.length).toBe(size);
    expect(result.successful()).toBe(true);
  });

  it("does not record history for real (non-faked) runs", async () => {
    await Process.run(["node", "-e", "1"]);
    await Process.run(["node", "-e", "2"]);
    expect(Process.ran()).toEqual([]);
  });
});

describe("ProcessResult.throw()", () => {
  afterEach(() => {
    Process.restore();
  });

  it("is a no-op and returns itself when successful", async () => {
    const result = await Process.run(["node", "-e", "1"]);
    expect(result.throw()).toBe(result);
  });

  it("throws a ProcessFailedError wrapping the result when failed", async () => {
    const result = await Process.run(["node", "-e", "process.exit(2)"]);
    expect(() => result.throw()).toThrow(ProcessFailedError);
    try {
      result.throw();
    } catch (error) {
      expect((error as ProcessFailedError).result).toBe(result);
    }
  });
});

describe("Process.fake", () => {
  afterEach(() => {
    Process.restore();
  });

  it("resolves run() from a fixed registered result instead of spawning", async () => {
    Process.fake({ "git *": makeProcessResult("git rev-parse HEAD", 0, "abc123\n", "") });
    const result = await Process.run(["git", "rev-parse", "HEAD"]);
    expect(result.stdout).toBe("abc123\n");
    expect(result.successful()).toBe(true);
  });

  it("resolves run() from a handler function computing a result from the command", async () => {
    Process.fake({
      "echo *": (command) => makeProcessResult(command, 0, `${command}\n`, ""),
    });
    const result = await Process.run(["echo", "hi"]);
    expect(result.stdout).toBe("echo hi\n");
  });

  it("falls back to a generic successful empty result for unmatched commands", async () => {
    Process.fake({ "git *": makeProcessResult("git", 0, "matched", "") });
    const result = await Process.run(["npm", "install"]);
    expect(result.successful()).toBe(true);
    expect(result.stdout).toBe("");
  });

  it("fakes every command with the generic default result when called with no handlers", async () => {
    Process.fake();
    const result = await Process.run(["rm", "-rf", "/"]);
    expect(result.successful()).toBe(true);
    expect(result.stdout).toBe("");
  });

  it("reports isFaked() while active, and false again after restore()", async () => {
    expect(Process.isFaked()).toBe(false);
    Process.fake();
    expect(Process.isFaked()).toBe(true);
    Process.restore();
    expect(Process.isFaked()).toBe(false);
  });

  it("never actually spawns a real process while faked", async () => {
    Process.fake();
    const result = await Process.run(["this-command-does-not-exist-xyz"]);
    // A real spawn of a nonexistent command would fail(); under fake()
    // it resolves successfully instead, proving no real spawn happened.
    expect(result.successful()).toBe(true);
  });
});

describe("Process.ran / assertRan / assertNotRan", () => {
  afterEach(() => {
    Process.restore();
  });

  it("records every faked run() call in ran()", async () => {
    Process.fake();
    await Process.run(["git", "status"]);
    await Process.run(["npm", "install"]);
    expect(Process.ran()).toEqual(["git status", "npm install"]);
  });

  it("assertRan() passes when a matching command ran, via wildcard pattern", async () => {
    Process.fake();
    await Process.run(["git", "commit", "-m", "test"]);
    expect(() => Process.assertRan("git *")).not.toThrow();
  });

  it("assertRan() throws when no command matches", async () => {
    Process.fake();
    await Process.run(["npm", "install"]);
    expect(() => Process.assertRan("git *")).toThrow();
  });

  it("assertRan() accepts a predicate function", async () => {
    Process.fake();
    await Process.run(["git", "status"]);
    expect(() => Process.assertRan((cmd) => cmd.startsWith("git"))).not.toThrow();
    expect(() => Process.assertRan((cmd) => cmd.startsWith("npm"))).toThrow();
  });

  it("assertNotRan() passes when no command matches", async () => {
    Process.fake();
    await Process.run(["npm", "install"]);
    expect(() => Process.assertNotRan("git *")).not.toThrow();
  });

  it("assertNotRan() throws when a matching command did run", async () => {
    Process.fake();
    await Process.run(["git", "push", "--force"]);
    expect(() => Process.assertNotRan("git *")).toThrow();
  });

  it("restore() clears call history as well as fake handlers", async () => {
    Process.fake();
    await Process.run(["git", "status"]);
    Process.restore();
    expect(Process.ran()).toEqual([]);
  });
});
