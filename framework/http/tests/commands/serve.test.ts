import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Application } from "@mahiframework/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponse } from "../../src/response.js";
import { HttpKernel } from "../../src/http-kernel.js";
import { HTTP_KERNEL_TOKEN, HttpServiceProvider } from "../../src/http-service-provider.js";
import {
  ServeCommand,
  resolveTsxCli,
  serveWorkerArgs,
  startServeWorker,
} from "../../src/commands/serve.js";
import {
  formatServeUrl,
  getHostAndPort,
  resolveServeBinding,
  SERVE_WORKER_ENV,
  shouldSupervise,
} from "../../src/commands/serve-binding.js";
import type { Router } from "../../src/router.js";
import type { ListeningServer } from "../../src/listen.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.kill = vi.fn();
  child.exitCode = null;
  child.signalCode = null;

  return child;
}

function appWithPing(): Application {
  class PingProvider {
    routes(router: Router) {
      router.get("/ping", () => HttpResponse.json({ ok: true }));
    }
  }

  const app = new Application();
  (app as any).providers = [new PingProvider()];
  const kernel = new HttpKernel(app);
  kernel.collectFromProviders();
  app.instance(HTTP_KERNEL_TOKEN, kernel);

  return app;
}

describe("resolveServeBinding", () => {
  it("defaults to 127.0.0.1:8000", () => {
    expect(resolveServeBinding({}, {})).toEqual({
      hostname: "127.0.0.1",
      port: 8000,
      portWasExplicit: false,
    });
  });

  it("reads SERVER_HOST and SERVER_PORT from the environment", () => {
    expect(resolveServeBinding({}, { SERVER_HOST: "0.0.0.0", SERVER_PORT: "8080" })).toEqual({
      hostname: "0.0.0.0",
      port: 8080,
      portWasExplicit: true,
    });
  });

  it("falls back to PORT when SERVER_PORT is unset", () => {
    expect(resolveServeBinding({}, { PORT: "3000" })).toEqual({
      hostname: "127.0.0.1",
      port: 3000,
      portWasExplicit: false,
    });
  });

  it("CLI --port wins over env and host:port", () => {
    expect(
      resolveServeBinding(
        { host: "127.0.0.1:9000", port: "7000" },
        { SERVER_PORT: "8080", PORT: "3000" },
      ),
    ).toEqual({
      hostname: "127.0.0.1",
      port: 7000,
      portWasExplicit: true,
    });
  });

  it("parses host:port", () => {
    expect(getHostAndPort("127.0.0.1:8080")).toEqual(["127.0.0.1", "8080"]);
    expect(resolveServeBinding({ host: "127.0.0.1:8080" }, {})).toEqual({
      hostname: "127.0.0.1",
      port: 8080,
      portWasExplicit: false,
    });
  });

  it("parses IPv6 [host]:port", () => {
    expect(getHostAndPort("[::1]:8080")).toEqual(["[::1]", "8080"]);
    expect(getHostAndPort("[::1]")).toEqual(["[::1]", undefined]);
    expect(resolveServeBinding({ host: "[::1]:8080" }, {})).toEqual({
      hostname: "[::1]",
      port: 8080,
      portWasExplicit: false,
    });
  });

  it("marks the port explicit only for --port or SERVER_PORT", () => {
    expect(resolveServeBinding({ port: "8000" }, {}).portWasExplicit).toBe(true);
    expect(resolveServeBinding({}, { SERVER_PORT: "8000" }).portWasExplicit).toBe(true);
    expect(resolveServeBinding({}, { PORT: "8000" }).portWasExplicit).toBe(false);
    expect(resolveServeBinding({ host: "127.0.0.1:8000" }, {}).portWasExplicit).toBe(false);
  });
});

describe("formatServeUrl / shouldSupervise", () => {
  it("brackets unbracketed IPv6 hosts", () => {
    expect(formatServeUrl("::1", 8000)).toBe("http://[::1]:8000");
    expect(formatServeUrl("[::1]", 8000)).toBe("http://[::1]:8000");
    expect(formatServeUrl("127.0.0.1", 8000)).toBe("http://127.0.0.1:8000");
  });

  it("supervises unless --no-reload or the worker env is set", () => {
    expect(shouldSupervise({}, {})).toBe(true);
    expect(shouldSupervise({ noReload: true }, {})).toBe(false);
    expect(shouldSupervise({ reload: false }, {})).toBe(false);
    expect(shouldSupervise({}, { [SERVE_WORKER_ENV]: "1" })).toBe(false);
  });
});

describe("serveWorkerArgs", () => {
  it("runs tsx's cli.mjs rather than the POSIX .bin shim (so .js imports rewrite to .ts)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "serve-tsx-"));
    const cli = path.join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, "");

    const argv = [
      "/usr/bin/node",
      "/Users/bradie/.npm/_npx/deadbeef/node_modules/tsx/dist/cli.mjs",
      "bin/console.ts",
      "serve",
      "--port",
      "8000",
    ];

    expect(resolveTsxCli(dir)).toBe(cli);
    expect(serveWorkerArgs(argv, dir)).toEqual([cli, "bin/console.ts", "serve", "--port", "8000"]);

    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A compiled binary IS the interpreter, so `spawn(process.execPath, ...)`
   * re-runs it and everything before the command word must be dropped.
   *
   * The old fallback (`argv.slice(1)`) passed `argv[1]` through — which for
   * such a binary is a path inside its virtual filesystem — and Commander read
   * it as a subcommand:
   *
   *     error: unknown command '/$bunfs/root/hivemind'
   *
   * so `serve` (without `--no-reload`) could not run from a shipped binary at
   * all.
   */
  it("re-executes a compiled binary with just the command, not its virtual argv[1]", () => {
    const argv = ["bun", "/$bunfs/root/hivemind", "serve", "--port", "8000"];

    expect(serveWorkerArgs(argv, "/nonexistent")).toEqual(["serve", "--port", "8000"]);
  });

  /**
   * A built `.js` entry point runs under plain Node. Routing it through tsx
   * was harmless but misleading, and it made the compiled case above look like
   * a special case rather than the third of three.
   */
  it("does not route a built .js entry point through tsx", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "serve-js-"));
    const cli = path.join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, "");

    const argv = ["/usr/bin/node", "/app/dist/bin/console.js", "serve"];

    expect(serveWorkerArgs(argv, dir)).toEqual(["/app/dist/bin/console.js", "serve"]);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("HttpServiceProvider", () => {
  it("exposes ServeCommand via commands()", () => {
    const app = new Application();
    const provider = new HttpServiceProvider(app);
    expect(provider.commands()).toContain(ServeCommand);
  });
});

describe("startServeWorker", () => {
  let listening: ListeningServer | undefined;

  afterEach(async () => {
    await listening?.close();
    listening = undefined;
  });

  it("starts and can be closed without sending SIGINT", async () => {
    const app = appWithPing();
    listening = await startServeWorker(app, { host: "127.0.0.1", port: "0", noReload: true }, {});

    const response = await fetch(`http://127.0.0.1:${listening.port}/ping`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("ServeCommand supervisor", () => {
  const originalEnv = {
    SERVER_HOST: process.env.SERVER_HOST,
    SERVER_PORT: process.env.SERVER_PORT,
    PORT: process.env.PORT,
    [SERVE_WORKER_ENV]: process.env[SERVE_WORKER_ENV],
  };

  function restoreEnv() {
    for (const key of ["SERVER_HOST", "SERVER_PORT", "PORT", SERVE_WORKER_ENV] as const) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  }

  beforeEach(() => {
    delete process.env.SERVER_HOST;
    delete process.env.SERVER_PORT;
    delete process.env.PORT;
    delete process.env[SERVE_WORKER_ENV];
  });

  afterEach(() => {
    spawnMock.mockReset();
    process.exitCode = undefined;
    restoreEnv();
  });

  it("spawns a worker child of the current process with MAHI_SERVE_WORKER=1", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const command = new ServeCommand(new Application());
    const handled = command.handle({ host: "127.0.0.1", port: "8000" });

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      serveWorkerArgs(),
      expect.objectContaining({
        stdio: "inherit",
        cwd: process.cwd(),
        env: expect.objectContaining({
          [SERVE_WORKER_ENV]: "1",
          SERVER_HOST: "127.0.0.1",
          SERVER_PORT: "8000",
        }),
      }),
    );

    child.exitCode = 0;
    child.emit("exit", 0);
    await handled;
  });

  it("does not pin SERVER_PORT when the port was not explicit, so the worker can walk --tries", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const command = new ServeCommand(new Application());
    const handled = command.handle({ host: "127.0.0.1" });

    const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(env[SERVE_WORKER_ENV]).toBe("1");
    expect(env.SERVER_PORT).toBeUndefined();

    child.exitCode = 0;
    child.emit("exit", 0);
    await handled;
  });

  it("propagates a non-zero worker exit code", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const command = new ServeCommand(new Application());
    const handled = command.handle({});

    child.exitCode = 7;
    child.emit("exit", 7);
    await handled;

    expect(process.exitCode).toBe(7);
  });
});
